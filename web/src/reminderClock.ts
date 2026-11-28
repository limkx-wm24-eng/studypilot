import { dayDifference, malaysiaDay } from './dateOnly';
export { malaysiaDay as reminderDay, nextMalaysiaMidnight as nextReminderBoundary, deadlineText as reminderDueText } from './dateOnly';
export const reminderDaysLeft = (due: string, now = new Date()) => dayDifference(due, malaysiaDay(now));
