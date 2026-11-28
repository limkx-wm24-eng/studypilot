import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, scrypt } from 'node:crypto';
import { securityHarness } from './support/securityHarness.ts';
import { strongPasswordFixture, weakPasswordFixture } from './support/strongPassword.ts';
import { legacyHash } from './support/legacyPassword.ts';
import { HashQueue, PasswordService, AUTH_BUSY_MESSAGE, type Derive } from '../src/passwords.js';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
const deadline=async<T>(promise:Promise<T>)=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic concurrency deadline')),15000);})]);}
  finally{clearTimeout(timer);}
};
type Harness=Awaited<ReturnType<typeof securityHarness>>;
const record=async(h:Harness,id:string)=>String((await h.db.get('SELECT password_hash FROM users WHERE id=?',[id]))!.password_hash);
const sessions=async(h:Harness,id:string)=>Number((await h.db.get('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?',[id]))!.count);
const resetToken=async(h:Harness,id:string)=>{
  const token=randomUUID();await h.db.run('INSERT INTO auth_tokens(id,user_id,purpose,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)',[token,id,'password_reset',createHash('sha256').update(token).digest('hex'),Date.now()+60000,Date.now()]);return token;
};
const login=(h:Harness,email:string,password='synthetic-password-123')=>h.send('POST','/api/auth/login',{email,password});
const native:Derive=(password,salt,parameters)=>new Promise((resolve,reject)=>scrypt(password,salt,64,{...parameters,maxmem:34*1024*1024},(error,key)=>error?reject(error):resolve(key)));

test('P1-B: every supported weaker profile upgrades only after successful login; strong login never rehashes',async()=>{
  class CountWrites extends PasswordService {writes=0;override hash(password:string){this.writes++;return super.hash(password);}}
  const service=new CountWrites(),h=await securityHarness(true,false,service);
  try{
    const a=await h.register();assert.ok((await record(h,a.user.id)).startsWith('scrypt$v1$N=16384,r=8,p=5$'));
    for(const original of [legacyHash('synthetic-password-123'),await weakPasswordFixture(8192),await weakPasswordFixture(),await strongPasswordFixture()]){
      await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[original,a.user.id]);
      const before=await sessions(h,a.user.id);const failed=await login(h,a.email,'incorrect-synthetic');
      assert.equal(failed.status,401);assert.equal(failed.headers.getSetCookie().length,0);
      assert.ok(await record(h,a.user.id)===original);assert.equal(await sessions(h,a.user.id),before);
      const writes=service.writes;assert.equal((await login(h,a.email)).status,200);
      const next=await record(h,a.user.id);assert.ok(next.startsWith('scrypt$v1$N=16384,r=8,p=5$'));
      const strong=original.startsWith('scrypt$v1$N=16384,r=8,p=5$');
      assert.equal(service.writes-writes,strong?0:1);assert.equal(next===original,strong);
    }
  }finally{await h.close();}
});

test('P1-B: resets of all supported profiles use fresh p=5 salts, revoke sessions and consume tokens once',async()=>{
  const h=await securityHarness(false,false);
  try{
    for(const original of [legacyHash('synthetic-password-123'),await weakPasswordFixture(8192),await weakPasswordFixture(),await strongPasswordFixture()]){
      const a=await h.register();await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[original,a.user.id]);
      const token=await resetToken(h,a.user.id);
      assert.equal((await h.send('POST','/api/auth/reset',{token,newPassword:'synthetic-password-123'})).status,200);
      const next=await record(h,a.user.id);assert.ok(next.startsWith('scrypt$v1$N=16384,r=8,p=5$'));
      const oldSalt=original.startsWith('scrypt$')?original.split('$')[3]:original.split(':')[0];
      assert.ok(next.split('$')[3]!==oldSalt,'Reset must generate a fresh salt');
      assert.equal(await sessions(h,a.user.id),0);assert.equal((await login(h,a.email)).status,200);
      assert.equal((await h.send('POST','/api/auth/reset',{token,newPassword:'synthetic-password-123'})).status,400);
    }
  }finally{await h.close();}
});

test('P1-B: two successful weaker-password verifications commit one upgrade; the stale login fails safely',async()=>{
  const firstEntered=deferred(),entered=deferred(),gates=[deferred(),deferred()];
  class Gated extends PasswordService {
    armed=false;arrivals=0;
    override async hash(password:string){if(this.armed){const index=this.arrivals++;if(index===0)firstEntered.resolve();if(this.arrivals===2)entered.resolve();await gates[index].promise;}return super.hash(password);}
  }
  const service=new Gated(),h=await securityHarness(false,false,service);const pending:Promise<Response>[]=[];
  try{
    const a=await h.register();await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[await weakPasswordFixture(),a.user.id]);
    service.armed=true;pending.push(login(h,a.email));
    // The first request reaches its write gate before the second starts.
    await deadline(firstEntered.promise);
    pending.push(login(h,a.email));await deadline(entered.promise);
    gates[0].resolve();assert.equal((await pending[0]).status,200);const winner=await record(h,a.user.id);
    gates[1].resolve();const stale=await pending[1];assert.equal(stale.status,401);assert.equal(stale.headers.getSetCookie().length,0);
    assert.ok(await record(h,a.user.id)===winner);assert.equal(await sessions(h,a.user.id),2);
    service.armed=false;assert.equal((await login(h,a.email)).status,200);
  }finally{gates.forEach(g=>g.resolve());await Promise.allSettled(pending);await h.close();}
});

