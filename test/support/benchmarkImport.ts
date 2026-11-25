import { runImportProbe } from './runImportProbe.ts';
import { MAX_TIMETABLE_TEXT_LENGTH } from '../../web/src/import/timetableImport.ts';

// Each case is isolated, time-bounded and heap-bounded so a bad parser cannot hang QA.
function probe(kind: string, mib: number) {
  const result = runImportProbe(kind, mib);
  console.log(JSON.stringify(result));
  if (result.parseMs === null || result.parseMs > 1_000) process.exitCode = 1;
}
for (const kind of ['capitals', 'fragments', 'brackets', 'dense']) for (const mib of [1, 5, 20]) probe(kind, mib);
// Exercise accepted text at the cap too, including the maximum overlapping sessions.
for (const kind of ['capitals', 'fragments', 'brackets', 'dense', 'overlaps']) probe(kind, MAX_TIMETABLE_TEXT_LENGTH / 1024 / 1024);
