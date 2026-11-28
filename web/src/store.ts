import { useEffect, useRef, useState } from 'react';
import { api, type Course, type Klass, type Slot, type Summary, type Task } from './api';
import { MutationQueue } from './mutationQueue';
import { showToast } from './toast';

const PALETTE = ['#0f766e', '#6366f1', '#d97706', '#db2777', '#16a34a', '#7c3aed'];
export type NewTask = Pick<Task, 'classId' | 'type' | 'name' | 'priority' | 'due'>;
export type NewSlot = Omit<Slot, 'id'>;
const resources = ['classes', 'tasks', 'slots', 'summary', 'courses'] as const;
type Resource = typeof resources[number];
type Load = { loaded: boolean; loading: boolean; error: string };
const initialLoads = () => Object.fromEntries(resources.map((key) => [key, { loaded: false, loading: true, error: '' }])) as Record<Resource, Load>;

export function useStore() {
  const [classes, setClasses] = useState<Klass[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loads, setLoads] = useState(initialLoads);
  const latestLoads = useRef(loads);
  latestLoads.current = loads;
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Record<string, number>>({});
  const active = useRef(0);
  const requests = useRef<Record<string, number>>({});
  const queue = useRef(new MutationQueue());
  const creating = useRef(new Set<string>());
  const valid = (generation: number) => generation > 0 && active.current === generation;
  const invalidate = (...keys: Resource[]) => {
    for (const key of keys) requests.current[key] = (requests.current[key] ?? 0) + 1;
    setLoads((old) => { const next = { ...old }; for (const key of keys) next[key] = { ...old[key], loading: false }; return next; });
  };
  const readers: Record<Resource, () => Promise<() => void>> = {
    classes: async () => { const rows = await api.get<Klass[]>('/api/classes'); return () => setClasses(rows); },
    tasks: async () => { const rows = await api.get<Task[]>('/api/tasks'); return () => setTasks(rows); },
    slots: async () => { const rows = await api.get<Slot[]>('/api/slots'); return () => setSlots(rows); },
    courses: async () => { const rows = await api.get<Course[]>('/api/courses'); return () => setCourses(rows); },
    summary: async () => { const row = await api.get<Summary>('/api/attendance/summary'); return () => setSummary(row); },
  };

  const load = async (key: Resource): Promise<boolean> => {
    const generation = active.current;
    const version = requests.current[key] = (requests.current[key] ?? 0) + 1;
    const current = () => valid(generation) && requests.current[key] === version;
    if (!valid(generation)) return false;
    setLoads((old) => ({ ...old, [key]: { ...old[key], loading: true, error: '' } }));
    try {
      const commit = await readers[key]();
      if (!current()) return false;
      commit();
      setLoads((old) => ({ ...old, [key]: { loaded: true, loading: false, error: '' } }));
      return true;
    } catch (failure) {
      if (current()) setLoads((old) => ({ ...old, [key]: { ...old[key], loading: false, error: (failure as Error).message } }));
      return false;
    }
  };
  const refreshSummary = () => load('summary');
  useEffect(() => {
    const generation = active.current = Math.abs(active.current) + 1;
    for (const key of resources) void load(key);
    return () => { if (active.current === generation) active.current = -generation; };
  }, []);

  // Explicit outcomes keep event handlers safe and let forms retain failed drafts.
  const act = (key: string, affected: Resource[], request: () => Promise<() => void>, message: string, unique = false): Promise<boolean> => {
    const generation = active.current;
    if (!valid(generation) || (unique && creating.current.has(key))) return Promise.resolve(false);
    if (unique) creating.current.add(key);
    setPending((old) => ({ ...old, [key]: (old[key] ?? 0) + 1 }));
    return queue.current.run(key, async () => {
      if (!valid(generation)) return false;
      invalidate(...affected);
      try {
        const commit = await request();
        if (!valid(generation)) return false;
        invalidate(...affected);
        commit(); setError(''); showToast(message);
        return true;
      } catch (failure) {
        if (valid(generation)) setError((failure as Error).message);
        return false;
      }
    }).finally(() => {
      creating.current.delete(key);
      if (valid(generation)) {
        setPending((old) => ({ ...old, [key]: Math.max(0, (old[key] ?? 1) - 1) }));
        // A parent deletion can invalidate a dataset whose first load is still
        // pending. Replace that obsolete read rather than leaving it unavailable.
        for (const resource of affected) if (!latestLoads.current[resource].loaded) void load(resource);
      }
    });
  };

  return {
    classes, tasks, slots, courses, summary, loads, error, refreshSummary,
    loading: resources.some((key) => !loads[key].loaded && loads[key].loading),
    isPending: (key: string) => Boolean(pending[key]),
    retryLoad: () => { for (const key of resources) if (loads[key].error) void load(key); },
    clearError: () => setError(''),
    refreshTimetable: async () => {
      const results = await Promise.all([load('classes'), load('slots'), refreshSummary()]);
      if (!results[0] || !results[1]) throw new Error('Timetable could not be refreshed. Retry loading.');
    },
    addClass: (name: string) => act('addClass', ['classes'], async () => {
      const row = await api.post<Klass>('/api/classes', { name, color: PALETTE[classes.length % PALETTE.length] });
      return () => setClasses((old) => [...old, row]);
    }, 'Class added.', true),
    removeClass: (id: string) => act(`class:${id}`, ['classes', 'tasks', 'slots'], async () => {
      await api.del(`/api/classes/${id}`);
      return () => { setClasses((old) => old.filter((row) => row.id !== id)); setTasks((old) => old.filter((row) => row.classId !== id)); setSlots((old) => old.filter((row) => row.classId !== id)); void refreshSummary(); };
    }, 'Class deleted.'),
    addTask: (task: NewTask) => act('addTask', ['tasks'], async () => {
      const row = await api.post<Task>('/api/tasks', { ...task, status: 'Not started', grade: null });
      return () => setTasks((old) => [...old, row]);
    }, 'Task added.', true),
    patchTask: (id: string, patch: Partial<Pick<Task, 'status' | 'grade'>>) => act(`task:${id}`, ['tasks'], async () => {
      const row = await api.patch<Task>(`/api/tasks/${id}`, patch);
      return () => setTasks((old) => old.map((task) => task.id === id ? row : task));
    }, 'Task saved.'),
    removeTask: (id: string) => act(`task:${id}`, ['tasks'], async () => {
      await api.del(`/api/tasks/${id}`); return () => setTasks((old) => old.filter((row) => row.id !== id));
    }, 'Task deleted.'),
    addCourse: (course: Omit<Course, 'id'>) => act('addCourse', ['courses'], async () => {
      const row = await api.post<Course>('/api/courses', course); return () => setCourses((old) => [...old, row]);
    }, 'Course added.', true),
    patchCourse: (id: string, patch: Partial<Omit<Course, 'id'>>) => act(`course:${id}`, ['courses'], async () => {
      const row = await api.patch<Course>(`/api/courses/${id}`, patch); return () => setCourses((old) => old.map((course) => course.id === id ? row : course));
    }, 'Course saved.'),
    removeCourse: (id: string) => act(`course:${id}`, ['courses'], async () => {
      await api.del(`/api/courses/${id}`); return () => setCourses((old) => old.filter((row) => row.id !== id));
    }, 'Course deleted.'),
    addSlot: (slot: NewSlot) => act('addSlot', ['slots'], async () => {
      const row = await api.post<Slot>('/api/slots', slot); return () => { setSlots((old) => [...old, row]); void refreshSummary(); };
    }, 'Class time added.', true),
    removeSlot: (id: string) => act(`slot:${id}`, ['slots'], async () => {
      await api.del(`/api/slots/${id}`); return () => { setSlots((old) => old.filter((row) => row.id !== id)); void refreshSummary(); };
    }, 'Class time deleted.'),
  };
}
export type Store = ReturnType<typeof useStore>;
