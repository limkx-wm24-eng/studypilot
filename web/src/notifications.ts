import { useEffect, useRef, useState } from 'react';
import type { Task } from './api';
import { nextReminderBoundary, reminderDay, reminderDaysLeft, reminderDueText } from './reminderClock';
import { notificationDaysKey, readNotificationDays, removeLegacyNotificationDays } from './notificationStorage';

type Permission = NotificationPermission | 'unsupported';
const openNotifications = new Set<Notification>();
export function closeDeadlineNotifications() {
  for (const notification of openNotifications) {
    try { notification.close(); } catch { /* Some platforms cannot close notifications. */ }
  }
  openNotifications.clear();
}
export function clearLegacyNotificationHistory() {
  try { removeLegacyNotificationDays(localStorage); } catch { /* Storage may be unavailable. */ }
}

export function useDeadlineNotifications(userId: string, tasks: Task[], reminderDays: number, enabled = true) {
  const history = useRef<{ userId: string; sent: Record<string, string> }>({ userId, sent: {} });
  const [permission, setPermission] = useState<Permission>(() => 'Notification' in window ? Notification.permission : 'unsupported');
  const requestPermission = async () => {
    if (!('Notification' in window)) return;
    setPermission(await Notification.requestPermission());
  };

  useEffect(() => {
    clearLegacyNotificationHistory();
    return closeDeadlineNotifications;
  }, [userId]);

  useEffect(() => {
    if (!enabled || permission !== 'granted') return;
    if (history.current.userId !== userId) history.current = { userId, sent: {} };
    const sent = history.current.sent;
    try {
      for (const [id, day] of Object.entries(readNotificationDays(localStorage, userId))) if (!sent[id] || day > sent[id]) sent[id] = day;
    } catch { /* Storage may be blocked. */ }
    let cancelled = false;
    let timer: number;
    const checkAndSchedule = () => {
      if (cancelled) return;
      window.clearTimeout(timer);
      const now = new Date(), day = reminderDay(now);
      for (const task of tasks) {
        const remaining = reminderDaysLeft(task.due, now);
        if (Notification.permission !== 'granted' || task.status === 'Complete' || (remaining > reminderDays && remaining >= 0) || sent[task.id] === day) continue;
        try {
          const notification = new Notification('StudyPilot deadline', { body: `${task.name}: ${reminderDueText(remaining)}` });
          openNotifications.add(notification);
          notification.onclose = () => openNotifications.delete(notification);
          sent[task.id] = day;
        } catch { /* A browser may revoke permission or reject desktop delivery. */ }
      }
      try { localStorage.setItem(notificationDaysKey(userId), JSON.stringify(sent)); } catch { /* In-memory deduplication still applies. */ }
      timer = window.setTimeout(checkAndSchedule, Math.max(1, nextReminderBoundary(now) - now.getTime()));
    };
    const visible = () => { if (document.visibilityState === 'visible') checkAndSchedule(); };
    checkAndSchedule();
    window.addEventListener('focus', checkAndSchedule);
    document.addEventListener('visibilitychange', visible);
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener('focus', checkAndSchedule); document.removeEventListener('visibilitychange', visible); };
  }, [enabled, permission, reminderDays, tasks, userId]);

  return { permission, requestPermission };
}
