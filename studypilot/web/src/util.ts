export type Tab = 'dash' | 'classes' | 'tasks' | 'timetable' | 'progress' | 'profile';

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export const daysLeft = (due: string) =>
  Math.round((new Date(`${due}T00:00:00`).getTime() - midnight(new Date())) / 864e5);

export const dueText = (due: string) => {
  const d = daysLeft(due);
  return d < 0 ? `${-d}d overdue` : d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `in ${d} days`;
};
