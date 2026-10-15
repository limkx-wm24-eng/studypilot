import { useEffect, useState } from 'react';
import { api, type Course, type Klass, type Slot, type Summary, type Task } from './api';
import { showToast } from './toast';

const PALETTE = ['#0f766e', '#6366f1', '#d97706', '#db2777', '#16a34a', '#7c3aed'];
export type NewTask = Pick<Task, 'classId' | 'type' | 'name' | 'priority' | 'due'>;
export type NewSlot = Omit<Slot, 'id'>;

export function useStore() {
  const [classes, setClasses] = useState<Klass[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Runs an API call and shows any failure in the error banner instead of crashing.
  const act = async (fn: () => Promise<void>, successMessage: string) => {
    try {
      await fn();
      showToast(successMessage);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const refreshSummary = () => api.get<Summary>('/api/attendance/summary').then(setSummary).catch(() => {});

  useEffect(() => {
    Promise.all([
      api.get<Klass[]>('/api/classes'), api.get<Task[]>('/api/tasks'),
      api.get<Slot[]>('/api/slots'), api.get<Summary>('/api/attendance/summary'), api.get<Course[]>('/api/courses'),
    ])
      .then(([c, t, s, sum, courseRows]) => { setClasses(c); setTasks(t); setSlots(s); setSummary(sum); setCourses(courseRows); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return {
    classes, tasks, slots, courses, summary, loading, error, refreshSummary,
    clearError: () => setError(''),
    addClass: (name: string) => act(async () => {
      const c = await api.post<Klass>('/api/classes', { name, color: PALETTE[classes.length % PALETTE.length] });
      setClasses((x) => [...x, c]);
    }, 'Class added.'),
    removeClass: (id: string) => act(async () => {
      await api.del(`/api/classes/${id}`);
      setClasses((x) => x.filter((c) => c.id !== id));
      setTasks((x) => x.filter((t) => t.classId !== id));
      setSlots((x) => x.filter((s) => s.classId !== id));
      await refreshSummary();
    }, 'Class deleted.'),
    addTask: (t: NewTask) => act(async () => {
      const created = await api.post<Task>('/api/tasks', { ...t, status: 'Not started', grade: null });
      setTasks((x) => [...x, created]);
    }, 'Task added.'),
    patchTask: (id: string, patch: Partial<Pick<Task, 'status' | 'grade'>>) => act(async () => {
      const updated = await api.patch<Task>(`/api/tasks/${id}`, patch);
      setTasks((x) => x.map((t) => (t.id === id ? updated : t)));
    }, 'Task saved.'),
    removeTask: (id: string) => act(async () => {
      await api.del(`/api/tasks/${id}`);
      setTasks((x) => x.filter((t) => t.id !== id));
    }, 'Task deleted.'),
    addCourse: (course: Omit<Course, 'id'>) => act(async () => { const created = await api.post<Course>('/api/courses', course); setCourses((rows) => [...rows, created]); }, 'Course added.'),
    patchCourse: (id: string, patch: Partial<Omit<Course, 'id'>>) => act(async () => { const updated = await api.patch<Course>(`/api/courses/${id}`, patch); setCourses((rows) => rows.map((course) => course.id === id ? updated : course)); }, 'Course saved.'),
    removeCourse: (id: string) => act(async () => { await api.del(`/api/courses/${id}`); setCourses((rows) => rows.filter((course) => course.id !== id)); }, 'Course deleted.'),
    addSlot: (s: NewSlot) => act(async () => {
      const created = await api.post<Slot>('/api/slots', s);
      setSlots((x) => [...x, created]);
      await refreshSummary();
    }, 'Class time added.'),
    removeSlot: (id: string) => act(async () => {
      await api.del(`/api/slots/${id}`);
      setSlots((x) => x.filter((s) => s.id !== id));
      await refreshSummary();
    }, 'Class time deleted.'),
  };
}
export type Store = ReturnType<typeof useStore>;
