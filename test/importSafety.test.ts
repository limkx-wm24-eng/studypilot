import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runImportProbe } from './support/runImportProbe.ts';

test('QA import budget: a dense 1 MiB paste is rejected within one second without exhausting a 256 MiB heap', (t) => {
  const result = runImportProbe('dense', 1);
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.parseMs !== null && result.parseMs <= 1_000, 'Parser exceeded time or memory budget');
  assert.ok('problems' in result && result.problems.some((problem: string) => problem.includes('character limit')));
});

test('QA paste bound: the paste entry point has an explicit maximum input length', () => {
  const source = readFileSync(new URL('../web/src/import/ImportTimetable.tsx', import.meta.url), 'utf8');
  assert.ok(/<textarea[^>]*maxLength=/.test(source), 'Paste textarea has no explicit maximum input length');
});
