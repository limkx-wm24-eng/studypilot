import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_NOTIFICATION_KEY, notificationDaysKey, readNotificationDays, removeLegacyNotificationDays } from '../web/src/notificationStorage.ts';

test('notification history uses distinct opaque-user keys and never reads the shared legacy record', () => {
  const values = new Map([
    [LEGACY_NOTIFICATION_KEY, '{"legacy-task":"2026-11-25"}'],
    [notificationDaysKey('opaque-a'), '{"task-a":"2026-11-25"}'],
    [notificationDaysKey('opaque-b'), '{"task-b":"2026-11-26"}'],
    ['unrelated-setting', 'preserve'],
  ]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key); } };
  assert.equal(notificationDaysKey('opaque-a'), 'studypilot-notification-days:opaque-a');
  assert.notEqual(notificationDaysKey('opaque:a'), notificationDaysKey('opaque%3Aa'));
  assert.deepEqual(readNotificationDays(storage, 'opaque-a'), { 'task-a': '2026-11-25' });
  assert.deepEqual(readNotificationDays(storage, 'opaque-b'), { 'task-b': '2026-11-26' });
  assert.deepEqual(readNotificationDays(storage, 'opaque-new'), {});
  removeLegacyNotificationDays(storage);
  assert.equal(values.has(LEGACY_NOTIFICATION_KEY), false);
  assert.equal(values.get('unrelated-setting'), 'preserve');
  assert.equal(values.has(notificationDaysKey('opaque-a')), true);
});

test('corrupt or blocked notification storage does not break account access', () => {
  for (const value of ['invalid-json', 'null', '[]', '42']) assert.deepEqual(readNotificationDays({ getItem: () => value }, 'opaque-a'), {});
  assert.deepEqual(readNotificationDays({ getItem: () => '{"valid":"2026-11-25","invalid":{}}' }, 'opaque-a'), { valid: '2026-11-25' });
  assert.deepEqual(readNotificationDays({ getItem: () => { throw new Error('Synthetic blocked storage'); } }, 'opaque-a'), {});
  assert.doesNotThrow(() => removeLegacyNotificationDays({ removeItem: () => { throw new Error('Synthetic blocked storage'); } }));
});
