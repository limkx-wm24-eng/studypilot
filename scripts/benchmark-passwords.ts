import { scrypt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// Independent children keep each profile's high-water RSS separate. No secrets,
// hashes or random input are printed. All work uses a fixed synthetic fixture.
const profiles = [
  { name: 'baseline', N: 16384, r: 8, p: 1, maxmemMiB: 34 },
  { name: 'A', N: 16384, r: 8, p: 5, maxmemMiB: 34 },
  { name: 'B', N: 32768, r: 8, p: 3, maxmemMiB: 34 },
  { name: 'C', N: 65536, r: 8, p: 2, maxmemMiB: 66 },
  { name: 'D', N: 131072, r: 8, p: 1, maxmemMiB: 130 },
];
const percentile = (values: number[], p: number) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1];
const summary = (values: number[]) => ({ samples: values.length, medianMs: percentile(values,.5), p95Ms: percentile(values,.95), maxMs: Math.max(...values) });
const selected = process.argv.find(a => a.startsWith('--profile='))?.split('=')[1];
if (!selected) {
  console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, availableCPUs: availableParallelism(), totalMemoryMiB: totalmem()/2**20, constrainedMemoryMiB: process.constrainedMemory()/2**20 || null }, warmups: 3, samples: 30, concurrent: 'two active, five batches' }));
  for (const profile of profiles) {
    const result = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), `--profile=${profile.name}`], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '' } });
    if (result.status !== 0) throw new Error(`Synthetic benchmark profile ${profile.name} failed`);
    process.stdout.write(result.stdout);
  }
} else {
  const profile = profiles.find(p => p.name === selected);
  if (!profile) throw new Error('Select a bounded benchmark profile');
  const derive = () => new Promise<void>((resolve,reject) => scrypt('synthetic-benchmark-input', Buffer.alloc(16, 7), 64, { N: profile.N, r: profile.r, p: profile.p, maxmem: profile.maxmemMiB*2**20 }, error => error ? reject(error) : resolve()));
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss,process.memoryUsage().rss); }, 2);
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  try {
    for (let i=0;i<3;i++) await derive();
    const samples: number[] = [];
    for(let i=0;i<30;i++){const start=performance.now(); await derive();samples.push(performance.now()-start);}
    const concurrent: number[] = []; const started=performance.now();
    for(let batch=0;batch<5;batch++) await Promise.all([0,1].map(async()=>{const start=performance.now();await derive();concurrent.push(performance.now()-start);}));
    const cpu = process.cpuUsage();
    console.log(JSON.stringify({ ...profile, estimatedWorkingMiB: (128*profile.N*profile.r+128*profile.r*profile.p+256*profile.r)/2**20, ...summary(samples), concurrent: { ...summary(concurrent), elapsedMs: performance.now()-started }, initialRssMiB: initialRss/2**20, peakObservedRssMiB: peakRss/2**20, resourceMaxRssMiB: process.resourceUsage().maxRSS/1024, cpuMs: (cpu.user+cpu.system)/1000, eventLoopP95Ms: loop.percentile(95)/1e6, eventLoopMaxMs: loop.max/1e6 }));
  } finally { clearInterval(sampler); loop.disable(); }
}
