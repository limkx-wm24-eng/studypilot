export const DAY_MS = 86_400_000;
const malaysia = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' });
export const malaysiaDay = (now = new Date()) => malaysia.format(now);
const instant = (date: string) => Date.parse(`${date}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);
export const dayDifference = (date: string, from: string) => Math.round((instant(date) - instant(from)) / DAY_MS);
export const addDays = (date: string, count: number) => iso(new Date(instant(date) + count * DAY_MS));
export const weekday = (date: string) => new Date(instant(date)).getUTCDay();
export const mondayOf = (date: string) => addDays(date, -((weekday(date) + 6) % 7));
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
export function addMonths(date: string, count: number) {
  const first = new Date(instant(monthStart(date)));
  first.setUTCMonth(first.getUTCMonth() + count);
  return iso(first);
}
export const daysInMonth = (date: string) => dayDifference(addMonths(date, 1), monthStart(date));
export const nextMalaysiaMidnight = (now = new Date()) => instant(addDays(malaysiaDay(now), 1)) - 8 * 60 * 60_000;
export const deadlineText = (days: number) => days < 0 ? `${-days}d overdue` : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `in ${days} days`;
// A date-only value is a calendar label, not a browser-local timestamp.
export const formatDateOnly = (date: string, options: Intl.DateTimeFormatOptions, locales?: Intl.LocalesArgument) => new Intl.DateTimeFormat(locales, { ...options, timeZone: 'UTC' }).format(new Date(instant(date)));
