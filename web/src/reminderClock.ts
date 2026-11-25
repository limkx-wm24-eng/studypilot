const DAY = 86_400_000;
const malaysiaDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' });
export const reminderDay = (now = new Date()) => malaysiaDate.format(now);
export const nextReminderBoundary = (now = new Date()) => Date.parse(`${reminderDay(now)}T00:00:00+08:00`) + DAY;
export const reminderDaysLeft = (due: string, now = new Date()) => Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${reminderDay(now)}T00:00:00Z`)) / DAY);
export const reminderDueText = (days: number) => days < 0 ? `${-days}d overdue` : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `in ${days} days`;
