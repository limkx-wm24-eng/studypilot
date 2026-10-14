import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { deleteExpiredSessions } from '../src/auth.js';
import { openDb } from '../src/db.js';
import type { Email, Mailer } from '../src/mailer.js';
import type { Database } from '../src/db.js';

let server: Server;
let base = '';
let db: Database;
let mailer: MemoryMailer;
const originalAppUrl = process.env.APP_URL;

class MemoryMailer implements Mailer {
  readonly messages: Email[] = [];
  private readonly waiters: { count: number; resolve: (email: Email) => void }[] = [];

  async send(email: Email): Promise<void> {
    this.messages.push(email);
    for (const waiter of this.waiters.splice(0)) {
      if (this.messages.length >= waiter.count) waiter.resolve(this.messages[waiter.count - 1]);
      else this.waiters.push(waiter);
    }
  }

  waitForCount(count: number): Promise<Email> {
    const existing = this.messages[count - 1];
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }
}

before(async () => {
  process.env.APP_URL = 'https://studypilot.example.test';
  db = await openDb();
  mailer = new MemoryMailer();
  const app = createApp(db, { mailer });
  app.set('trust proxy', 1);
  await new Promise<void>((done) => { server = app.listen(0, done); });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (db) await db.close();
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
});

const send = (method: string, path: string, body?: unknown, cookie?: string, ip = '127.0.0.1') =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
let n = 0;
const email = () => `user${++n}@example.com`;
const signup = async (ip = '127.0.0.1') => {
  const r = await send('POST', '/api/auth/register', { email: email(), password: 'password123', name: 'Test' }, undefined, ip);
  assert.equal(r.status, 201);
  return r.headers.getSetCookie()[0].split(';')[0];
};
const json = async <T>(r: Response) => (await r.json()) as T;
const resetTokenFrom = (message: Email) => {
  const token = message.text.match(/\?reset=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token);
  return token;
};
const tokenFrom = (message: Email, query: 'verify' | 'confirm-email') => {
  const token = message.text.match(new RegExp(`\\?${query}=([A-Za-z0-9_-]+)`))?.[1];
  assert.ok(token);
  return token;
};
const newClass = async (cookie: string) => json<{ id: string }>(await send('POST', '/api/classes', { name: 'Databases', color: '#0f766e' }, cookie));
const taskFor = (classId: string) => ({ classId, type: 'Homework', name: 'Tutorial 1', priority: 'Medium', status: 'Not started', due: '2026-10-20', grade: null });

test('registration verifies email once, with used and expired tokens rejected', async () => {
  const address = email();
  const delivery = mailer.waitForCount(mailer.messages.length + 1);
  const registered = await send('POST', '/api/auth/register', { email: address, password: 'password123' }, undefined, '192.0.2.60');
  assert.equal(registered.status, 201);
  const cookie = registered.headers.getSetCookie()[0].split(';')[0];
  const user = await json<{ id: string; emailVerified: boolean }>(registered);
  assert.equal(user.emailVerified, false);
  const message = await delivery;
  assert.equal(message.to, address);
  assert.match(message.subject, /verify/i);
  const token = tokenFrom(message, 'verify');

  const verified = await send('POST', '/api/auth/verify-email', { token });
  assert.equal(verified.status, 200);
  assert.equal((await json<{ emailVerified: boolean }>(await send('GET', '/api/auth/me', undefined, cookie))).emailVerified, true);
  assert.equal((await send('POST', '/api/auth/verify-email', { token })).status, 400);

  const expired = 'expired-verification-token';
  await db.run(
    'INSERT INTO auth_tokens (id, user_id, purpose, token_hash, new_email, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['expired-verification', user.id, 'verify', createHash('sha256').update(expired).digest('hex'), null, Date.now() - 1, null, Date.now() - 60_000],
  );
  assert.equal((await send('POST', '/api/auth/verify-email', { token: expired })).status, 400);
});

