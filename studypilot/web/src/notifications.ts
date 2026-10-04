import { useEffect, useState } from 'react';
import type { Task } from './api';
import { daysLeft, dueText } from './util';

type Permission = NotificationPermission | 'unsupported';
const storageKey = 'studypilot-notification-days';
const today = () => new Date().toLocaleDateString('en-CA');

export function useDeadlineNotifications(tasks: Task[], reminderDays: number) {
  const [permission, setPermission] = useState<Permission>(() => 'Notification' in window ? Notification.permission : 'unsupported');
  const requestPermission = async () => {
    if (!('Notification' in window)) return;
    setPermission(await Notification.requestPermission());
  };

  useEffect(() => {
    if (permission !== 'granted') return;
    const sent = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, string>;
    const day = today();
    for (const task of tasks) {
      const remaining = daysLeft(task.due);
      if (task.status === 'Complete' || (remaining > reminderDays && remaining >= 0) || sent[task.id] === day) continue;
      new Notification('StudyPilot deadline', { body: `${task.name}: ${dueText(task.due)}` });
      sent[task.id] = day;
    }
    localStorage.setItem(storageKey, JSON.stringify(sent));
  }, [permission, reminderDays, tasks]);

  return { permission, requestPermission };
}
