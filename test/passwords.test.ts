import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyHash } from './support/legacyPassword.ts';
import { HashQueue, PasswordQueueFull, PasswordService, PASSWORD_POLICY, needsPasswordUpgrade, passwordQueue, hashPassword, checkPassword } from '../src/passwords.js';

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
  const service = new PasswordService(new HashQueue(), async (_password, _salt, parameters) => { calls.push(parameters.N); return Buffer.alloc(64); });
  const tail = `${'00'.repeat(16)}$${'ff'.repeat(64)}`;
  for (const [stored, expected] of [
    [undefined, [16384]], ['invalid', [16384]], [`${'00'.repeat(16)}:${'ff'.repeat(64)}`, [16384]],
    [`scrypt$v1$N=8192,r=8,p=1$${tail}`, [8192, 8192]], [`scrypt$v1$N=16384,r=8,p=1$${tail}`, [16384]],
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
  const older = `scrypt$v1$N=8192,r=8,p=1$${'00'.repeat(16)}$${'00'.repeat(64)}`;
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
