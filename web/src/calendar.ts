// TAR UMT Academic Calendar 2025/2026 (undergraduate and postgraduate programmes), November 2025 intake.
// Source: https://tarc.edu.my/files/admissions/428AACD0-B722-4DA9-BAAB-05BA59158557.pdf
// The calendar says its dates may change. Update this list when the 2026/2027 calendar is published.
import { addDays, dayDifference, malaysiaDay } from './dateOnly';
export type Semester = {
  name: string;
  session: string;
  weeks: 7 | 14; // teaching weeks: short semester = 7, long semester = 14
  start: string;
  exam: [string, string] | null;
  holidays: [string, string] | null;
};

export const CALENDAR_LABEL = 'TAR UMT semester calendar (2025/2026 and 202609 teaching dates)';

export const SEMESTERS: Semester[] = [
  { name: 'First Semester', session: '202509', weeks: 7, start: '2025-11-10', exam: ['2025-12-29', '2026-01-08'], holidays: ['2026-01-12', '2026-01-25'] },
  { name: 'Second Semester', session: '202601', weeks: 14, start: '2026-01-26', exam: ['2026-05-06', '2026-05-20'], holidays: ['2026-05-25', '2026-06-14'] },
  { name: 'Third Semester', session: '202605', weeks: 14, start: '2026-06-15', exam: ['2026-09-23', '2026-10-08'], holidays: ['2026-10-12', '2026-11-01'] },
  // Teaching dates supplied by the student; exam and holiday dates are unconfirmed.
  { name: 'Semester 202609', session: '202609', weeks: 7, start: '2026-11-02', exam: null, holidays: null },
];

export const isoToday = malaysiaDay;
export const kind = (s: Semester) => (s.weeks === 7 ? 'short' : 'long');

export const teachingEnd = (s: Semester) => addDays(s.start, s.weeks * 7 - 1);

/** Only identify dates covered by a known teaching, examination or holiday range. */
export const currentSemester = (today: string) => [...SEMESTERS].reverse().find((s) => today >= s.start && today <= (s.holidays?.[1] ?? s.exam?.[1] ?? teachingEnd(s)));

/** Where a date falls inside a semester. */
export function phase(s: Semester, today: string): string {
  if (today < s.start) return 'Not started';
  const week = Math.floor(dayDifference(today, s.start) / 7) + 1;
  if (week <= s.weeks) return `Teaching week ${week} of ${s.weeks}`;
  if (s.holidays && today >= s.holidays[0] && today <= s.holidays[1]) return 'Semester holidays';
  if (!s.exam) return s.holidays ? 'Exam dates unknown' : 'Exam and holiday dates unknown';
  if (today < s.exam[0]) return 'Study leave';
  if (today <= s.exam[1]) return 'Examination period';
  if (!s.holidays) return 'Holiday dates unknown';
  if (today < s.holidays[0]) return 'After exams';
  return 'Semester holidays';
}