test('verification resend is rate-limited and refused after verification', async () => {
  const address = email();
  const registrationDelivery = mailer.waitForCount(mailer.messages.length + 1);
  const registered = await send('POST', '/api/auth/register', { email: address, password: 'password123' }, undefined, '192.0.2.61');
  const cookie = registered.headers.getSetCookie()[0].split(';')[0];
  await registrationDelivery;

  const realNow = Date.now;
  const baseTime = realNow();
  try {
    const firstDelivery = mailer.waitForCount(mailer.messages.length + 1);
    assert.equal((await send('POST', '/api/auth/resend-verification', undefined, cookie)).status, 202);
    const firstMessage = await firstDelivery;
    assert.equal(firstMessage.to, address);
    const cooldown = await send('POST', '/api/auth/resend-verification', undefined, cookie);
    assert.equal(cooldown.status, 429);
    assert.ok(Number(cooldown.headers.get('Retry-After')) > 0);

    let lastMessage = firstMessage;
    for (let attempt = 1; attempt < 5; attempt++) {
      Date.now = () => baseTime + attempt * 61_000;
      const delivery = mailer.waitForCount(mailer.messages.length + 1);
      assert.equal((await send('POST', '/api/auth/resend-verification', undefined, cookie)).status, 202);
      lastMessage = await delivery;
    }
    Date.now = () => baseTime + 10 * 60_000;
    const dailyCooldown = await send('POST', '/api/auth/resend-verification', undefined, cookie);
    assert.equal(dailyCooldown.status, 429);
    assert.ok(Number(dailyCooldown.headers.get('Retry-After')) > 60);

    Date.now = realNow;
    const verified = await send('POST', '/api/auth/verify-email', { token: tokenFrom(lastMessage, 'verify') });
    assert.equal(verified.status, 200);
    assert.equal((await send('POST', '/api/auth/resend-verification', undefined, cookie)).status, 409);
  } finally {
    Date.now = realNow;
  }
});

test('forgot password responds generically and only sends mail for a known account', async () => {
  const address = email();
  const registrationDelivery = mailer.waitForCount(mailer.messages.length + 1);
  assert.equal((await send('POST', '/api/auth/register', { email: address, password: 'password123' }, undefined, '192.0.2.50')).status, 201);
  await registrationDelivery;
  const startingMessageCount = mailer.messages.length;
  const expected = { message: 'If an account exists for that email, we sent a reset link.' };
  const unknown = await send('POST', '/api/auth/forgot', { email: email() }, undefined, '192.0.2.51');
  const unknownBody = await json<{ message: string }>(unknown);
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknownBody, expected);
  assert.equal(mailer.messages.length, startingMessageCount);

  const delivery = mailer.waitForCount(startingMessageCount + 1);
  const known = await send('POST', '/api/auth/forgot', { email: ` ${address.toUpperCase()} ` }, undefined, '192.0.2.52');
  assert.equal(known.status, 200);
  assert.deepEqual(await json(known), unknownBody);
  const message = await delivery;
  assert.equal(message.to, address);
  assert.match(message.text, /^Use this link to choose a new password/);
  assert.match(message.text, /https:\/\/studypilot\.example\.test\/\?reset=[A-Za-z0-9_-]+/);
});

test('password reset is one-time, revokes sessions and accepts the new password', async () => {
  const address = email();
  const ip = '192.0.2.53';
  const registrationDelivery = mailer.waitForCount(mailer.messages.length + 1);
  const registered = await send('POST', '/api/auth/register', { email: address, password: 'password123' }, undefined, ip);
  await registrationDelivery;
  const firstSession = registered.headers.getSetCookie()[0].split(';')[0];
  const secondLogin = await send('POST', '/api/auth/login', { email: address, password: 'password123' }, undefined, ip);
  const secondSession = secondLogin.headers.getSetCookie()[0].split(';')[0];
  const delivery = mailer.waitForCount(mailer.messages.length + 1);
  await send('POST', '/api/auth/forgot', { email: address }, undefined, ip);
  const token = resetTokenFrom(await delivery);

  const weak = await send('POST', '/api/auth/reset', { token, newPassword: 'weak' });
  assert.equal(weak.status, 400);
  const reset = await send('POST', '/api/auth/reset', { token, newPassword: 'new-password-123' });
  assert.equal(reset.status, 200);
  assert.deepEqual(await json(reset), { message: 'Password updated.' });
  assert.equal((await send('POST', '/api/auth/reset', { token, newPassword: 'another-password-123' })).status, 400);
  assert.equal((await send('GET', '/api/auth/me', undefined, firstSession)).status, 401);
  assert.equal((await send('GET', '/api/auth/me', undefined, secondSession)).status, 401);
  assert.equal((await send('POST', '/api/auth/login', { email: address, password: 'password123' }, undefined, '192.0.2.54')).status, 401);
  assert.equal((await send('POST', '/api/auth/login', { email: address, password: 'new-password-123' }, undefined, '192.0.2.55')).status, 200);
});

