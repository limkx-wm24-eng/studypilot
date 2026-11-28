import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { securityHarness } from './support/securityHarness.ts';
import { hashPassword, checkPassword } from '../src/auth.js';

const protectedRoutes: [string, string][] = [
  ['GET', '/api/auth/me'], ['PATCH', '/api/auth/me'], ['DELETE', '/api/auth/me'], ['PATCH', '/api/auth/email'],
  ...['classes', 'tasks', 'courses'].flatMap((name): [string, string][] => [['GET', `/api/${name}`], ['POST', `/api/${name}`], ['PATCH', `/api/${name}/synthetic-id`], ['DELETE', `/api/${name}/synthetic-id`]]),
  ['GET', '/api/slots'], ['POST', '/api/slots'], ['DELETE', '/api/slots/synthetic-id'],
  ['GET', '/api/attendance?from=2026-11-01&to=2026-11-30'], ['PUT', '/api/attendance'], ['GET', '/api/attendance/summary'], ['POST', '/api/import/timetable'],
];

test('QA route inventory: every API route is classified and protected routes reject anonymous requests', async () => {
  const expected = new Set(protectedRoutes.map(([method, path]) => `${method} ${path.split('?')[0].replace('/synthetic-id', '/:id')}`));
  const publicRoutes = new Set(['GET /api/health', 'GET /api/config', ...['register', 'login', 'logout', 'forgot', 'reset', 'verify-email', 'confirm-email-change', 'resend-verification'].map((name) => `POST /api/auth/${name}`)]);
  const found = ['app', 'auth', 'timetable', 'timetableImport'].flatMap((name) => [...readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8').matchAll(/app\.(get|post|patch|put|delete)\('(\/api\/[^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`));
  assert.deepEqual([...found].sort(), [...expected, ...publicRoutes].sort());
  const h = await securityHarness();
  try {
    for (const [method, path] of protectedRoutes) assert.equal((await h.send(method, path, ['GET', 'DELETE'].includes(method) ? undefined : {})).status, 401, `${method} ${path}`);
    for (const [path, expectedStatus] of [['health', 200], ['config', 200]] as const) assert.equal((await h.send('GET', `/api/${path}`)).status, expectedStatus);
    for (const [name, expectedStatus] of [['register', 400], ['login', 401], ['logout', 204], ['forgot', 200], ['reset', 400], ['verify-email', 400], ['confirm-email-change', 400], ['resend-verification', 401]] as const) assert.equal((await h.send('POST', `/api/auth/${name}`, {})).status, expectedStatus, name);
  } finally { await h.close(); }
});

test('QA ownership: foreign URL IDs, collections, attendance, profile IDs and import names cannot cross accounts', async () => {
  const h = await securityHarness();
  try {
    const a = await h.register(), b = await h.register();
    const owned = await h.seed(a.cookie, 'Owner A'), other = await h.seed(b.cookie, 'Owner B', 2);
    const before = await h.snapshot();
    for (const [resource, id] of [['classes', owned.klass.id], ['tasks', owned.task.id], ['courses', owned.course.id], ['slots', owned.slot.id]]) {
      assert.equal((await h.send('GET', `/api/${resource}/${id}`, undefined, b.cookie)).status, 404);
      if (resource !== 'slots') assert.equal((await h.send('PATCH', `/api/${resource}/${id}`, resource === 'courses' ? { courseName: 'Unauthorized' } : { name: 'Unauthorized' }, b.cookie)).status, 404);
      assert.equal((await h.send('DELETE', `/api/${resource}/${id}`, undefined, b.cookie)).status, 404);
    }
    for (const name of ['classes', 'tasks', 'courses', 'slots']) {
      const rows = await (await h.send('GET', `/api/${name}`, undefined, b.cookie)).json();
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].id, ({ classes: owned.klass.id, tasks: owned.task.id, courses: owned.course.id, slots: owned.slot.id })[name]);
    }
    assert.deepEqual(await (await h.send('GET', `/api/tasks?classId=${owned.klass.id}`, undefined, b.cookie)).json(), []);
    const entries = await (await h.send('GET', '/api/attendance?from=2026-11-01&to=2026-11-30', undefined, b.cookie)).json();
    assert.equal(entries.length, 1); assert.equal(entries[0].slotId, other.slot.id);
    for (const status of ['absent', null]) assert.equal((await h.send('PUT', '/api/attendance', { slotId: owned.slot.id, date: '2026-11-02', status }, b.cookie)).status, 404);
    const summary = await (await h.send('GET', '/api/attendance/summary', undefined, b.cookie)).json();
    assert.ok(summary.classes.every((row: { classId: string }) => row.classId !== owned.klass.id));
    const profile = await (await h.send('GET', `/api/auth/me?userId=${a.user.id}`, undefined, b.cookie)).json();
    assert.equal(profile.id, b.user.id);
    const unknownId = await h.send('PATCH', '/api/auth/me', { id: a.user.id, userId: a.user.id }, b.cookie);
    assert.equal((await unknownId.json()).id, b.user.id);
    assert.deepEqual(await h.snapshot(), before);
    const imported = await h.send('POST', '/api/import/timetable', { userId: a.user.id, classes: [{ name: owned.klass.name }], slots: [{ className: owned.klass.name, kind: 'Lecture', weekday: 1, start: '08:00', end: '10:00', room: '' }] }, b.cookie);
    assert.equal(imported.status, 201);
    assert.equal((await imported.json()).createdClasses, 1);
    const after = await h.snapshot();
    for (const table of ['users', 'sessions', 'auth_tokens', 'tasks', 'courses', 'attendance']) assert.deepEqual(after[table], before[table]);
    for (const table of ['classes', 'slots']) assert.ok(before[table].every((row) => after[table].some((next) => JSON.stringify(next) === JSON.stringify(row))));
    assert.equal((await h.send('DELETE', `/api/auth/me?userId=${a.user.id}`, undefined, b.cookie)).status, 204);
    assert.equal((await h.send('GET', '/api/auth/me', undefined, a.cookie)).status, 200);
  } finally { await h.close(); }
});

for (const operation of ['create-task', 'move-task', 'create-slot'] as const) test(`QA foreign body ID contract: ${operation} retains 422 without changes`, async () => {
  const h = await securityHarness();
  try {
    const a = await h.register(), b = await h.register();
    const owned = await h.seed(a.cookie, 'Body A'), other = await h.seed(b.cookie, 'Body B', 2);
    const before = await h.snapshot();
    const result = operation === 'create-task'
      ? await h.send('POST', '/api/tasks', { ...other.task, classId: owned.klass.id }, b.cookie)
      : operation === 'move-task' ? await h.send('PATCH', `/api/tasks/${other.task.id}`, { classId: owned.klass.id }, b.cookie)
        : await h.send('POST', '/api/slots', { ...other.slot, classId: owned.klass.id }, b.cookie);
    assert.deepEqual(await h.snapshot(), before);
    // Stage 1 explicitly preserves the existing foreign-ID response contract.
    assert.equal(result.status, 422, 'Foreign body ID must be rejected without database changes');
  } finally { await h.close(); }
});

test('QA production sessions: cookie flags, hashed storage, fixation resistance, logout and exact expiry', async () => {
  const h = await securityHarness(true);
  try {
    const account = await h.register();
    const header = account.response.headers.getSetCookie()[0];
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(header.includes(flag), `Missing ${flag}`);
    const token = account.cookie.slice(account.cookie.indexOf('=') + 1);
    assert.equal(token.length, 43);
    const rows = await h.db.all('SELECT * FROM sessions WHERE user_id = ?', [account.user.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(rows[0].token_hash, token);
    const logged = await h.send('POST', '/api/auth/login', { email: account.email, password: 'synthetic-password-123' }, account.cookie);
    assert.equal(logged.status, 200);
    const nextCookie = logged.headers.getSetCookie()[0].split(';')[0];
    assert.ok(nextCookie !== account.cookie, 'Login must issue a fresh token');
    assert.equal((await h.send('POST', '/api/auth/logout', {}, account.cookie)).status, 204);
    assert.equal((await h.send('GET', '/api/auth/me', undefined, account.cookie)).status, 401);
    assert.equal((await h.send('GET', '/api/auth/me', undefined, nextCookie)).status, 200);
    await h.db.run('UPDATE sessions SET expires_at = ? WHERE user_id = ?', [Date.now() - 1, account.user.id]);
    assert.equal((await h.send('GET', '/api/auth/me', undefined, nextCookie)).status, 401);
  } finally { await h.close(); }
});

test('QA password hashing: random salts, bounded password inputs and versioned scrypt parameters', async (t) => {
  const one = await hashPassword('synthetic-password'), two = await hashPassword('synthetic-password');
  assert.notEqual(one, two);
  assert.match(one, /^scrypt\$v1\$N=16384,r=8,p=5\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await checkPassword('synthetic-password', one), true);
  assert.equal(await checkPassword('incorrect-synthetic', one), false);
  const h = await securityHarness();
  try {
    const account = await h.register();
    const started = performance.now();
    assert.equal((await h.send('POST', '/api/auth/register', { email: 'long-password@example.test', password: 'x'.repeat(10_000) })).status, 400);
    assert.equal((await h.send('POST', '/api/auth/login', { email: account.email, password: 'x'.repeat(10_000) })).status, 401);
    assert.equal((await h.send('POST', '/api/auth/reset', { token: 'synthetic', newPassword: 'x'.repeat(10_000) })).status, 400);
    t.diagnostic(`Three very-long-password rejections: ${(performance.now() - started).toFixed(1)} ms`);
    assert.equal((await h.send('GET', '/api/health')).status, 200);
  } finally { await h.close(); }
});

test('QA token handling: hashed storage, exact lifetimes, supersession, expiry and reset revocation', async () => {
  const h = await securityHarness();
  const realNow = Date.now;
  const tokenOf = (message: { text: string }, key: string) => new URL(message.text.match(/https:\/\/\S+/)![0]).searchParams.get(key)!;
  try {
    const a = await h.register();
    assert.equal(h.messages.length, 1);
    const original = tokenOf(h.messages[0], 'verify');
    let row = (await h.db.get('SELECT * FROM auth_tokens WHERE token_hash = ?', [createHash('sha256').update(original).digest('hex')]))!;
    assert.ok(row); assert.equal(Number(row.expires_at) - Number(row.created_at), 24 * 60 * 60_000);
    assert.ok(!Object.values(row).includes(original));
    assert.equal((await h.send('POST', '/api/auth/resend-verification', {}, a.cookie)).status, 202);
    const replacement = tokenOf(h.messages[h.messages.length - 1], 'verify');
    assert.notEqual(original, replacement);
    assert.equal((await h.send('POST', '/api/auth/verify-email', { token: original })).status, 400);
    assert.equal((await h.send('POST', '/api/auth/verify-email', { token: replacement })).status, 200);
    assert.equal((await h.send('POST', '/api/auth/verify-email', { token: replacement })).status, 400);
    await h.send('POST', '/api/auth/forgot', { email: a.email });
    for (let i = 0; i < 200 && h.messages.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.messages.length, 3);
    const reset = tokenOf(h.messages[2], 'reset');
    row = (await h.db.get('SELECT * FROM auth_tokens WHERE token_hash = ?', [createHash('sha256').update(reset).digest('hex')]))!;
    assert.equal(Number(row.expires_at) - Number(row.created_at), 30 * 60_000);
    assert.ok(!Object.values(row).includes(reset));
    Date.now = () => Number(row.expires_at);
    assert.equal((await h.send('POST', '/api/auth/reset', { token: reset, newPassword: 'new-synthetic-password' })).status, 400);
    Date.now = realNow;
    assert.equal((await h.send('POST', '/api/auth/reset', { token: reset, newPassword: 'new-synthetic-password' })).status, 200);
    assert.equal((await h.db.all('SELECT * FROM sessions WHERE user_id = ?', [a.user.id])).length, 0);
    assert.equal((await h.send('GET', '/api/auth/me', undefined, a.cookie)).status, 401);
    assert.equal((await h.send('POST', '/api/auth/reset', { token: reset, newPassword: 'another-synthetic-password' })).status, 400);
  } finally { Date.now = realNow; await h.close(); }
});

test('QA intended registration behavior: existing accounts return 409 and new accounts return 201', async () => {
  const h = await securityHarness();
  try {
    const a = await h.register();
    const known = await h.send('POST', '/api/auth/register', { email: a.email, password: 'synthetic-password-123' });
    const unknown = await h.send('POST', '/api/auth/register', { email: 'new-synthetic@example.test', password: 'synthetic-password-123' });
    // Hiding registration would require an email-based flow; mail is off on the demo.
    assert.equal(known.status, 409);
    assert.deepEqual(await known.json(), { error: 'That email is already registered' });
    assert.equal(unknown.status, 201);
  } finally { await h.close(); }
});

test('QA recovery privacy: known and missing emails have identical forgot/resend responses in both mail states', async (t) => {
  for (const enabled of [false, true]) {
    const h = await securityHarness(true, enabled);
    try {
      const a = await h.register();
      for (const endpoint of ['forgot', 'resend-verification']) {
        const samples: number[][] = [[], []];
        const bodies = [a.email, 'missing-synthetic@example.test'];
        const responses: { status: number; body: unknown }[][] = [[], []];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
          const started = performance.now();
          const result = await h.send('POST', `/api/auth/${endpoint}`, { email: bodies[j] }, undefined, { 'X-Forwarded-For': `192.0.2.${170 + j}` });
          samples[j].push(performance.now() - started);
          responses[j].push({ status: result.status, body: await result.json() });
        }
        assert.deepEqual(responses[0], responses[1]);
        const median = (values: number[]) => values.sort((a, b) => a - b)[1];
        t.diagnostic(JSON.stringify({ endpoint, emailEnabled: enabled, knownMedianMs: median(samples[0]), missingMedianMs: median(samples[1]) }));
        assert.ok(Math.abs(median(samples[0]) - median(samples[1])) <= 50, 'Recovery response median differed by over 50 ms');
      }
    } finally { await h.close(); }
  }
});

test('QA email ownership: body IDs cannot initiate an email change for another account', async () => {
  const h = await securityHarness();
  try {
    const a = await h.register(), b = await h.register();
    const before = await h.db.get('SELECT * FROM users WHERE id = ?', [a.user.id]);
    const changed = await h.send('PATCH', '/api/auth/email', { userId: a.user.id, id: a.user.id, newEmail: 'new-synthetic@example.test', password: 'synthetic-password-123' }, b.cookie);
    assert.equal(changed.status, 202);
    assert.deepEqual(await h.db.get('SELECT * FROM users WHERE id = ?', [a.user.id]), before);
    const tokens = await h.db.all("SELECT user_id FROM auth_tokens WHERE purpose = 'change_email'");
    assert.deepEqual(tokens.map((row) => row.user_id), [b.user.id]);
    assert.equal((await h.send('GET', '/api/auth/me', undefined, b.cookie)).status, 200);
  } finally { await h.close(); }
});

test('QA login privacy: failures do equivalent password work for missing and existing users', async (t) => {
  const h = await securityHarness(true);
  try {
    const a = await h.register();
    const known: number[] = [], unknown: number[] = [];
    for (let i = 0; i < 3; i++) {
      let started = performance.now();
      const first = await h.send('POST', '/api/auth/login', { email: a.email, password: 'incorrect-synthetic' }, undefined, { 'X-Forwarded-For': `192.0.2.${100 + i}` });
      known.push(performance.now() - started);
      started = performance.now();
      const second = await h.send('POST', '/api/auth/login', { email: 'missing-synthetic@example.test', password: 'incorrect-synthetic' }, undefined, { 'X-Forwarded-For': `192.0.2.${110 + i}` });
      unknown.push(performance.now() - started);
      assert.equal(first.status, second.status); assert.deepEqual(await first.json(), await second.json());
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[1];
    t.diagnostic(JSON.stringify({ medianWrongPasswordMs: median(known), medianMissingAccountMs: median(unknown) }));
    const tolerance = Math.max(30, Math.max(median(known), median(unknown)) * 0.6);
    assert.ok(Math.abs(median(known) - median(unknown)) <= tolerance, 'Login medians differ beyond the loose timing tolerance');
  } finally { await h.close(); }
});

test('QA account lockout: another IP cannot deny a legitimate password after five failures', async () => {
  const h = await securityHarness(true);
  try {
    const a = await h.register();
    for (let i = 0; i < 5; i++) await h.send('POST', '/api/auth/login', { email: a.email, password: 'incorrect-synthetic' }, undefined, { 'X-Forwarded-For': '192.0.2.150' });
    const valid = await h.send('POST', '/api/auth/login', { email: a.email, password: 'synthetic-password-123' }, undefined, { 'X-Forwarded-For': '192.0.2.151' });
    assert.equal(valid.status, 200);
  } finally { await h.close(); }
});

test('QA known proxy assumption: a directly connected client cannot reset IP limits by spoofing XFF', { todo: 'trust proxy=1 accepts XFF from any immediate peer; actual Render proxy sanitization is unverified.' }, async () => {
  const h = await securityHarness(true);
  try {
    assert.equal(h.app.get('trust proxy'), 1);
    for (let i = 0; i < 10; i++) await h.send('POST', '/api/auth/reset', {}, undefined, { 'X-Forwarded-For': '192.0.2.160' });
    assert.equal((await h.send('POST', '/api/auth/reset', {}, undefined, { 'X-Forwarded-For': '192.0.2.160' })).status, 429);
    assert.equal((await h.send('POST', '/api/auth/reset', {}, undefined, { 'X-Forwarded-For': '192.0.2.161' })).status, 429);
  } finally { await h.close(); }
});

test('QA input: malformed JSON, wrong types/content type, unknown fields, numbers, Unicode and SQL payloads', async () => {
  const h = await securityHarness();
  try {
    const a = await h.register(), data = await h.seed(a.cookie, 'Inputs');
    assert.equal((await fetch(h.base + '/api/classes', { method: 'POST', headers: { Cookie: a.cookie, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(h.base + '/api/classes', { method: 'POST', headers: { Cookie: a.cookie, 'Content-Type': 'text/plain' }, body: '{"name":"Synthetic","color":"#0f766e"}' })).status, 400);
    for (const name of [null, 42, {}, [], 'x'.repeat(61)]) assert.equal((await h.send('POST', '/api/classes', { name, color: '#0f766e' }, a.cookie)).status, 400);
    assert.equal((await h.send('PATCH', `/api/tasks/${data.task.id}`, { name: 'x'.repeat(61) }, a.cookie)).status, 400);
    assert.equal((await h.send('POST', '/api/slots', { ...data.slot, weekday: 3, room: 'x'.repeat(31) }, a.cookie)).status, 400);
    for (const creditHours of [-1, 0, 13, '3', 1e100]) assert.equal((await h.send('POST', '/api/courses', { semesterLabel: 'Synthetic', courseName: 'Synthetic', creditHours, grade: 'A' }, a.cookie)).status, 400);
    for (const weekday of [-1, 0, 8, 1.5, '1', 1e100]) assert.equal((await h.send('POST', '/api/slots', { ...data.slot, weekday }, a.cookie)).status, 400);
    for (const grade of [-1, 101, '50']) assert.equal((await h.send('PATCH', `/api/tasks/${data.task.id}`, { grade }, a.cookie)).status, 400);
    const text = "合成 😀 '); DROP TABLE users;--";
    const response = await h.send('POST', '/api/classes', { name: text, color: '#0f766e', user_id: 'foreign', unknown: 'ignore' }, a.cookie);
    assert.equal(response.status, 201); const row = await response.json(); assert.equal(row.name, text); assert.equal('unknown' in row, false);
    const task = await h.send('PATCH', `/api/tasks/${data.task.id}`, { name: text }, a.cookie);
    assert.equal(task.status, 200); assert.equal((await task.json()).name, text);
    const room = await h.send('POST', '/api/slots', { ...data.slot, weekday: 3, room: text }, a.cookie);
    assert.equal(room.status, 201); assert.equal((await room.json()).room, text);
    for (const resource of ['classes', 'tasks', 'courses', 'slots']) assert.equal((await h.send('DELETE', `/api/${resource}/${encodeURIComponent("' OR 1=1 --")}`, undefined, a.cookie)).status, 400);
    assert.equal((await h.send('GET', `/api/tasks?classId=${encodeURIComponent("' OR 1=1 --")}`, undefined, a.cookie)).status, 400);
    assert.equal((await h.db.all('SELECT id FROM users')).length, 1);
    assert.equal((await h.send('PATCH', `/api/classes/${data.klass.id}`, { id: 'foreign', user_id: 'foreign' }, a.cookie)).status, 200);
    assert.equal((await h.send('GET', '/api/attendance?from=invalid&to=invalid', undefined, a.cookie)).status, 400);
  } finally { await h.close(); }
});

test('QA parser error: oversized JSON returns 413 rather than 500', async () => {
  const h = await securityHarness();
  try {
    const a = await h.register();
    const result = await h.send('POST', '/api/classes', { name: 'x'.repeat(150_000), color: '#0f766e' }, a.cookie);
    assert.equal((await h.send('GET', '/api/health')).status, 200);
    assert.equal(result.status, 413);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await result.json(), { error: 'Request body too large' });
  } finally { await h.close(); }
});

test('QA error cache policy: malformed JSON responses also have no-store', async () => {
  const h = await securityHarness();
  try {
    const result = await fetch(h.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(result.status, 400);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await result.json(), { error: 'Invalid JSON' });
  } finally { await h.close(); }
});

test('QA control characters: embedded NUL in class, task and room names is rejected cleanly', async (t) => {
  const h = await securityHarness();
  try {
    const a = await h.register(), data = await h.seed(a.cookie, 'Controls');
    const results = [
      await h.send('POST', '/api/classes', { name: 'SYN\u0000CLASS', color: '#0f766e' }, a.cookie),
      await h.send('PATCH', `/api/tasks/${data.task.id}`, { name: 'SYN\u0000TASK' }, a.cookie),
      await h.send('POST', '/api/slots', { ...data.slot, weekday: 3, room: 'SYN\u0000ROOM' }, a.cookie),
    ];
    t.diagnostic(`Embedded NUL statuses (class/task/room): ${results.map((result) => result.status).join('/')}`);
    assert.deepEqual(results.map((result) => result.status), [400, 400, 400]);
  } finally { await h.close(); }
});

test('QA headers: production CSP, HSTS, no wildcard CORS, API cache policy and safe SQL errors', async () => {
  const h = await securityHarness(true);
  try {
    const response = await h.send('GET', '/api/health', undefined, undefined, { Origin: 'https://synthetic-attacker.test' });
    assert.equal(response.headers.get('X-Powered-By'), null);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.match(response.headers.get('Strict-Transport-Security') ?? '', /max-age=/);
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "worker-src 'self'"]) assert.ok(csp.includes(directive));
    assert.ok(!csp.includes('unsafe-eval'));
    const original = h.db.all.bind(h.db);
    h.db.all = async () => { throw new Error('Synthetic SQL stack SELECT private_value'); };
    const a = await h.register();
    const failure = await h.send('GET', '/api/classes', undefined, a.cookie);
    assert.equal(failure.status, 500); assert.deepEqual(await failure.json(), { error: 'Server error' });
    h.db.all = original;
  } finally { await h.close(); }
});

test('QA CSRF defense: unsafe requests with a foreign Origin are rejected', async () => {
  const h = await securityHarness();
  try {
    const a = await h.register(), data = await h.seed(a.cookie, 'Origin');
    const responses = [
      await h.send('POST', '/api/classes', { name: 'Synthetic foreign-origin class', color: '#0f766e' }, a.cookie, { Origin: 'https://synthetic-attacker.test' }),
      await h.send('PATCH', `/api/classes/${data.klass.id}`, { name: 'Synthetic foreign-origin change' }, a.cookie, { Origin: 'https://synthetic-attacker.test' }),
      await h.send('PUT', '/api/attendance', { slotId: data.slot.id, date: '2026-11-02', status: 'absent' }, a.cookie, { Origin: 'https://synthetic-attacker.test' }),
      await h.send('DELETE', `/api/classes/${data.klass.id}`, undefined, a.cookie, { Origin: 'https://synthetic-attacker.test' }),
    ];
    assert.deepEqual(responses.map((r) => r.status), [403, 403, 403, 403]);
  } finally { await h.close(); }
});

test('QA import: bounds and simultaneous identical imports are atomic and idempotent', async () => {
  const h = await securityHarness();
  try {
    const a = await h.register();
    const slot = { className: 'Synthetic concurrent import', kind: 'Lecture', weekday: 1, start: '08:00', end: '10:00', room: 'SYN 1' };
    const results = await Promise.all([h.send('POST', '/api/import/timetable', { slots: [slot] }, a.cookie), h.send('POST', '/api/import/timetable', { slots: [slot] }, a.cookie)]);
    for (const result of results) assert.equal(result.status, 201);
    const values = await Promise.all(results.map((r) => r.json()));
    assert.equal(values.reduce((sum, r) => sum + r.createdSlots, 0), 1);
    assert.equal(values.reduce((sum, r) => sum + r.createdClasses, 0), 1);
    assert.equal(values.reduce((sum, r) => sum + r.skipped, 0), 1);
    const payloads = [
      { slots: Array(201).fill(slot) },
      { classes: Array.from({ length: 41 }, (_, i) => ({ name: `Synthetic ${i}` })), slots: [] },
      { slots: [{ ...slot, className: 'x'.repeat(61) }] },
      { slots: [{ ...slot, start: '25:00' }] },
      { slots: [{ ...slot, kind: 'Unknown' }] },
    ];
    for (const body of payloads) assert.equal((await h.send('POST', '/api/import/timetable', body, a.cookie)).status, 400);
    assert.equal((await h.db.all('SELECT id FROM slots')).length, 1);
  } finally { await h.close(); }
});

test('QA account deletion: all owned rows including imported classes, tokens, sessions and attendance cascade; other owner survives', async () => {
  const h = await securityHarness();
  try {
    const a = await h.register(), b = await h.register();
    const owner = await h.seed(a.cookie, 'Deletion A'), other = await h.seed(b.cookie, 'Deletion B', 2);
    await h.send('POST', '/api/import/timetable', { classes: [{ name: 'Synthetic imported project' }], slots: [] }, a.cookie);
    await h.send('POST', '/api/auth/login', { email: a.email, password: 'synthetic-password-123' });
    for (const purpose of ['password_reset', 'change_email']) await h.db.run('INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [`synthetic-${purpose}`, a.user.id, purpose, createHash('sha256').update(purpose).digest('hex'), Date.now() + 60_000, Date.now()]);
    const before = await h.snapshot();
    const expected: typeof before = {};
    for (const [table, rows] of Object.entries(before)) expected[table] = rows.filter((row) => table === 'users' ? row.id === b.user.id : ['tasks', 'slots'].includes(table) ? row.class_id === other.klass.id : table === 'attendance' ? row.slot_id === other.slot.id : row.user_id === b.user.id);
    assert.equal((await h.send('DELETE', '/api/auth/me', undefined, a.cookie)).status, 204);
    assert.deepEqual(await h.snapshot(), expected);
    assert.equal((await h.send('GET', '/api/auth/me', undefined, a.cookie)).status, 401);
    assert.equal((await h.send('GET', '/api/auth/me', undefined, b.cookie)).status, 200);
    assert.equal((await h.db.all('SELECT id FROM slots')).some((row) => row.id === owner.slot.id), false);
  } finally { await h.close(); }
});
