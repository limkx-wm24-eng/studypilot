import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOverlaps, parseTimetableText, to24h } from '../web/src/import/timetableImport.ts';

const heading = 'BDEM1001 SYNTHETIC COURSE Course Plan ';
const session = (start: string, end = '2:00 AM', kind = 'Lecture', room = 'SYN 1') => `Mon , ${start} ~ ${end} ( ${kind}: 1.0 hours ) ${room}, Block B `;
const invalid = ['0:00 AM', '00:00 AM', '13:00 AM', '13:00 PM', '99:00 AM', '1:60 AM', '1:99 PM', '1:00 XM', '1:00', '1:00 A.M.', '1:00 AMX', '100:00 AM', '1:0 AM', '-1:00 AM', '1:00 AM PM', ''];
for (const raw of invalid) test(`Q2-C parser: invalid start ${JSON.stringify(raw)} is visible, never normalized or treated as an overlap`, () => {
  const result = parseTimetableText(heading + session(raw) + session('1:00 AM'));
  assert.equal(result.slots.length, 2);
  assert.equal(result.slots[0].start, '');
  assert.ok(result.slots[0].errors.some((error) => error.includes('Invalid source start time')));
  assert.ok(result.slots[0].sourceStart);
  assert.deepEqual(findOverlaps(result.slots), []);
  assert.equal(result.slots.some((slot) => slot.warnings.some((warning) => warning.includes('Metadata conflict'))), false);
  assert.equal(result.slots[1].start, '01:00');
});
for (const [hm, marker, expected] of [
  ['12:00', 'AM', '00:00'], ['12:30', 'AM', '00:30'], ['12:00', 'PM', '12:00'], ['12:30', 'PM', '12:30'],
  ['1:00', 'AM', '01:00'], ['1:00', 'PM', '13:00'], ['11:59', 'PM', '23:59'], ['01:00', 'am', '01:00'], ['09:05', 'pM', '21:05'],
]) test(`Q2-C conversion: ${hm} ${marker} stays ${expected}`, () => assert.equal(to24h(hm, marker), expected));

test('Q2-C conversion: helper rejects invalid hour, minute, format and indicator values before modulo arithmetic', () => {
  for (const [hm, marker] of [['0:00', 'AM'], ['00:00', 'AM'], ['13:00', 'AM'], ['13:00', 'PM'], ['99:00', 'AM'], ['1:60', 'AM'], ['1:99', 'PM'], ['1:00', ''], ['1:00', 'XM'], ['1:00', 'A.M.'], ['1:00', ' AM'], ['1:0', 'AM'], ['100:00', 'AM']]) assert.throws(() => to24h(hm, marker), RangeError);
});
test('Q2-C parser: invalid end and both-invalid times remain distinct editable rows', () => {
  const rows = parseTimetableText(heading + session('1:00 AM', '13:00 PM') + session('13:00 AM', '14:00 AM') + session('99:00 AM', '99:00 AM') + session('99:00 AM', '99:00 AM')).slots;
  assert.equal(rows.length, 4);
  assert.equal(rows[0].start, '01:00'); assert.equal(rows[0].end, '');
  for (const row of rows.slice(1)) { assert.equal(row.start, ''); assert.equal(row.end, ''); assert.equal(row.errors.length, 2); }
  assert.deepEqual(findOverlaps(rows), []);
});
test('Q2-C parser: source without a range separator or AM/PM is explicit and does not hide valid neighbors', () => {
  const result = parseTimetableText(heading + 'Mon , 8:00 10:00 ( Lecture: 2.0 hours ) SYN 1, Block B ' + session('1:00 AM'));
  assert.equal(result.slots.length, 2); assert.equal(result.slots[0].errors.length, 2); assert.equal(result.slots[1].errors.length, 0);
});
test('Q2-C parser: headings without Course Plan still retain malformed or missing source clocks', () => {
  for (const start of ['13:00 AM', '100:00 AM', 'not a clock', '']) {
    const result = parseTimetableText('BDEM1001 SYNTHETIC COURSE ' + session(start));
    assert.equal(result.courses.length, 1); assert.equal(result.slots.length, 1);
    assert.equal(result.slots[0].start, ''); assert.ok(result.slots[0].errors.some((error) => error.includes('Invalid source start time')));
  }
});
test('Q2-C parser: oversized unreadable rows have actionable file problems and remain resource bounded', () => {
  const malformed = `Mon , ${'1'.repeat(170)} AM ~ 2:00 AM ( Lecture: 1.0 hours ) SYN 1, Block B `;
  const result = parseTimetableText(heading + malformed + session('1:00 AM'));
  assert.equal(result.slots.length, 1); assert.match(result.problems[0], /Could not read.*Choose again/);
  const capped = parseTimetableText(heading + malformed.repeat(3), { maxSessions: 2 });
  assert.equal(capped.slots.length, 0); assert.equal(capped.courses.length, 0); assert.ok(capped.problems.some((problem) => /limit of 2 sessions/.test(problem)));
  const invalidCap = parseTimetableText(heading + session('13:00 AM').repeat(3), { maxSessions: 2 });
  assert.equal(invalidCap.slots.length, 0); assert.match(invalidCap.problems[0], /limit of 2 sessions/);
});
test('Q2-C parser: valid lower-case/padded times, adjacency, overlaps, duplicates and metadata remain unchanged', () => {
  const first = session('01:00 am', '02:00 Am');
  const adjacent = session('02:00 am', '03:00 am');
  const good = parseTimetableText(heading + first + first + adjacent);
  assert.equal(good.slots.length, 2); assert.deepEqual(findOverlaps(good.slots), []);
  assert.equal(good.slots.some((slot) => slot.errors.length), false);
  const overlap = parseTimetableText(heading + first + session('01:30 AM', '03:00 AM'));
  assert.deepEqual(findOverlaps(overlap.slots), [[0, 1]]);
  const metadata = parseTimetableText(heading + first + session('01:00 AM', '02:00 AM', 'Practical', 'SYN 2'));
  assert.equal(metadata.slots.length, 2); assert.ok(metadata.slots.every((slot) => slot.warnings.some((warning) => warning.includes('Metadata conflict'))));
  const backwards = parseTimetableText(heading + session('2:00 PM', '1:00 PM')).slots[0];
  assert.deepEqual(backwards.errors, ['The end time must be after the start time.']);
  assert.deepEqual(findOverlaps([backwards]), []);
});
