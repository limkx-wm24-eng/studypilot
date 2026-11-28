import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimetableText, MAX_TIMETABLE_TEXT_LENGTH } from '../web/src/import/timetableImport.ts';

const course = (index: number) => `BDEM${1000 + index} SYNTHETIC COURSE Course Without Class `;
const session = (index: number) => {
  const hour = Math.floor(index / 60), minute = index % 60;
  return `Mon , ${hour % 12 || 12}:${String(minute).padStart(2, '0')} AM ~ 11:59 PM ( Lecture: 1.0 hours ) SYN 1, Block B `;
};
const sessions = (count: number) => 'BDEM1001 SYNTHETIC COURSE Course Plan ' + Array.from({ length: count }, (_, i) => session(i)).join('');
const assertLimit = (result: ReturnType<typeof parseTimetableText>, message: RegExp) => {
  assert.deepEqual(result.courses, []); assert.deepEqual(result.slots, []);
  assert.equal(result.problems.length, 1); assert.match(result.problems[0], message);
};

test('import limits: raw text is checked before whitespace normalization, with an inclusive default cap', () => {
  const exact = course(1).padEnd(MAX_TIMETABLE_TEXT_LENGTH, ' ');
  assert.equal(parseTimetableText(exact).courses.length, 1);
  assertLimit(parseTimetableText(exact + ' '), /200,000-character limit/);
  assertLimit(parseTimetableText(' '.repeat(MAX_TIMETABLE_TEXT_LENGTH + 1)), /character limit/);
});

test('import limits: defaults allow 60 courses and reject 61 without partial data', () => {
  assert.equal(parseTimetableText(Array.from({ length: 60 }, (_, i) => course(i)).join('')).courses.length, 60);
  assertLimit(parseTimetableText(Array.from({ length: 61 }, (_, i) => course(i)).join('')), /60 courses/);
});

test('import limits: defaults allow 400 sessions; 401 returns before overlap warnings', () => {
  const exact = parseTimetableText(sessions(400));
  assert.equal(exact.slots.length, 400);
  assert.ok(exact.slots[0].warnings.some((warning) => warning.startsWith('Overlaps with ')));
  assertLimit(parseTimetableText(sessions(401)), /400 sessions/);
});

test('import limits: optional limits and existing maxNameLength are additive; duplicates do not consume session limits', () => {
  const text = sessions(1);
  assert.equal(parseTimetableText(text, { maxTextLength: text.length, maxCourses: 1, maxSessions: 1, maxNameLength: 20 }).slots.length, 1);
  assert.equal(parseTimetableText(text, { maxNameLength: 20 }).courses[0].className, 'BDEM1001 Synthetic…');
  assertLimit(parseTimetableText(text, { maxTextLength: text.length - 1 }), /character limit/);
  assertLimit(parseTimetableText(course(0) + course(1), { maxCourses: 1 }), /1 courses/);
  assertLimit(parseTimetableText(sessions(2), { maxSessions: 1 }), /1 sessions/);
  assert.equal(parseTimetableText(text + session(0), { maxSessions: 1 }).slots.length, 1);
});
