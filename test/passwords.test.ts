import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scrypt } from 'node:crypto';
import { legacyHash } from './support/legacyPassword.ts';
import { HashQueue, PasswordQueueFull, PasswordService, PASSWORD_POLICY, needsPasswordUpgrade, passwordQueue, hashPassword, checkPassword } from '../src/passwords.js';
import { strongPasswordFixture } from './support/strongPassword.ts';

test('passwords: async versioned hashes, legacy compatibility, incorrect passwords and conservative upgrades', async () => {
  const legacy = legacyHash('synthetic-password');
  assert.equal(await checkPassword('synthetic-password', legacy), true);
  assert.equal(await checkPassword('incorrect', legacy), false);
  assert.equal(needsPasswordUpgrade(legacy), true);
  const current = await hashPassword('synthetic-password');
  assert.match(current, /^scrypt\$v1\$N=16384,r=8,p=1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await checkPassword('synthetic-password', current), true);
  assert.equal(await checkPassword('incorrect', current), false);
  assert.equal(needsPasswordUpgrade(current), false);
  assert.equal(needsPasswordUpgrade(current, { ...PASSWORD_POLICY, N: 8192 }), false, 'A weaker target must not downgrade a supported stronger hash');
  assert.deepEqual(passwordQueue.status, { active: 0, waiting: 0 });
});

test('passwords: malformed, excessive-cost and unsupported hashes are rejected before native work', async () => {
  let calls = 0;
  const service = new PasswordService(new HashQueue(), async () => { calls++; return Buffer.alloc(64); });
  for (const value of ['', 'invalid', 'a'.repeat(10_000), '00:00', `scrypt$v2$N=16384,r=8,p=1$${'00'.repeat(16)}$${'00'.repeat(64)}`, `scrypt$v1$N=16384,r=8,p=2$${'00'.repeat(16)}$${'00'.repeat(64)}`, `scrypt$v1$N=1073741824,r=8,p=999$${'00'.repeat(16)}$${'00'.repeat(64)}`]) {
    assert.equal(await service.verify('synthetic', value), false);
  }
  assert.equal(calls, 0);
});

test('passwords: legacy, current, older, malformed and missing login hashes do equivalent bounded work', async () => {
  const calls: number[] = [];
  const service = new PasswordService(new HashQueue(), async (_password, _salt, parameters) => { calls.push(parameters.N * parameters.p); return Buffer.alloc(64); });
  const tail = `${'00'.repeat(16)}$${'ff'.repeat(64)}`;
  for (const [stored, expected] of [
    [undefined, [81920]], ['invalid', [81920]], [`${'00'.repeat(16)}:${'ff'.repeat(64)}`, [16384, 65536]],
    [`scrypt$v1$N=8192,r=8,p=1$${tail}`, [8192, 73728]], [`scrypt$v1$N=16384,r=8,p=1$${tail}`, [16384, 65536]],
    [`scrypt$v1$N=16384,r=8,p=5$${tail}`, [81920]],
  ] as const) {
    calls.length = 0; assert.equal(await service.verifyLogin('incorrect', stored), false);
    assert.deepEqual(calls, expected);
  }
});

test('passwords: one shared queue covers hash, verify, dummy and upgrade work, bounds waiting, releases after errors', async () => {
  const queue = new HashQueue(2, 3);
  let active = 0, maximum = 0, calls = 0;
  const releases: (() => void)[] = [];
  const derive = async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve)); active--; return Buffer.alloc(64);
  };
  const a = new PasswordService(queue, derive), b = new PasswordService(queue, derive);
  const current = `scrypt$v1$N=16384,r=8,p=1$${'00'.repeat(16)}$${'00'.repeat(64)}`;
  const older = `scrypt$v1$N=8192,r=8,p=1$${'00'.repeat(16)}$${'ff'.repeat(64)}`;
  const work = [a.hash('synthetic'), b.verify('synthetic', current), a.verifyLogin('synthetic'), b.verifyLogin('synthetic', older), a.hash('synthetic-upgrade')];
  assert.deepEqual(queue.status, { active: 2, waiting: 3 });
  await assert.rejects(b.verifyLogin('synthetic'), PasswordQueueFull);
  // An older-profile login has a second native call under the same permit.
  while (queue.status.active || queue.status.waiting) { releases.splice(0).forEach((release) => release()); await new Promise((resolve) => setImmediate(resolve)); }
  await Promise.all(work);
  assert.equal(maximum, 2); assert.equal(calls, 6);
  await assert.rejects(queue.run(async () => { throw new Error('Synthetic operation failure'); }));
  const broken = new PasswordService(queue, async () => { throw new Error('Synthetic derivation failure'); });
  await assert.rejects(broken.hash('synthetic'));
  assert.deepEqual(queue.status, { active: 0, waiting: 0 });
  assert.equal(await queue.run(async () => 42), 42);
});

