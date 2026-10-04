import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

let server: Server;
let base = '';
before(async () => {
  await new Promise<void>((done) => { server = createApp(openDb()).listen(0, done); });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const send = (method: string, path: string, body?: unknown, cookie?: string) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
let n = 0;
const email = () => `user${++n}@example.com`;
const signup = async () => {
  const r = await send('POST', '/api/auth/register', { email: email(), password: 'password123', name: 'Test' });
  assert.equal(r.status, 201);
  return r.headers.getSetCookie()[0].split(';')[0];
};
const json = async <T>(r: Response) => (await r.json()) as T;
const newClass = async (cookie: string) => json<{ id: string }>(await send('POST', '/api/classes', { name: 'Databases', color: '#0f766e' }, cookie));
const taskFor = (classId: string) => ({ classId, type: 'Homework', name: 'Tutorial 1', priority: 'Medium', status: 'Not started', due: '2026-10-20', grade: null });

test('register, read profile, log out', async () => {
  const cookie = await signup();
  const me = await json<{ name: string }>(await send('GET', '/api/auth/me', undefined, cookie));
  assert.equal(me.name, 'Test');
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

test('profile can be updated and the account deleted', async () => {
  const address = email();
  const r = await send('POST', '/api/auth/register', { email: address, password: 'password123' });
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  const me = await json<{ courseType: string; programme: string }>(await send('PATCH', '/api/auth/me', { courseType: 'Degree', programme: 'Software Engineering' }, cookie));
  assert.deepEqual([me.courseType, me.programme], ['Degree', 'Software Engineering']);
  assert.equal((await send('PATCH', '/api/auth/me', { courseType: 'PhD' }, cookie)).status, 400);
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