test('P1-B: two different reset tokens cannot overwrite a concurrent reset; the unused token can be retried',async()=>{
  const firstEntered=deferred(),entered=deferred(),gates=[deferred(),deferred()];
  class Gated extends PasswordService {
    armed=true;arrivals=0;
    override async hashForReset(password:string,original:string){if(this.armed){const index=this.arrivals++;if(index===0)firstEntered.resolve();if(this.arrivals===2)entered.resolve();await gates[index].promise;}return super.hashForReset(password,original);}
  }
  const service=new Gated(),h=await securityHarness(false,false,service);const pending:Promise<Response>[]=[];
  try{
    const a=await h.register(),first=await resetToken(h,a.user.id),second=await resetToken(h,a.user.id);
    pending.push(h.send('POST','/api/auth/reset',{token:first,newPassword:'first-synthetic-password'}));
    await deadline(firstEntered.promise);
    pending.push(h.send('POST','/api/auth/reset',{token:second,newPassword:'second-synthetic-password'}));await deadline(entered.promise);
    gates[0].resolve();assert.equal((await pending[0]).status,200);const winner=await record(h,a.user.id);
    gates[1].resolve();assert.equal((await pending[1]).status,400);assert.ok(await record(h,a.user.id)===winner);
    assert.equal((await h.db.get('SELECT used_at FROM auth_tokens WHERE id=?',[second]))!.used_at,null);
    assert.equal(await sessions(h,a.user.id),0);service.armed=false;
    assert.equal((await h.send('POST','/api/auth/reset',{token:second,newPassword:'second-synthetic-password'})).status,200);
    assert.equal((await login(h,a.email,'second-synthetic-password')).status,200);
  }finally{gates.forEach(g=>g.resolve());await Promise.allSettled(pending);await h.close();}
});

test('P1-B: queue saturation between verification and upgrade returns generic 503, then retries safely',async()=>{
  const queue=new HashQueue(),release=deferred();let blockers:Promise<void>[]=[];
  class Saturated extends PasswordService {
    armed=false;
    override hash(password:string){if(this.armed){this.armed=false;blockers=Array.from({length:10},()=>queue.run(()=>release.promise));}return super.hash(password);}
  }
  const service=new Saturated(queue),h=await securityHarness(false,false,service);
  try{
    const a=await h.register(),original=await weakPasswordFixture();await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[original,a.user.id]);
    service.armed=true;const response=await login(h,a.email);
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:AUTH_BUSY_MESSAGE});assert.equal(response.headers.get('Retry-After'),'1');
    assert.ok(await record(h,a.user.id)===original);assert.equal(await sessions(h,a.user.id),1);
    release.resolve();await Promise.all(blockers);assert.equal((await login(h,a.email)).status,200);
    assert.deepEqual(queue.status,{active:0,waiting:0});
  }finally{release.resolve();await Promise.all(blockers);await h.close();}
});

test('P1-B: failed upgrade derivation releases its permit without weak fallback or mutation; retry works',async()=>{
  const queue=new HashQueue();let fail=false;
  const service=new PasswordService(queue,async(password,salt,parameters)=>{
    if(fail&&parameters.p===5){fail=false;throw new Error('Synthetic upgrade derivation failure');}
    return native(password,salt,parameters);
  });
  const h=await securityHarness(false,false,service);
  try{
    const a=await h.register(),original=await weakPasswordFixture();await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[original,a.user.id]);
    fail=true;const response=await login(h,a.email);assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'Server error'});
    assert.ok(await record(h,a.user.id)===original);assert.equal(await sessions(h,a.user.id),1);
    assert.deepEqual(queue.status,{active:0,waiting:0});assert.equal((await login(h,a.email)).status,200);
    assert.ok((await record(h,a.user.id)).startsWith('scrypt$v1$N=16384,r=8,p=5$'));
  }finally{await h.close();}
});

test('P1-B: session insertion failure rolls back the attempted upgrade and a later retry succeeds',async()=>{
  const h=await securityHarness(false,false),transaction=h.db.transaction.bind(h.db);
  let insertionReached=false;
  try{
    const a=await h.register(),original=await weakPasswordFixture();await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[original,a.user.id]);
    h.db.transaction=async op=>transaction(async db=>op({...db,run:async(sql,values)=>{
      if(sql.startsWith('INSERT INTO sessions')){insertionReached=true;throw new Error('Synthetic session insertion failure');}
      return db.run(sql,values);
    }}));
    const response=await login(h,a.email);assert.equal(response.status,500);assert.equal(response.headers.getSetCookie().length,0);
    assert.equal(insertionReached,true);
    assert.ok(await record(h,a.user.id)===original);assert.equal(await sessions(h,a.user.id),1);
    h.db.transaction=transaction;assert.equal((await login(h,a.email)).status,200);
    assert.ok((await record(h,a.user.id)).startsWith('scrypt$v1$N=16384,r=8,p=5$'));
  }finally{h.db.transaction=transaction;await h.close();}
});