test('invalid, expired and superseded password reset tokens are rejected', async () => {
  const address = email();
  const ip = '192.0.2.56';
  const registrationDelivery = mailer.waitForCount(mailer.messages.length + 1);
  const registered = await send('POST', '/api/auth/register', { email: address, password: 'password123' }, undefined, ip);
  await registrationDelivery;
  const me = await json<{ id: string }>(registered);
  assert.equal((await send('POST', '/api/auth/reset', { token: 'garbage', newPassword: 'new-password-123' })).status, 400);

  const expiredToken = 'expired-reset-token';
  await db.run(
    'INSERT INTO auth_tokens (id, user_id, purpose, token_hash, new_email, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['expired-reset', me.id, 'password_reset', createHash('sha256').update(expiredToken).digest('hex'), null, Date.now() - 1, null, Date.now() - 60_000],
  );
  assert.equal((await send('POST', '/api/auth/reset', { token: expiredToken, newPassword: 'new-password-123' })).status, 400);

  const firstDelivery = mailer.waitForCount(mailer.messages.length + 1);
  await send('POST', '/api/auth/forgot', { email: address }, undefined, ip);
  const oldToken = resetTokenFrom(await firstDelivery);
  const secondDelivery = mailer.waitForCount(mailer.messages.length + 1);
  await send('POST', '/api/auth/forgot', { email: address }, undefined, ip);
  const newToken = resetTokenFrom(await secondDelivery);
  assert.notEqual(newToken, oldToken);
  assert.equal((await send('POST', '/api/auth/reset', { token: oldToken, newPassword: 'new-password-123' })).status, 400);
  assert.equal((await send('POST', '/api/auth/reset', { token: newToken, newPassword: 'new-password-123' })).status, 200);
});

test('forgot password is rate-limited with the same generic response', async () => {
  const address = email();
  const ip = '192.0.2.57';
  const registrationDelivery = mailer.waitForCount(mailer.messages.length + 1);
  assert.equal((await send('POST', '/api/auth/register', { email: address, password: 'password123' }, undefined, ip)).status, 201);
  await registrationDelivery;
  const startingMessageCount = mailer.messages.length;
  const responses: Response[] = [];
  for (let index = 0; index < 6; index++) {
    responses.push(await send('POST', '/api/auth/forgot', { email: address }, undefined, ip));
  }
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { message: 'If an account exists for that email, we sent a reset link.' });
  }
  await mailer.waitForCount(startingMessageCount + 4);
  assert.equal(mailer.messages.filter((message) => message.to === address && /reset.*password/i.test(message.subject)).length, 4);
});

test('register, read profile, log out', async () => {
  const cookie = await signup();
  const me = await json<{ name: string; reminderDays: number }>(await send('GET', '/api/auth/me', undefined, cookie));
  assert.equal(me.name, 'Test');
  assert.equal(me.reminderDays, 1);
  assert.equal((await send('POST', '/api/auth/logout', undefined, cookie)).status, 204);
  assert.equal((await send('GET', '/api/auth/me', undefined, cookie)).status, 401);
});

test('login checks the password and emails are unique', async () => {
  const address = email();
  await send('POST', '/api/auth/register', { email: address, password: 'password123' });
  assert.equal((await send('POST', '/api/auth/register', { email: address, password: 'password123' })).status, 409);
  assert.equal((await send('POST', '/api/auth/login', { email: address, password: 'wrong-password' })).status, 401);
  assert.equal((await send('POST', '/api/auth/login', { email: address, password: 'password123' })).status, 200);
  assert.equal((await send('POST', '/api/auth/register', { email: email(), password: 'short' })).status, 400);
});

