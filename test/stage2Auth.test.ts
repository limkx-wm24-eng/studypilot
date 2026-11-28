import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, scryptSync, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { securityHarness } from './support/securityHarness.ts';
import { legacyHash } from './support/legacyPassword.ts';
import { PasswordService, HashQueue, AUTH_BUSY_MESSAGE } from '../src/passwords.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const withDeadline = (operation: Promise<unknown>) => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic operation timed out')), 10_000); })]).finally(() => clearTimeout(timer));
};

test('Stage 2 auth: legacy, current and unknown failed-login medians stay within a loose tolerance', async (t) => {
  const h = await securityHarness(true);
  try {
    const a = await h.register();
    const current = String((await h.db.get('SELECT password_hash FROM users WHERE id = ?', [a.user.id]))!.password_hash);
    const legacy = legacyHash('synthetic-password-123');
    const medians: number[] = [];
    for (const [index, mode] of ['current', 'legacy', 'unknown'].entries()) {
      await h.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [mode === 'legacy' ? legacy : current, a.user.id]);
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        const result = await h.send('POST', '/api/auth/login', { email: mode === 'unknown' ? 'timing-missing@example.test' : a.email, password: 'incorrect-synthetic' }, undefined, { 'X-StudyPilot-Test-Client': `192.0.2.${150 + index}` });
        assert.equal(result.status, 401); assert.deepEqual(await result.json(), { error: 'Invalid email or password' });
        samples.push(performance.now() - started);
      }
      const median = samples.sort((a, b) => a - b)[1]; medians.push(median);
      t.diagnostic(JSON.stringify({ mode, medianMs: median }));
    }
    const maximum = Math.max(...medians);
    assert.ok(maximum - Math.min(...medians) <= Math.max(80, maximum * 0.6), 'Failure medians differ beyond the loose tolerance');
  } finally { await h.close(); }
});

test('Stage 2 auth: legacy and older versioned hashes upgrade only after a correct password; subsequent login works', async (t) => {
  const h = await securityHarness();
  try {
    const a = await h.register();
    const legacy = legacyHash('synthetic-password-123');
    await h.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [legacy, a.user.id]);
    assert.equal((await h.send('POST', '/api/auth/login', { email: a.email, password: 'incorrect-synthetic' })).status, 401);
    assert.ok((await h.db.get('SELECT password_hash FROM users WHERE id = ?', [a.user.id]))!.password_hash === legacy);
    const start = performance.now();
    assert.equal((await h.send('POST', '/api/auth/login', { email: a.email, password: 'synthetic-password-123' })).status, 200);
    t.diagnostic(`Legacy-upgrade HTTP login ms: ${(performance.now() - start).toFixed(1)}`);
    const upgraded = String((await h.db.get('SELECT password_hash FROM users WHERE id = ?', [a.user.id]))!.password_hash);
    assert.ok(upgraded !== legacy && upgraded.startsWith('scrypt$v1$N=16384,r=8,p=5$'));
    assert.equal((await h.send('POST', '/api/auth/login', { email: a.email, password: 'synthetic-password-123' })).status, 200);
    assert.ok((await h.db.get('SELECT password_hash FROM users WHERE id = ?', [a.user.id]))!.password_hash === upgraded);
    const salt = randomBytes(16);
    const key = scryptSync('synthetic-password-123', salt, 64, { N: 8192, r: 8, p: 1 });
    await h.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [`scrypt$v1$N=8192,r=8,p=1$${salt.toString('hex')}$${key.toString('hex')}`, a.user.id]);
    assert.equal((await h.send('POST', '/api/auth/login', { email: a.email, password: 'synthetic-password-123' })).status, 200);
    assert.ok(String((await h.db.get('SELECT password_hash FROM users WHERE id = ?', [a.user.id]))!.password_hash).startsWith('scrypt$v1$N=16384,r=8,p=5$'));
  } finally { await h.close(); }
});

test('Stage 2 auth: reset during a delayed legacy upgrade cannot be overwritten or issue an obsolete session', async () => {
  const entered = deferred(), release = deferred();
  class PausedUpgrade extends PasswordService {
    pause = false;
    override async hash(password: string) {
      if (this.pause) { this.pause = false; entered.resolve(); await release.promise; }
      return super.hash(password);
    }
  }
  const service = new PausedUpgrade(), h = await securityHarness(false, true, service);
  let login: Promise<Response> | undefined;
  try {
    const a = await h.register();
    await h.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [legacyHash('synthetic-password-123'), a.user.id]);
    service.pause = true;
    login = h.send('POST', '/api/auth/login', { email: a.email, password: 'synthetic-password-123' });
    await withDeadline(entered.promise);
    const token = 'synthetic-concurrent-reset';
    await h.db.run('INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['synthetic-concurrent-reset', a.user.id, 'password_reset', createHash('sha256').update(token).digest('hex'), Date.now() + 60_000, Date.now()]);
    assert.equal((await h.send('POST', '/api/auth/reset', { token, newPassword: 'new-synthetic-password' })).status, 200);
    const afterReset = (await h.db.get('SELECT password_hash FROM users WHERE id = ?', [a.user.id]))!.password_hash;
    release.resolve(); assert.equal((await login).status, 401);
    assert.ok((await h.db.get('SELECT password_hash FROM users WHERE id = ?', [a.user.id]))!.password_hash === afterReset);
    assert.equal((await h.db.all('SELECT * FROM sessions WHERE user_id = ?', [a.user.id])).length, 0);
    assert.equal((await h.send('POST', '/api/auth/login', { email: a.email, password: 'new-synthetic-password' })).status, 200);
  } finally { release.resolve(); await login; await h.close(); }
});

