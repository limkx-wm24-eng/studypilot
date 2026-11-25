import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MutationQueue } from '../web/src/mutationQueue.ts';
import { nextReminderBoundary, reminderDay, reminderDaysLeft } from '../web/src/reminderClock.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
test('Q2-B mutation queue serializes one record while independent records proceed', async () => {
  const queue = new MutationQueue(), entered = deferred(), release = deferred();
  const order: string[] = [];
  const first = queue.run('task:A', async () => { order.push('A1'); entered.resolve(); await release.promise; order.push('A1 done'); });
  await entered.promise;
  const second = queue.run('task:A', async () => { order.push('A2'); });
  await queue.run('task:B', async () => { order.push('B'); });
  assert.deepEqual(order, ['A1', 'B']);
  release.resolve(); await Promise.all([first, second]);
  assert.deepEqual(order, ['A1', 'B', 'A1 done', 'A2']);
});
test('Q2-B mutation queue releases a failed operation before the next write', async () => {
  const queue = new MutationQueue(); let committed = false;
  const failure = queue.run('task:A', async () => { throw new Error('Synthetic failure'); });
  const success = queue.run('task:A', async () => { committed = true; return 85; });
  await assert.rejects(failure, /Synthetic failure/); assert.equal(await success, 85); assert.equal(committed, true);
});
for (const [before, after] of [
  ['2026-11-02', '2026-11-03'], ['2026-11-30', '2026-12-01'], ['2026-12-31', '2027-01-01'],
  ['2024-02-28', '2024-02-29'], ['2024-02-29', '2024-03-01'], ['2100-02-28', '2100-03-01'],
]) test(`Q2-B reminders: Malaysia boundary ${before} to ${after}`, () => {
  const now = new Date(`${before}T23:59:00+08:00`);
  assert.equal(reminderDay(now), before);
  const boundary = nextReminderBoundary(now);
  assert.equal(boundary - now.getTime(), 60_000);
  assert.equal(reminderDay(new Date(boundary)), after);
  assert.equal(reminderDaysLeft(after, now), 1);
  assert.equal(reminderDaysLeft(after, new Date(boundary + 60_000)), 0);
  assert.equal(nextReminderBoundary(new Date(boundary + 60_000)), boundary + 86_400_000);
});