test('users can change their email after confirming their password', async () => {
  const ip = '198.51.100.40';
  const oldEmail = email();
  const duplicateEmail = email();
  const registrationDelivery = mailer.waitForCount(mailer.messages.length + 1);
  const registered = await send('POST', '/api/auth/register', { email: oldEmail, password: 'password123' }, undefined, ip);
  assert.equal(registered.status, 201);
  await registrationDelivery;
  const currentCookie = registered.headers.getSetCookie()[0].split(';')[0];

  const duplicateDelivery = mailer.waitForCount(mailer.messages.length + 1);
  const duplicateRegistration = await send('POST', '/api/auth/register', { email: duplicateEmail, password: 'password123' }, undefined, '198.51.100.41');
  assert.equal(duplicateRegistration.status, 201);
  await duplicateDelivery;
  await db.run('UPDATE users SET email = UPPER(email) WHERE email = ?', [duplicateEmail]);

  const otherLogin = await send('POST', '/api/auth/login', { email: oldEmail, password: 'password123' }, undefined, '198.51.100.42');
  assert.equal(otherLogin.status, 200);
  const otherCookie = otherLogin.headers.getSetCookie()[0].split(';')[0];

  const payload = (newEmail: string, password = 'password123') => ({ newEmail, password });
  assert.equal((await send('PATCH', '/api/auth/email', payload(email()))).status, 401);

  const wrongPassword = await send('PATCH', '/api/auth/email', payload(email(), 'wrong'), currentCookie, ip);
  assert.equal(wrongPassword.status, 401);
  assert.equal((await json<{ error: string }>(wrongPassword)).error, 'Incorrect password');
  assert.equal((await json<{ email: string }>(await send('GET', '/api/auth/me', undefined, currentCookie))).email, oldEmail);

  assert.equal((await send('PATCH', '/api/auth/email', payload('not-an-email'), currentCookie, ip)).status, 400);
  assert.equal((await send('PATCH', '/api/auth/email', payload(oldEmail.toUpperCase()), currentCookie, ip)).status, 400);
  const duplicate = await send('PATCH', '/api/auth/email', payload(duplicateEmail), currentCookie, ip);
  assert.equal(duplicate.status, 409);
  assert.equal((await json<{ error: string }>(duplicate)).error, 'That email is already registered');

  const oldMailCount = mailer.messages.length;
  const changed = await send('PATCH', '/api/auth/email', payload('  New.Email@Example.com  '), currentCookie, ip);
  assert.equal(changed.status, 202);
  assert.deepEqual(await json(changed), { message: 'Check your new inbox to confirm.', pendingEmail: 'new.email@example.com' });
  const pendingUser = await json<{ email: string; pendingEmail: string | null }>(await send('GET', '/api/auth/me', undefined, currentCookie));
  assert.equal(pendingUser.email, oldEmail);
  assert.equal(pendingUser.pendingEmail, 'new.email@example.com');
  const changeMessage = mailer.messages[oldMailCount];
  assert.equal(changeMessage.to, 'new.email@example.com');
  assert.match(changeMessage.text, /confirm-email=/);

  const noticeDelivery = mailer.waitForCount(oldMailCount + 2);
  const confirmed = await send('POST', '/api/auth/confirm-email-change', { token: tokenFrom(changeMessage, 'confirm-email') }, currentCookie);
  assert.equal(confirmed.status, 200);
  const notice = await noticeDelivery;
  assert.equal(notice.to, oldEmail);
  assert.match(notice.subject, /changed/i);
  const updatedUser = await json<{ email: string; emailVerified: boolean; pendingEmail: string | null }>(await send('GET', '/api/auth/me', undefined, currentCookie));
  assert.equal(updatedUser.email, 'new.email@example.com');
  assert.equal(updatedUser.emailVerified, true);
  assert.equal(updatedUser.pendingEmail, null);
  assert.equal((await send('GET', '/api/auth/me', undefined, otherCookie)).status, 401);
  assert.equal((await send('POST', '/api/auth/login', { email: 'new.email@example.com', password: 'password123' }, undefined, '198.51.100.43')).status, 200);
  assert.equal((await send('POST', '/api/auth/login', { email: oldEmail, password: 'password123' }, undefined, '198.51.100.44')).status, 401);

  const takenEmail = email();
  const pendingMail = mailer.waitForCount(mailer.messages.length + 1);
  const pendingChange = await send('PATCH', '/api/auth/email', payload(takenEmail), currentCookie, ip);
  assert.equal(pendingChange.status, 202);
  const pendingNotice = await pendingMail;
  const takenRegistrationMail = mailer.waitForCount(mailer.messages.length + 1);
  assert.equal((await send('POST', '/api/auth/register', { email: takenEmail, password: 'password123' }, undefined, '198.51.100.45')).status, 201);
  await takenRegistrationMail;
  const conflict = await send('POST', '/api/auth/confirm-email-change', { token: tokenFrom(pendingNotice, 'confirm-email') }, currentCookie);
  assert.equal(conflict.status, 409);
  assert.equal((await json<{ email: string }>(await send('GET', '/api/auth/me', undefined, currentCookie))).email, 'new.email@example.com');
});

