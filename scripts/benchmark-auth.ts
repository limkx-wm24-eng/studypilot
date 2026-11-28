import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

// This benchmark always uses synthetic accounts and in-memory SQLite.
process.env.DATABASE_URL = '';
process.env.TEST_DATABASE_URL = '';
process.env.DB_PATH = ':memory:';
process.env.STUDYPILOT_TEST_POSTGRES = '';
const { securityHarness } = await import('../test/support/securityHarness.ts');
const { PasswordService, HashQueue, AUTH_BUSY_MESSAGE } = await import('../src/passwords.ts');
const queue=new HashQueue();
assert.ok(!process.argv.includes('--future-writer-fixture'),'Historical fixture benchmarks require the immutable P1-A source');
const h = await securityHarness(true, false, new PasswordService(queue));
const summarize = (values: number[]) => {
  const sorted=[...values].sort((a,b)=>a-b);
  return { samples:values.length,medianMs:sorted[Math.ceil(values.length*.5)-1],p95Ms:sorted[Math.ceil(values.length*.95)-1],maxMs:Math.max(...values) };
};
const fixture=async(N:number,p:number,legacy=false)=>{
  const salt=randomBytes(16);
  const key=await new Promise<Buffer>((resolve,reject)=>scrypt('synthetic-password-123',salt,64,{N,r:8,p,maxmem:34*2**20},(error,key)=>error?reject(error):resolve(key)));
  return legacy?`${salt.toString('hex')}:${key.toString('hex')}`:`scrypt$v1$N=${N},r=8,p=${p}$${salt.toString('hex')}$${key.toString('hex')}`;
};
const initialRss=process.memoryUsage().rss;let peakRss=initialRss,peakActive=0,peakWaiting=0;
const sampler=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);peakActive=Math.max(peakActive,queue.status.active);peakWaiting=Math.max(peakWaiting,queue.status.waiting);},2);
const loop=monitorEventLoopDelay({resolution:10});loop.enable();
try {
  const a = await h.register();
  const strong=String((await h.db.get('SELECT password_hash FROM users WHERE id=?',[a.user.id]))!.password_hash);
  assert.ok(strong.startsWith('scrypt$v1$N=16384,r=8,p=5$'),'Actual registration must use the activated writer');
  const current=await fixture(16384,1),legacy=await fixture(16384,1,true),older=await fixture(8192,1);
  const modes=[['registration',undefined],['normal-login',strong],['legacy-upgrade',legacy],['older-upgrade',older],['p1-upgrade',current],['password-reset',strong],['weak-password-reset',current],['p1-failure',current],['legacy-failure',legacy],['older-failure',older],['strong-failure',strong],['malformed-failure','invalid'],['unknown-failure',undefined]] as const;
  console.log(JSON.stringify({ environment:{node:process.version,platform:process.platform,constrainedMemoryMiB:process.constrainedMemory()/2**20 || null,database:'isolated in-memory SQLite',writer:'actual activated p=5 application writer'},warmups:3,samples:30 }));
  // Interleave modes to reduce thermal/load drift between failure categories.
  const measurements=new Map(modes.map(([mode])=>[mode,[] as number[]]));
  for (let i = 0; i < 33; i++) {
    for (const [mode,record] of modes) {
      if(record) await h.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [record, a.user.id]);
      const failure = mode.endsWith('failure');
      const resetting=mode.endsWith('reset');
      let token:string|undefined;
      if(resetting){token=randomUUID();await h.db.run('INSERT INTO auth_tokens(id,user_id,purpose,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)',[token,a.user.id,'password_reset',createHash('sha256').update(token).digest('hex'),Date.now()+60000,Date.now()]);}
      const before=failure?{hash:String((await h.db.get('SELECT password_hash FROM users WHERE id=?',[a.user.id]))!.password_hash),sessions:Number((await h.db.get('SELECT COUNT(*) AS count FROM sessions'))!.count)}:undefined;
      const started = performance.now();
      const registration=mode==='registration';
      const headers={ 'X-Forwarded-For': `198.18.${modes.findIndex(m=>m[0]===mode)}.${i+1}` };
      const result = registration?await h.register():resetting?await h.send('POST','/api/auth/reset',{token,newPassword:'synthetic-password-123'},undefined,headers):await h.send('POST', '/api/auth/login', { email: mode === 'unknown-failure' ? 'missing-benchmark@example.test' : a.email, password: failure ? 'incorrect-synthetic' : 'synthetic-password-123' }, undefined,headers);
      assert.equal('status' in result?result.status:result.response.status,registration?201:failure?401:200,'Synthetic authentication benchmark status');
      const body='status' in result?await result.json():undefined;
      const elapsed=performance.now()-started;
      if(before){assert.deepEqual(body,{error:'Invalid email or password'});assert.ok(String((await h.db.get('SELECT password_hash FROM users WHERE id=?',[a.user.id]))!.password_hash)===before.hash);assert.equal(Number((await h.db.get('SELECT COUNT(*) AS count FROM sessions'))!.count),before.sessions);}
      if (i>=3) measurements.get(mode)!.push(elapsed);
    }
  }
  for(const [mode,values] of measurements) console.log(JSON.stringify({ mode, ...summarize(values) }));
  await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[strong,a.user.id]);
  const started=performance.now(),health:number[]=[];
  let probing=true;
  const probe=(async()=>{while(probing){const start=performance.now();assert.equal((await h.send('GET','/api/health')).status,200);health.push(performance.now()-start);await new Promise(done=>setTimeout(done,20));}})();
  const results=await Promise.all(Array.from({length:24},(_,i)=>h.send('POST','/api/auth/login',{email:a.email,password:'synthetic-password-123'},undefined,{'X-Forwarded-For':`198.19.0.${i+1}`})));
  probing=false;await probe;
  for(const response of results){assert.ok([200,503].includes(response.status));if(response.status===503){assert.deepEqual(await response.json(),{error:AUTH_BUSY_MESSAGE});assert.equal(response.headers.get('Retry-After'),'1');}}
  assert.equal((await h.send('POST','/api/auth/login',{email:a.email,password:'synthetic-password-123'},undefined,{'X-Forwarded-For':'198.19.1.1'})).status,200);
  assert.deepEqual(queue.status,{active:0,waiting:0});
  console.log(JSON.stringify({mode:'concurrent-strong-logins',requests:24,status200:results.filter(r=>r.status===200).length,status503:results.filter(r=>r.status===503).length,elapsedMs:performance.now()-started,peakActive,peakWaiting,recovered:true,health:summarize(health)}));
  console.log(JSON.stringify({initialRssMiB:initialRss/2**20,peakObservedRssMiB:peakRss/2**20,resourceMaxRssMiB:process.resourceUsage().maxRSS/1024,eventLoopP95Ms:loop.percentile(95)/1e6,eventLoopMaxMs:loop.max/1e6}));
} finally { clearInterval(sampler);loop.disable();await h.close(); }
