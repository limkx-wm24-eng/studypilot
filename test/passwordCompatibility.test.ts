import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { securityHarness } from './support/securityHarness.ts';
import { strongPasswordFixture } from './support/strongPassword.ts';
import { PasswordService, HashQueue, AUTH_BUSY_MESSAGE } from '../src/passwords.js';

const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => {resolve=done;});return {promise,resolve}; };
const issueReset = async (h: Awaited<ReturnType<typeof securityHarness>>, userId: string) => {
  const token=randomUUID();
  await h.db.run('INSERT INTO auth_tokens(id,user_id,purpose,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)', [token,userId,'password_reset',createHash('sha256').update(token).digest('hex'),Date.now()+60000,Date.now()]);
  return token;
};
const stored = async (h: Awaited<ReturnType<typeof securityHarness>>, id: string) => String((await h.db.get('SELECT password_hash FROM users WHERE id=?',[id]))!.password_hash);

test('P1 auth: strong login preserves records, sessions, ownership, study data, ledger and guards', async () => {
  const h=await securityHarness(true,false);
  try {
    const a=await h.register(), b=await h.register();
    const data=await h.seed(a.cookie,'P1 recovery');
    const strong=await strongPasswordFixture();
    await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[strong,a.user.id]);
    const ledger=await h.db.all('SELECT id FROM schema_migrations ORDER BY id');
    const before=await h.db.all('SELECT token_hash FROM sessions WHERE user_id=?',[a.user.id]);
    const failed=await h.send('POST','/api/auth/login',{email:a.email,password:'incorrect-synthetic'});
    assert.equal(failed.status,401); assert.equal(failed.headers.getSetCookie().length,0);
    assert.deepEqual(await h.db.all('SELECT token_hash FROM sessions WHERE user_id=?',[a.user.id]),before);
    const login=await h.send('POST','/api/auth/login',{email:a.email,password:'synthetic-password-123'});
    assert.equal(login.status,200); assert.ok(await stored(h,a.user.id)===strong);
    const cookie=login.headers.getSetCookie()[0].split(';')[0];
    assert.equal((await h.send('GET','/api/auth/me',undefined,a.cookie)).status,200);
    assert.equal((await h.send('PATCH',`/api/tasks/${data.task.id}`,{grade:91},cookie)).status,200);
    assert.equal((await h.send('PATCH',`/api/tasks/${data.task.id}`,{grade:99},b.cookie)).status,404);
    assert.equal((await h.send('GET','/api/attendance/summary',undefined,cookie)).status,200);
    await assert.rejects(h.db.run('UPDATE classes SET name=? WHERE id=?',['x'.repeat(61),data.klass.id]));
    await assert.rejects(h.db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)',[randomUUID(),randomUUID(),'Synthetic orphan','#112233']));
    assert.deepEqual(await h.db.all('SELECT id FROM schema_migrations ORDER BY id'),ledger);
    assert.ok((await stored(h,b.user.id)).startsWith('scrypt$v1$N=16384,r=8,p=1$'));
  } finally {await h.close();}
});

test('P1 auth: reset retains stronger profile, ordinary writer stays current and sessions are revoked', async () => {
  const h=await securityHarness(false,false);
  try {
    for(const strongAccount of [false,true]) {
      const a=await h.register();
      if(strongAccount) await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[await strongPasswordFixture(),a.user.id]);
      const token=await issueReset(h,a.user.id);
      assert.equal((await h.send('POST','/api/auth/reset',{token,newPassword:'new-synthetic-password'})).status,200);
      assert.ok((await stored(h,a.user.id)).startsWith(`scrypt$v1$N=16384,r=8,p=${strongAccount?5:1}$`));
      assert.equal((await h.send('GET','/api/auth/me',undefined,a.cookie)).status,401);
      assert.equal((await h.send('POST','/api/auth/login',{email:a.email,password:'new-synthetic-password'})).status,200);
      assert.equal((await h.send('POST','/api/auth/reset',{token,newPassword:'another-synthetic-password'})).status,400);
    }
  } finally {await h.close();}
});

test('P1 auth: malformed and unrecognized records create no sessions and return generic failures', async () => {
  const h=await securityHarness(true,false);
  try {
    const a=await h.register();
    const count=(await h.db.all('SELECT token_hash FROM sessions')).length;
    for(const value of ['malformed',`scrypt$v1$N=1073741824,r=8,p=999$${'00'.repeat(16)}$${'00'.repeat(64)}`]) {
      await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[value,a.user.id]);
      const result=await h.send('POST','/api/auth/login',{email:a.email,password:'synthetic-password-123'});
      assert.equal(result.status,401);assert.deepEqual(await result.json(),{error:'Invalid email or password'});
      assert.equal(result.headers.getSetCookie().length,0);
    }
    assert.equal((await h.db.all('SELECT token_hash FROM sessions')).length,count);
  } finally {await h.close();}
});