test('remember me controls persistent login cookies', async () => {
  const address = email();
  const ip = '198.51.100.6';
  assert.equal((await send('POST', '/api/auth/register', { email: address, password: 'password123' }, undefined, ip)).status, 201);

  const regularLogin = await send('POST', '/api/auth/login', { email: address, password: 'password123' }, undefined, ip);
  assert.equal(regularLogin.status, 200);
  assert.doesNotMatch(regularLogin.headers.getSetCookie()[0], /max-age=/i);

  const rememberedLogin = await send('POST', '/api/auth/login', { email: address, password: 'password123', rememberMe: true }, undefined, ip);
  assert.equal(rememberedLogin.status, 200);
  assert.match(rememberedLogin.headers.getSetCookie()[0], /max-age=1209600/i);
});

test('five failed login attempts lock the email and IP with Retry-After', async () => {
  const address = email();
  const ip = '198.51.100.1';
  assert.equal((await send('POST', '/api/auth/register', { email: address, password: 'password123' }, undefined, ip)).status, 201);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await send('POST', '/api/auth/login', { email: address, password: 'wrong-password' }, undefined, ip);
    assert.equal(response.status, attempt === 5 ? 429 : 401);
    if (attempt === 5) assert.ok(Number(response.headers.get('Retry-After')) > 0);
  }
  assert.equal((await send('POST', '/api/auth/login', { email: address, password: 'password123' }, undefined, ip)).status, 429);
});

test('a correct login succeeds after four failed attempts', async () => {
  const address = email();
  const ip = '198.51.100.2';
  assert.equal((await send('POST', '/api/auth/register', { email: address, password: 'password123' }, undefined, ip)).status, 201);
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal((await send('POST', '/api/auth/login', { email: address, password: 'wrong-password' }, undefined, ip)).status, 401);
  }
  assert.equal((await send('POST', '/api/auth/login', { email: address, password: 'password123' }, undefined, ip)).status, 200);
});

test('registration failures are also throttled', async () => {
  const ip = '198.51.100.3';
  const body = { email: email(), password: 'password123' };
  assert.equal((await send('POST', '/api/auth/register', body, undefined, ip)).status, 201);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await send('POST', '/api/auth/register', body, undefined, ip);
    assert.equal(response.status, attempt === 5 ? 429 : 409);
    if (attempt === 5) assert.ok(Number(response.headers.get('Retry-After')) > 0);
  }
});

test('Helmet sets a Vite-compatible content security policy', async () => {
  const response = await send('GET', '/api/health');
  const policy = response.headers.get('Content-Security-Policy') ?? '';
  assert.ok(policy.includes("script-src 'self'"));
  assert.ok(policy.includes("style-src 'self' 'unsafe-inline'"));
});

test('expired sessions are deleted without removing active sessions', async () => {
  const cookie = await signup('198.51.100.4');
  const me = await json<{ id: string }>(await send('GET', '/api/auth/me', undefined, cookie));
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', ['expired-test-token', me.id, Date.now() - 1]);
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', ['active-test-token', me.id, Date.now() + 60_000]);
  await deleteExpiredSessions(db);
  assert.equal(await db.get('SELECT token_hash FROM sessions WHERE token_hash = ?', ['expired-test-token']), undefined);
  assert.ok(await db.get('SELECT token_hash FROM sessions WHERE token_hash = ?', ['active-test-token']));
});

