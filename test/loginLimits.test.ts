import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginLimits } from '../src/loginLimits.js';

test('login limits: pair lockout, unrelated pairs, success reset, aggregate preservation and expiry', () => {
  let now = 1_000_000;
  const limits = new LoginLimits(() => now);
  const failed = (email: string, ip: string) => {
    const ticket = limits.begin(email, ip); assert.ok('finish' in ticket);
    return ticket.finish(false);
  };
  for (let i = 0; i < 4; i++) assert.equal(failed('a@example.test', 'attacker'), undefined);
  assert.equal(failed('a@example.test', 'attacker'), 900);
  const locked = limits.begin('a@example.test', 'attacker'); assert.deepEqual(locked, { retryAfter: 900 });
  const legitimate = limits.begin('a@example.test', 'real'); assert.ok('finish' in legitimate); legitimate.finish(true);
  assert.deepEqual(limits.begin('a@example.test', 'attacker'), { retryAfter: 900 });
  for (let i = 0; i < 4; i++) failed('a@example.test', 'real');
  const success = limits.begin('a@example.test', 'real'); assert.ok('finish' in success); success.finish(true);
  for (let i = 0; i < 4; i++) assert.equal(failed('a@example.test', 'real'), undefined);
  // Eight failures remain in this IP counter despite the successful login.
  for (let i = 0; i < 22; i++) failed(`other-${i}@example.test`, 'real');
  assert.deepEqual(limits.begin('fresh@example.test', 'real'), { retryAfter: 900 });
  now += 15 * 60_000;
  const expired = limits.begin('a@example.test', 'attacker'); assert.ok('finish' in expired); expired.finish(true);
  const expiredIp = limits.begin('fresh@example.test', 'real'); assert.ok('finish' in expiredIp); expiredIp.finish(true);
});

test('login limits: pending attempts reserve pair/IP capacity; cancellation does not count as failure', () => {
  const limits = new LoginLimits();
  const pending = Array.from({ length: 5 }, () => limits.begin('same@example.test', 'ip'));
  assert.ok('retryAfter' in limits.begin('same@example.test', 'ip'));
  for (const ticket of pending) { assert.ok('finish' in ticket); ticket.finish(false, false); }
  const next = limits.begin('same@example.test', 'ip'); assert.ok('finish' in next); next.finish(true);
  for (let i = 0; i < 4; i++) { const failed = limits.begin('busy@example.test', 'other-ip'); assert.ok('finish' in failed); failed.finish(false); }
  const inFlight = limits.begin('busy@example.test', 'other-ip'); assert.ok('finish' in inFlight);
  assert.deepEqual(limits.begin('busy@example.test', 'other-ip'), { retryAfter: 1 });
  inFlight.finish(false, false);
  const all = Array.from({ length: 30 }, (_, i) => limits.begin(`pair-${i}@example.test`, 'ip'));
  assert.ok(all.every((ticket) => 'finish' in ticket));
  assert.ok('retryAfter' in limits.begin('overflow@example.test', 'ip'));
  for (const ticket of all) if ('finish' in ticket) ticket.finish(false, false);
});

test('login limits: retained keys are bounded and idle expired counters are reclaimed', () => {
  let now = 0;
  const limits = new LoginLimits(() => now);
  for (let i = 0; i < 4096; i++) {
    const ticket = limits.begin(`bounded-${i}@example.test`, `ip-${i}`); assert.ok('finish' in ticket); ticket.finish(false);
  }
  assert.deepEqual(limits.begin('overflow@example.test', 'overflow'), { retryAfter: 60 });
  now = 900_001;
  const reclaimed = limits.begin('overflow@example.test', 'overflow'); assert.ok('finish' in reclaimed); reclaimed.finish(true);
});
