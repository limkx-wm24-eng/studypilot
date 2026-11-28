import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createMailer, EMAIL_UNAVAILABLE } from '../src/mailer.js';
import { openTestDb } from './support/database.js';
import type { AddressInfo } from 'node:net';
import { startSyntheticIngress, syntheticIngressConfig } from './support/syntheticIngress.ts';

test('public email configuration exposes only availability for both states', async () => {
  for (const enabled of [false, true]) {
    const db = await openTestDb();
    const app = createApp(db, { mailer: { enabled, async send() {} } });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const base = `http://localhost:${(server.address() as AddressInfo).port}`;
      const result = await fetch(`${base}/api/config`);
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await result.json(), { emailEnabled: enabled });
      assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await db.close(); }
  }
});

test('disabled mail creates no tokens or false promises and does not gate demo accounts', async () => {
  const db = await openTestDb();
  const app = createApp(db, { mailer: createMailer({ NODE_ENV: 'production' }), ingress: syntheticIngressConfig() });
  const proxy=await startSyntheticIngress(app);
  const base=proxy.base;
  const send = (method: string, path: string, body?: unknown, cookie?: string, ip = '192.0.2.201') => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-StudyPilot-Test-Client': ip, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.deepEqual(await (await send('GET', '/api/config')).json(), { emailEnabled: false });
    const registered = await send('POST', '/api/auth/register', { email: 'disabled@example.test', password: 'synthetic-password-123' });
    assert.equal(registered.status, 201);
    const user = await registered.json();
    assert.equal(user.emailVerified, false);
    const cookie = registered.headers.getSetCookie()[0].split(';')[0];
    assert.equal((await send('GET', '/api/classes', undefined, cookie)).status, 200);
    assert.equal((await send('POST', '/api/classes', { name: 'Synthetic demo class', color: '#0f766e' }, cookie)).status, 201);
    for (const [index, body] of [{ email: user.email }, { email: 'unknown@example.test' }, { email: 'invalid' }, {}].entries()) {
      const result = await send('POST', '/api/auth/forgot', body, undefined, `192.0.2.${210 + index}`);
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { message: EMAIL_UNAVAILABLE });
      const resend = await send('POST', '/api/auth/resend-verification', body, index === 0 ? cookie : undefined, `192.0.2.${220 + index}`);
      assert.equal(resend.status, 202);
      assert.deepEqual(await resend.json(), { message: EMAIL_UNAVAILABLE });
    }
    // Verified accounts receive the same disabled response too.
    await db.run('UPDATE users SET email_verified_at = ? WHERE id = ?', [Date.now(), user.id]);
    assert.deepEqual(await (await send('POST', '/api/auth/resend-verification', {}, cookie, '192.0.2.230')).json(), { message: EMAIL_UNAVAILABLE });
    const limited = await send('POST', '/api/auth/resend-verification', {}, cookie, '192.0.2.230');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);
    assert.deepEqual(await limited.json(), { message: EMAIL_UNAVAILABLE });
    for (let i = 0; i < 7; i++) assert.deepEqual(await (await send('POST', '/api/auth/forgot', { email: user.email })).json(), { message: EMAIL_UNAVAILABLE });
    const change = await send('PATCH', '/api/auth/email', { newEmail: 'new@example.test', password: 'synthetic-password-123' }, cookie);
    assert.equal(change.status, 503);
    assert.deepEqual(await change.json(), { error: EMAIL_UNAVAILABLE });
    assert.deepEqual(await db.all('SELECT * FROM auth_tokens'), []);

    // Already-issued links remain usable; consuming one needs no outgoing email.
    const token = 'synthetic-previously-issued-reset';
    await db.run('INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['synthetic-reset', user.id, 'password_reset', createHash('sha256').update(token).digest('hex'), Date.now() + 60_000, Date.now()]);
    assert.equal((await send('POST', '/api/auth/reset', { token, newPassword: 'new-synthetic-password' })).status, 200);
    const verificationToken = 'synthetic-previously-issued-verification';
    await db.run('INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['synthetic-verification', user.id, 'verify', createHash('sha256').update(verificationToken).digest('hex'), Date.now() + 60_000, Date.now()]);
    assert.equal((await send('POST', '/api/auth/verify-email', { token: verificationToken })).status, 200);
    const confirmationToken = 'synthetic-previously-issued-email-change';
    await db.run('INSERT INTO auth_tokens (id, user_id, purpose, token_hash, new_email, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['synthetic-confirmation', user.id, 'change_email', createHash('sha256').update(confirmationToken).digest('hex'), 'confirmed@example.test', Date.now() + 60_000, Date.now()]);
    assert.equal((await send('POST', '/api/auth/confirm-email-change', { token: confirmationToken })).status, 200);
    assert.equal((await db.get('SELECT email FROM users WHERE id = ?', [user.id]))?.email, 'confirmed@example.test');
    assert.equal((await db.all('SELECT id FROM auth_tokens')).length, 3);
  } finally { await proxy.close(); await db.close(); }
});