test('classes and tasks need a login', async () => {
  assert.equal((await send('GET', '/api/classes')).status, 401);
  assert.equal((await send('GET', '/api/tasks')).status, 401);
});

test('class and task CRUD', async () => {
  const cookie = await signup();
  const c = await newClass(cookie);
  const t = await json<{ id: string }>(await send('POST', '/api/tasks', taskFor(c.id), cookie));
  const patched = await json<Record<string, unknown>>(await send('PATCH', `/api/tasks/${t.id}`, { status: 'Complete', grade: 85 }, cookie));
  assert.deepEqual([patched.status, patched.grade, patched.name], ['Complete', 85, 'Tutorial 1']);
  assert.equal((await send('POST', '/api/tasks', { ...taskFor(c.id), type: 'Quiz' }, cookie)).status, 400);
  assert.equal((await send('DELETE', `/api/classes/${c.id}`, undefined, cookie)).status, 204);
  assert.equal((await json<unknown[]>(await send('GET', '/api/tasks', undefined, cookie))).length, 0);
});

test('users cannot see or change each other\'s data', async () => {
  const [alice, bob] = [await signup(), await signup()];
  const c = await newClass(alice);
  const t = await json<{ id: string }>(await send('POST', '/api/tasks', taskFor(c.id), alice));
  assert.equal((await json<unknown[]>(await send('GET', '/api/classes', undefined, bob))).length, 0);
  assert.equal((await send('PATCH', `/api/classes/${c.id}`, { name: 'Hacked' }, bob)).status, 404);
  assert.equal((await send('DELETE', `/api/tasks/${t.id}`, undefined, bob)).status, 404);
  assert.equal((await send('POST', '/api/tasks', taskFor(c.id), bob)).status, 422);
});

test('course CRUD is validated and private to its owner', async () => {
  const [alice, bob] = [await signup(), await signup()];
  const body = { semesterLabel: 'Year 1 Semester 1', courseName: 'Calculus', creditHours: 3, grade: 'A−' };
  const course = await json<{ id: string; grade: string }>(await send('POST', '/api/courses', body, alice));
  assert.equal(course.grade, 'A−');
  assert.equal((await json<unknown[]>(await send('GET', '/api/courses', undefined, bob))).length, 0);
  assert.equal((await send('PATCH', `/api/courses/${course.id}`, { grade: 'D' }, alice)).status, 400);
  assert.equal((await send('PATCH', `/api/courses/${course.id}`, { grade: 'B+' }, bob)).status, 404);
  assert.equal((await send('DELETE', `/api/courses/${course.id}`, undefined, bob)).status, 404);
  assert.equal((await send('PATCH', `/api/courses/${course.id}`, { grade: 'B+' }, alice)).status, 200);
  assert.equal((await send('DELETE', `/api/courses/${course.id}`, undefined, alice)).status, 204);
});

test('profile can be updated and the account deleted', async () => {
  const address = email();
  const r = await send('POST', '/api/auth/register', { email: address, password: 'password123' });
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  const me = await json<{ courseType: string; programme: string; reminderDays: number }>(await send('PATCH', '/api/auth/me', { courseType: 'Degree', programme: 'Software Engineering', reminderDays: 3 }, cookie));
  assert.deepEqual([me.courseType, me.programme, me.reminderDays], ['Degree', 'Software Engineering', 3]);
  assert.equal((await send('PATCH', '/api/auth/me', { courseType: 'PhD' }, cookie)).status, 400);
  assert.equal((await send('PATCH', '/api/auth/me', { reminderDays: 4 }, cookie)).status, 400);
  assert.equal((await send('DELETE', '/api/auth/me', undefined, cookie)).status, 204);
  assert.equal((await send('POST', '/api/auth/login', { email: address, password: 'password123' })).status, 401);
});