test('P1 auth: stronger reset saturation returns 503 without consuming token, then recovers', async () => {
  const queue=new HashQueue(),h=await securityHarness(false,false,new PasswordService(queue));
  const gate=defer();let blockers: Promise<void>[]=[];
  try {
    const a=await h.register(),strong=await strongPasswordFixture();
    await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[strong,a.user.id]);
    const token=await issueReset(h,a.user.id);
    blockers=Array.from({length:10},()=>queue.run(()=>gate.promise));
    const result=await h.send('POST','/api/auth/reset',{token,newPassword:'new-synthetic-password'});
    assert.equal(result.status,503);assert.deepEqual(await result.json(),{error:AUTH_BUSY_MESSAGE});
    assert.equal((await h.db.get('SELECT used_at FROM auth_tokens WHERE id=?',[token]))!.used_at,null);
    assert.ok(await stored(h,a.user.id)===strong);
    gate.resolve();await Promise.all(blockers);
    assert.equal((await h.send('POST','/api/auth/reset',{token,newPassword:'new-synthetic-password'})).status,200);
    assert.deepEqual(queue.status,{active:0,waiting:0});
  } finally {gate.resolve();await Promise.all(blockers);await h.close();}
});

test('P1 auth: concurrent profile change during reset hashing cannot downgrade or consume token', async () => {
  const entered=defer(),release=defer();let held=false;
  class PausedReset extends PasswordService {
    override async hashForReset(password:string,original:string) {entered.resolve();await release.promise;return super.hashForReset(password,original);}
  }
  const h=await securityHarness(false,false,new PausedReset());
  let pending:Promise<Response>|undefined;
  const transaction=h.db.transaction.bind(h.db);
  try {
    const a=await h.register(),token=await issueReset(h,a.user.id);
    h.db.transaction=async op=>transaction(async db=>{held=true;try{return await op(db);}finally{held=false;}});
    pending=h.send('POST','/api/auth/reset',{token,newPassword:'new-synthetic-password'});
    await entered.promise;assert.equal(held,false,'Hashing must occur outside a database transaction');
    const strong=await strongPasswordFixture();await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[strong,a.user.id]);
    release.resolve();assert.equal((await pending).status,400);
    assert.ok(await stored(h,a.user.id)===strong);
    assert.equal((await h.db.get('SELECT used_at FROM auth_tokens WHERE id=?',[token]))!.used_at,null);
    assert.equal((await h.send('POST','/api/auth/reset',{token,newPassword:'new-synthetic-password'})).status,200);
    assert.ok((await stored(h,a.user.id)).startsWith('scrypt$v1$N=16384,r=8,p=5$'));
  } finally {release.resolve();await pending;h.db.transaction=transaction;await h.close();}
});

test('P1 auth: stronger reset transaction failure preserves token, password and sessions', async () => {
  const h=await securityHarness(false,false),transaction=h.db.transaction.bind(h.db);
  try {
    const a=await h.register(),strong=await strongPasswordFixture();
    await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[strong,a.user.id]);
    const token=await issueReset(h,a.user.id);
    h.db.transaction=async op=>transaction(async db=>{await op(db);throw new Error('Synthetic reset rollback');});
    const response=await h.send('POST','/api/auth/reset',{token,newPassword:'new-synthetic-password'});
    assert.equal(response.status,500);assert.ok(await stored(h,a.user.id)===strong);
    assert.equal((await h.db.get('SELECT used_at FROM auth_tokens WHERE id=?',[token]))!.used_at,null);
    assert.equal((await h.send('GET','/api/auth/me',undefined,a.cookie)).status,200);
  } finally {h.db.transaction=transaction;await h.close();}
});

test('P1 auth: reset derivation failure never falls back or consumes the token and retry succeeds', async () => {
  class FailingReset extends PasswordService {
    fail=true;
    override async hashForReset(password:string,original:string) {
      if(this.fail) throw new Error('Synthetic derivation failure');
      return super.hashForReset(password,original);
    }
  }
  const service=new FailingReset(),h=await securityHarness(false,false,service);
  try {
    const a=await h.register(),strong=await strongPasswordFixture();
    await h.db.run('UPDATE users SET password_hash=? WHERE id=?',[strong,a.user.id]);
    const token=await issueReset(h,a.user.id);
    const result=await h.send('POST','/api/auth/reset',{token,newPassword:'new-synthetic-password'});
    assert.equal(result.status,500);assert.deepEqual(await result.json(),{error:'Server error'});
    assert.ok(await stored(h,a.user.id)===strong);
    assert.equal((await h.db.get('SELECT used_at FROM auth_tokens WHERE id=?',[token]))!.used_at,null);
    assert.equal((await h.send('GET','/api/auth/me',undefined,a.cookie)).status,200);
    service.fail=false;
    assert.equal((await h.send('POST','/api/auth/reset',{token,newPassword:'new-synthetic-password'})).status,200);
    assert.ok((await stored(h,a.user.id)).startsWith('scrypt$v1$N=16384,r=8,p=5$'));
  } finally {await h.close();}
});
