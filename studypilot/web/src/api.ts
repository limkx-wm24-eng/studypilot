export const TYPES = ['Assignment', 'Homework', 'Exam', 'Project', 'Others'] as const;
export const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'] as const;
export const STATUSES = ['Not started', 'In progress', 'Complete'] as const;
export const COURSE_TYPES = ['Degree', 'Diploma', 'Foundation'] as const;
export const KINDS = ['Lecture', 'Practical', 'Tutorial'] as const;

export type User = { id: string; email: string; name: string; courseType: string; programme: string; semesterWeeks: number; semesterStart: string; reminderDays: number };
export type Klass = { id: string; name: string; color: string };
export type Task = {
  id: string;
  classId: string;
  type: (typeof TYPES)[number];
  name: string;
  priority: (typeof PRIORITIES)[number];
  status: (typeof STATUSES)[number];
  due: string;
  grade: number | null;
};
export type Course = { id: string; semesterLabel: string; courseName: string; creditHours: number; grade: import('./gradeScale').LetterGrade | null };

export type Slot = { id: string; classId: string; kind: (typeof KINDS)[number]; weekday: number; start: string; end: string; room: string };
export type Mark = 'present' | 'absent' | 'leave';
export type Entry = { slotId: string; date: string; status: Mark };
export type ClassSummary = {
  classId: string; weeklyHours: number; totalHours: number; allowedHours: number | null; absentHours: number; leaveHours: number;
  loggedHours: number; remainingHours: number | null; percent: number | null; state: 'ok' | 'careful' | 'over' | 'unknown';
};
export type Summary = { requiredPercent: number | null; weeks: number; semesterStart: string; classes: ClassSummary[] };

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
  return data as T;
}

export const api = {
  get: <T,>(url: string) => request<T>('GET', url),
  post: <T,>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T,>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T,>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: (url: string) => request<void>('DELETE', url),
};