const slotFor = (classId: string, over: Record<string, unknown> = {}) =>
  ({ classId, kind: 'Lecture', weekday: 1, start: '09:00', end: '11:00', room: 'B101', ...over });

test('timetable rejects clashes and bad times', async () => {
  const cookie = await signup();
  const c = await newClass(cookie);
  assert.equal((await send('POST', '/api/slots', slotFor(c.id), cookie)).status, 201);
  assert.equal((await send('POST', '/api/slots', slotFor(c.id, { start: '10:00', end: '12:00' }), cookie)).status, 409);
  assert.equal((await send('POST', '/api/slots', slotFor(c.id, { start: '11:00', end: '13:00' }), cookie)).status, 201);
  assert.equal((await send('POST', '/api/slots', slotFor(c.id, { weekday: 2, start: '12:00', end: '10:00' }), cookie)).status, 400);
  assert.equal((await send('POST', '/api/slots', slotFor('missing', { weekday: 3 }), cookie)).status, 422);
});

test('attendance can be marked, cleared and is private', async () => {
  const [cookie, other] = [await signup(), await signup()];
  const c = await newClass(cookie);
  const s = await json<{ id: string }>(await send('POST', '/api/slots', slotFor(c.id), cookie));
  const mark = (status: string | null, date = '2026-10-05', who = cookie) => send('PUT', '/api/attendance', { slotId: s.id, date, status }, who);
  const week = async () => json<unknown[]>(await send('GET', '/api/attendance?from=2026-10-05&to=2026-10-11', undefined, cookie));
  assert.equal((await mark('absent')).status, 200);
  assert.equal((await mark('present', '2026-10-06')).status, 422); // a Tuesday, but the class is on Mondays
  assert.equal((await week()).length, 1);
  await mark(null);
  assert.equal((await week()).length, 0);
  assert.equal((await mark('present', '2026-10-05', other)).status, 404);
});

test('summary counts approved leave as attended', async () => {
  const cookie = await signup();
  const c = await newClass(cookie);
  const s = await json<{ id: string }>(await send('POST', '/api/slots', slotFor(c.id), cookie)); // 2 hours a week
  type Summary = { requiredPercent: number | null; weeks: number; classes: { allowedHours: number; absentHours: number; remainingHours: number; percent: number; state: string }[] };
  const summary = async () => json<Summary>(await send('GET', '/api/attendance/summary', undefined, cookie));
  assert.equal((await summary()).requiredPercent, null); // no course type yet
  await send('PATCH', '/api/auth/me', { courseType: 'Degree' }, cookie);
  for (const [date, status] of [['2026-10-05', 'absent'], ['2026-10-12', 'absent'], ['2026-10-19', 'present'], ['2026-10-26', 'leave']]) {
    await send('PUT', '/api/attendance', { slotId: s.id, date, status }, cookie);
  }
  const [row] = (await summary()).classes;
  // 14 weeks x 2 hours = 28 hours, 20% = 5.6 -> 5 whole hours allowed. Two absences use 4 of them.
  assert.deepEqual([row.allowedHours, row.absentHours, row.remainingHours, row.state], [5, 4, 1, 'careful']);
  assert.equal(row.percent, 50); // 8 logged hours, 4 absent; present and leave both count as attended
  await send('PATCH', '/api/auth/me', { semesterWeeks: 7 }, cookie);
  assert.equal((await summary()).classes[0].allowedHours, 2); // 14 hours x 20% = 2.8 -> 2
  assert.equal((await send('PATCH', '/api/auth/me', { semesterWeeks: 10 }, cookie)).status, 400); // only long (14) or short (7)
  await send('PATCH', '/api/auth/me', { semesterStart: '2026-10-12' }, cookie); // the 5 Oct absence is before this semester
  const [later] = (await summary()).classes;
  assert.deepEqual([later.absentHours, later.percent], [2, 66.7]);
});

test('deleting a class removes its class times', async () => {
  const cookie = await signup();
  const c = await newClass(cookie);
  await send('POST', '/api/slots', slotFor(c.id), cookie);
  await send('DELETE', `/api/classes/${c.id}`, undefined, cookie);
  assert.equal((await json<unknown[]>(await send('GET', '/api/slots', undefined, cookie))).length, 0);
});
