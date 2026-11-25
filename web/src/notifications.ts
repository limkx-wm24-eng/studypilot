import { useEffect, useState } from 'react';
import type { Task } from './api';
import { daysLeft, dueText } from './util';
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
const today = () => new Date().toLocaleDateString('en-CA');

export function useDeadlineNotifications(userId: string, tasks: Task[], reminderDays: number, enabled = true) {
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
    let sent: Record<string, string> = {};
    try { sent = readNotificationDays(localStorage, userId); } catch { /* Storage may be blocked. */ }
    const day = today();
    for (const task of tasks) {
      const remaining = daysLeft(task.due);
      if (task.status === 'Complete' || (remaining > reminderDays && remaining >= 0) || sent[task.id] === day) continue;
      const notification = new Notification('StudyPilot deadline', { body: `${task.name}: ${dueText(task.due)}` });
      openNotifications.add(notification);
      notification.onclose = () => openNotifications.delete(notification);
      sent[task.id] = day;
    }
    try { localStorage.setItem(notificationDaysKey(userId), JSON.stringify(sent)); } catch { /* Notifications still work without persistence. */ }
  }, [enabled, permission, reminderDays, tasks, userId]);

  return { permission, requestPermission };
}
