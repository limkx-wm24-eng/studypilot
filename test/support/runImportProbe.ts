import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export function runImportProbe(kind: string, mib: number) {
  const started = performance.now();
  const result = spawnSync(process.execPath, ['--max-old-space-size=256', '--import', 'tsx', fileURLToPath(new URL('./importSafetyProbe.mjs', import.meta.url)), kind, String(mib)], {
    timeout: 4_000, encoding: 'utf8', maxBuffer: 64 * 1024,
  });
  if (result.status === 0) return JSON.parse(result.stdout.trim()) as { kind: string; mib: number; characters: number; parseMs: number; peakRssMiB: number; problems: string[] };
  return { kind, mib, parseMs: null, peakRssMiB: null, wallMs: performance.now() - started,
    timedOut: result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT',
    heapLimitReached: /heap out of memory|allocation failed/i.test(result.stderr ?? ''), failed: true };
}
