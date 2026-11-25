import { scrypt, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const candidates = process.argv.includes('--shortlist') ? [[16384, 1], [16384, 2], [16384, 3], [16384, 4]]
  : [[16384, 1], [16384, 2], [16384, 3], [16384, 4], [16384, 5], [16384, 6], [16384, 7], [16384, 8], [32768, 2], [32768, 3], [32768, 4]];
for (const [N, p] of candidates) {
  const samples: number[] = [];
  for (let i = 0; i < 4; i++) {
    const salt = randomBytes(16), start = performance.now();
    await new Promise<void>((resolve, reject) => scrypt('synthetic-benchmark-input', salt, 64, { N, r: 8, p, maxmem: 34 * 1024 * 1024 }, (error) => error ? reject(error) : resolve()));
    if (i) samples.push(performance.now() - start);
  }
  console.log(JSON.stringify({ N, r: 8, p, maxmemMiB: 34, estimatedWorkingMiB: (128 * N * 8 + 128 * 8 * p + 256 * 8) / 1024 / 1024, medianMs: median(samples), maxMs: Math.max(...samples) }));
}
