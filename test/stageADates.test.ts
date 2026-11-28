import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityHarness } from './support/securityHarness.ts';
import { testDialect } from './support/database.ts';
import { calendarDate } from '../src/validation.js';

const invalid = ['2026-02-30', '2026-02-29', '2100-02-29', '2026-00-10', '2026-13-10', '2026-01-00', '2026-01-32', '2026-04-31', '2026-06-31', '2026-11-31', '2026-2-03', '2026/02/03', '2026-01-01T00:00:00Z', ' 2026-01-01', '', '0000-01-01', '10000-01-01'];
// Independently specified weekdays: Monday=1, Sunday=7.
const valid = [
  ['2024-02-29', 4], ['2000-02-29', 2], ['1900-02-28', 3], ['2100-02-28', 7],
  ['2026-01-31', 6], ['2026-04-30', 4], ['2026-12-31', 4], ['2027-01-01', 5],
] as const;
const task = (classId: string, due = '2026-11-30') => ({ classId, type: 'Homework', name: 'Synthetic date task', priority: 'Medium', status: 'Not started', due, grade: null });

test(`Q2-A dates (${testDialect}): impossible dates return 400 on every applicable create/update path without writes`, async () => {
  const h = await securityHarness(false, false);
  try {
    const a = await h.register(), data = await h.seed(a.cookie, 'Invalid dates');
    const original = await h.db.get('SELECT due, grade FROM tasks WHERE id = ?', [data.task.id]);
    for (const date of invalid) {
      const results = [
        await h.send('POST', '/api/tasks', task(data.klass.id, date), a.cookie),
        await h.send('PATCH', `/api/tasks/${data.task.id}`, { due: date }, a.cookie),
        await h.send('PATCH', '/api/auth/me', { semesterStart: date }, a.cookie),
        await h.send('PUT', '/api/attendance', { slotId: data.slot.id, date, status: 'absent' }, a.cookie),
        await h.send('GET', `/api/attendance?from=${encodeURIComponent(date)}&to=2026-12-31`, undefined, a.cookie),
        await h.send('GET', `/api/attendance?from=2026-01-01&to=${encodeURIComponent(date)}`, undefined, a.cookie),
      ];
      for (const [index, result] of results.entries()) {
        // Clearing the optional semester start remains supported.
        assert.equal(result.status, date === '' && index === 2 ? 200 : 400, `${date || '(empty)'} path ${index}`);
        assert.equal(result.headers.get('Cache-Control'), 'no-store');
      }
    }
    assert.deepEqual(await h.db.get('SELECT due, grade FROM tasks WHERE id = ?', [data.task.id]), original);
    assert.equal((await h.db.all('SELECT id FROM tasks')).length, 1);
    assert.equal((await h.db.all('SELECT date FROM attendance')).length, 1);
    assert.equal((await h.db.get('SELECT semester_start FROM users WHERE id = ?', [a.user.id]))!.semester_start, '');
  } finally { await h.close(); }
});

test(`Q2-A dates (${testDialect}): leap days and valid boundaries round-trip exactly, preserving weekday/empty/null semantics`, async () => {
  const h = await securityHarness(false, false);
  try {
    const a = await h.register();
    const c = await (await h.send('POST', '/api/classes', { name: 'Synthetic calendar', color: '#0f766e' }, a.cookie)).json();
    const existing = await (await h.send('POST', '/api/tasks', task(c.id), a.cookie)).json();
    const slots: Record<number, string> = {};
    for (let weekday = 1; weekday <= 7; weekday++) {
      const response = await h.send('POST', '/api/slots', { classId: c.id, kind: 'Lecture', weekday, start: '08:00', end: '09:00', room: '' }, a.cookie);
      assert.equal(response.status, 201); slots[weekday] = (await response.json()).id;
    }
    for (const [date, weekday] of valid) {
      const created = await h.send('POST', '/api/tasks', task(c.id, date), a.cookie);
      assert.equal(created.status, 201); assert.equal((await created.json()).due, date);
      const patched = await h.send('PATCH', `/api/tasks/${existing.id}`, { due: date }, a.cookie);
      assert.equal(patched.status, 200); assert.equal((await patched.json()).due, date);
      const profile = await h.send('PATCH', '/api/auth/me', { semesterStart: date }, a.cookie);
      assert.equal(profile.status, 200); assert.equal((await profile.json()).semesterStart, date);
      const marked = await h.send('PUT', '/api/attendance', { slotId: slots[weekday], date, status: 'present' }, a.cookie);
      assert.equal(marked.status, 200); assert.equal((await marked.json()).date, date);
      const wrongWeekday = await h.send('PUT', '/api/attendance', { slotId: slots[weekday % 7 + 1], date, status: 'absent' }, a.cookie);
      assert.equal(wrongWeekday.status, 422);
      assert.equal((await h.send('PUT', '/api/attendance', { slotId: slots[weekday], date, status: null }, a.cookie)).status, 200);
      assert.deepEqual(await (await h.send('GET', `/api/attendance?from=${date}&to=${date}`, undefined, a.cookie)).json(), []);
    }
    const blank = await h.send('PATCH', '/api/auth/me', { semesterStart: '' }, a.cookie);
    assert.equal(blank.status, 200); assert.equal((await blank.json()).semesterStart, '');
    assert.equal((await h.send('PATCH', '/api/auth/me', { semesterStart: null }, a.cookie)).status, 400);
    assert.equal((await h.send('PATCH', `/api/tasks/${existing.id}`, { due: null }, a.cookie)).status, 400);
  } finally { await h.close(); }
});

test(`Q2-A dates (${testDialect}): validation never silently repairs or deletes legacy invalid records`, async () => {
  const h = await securityHarness(false, false);
  try {
    const a = await h.register(), data = await h.seed(a.cookie, 'Legacy dates');
    await h.db.run('UPDATE tasks SET due = ? WHERE id = ?', ['2026-02-30', data.task.id]);
    await h.db.run('UPDATE users SET semester_start = ? WHERE id = ?', ['2026-02-30', a.user.id]);
    await h.db.run('INSERT INTO attendance(slot_id,date,status) VALUES(?,?,?)', [data.slot.id, '2026-02-30', 'absent']);
    const updated = await h.send('PATCH', `/api/tasks/${data.task.id}`, { grade: 75 }, a.cookie);
    assert.equal(updated.status, 200); assert.equal((await updated.json()).due, '2026-02-30');
    const profile = await h.send('PATCH', '/api/auth/me', { name: 'Synthetic retained legacy date' }, a.cookie);
    assert.equal(profile.status, 200); assert.equal((await profile.json()).semesterStart, '2026-02-30');
    assert.equal((await h.db.all('SELECT date FROM attendance WHERE date = ?', ['2026-02-30'])).length, 1);
  } finally { await h.close(); }
});

test('Q2-A dates: validation is identical in UTC and Malaysia and preserves date-only strings', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Asia/Kuala_Lumpur']) {
      process.env.TZ = zone;
      for (const [date] of valid) assert.equal(calendarDate.parse(date), date);
      for (const date of invalid) assert.equal(calendarDate.safeParse(date).success, false);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