test('Stage 2 auth: a full hash queue returns generic 503; reset tokens/sessions survive and login reservations release', async () => {
  const queue = new HashQueue(), service = new PasswordService(queue), h = await securityHarness(false, true, service);
  const release = deferred();
  let blockers: Promise<void>[] = [];
  try {
    const a = await h.register();
    const token = 'synthetic-saturated-reset';
    await h.db.run('INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['synthetic-saturated-reset', a.user.id, 'password_reset', createHash('sha256').update(token).digest('hex'), Date.now() + 60_000, Date.now()]);
    blockers = Array.from({ length: 10 }, () => queue.run(() => release.promise));
    assert.deepEqual(queue.status, { active: 2, waiting: 8 });
    const bodies: [string, unknown][] = [
      ['/api/auth/register', { email: 'saturated-new@example.test', password: 'synthetic-password-123' }],
      ['/api/auth/reset', { token, newPassword: 'new-synthetic-password' }],
      ...Array.from({ length: 6 }, () => ['/api/auth/login', { email: a.email, password: 'synthetic-password-123' }] as [string, unknown]),
      ...Array.from({ length: 6 }, () => ['/api/auth/login', { email: 'missing@example.test', password: 'synthetic-password-123' }] as [string, unknown]),
    ];
    for (const [path, body] of bodies) {
      const result = await h.send('POST', path, body);
      assert.equal(result.status, 503, path); assert.equal(result.headers.get('Retry-After'), '1');
      assert.equal(result.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await result.json(), { error: AUTH_BUSY_MESSAGE });
    }
    assert.equal((await h.db.get('SELECT used_at FROM auth_tokens WHERE id = ?', ['synthetic-saturated-reset']))!.used_at, null);
    assert.equal((await h.send('GET', '/api/auth/me', undefined, a.cookie)).status, 200);
    release.resolve(); await Promise.all(blockers);
    assert.equal((await h.send('POST', '/api/auth/reset', { token, newPassword: 'new-synthetic-password' })).status, 200);
    assert.equal((await h.send('GET', '/api/auth/me', undefined, a.cookie)).status, 401);
    assert.deepEqual(queue.status, { active: 0, waiting: 0 });
  } finally { release.resolve(); await Promise.all(blockers); await h.close(); }
});

test('Stage 2 auth: aggregate failures across emails throttle only their own IP with Retry-After', async () => {
  // Stub only password verification here to test 30 attempts without slow KDF work.
  class CountingPasswords extends PasswordService {
    verifications = 0;
    override async verifyLogin(password: string, stored?: string) { this.verifications++; return !!stored && password === 'synthetic-password-123'; }
  }
  const service = new CountingPasswords(), h = await securityHarness(true, true, service);
  try {
    const a = await h.register();
    for (let i = 0; i < 30; i++) {
      const response = await h.send('POST', '/api/auth/login', { email: `aggregate-${i}@example.test`, password: 'incorrect-synthetic' }, undefined, { 'X-StudyPilot-Test-Client': '192.0.2.80' });
      assert.equal(response.status, i === 29 ? 429 : 401);
      if (i === 29) assert.ok(Number(response.headers.get('Retry-After')) > 0);
    }
    assert.equal((await h.send('POST', '/api/auth/login', { email: a.email, password: 'synthetic-password-123' }, undefined, { 'X-StudyPilot-Test-Client': '192.0.2.81' })).status, 200);
    assert.equal((await h.send('POST', '/api/auth/login', { email: a.email, password: 'synthetic-password-123' }, undefined, { 'X-StudyPilot-Test-Client': '192.0.2.80' })).status, 429);
    assert.equal(service.verifications, 31);
  } finally { await h.close(); }
});

test('Stage 2 auth: a rolled-back login never publishes a session cookie', async () => {
  const h = await securityHarness();
  const transaction = h.db.transaction.bind(h.db);
  try {
    const a = await h.register();
    h.db.transaction = async (operation) => transaction(async (db) => {
      await operation(db);
      throw new Error('Synthetic commit failure');
    });
    const response = await h.send('POST', '/api/auth/login', { email: a.email, password: 'synthetic-password-123' });
    assert.equal(response.status, 500);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.deepEqual(await response.json(), { error: 'Server error' });
    assert.equal((await h.db.all('SELECT token_hash FROM sessions WHERE user_id = ?', [a.user.id])).length, 1);
    assert.equal((await h.send('GET', '/api/auth/me', undefined, a.cookie)).status, 200);
  } finally { h.db.transaction = transaction; await h.close(); }
});

test('Stage 2 auth: asynchronous registration preserves 409 when duplicate emails race', async () => {
  const entered = deferred(), release = deferred();
  class GatedRegistration extends PasswordService {
    arrivals = 0;
    override async hash(password: string) {
      if (++this.arrivals === 2) entered.resolve();
      await release.promise;
      return super.hash(password);
    }
  }
  const h = await securityHarness(false, true, new GatedRegistration());
  const attempts: Promise<Response>[] = [];
  try {
    const body = { email: 'concurrent-registration@example.test', password: 'synthetic-password-123' };
    attempts.push(h.send('POST', '/api/auth/register', body), h.send('POST', '/api/auth/register', body));
    await withDeadline(entered.promise); release.resolve();
    const responses = await Promise.all(attempts);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    assert.equal((await h.db.all('SELECT id FROM users')).length, 1);
    assert.equal((await h.db.all('SELECT token_hash FROM sessions')).length, 1);
  } finally { release.resolve(); await Promise.all(attempts); await h.close(); }
});
