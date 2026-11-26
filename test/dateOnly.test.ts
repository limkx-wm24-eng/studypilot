import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { addDays, addMonths, dayDifference, daysInMonth, formatDateOnly, malaysiaDay, mondayOf, monthStart, nextMalaysiaMidnight, weekday } from '../web/src/dateOnly.ts';
import { daysLeft, dueText } from '../web/src/util.ts';
import { isoToday, SEMESTERS, phase, teachingEnd } from '../web/src/calendar.ts';
import { reminderDay, reminderDaysLeft, reminderDueText } from '../web/src/reminderClock.ts';

test('Malaysia day changes exactly at 16:00 UTC and retains reminder contracts', () => {
  const before = new Date('2026-11-02T15:59:59.999Z');
  const boundary = nextMalaysiaMidnight(before);
  assert.equal(boundary, Date.parse('2026-11-02T16:00:00Z'));
  assert.equal(malaysiaDay(before), '2026-11-02');
  assert.equal(malaysiaDay(new Date(boundary)), '2026-11-03');
  assert.equal(nextMalaysiaMidnight(new Date(boundary)), boundary + 86_400_000);
  const now = new Date('2026-11-02T16:30:00Z');
  assert.equal(isoToday(now), '2026-11-03');
  assert.equal(reminderDay(now), malaysiaDay(now));
  assert.equal(reminderDaysLeft('2026-11-03', now), 0);
  assert.equal(dueText('2026-11-03', malaysiaDay(now)), reminderDueText(0));
});

for (const [before, after] of [
  ['2026-11-30', '2026-12-01'], ['2026-12-31', '2027-01-01'],
  ['2028-02-28', '2028-02-29'], ['2028-02-29', '2028-03-01'],
  ['2027-02-28', '2027-03-01'], ['2100-02-28', '2100-03-01'],
]) test(`date-only forward, backward and midnight boundaries: ${before}`, () => {
  assert.equal(addDays(before, 1), after);
  assert.equal(addDays(after, -1), before);
  assert.equal(dayDifference(after, before), 1);
  const boundary = nextMalaysiaMidnight(new Date(`${before}T23:59:00+08:00`));
  assert.equal(malaysiaDay(new Date(boundary - 1)), before);
  assert.equal(malaysiaDay(new Date(boundary)), after);
  assert.equal(formatDateOnly(after, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA'), after);
});

test('date-only differences and deadline wording preserve overdue, today and future rules', () => {
  for (const [date, count, text] of [
    ['2026-11-01', -2, '2d overdue'], ['2026-11-03', 0, 'Today'],
    ['2026-11-04', 1, 'Tomorrow'], ['2026-11-10', 7, 'in 7 days'],
  ] as const) {
    assert.equal(daysLeft(date, '2026-11-03'), count);
    assert.equal(dueText(date, '2026-11-03'), text);
  }
});

test('Monday weeks, weekdays and month navigation cross year and leap boundaries', () => {
  assert.equal(mondayOf('2027-01-03'), '2026-12-28');
  assert.equal(mondayOf('2027-01-04'), '2027-01-04');
  assert.equal(weekday('2026-11-03'), 2);
  assert.equal(weekday('2028-02-29'), 2);
  assert.equal(monthStart('2026-12-31'), '2026-12-01');
  assert.equal(addMonths('2026-12-31', 1), '2027-01-01');
  assert.equal(addMonths('2027-01-31', -1), '2026-12-01');
  assert.equal(daysInMonth('2028-02-01'), 29);
  assert.equal(daysInMonth('2027-02-01'), 28);
  assert.equal(daysInMonth('2100-02-01'), 28);
  assert.equal(addDays('0099-12-31', 1), '0100-01-01');
});

test('semester teaching weeks use calendar days and retain known and unknown phases', () => {
  const semester = SEMESTERS.find(item => item.session === '202609')!;
  assert.equal(phase(semester, '2026-11-08'), 'Teaching week 1 of 7');
  assert.equal(phase(semester, '2026-11-09'), 'Teaching week 2 of 7');
  assert.equal(teachingEnd(semester), '2026-12-20');
  assert.equal(phase(semester, '2026-12-21'), 'Exam and holiday dates unknown');
});

for (const zone of ['Asia/Kuala_Lumpur', 'UTC', 'America/Los_Angeles']) test(`helpers are host-timezone independent, including DST: ${zone}`, () => {
  const script = `import assert from 'node:assert/strict';
    import { addDays, addMonths, dayDifference, formatDateOnly, malaysiaDay, mondayOf, weekday } from './web/src/dateOnly.ts';
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, process.env.TZ);
    assert.equal(malaysiaDay(new Date('2026-11-02T16:30:00Z')), '2026-11-03');
    for (const start of ['2026-03-07', '2026-10-31']) {
      const end = addDays(start, 2); assert.equal(dayDifference(end, start), 2);
      assert.equal(addDays(end, -2), start);
    }
    assert.equal(mondayOf('2026-11-01'), '2026-10-26');
    assert.equal(weekday('2026-03-09'), 1);
    assert.equal(addMonths('2026-12-31', 1), '2027-01-01');
    assert.equal(formatDateOnly('2028-02-29', { year:'numeric',month:'2-digit',day:'2-digit' }, 'en-CA'), '2028-02-29');`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, TZ: zone }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});