test('P1 passwords: stronger v1 verifies without automatic downgrade; explicit resets preserve the profile', async () => {
  const service = new PasswordService();
  const strong = await strongPasswordFixture();
  assert.equal(await service.verify('synthetic-password-123', strong), true);
  assert.equal(await service.verify('incorrect-synthetic', strong), false);
  assert.equal(await service.verifyLogin('synthetic-password-123', strong), true);
  assert.equal(needsPasswordUpgrade(strong), false);
  const reset = await service.hashForReset('new-synthetic-password', strong);
  assert.ok(reset.startsWith('scrypt$v1$N=16384,r=8,p=5$'));
  assert.ok(reset !== strong);
  assert.equal(await service.verify('new-synthetic-password', reset), true);
  assert.equal(await service.verify('synthetic-password-123', reset), false);
  const ordinary = await service.hashForReset('new-synthetic-password', await service.hash('synthetic-password-123'));
  assert.ok(ordinary.startsWith('scrypt$v1$N=16384,r=8,p=1$'));
});

test('P1 passwords: older native v1 verifies correct passwords and rejects incorrect passwords with padding', async () => {
  const salt=randomBytes(16);
  const key=await new Promise<Buffer>((resolve,reject)=>scrypt('synthetic-password-123',salt,64,{N:8192,r:8,p:1,maxmem:34*1024*1024},(error,key)=>error?reject(error):resolve(key)));
  const older=`scrypt$v1$N=8192,r=8,p=1$${salt.toString('hex')}$${key.toString('hex')}`;
  const service=new PasswordService();
  assert.equal(await service.verify('synthetic-password-123',older),true);
  assert.equal(await service.verify('incorrect-synthetic',older),false);
  assert.equal(await service.verifyLogin('incorrect-synthetic',older),false);
  assert.equal(needsPasswordUpgrade(older),true);
});

test('P1 passwords: stronger parser rejects unlisted combinations and invalid encodings before native work', async () => {
  let calls = 0;
  const service = new PasswordService(new HashQueue(), async () => { calls++; return Buffer.alloc(64); });
  const tail = `${'00'.repeat(16)}$${'ff'.repeat(64)}`;
  for (const value of [
    `scrypt$v1$N=8192,r=8,p=5$${tail}`, `scrypt$v1$N=32768,r=8,p=3$${tail}`,
    `scrypt$v1$N=16384,r=9,p=5$${tail}`, `scrypt$v1$N=16384,r=8,p=999999$${tail}`,
    `scrypt$v1$N=16384,r=8,p=5$${'gg'.repeat(16)}$${'ff'.repeat(64)}`,
    `scrypt$v1$N=16384,r=8,p=5$${'00'.repeat(16)}$${'gg'.repeat(64)}`,
    `scrypt$v1$N=16384,r=8,p=5$${'00'.repeat(15)}$${'ff'.repeat(64)}`,
    `scrypt$v1$N=16384,r=8,p=5$${'00'.repeat(16)}$${'ff'.repeat(63)}`,
    `scrypt$v1$N=16384,r=8,p=5$${tail}\n`, 'x'.repeat(10000),
  ]) assert.equal(await service.verify('synthetic', value), false);
  assert.equal(calls, 0);
});

test('P1 passwords: padding errors propagate, release the shared permit, and do not prevent recovery', async () => {
  const queue = new HashQueue(); let fail = true;
  const service = new PasswordService(queue, async (_password, _salt, parameters) => {
    if (parameters.p === 4 && fail) throw new Error('Synthetic padding failure');
    return Buffer.alloc(64);
  });
  const stored = `scrypt$v1$N=16384,r=8,p=1$${'00'.repeat(16)}$${'ff'.repeat(64)}`;
  await assert.rejects(service.verifyLogin('incorrect', stored), /Synthetic padding failure/);
  assert.deepEqual(queue.status, { active: 0, waiting: 0 }); fail = false;
  assert.equal(await service.verifyLogin('incorrect', stored), false);
  const broken = new PasswordService(queue, async () => { throw new Error('Synthetic native failure'); });
  const strong = `scrypt$v1$N=16384,r=8,p=5$${'00'.repeat(16)}$${'ff'.repeat(64)}`;
  await assert.rejects(broken.verify('incorrect', strong));
  await assert.rejects(broken.hashForReset('synthetic', strong));
  assert.deepEqual(queue.status, { active: 0, waiting: 0 });
});
