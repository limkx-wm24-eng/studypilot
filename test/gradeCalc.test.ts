import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCgpa, calculateGpa, neededAverage } from '../web/src/gradeCalc.ts';

test('semester GPA uses TAR UMT points and reports four decimals', () => {
  const result = calculateGpa([{ semesterLabel: 'Sem 1', creditHours: 3, grade: 'A' }, { semesterLabel: 'Sem 1', creditHours: 2, grade: 'B+' }, { semesterLabel: 'Sem 1', creditHours: 1, grade: 'C' }]);
  assert.deepEqual(result, { points: 21, credits: 6, gpa: 3.5 });
});
test('cumulative CGPA weights semesters by credit hours', () => {
  const result = calculateCgpa([{ semesterLabel: 'Sem 1', creditHours: 3, grade: 'A−' }, { semesterLabel: 'Sem 2', creditHours: 1, grade: 'C+' }]);
  assert.equal(result.gpa, 3.4375);
});
test('target calculator reports the needed average and unreachable targets', () => {
  const current = calculateCgpa([{ semesterLabel: 'Sem 1', creditHours: 20, grade: 'B' }]);
  assert.deepEqual(neededAverage(current, 3.25, 20), { needed: 3.5, reachable: true });
  assert.deepEqual(neededAverage(current, 3.8, 10), { needed: 5.4, reachable: false });
});
