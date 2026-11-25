import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimetableText } from '../web/src/import/timetableImport.ts';

const session = (kind = 'Lecture', room = 'SYN 1') => `Mon , 8:00 AM ~ 10:00 AM ( ${kind}: 2.0 hours ) ${room}, Block B `;
const heading = 'BDEM1001 SYNTHETIC COURSE Course Plan ';

test('Q2-A parser: exact metadata duplicates remain deduplicated after existing normalization', () => {
  const result = parseTimetableText(heading + session() + session('Lecture', 'SYN   1'));
  assert.equal(result.slots.length, 1); assert.equal(result.courses[0].sessions, 1);
  assert.equal(result.slots[0].warnings.some((warning) => warning.includes('Metadata conflict')), false);
});

for (const [kind, room] of [['Lecture', 'SYN 2'], ['Practical', 'SYN 1'], ['Practical', 'SYN 2']]) {
  test(`Q2-A parser: conflicting ${kind}/${room} remains available for review`, () => {
    const result = parseTimetableText(heading + session() + session(kind, room));
    assert.equal(result.slots.length, 2); assert.equal(result.courses[0].sessions, 2);
    assert.equal(result.slots[1].kind, kind); assert.equal(result.slots[1].room, room);
    for (const row of result.slots) {
      assert.ok(row.warnings.some((warning) => warning.includes('Metadata conflict') && warning.includes('SYN 1')));
      assert.ok(row.warnings.some((warning) => warning.startsWith('Overlaps with ')));
    }
  });
}

test('Q2-A parser: metadata changes do not change identity across unrelated times or defeat limits', () => {
  const differentTime = session('Practical', 'SYN 2').replace('8:00 AM ~ 10:00 AM', '10:00 AM ~ 12:00 PM');
  const result = parseTimetableText(heading + session() + differentTime);
  assert.equal(result.slots.length, 2);
  assert.equal(result.slots.some((row) => row.warnings.some((warning) => warning.includes('Metadata conflict'))), false);
  const capped = parseTimetableText(heading + session() + session('Practical', 'SYN 2'), { maxSessions: 1 });
  assert.equal(capped.slots.length, 0); assert.match(capped.problems[0], /1 sessions/);
});
