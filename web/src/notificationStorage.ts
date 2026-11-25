export const LEGACY_NOTIFICATION_KEY = 'studypilot-notification-days';
export const notificationDaysKey = (userId: string) => `${LEGACY_NOTIFICATION_KEY}:${encodeURIComponent(userId)}`;

export function removeLegacyNotificationDays(storage: Pick<Storage, 'removeItem'>) {
  try { storage.removeItem(LEGACY_NOTIFICATION_KEY); } catch { /* Storage may be blocked. */ }
}

export function readNotificationDays(storage: Pick<Storage, 'getItem'>, userId: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(storage.getItem(notificationDaysKey(userId)) ?? '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).filter(([, day]) => typeof day === 'string'));
    }
  } catch { /* Corrupt or unavailable storage must not break the app. */ }
  return {};
}
