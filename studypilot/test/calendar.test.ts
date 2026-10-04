import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentSemester, phase, SEMESTERS } from '../web/src/calendar.js';

const third = SEMESTERS[2];
const second = SEMESTERS[1];
const first = SEMESTERS[0];

test('long semesters have 14 teaching weeks and the short one has 7', () => {
  assert.deepEqual(SEMESTERS.map((s) => s.weeks), [7, 14, 14]);
});

test('third semester phases follow the official dates', () => {
  assert.equal(phase(third, '2026-06-15'), 'Teaching week 1 of 14');
  assert.equal(phase(third, '2026-09-20'), 'Teaching week 14 of 14');
  assert.equal(phase(third, '2026-09-21'), 'Study leave');
  assert.equal(phase(third, '2026-09-22'), 'Study leave');
  assert.equal(phase(third, '2026-09-23'), 'Examination period');
  assert.equal(phase(third, '2026-10-08'), 'Examination period');
  assert.equal(phase(third, '2026-10-09'), 'After exams');
  assert.equal(phase(third, '2026-10-12'), 'Semester holidays');
});

test('the short and second semesters end teaching on the right day', () => {
  assert.equal(phase(first, '2025-12-28'), 'Teaching week 7 of 7');
  assert.equal(phase(first, '2025-12-29'), 'Examination period');
  assert.equal(phase(second, '2026-05-03'), 'Teaching week 14 of 14');
  assert.equal(phase(second, '2026-05-04'), 'Study leave');
});

test('finds the semester running today, if any', () => {
  assert.equal(currentSemester('2026-10-02')?.name, 'Third Semester');
  assert.equal(currentSemester('2026-01-20')?.name, 'First Semester'); // still in its holidays
  assert.equal(currentSemester('2026-11-02'), undefined); // the 2025/2026 calendar has ended
});
