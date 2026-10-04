import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { authRoutes, makeRequireUser } from './auth.js';
import { timetableRoutes } from './timetable.js';

const TYPES = ['Assignment', 'Homework', 'Exam', 'Project', 'Others'] as const;
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'] as const;
const STATUSES = ['Not started', 'In progress', 'Complete'] as const;

const classBody = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});
const taskBody = z.object({
  classId: z.string().min(1).max(64),
  type: z.enum(TYPES),
  name: z.string().trim().min(1).max(60),
  priority: z.enum(PRIORITIES),
  status: z.enum(STATUSES),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  grade: z.number().min(0).max(100).nullable(),
});

const CLASS_COLS = { name: 'name', color: 'color' };
const TASK_COLS = { classId: 'class_id', type: 'type', name: 'name', priority: 'priority', status: 'status', due: 'due', grade: 'grade' };
const TASK_SQL = 'SELECT t.* FROM tasks t JOIN classes c ON c.id = t.class_id WHERE c.user_id = ?';

const toTask = (r: Record<string, any>) => ({
  id: r.id, classId: r.class_id, type: r.type, name: r.name,
  priority: r.priority, status: r.status, due: r.due, grade: r.grade,
});
const invalid = (res: Response, issues: unknown) => void res.status(400).json({ error: 'Invalid input', errors: issues });

export function createApp(db: DatabaseSync) {
  const app = express();
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use(express.json());

  const uid = (res: Response) => res.locals.userId as string;
  const getClass = (id: string, user: string) =>
    db.prepare('SELECT id, name, color FROM classes WHERE id = ? AND user_id = ?').get(id, user);
  const getTask = (id: string, user: string) => {
    const r = db.prepare(`${TASK_SQL} AND t.id = ?`).get(user, id);
    return r ? toTask(r) : undefined;
  };
  // Table and column names come from the constants above, never from user input.
  const update = (table: string, cols: Record<string, string>, rowId: string, data: Record<string, unknown>) => {
    const keys = Object.keys(data).filter((k) => k in cols);
    if (!keys.length) return;
    db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => data[k] as SQLInputValue), rowId);
  };

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  authRoutes(app, db);
  const auth = makeRequireUser(db);
  app.use('/api/classes', auth);
  app.use('/api/tasks', auth);
  timetableRoutes(app, db, auth);

  // ---- Classes ----
  app.get('/api/classes', (_req, res) => {
    res.json(db.prepare('SELECT id, name, color FROM classes WHERE user_id = ? ORDER BY rowid').all(uid(res)));
  });
  app.post('/api/classes', (req, res) => {
    const p = classBody.safeParse(req.body);
    if (!p.success) return invalid(res, p.error.issues);
    const id = randomUUID();
    db.prepare('INSERT INTO classes (id, user_id, name, color) VALUES (?, ?, ?, ?)').run(id, uid(res), p.data.name, p.data.color);
    res.status(201).json(getClass(id, uid(res)));
  });
  app.patch('/api/classes/:id', (req, res) => {
    const p = classBody.partial().safeParse(req.body);
    if (!p.success) return invalid(res, p.error.issues);
    if (!getClass(req.params.id, uid(res))) return void res.status(404).json({ error: 'Class not found' });
    update('classes', CLASS_COLS, req.params.id, p.data);
    res.json(getClass(req.params.id, uid(res)));
  });
  app.delete('/api/classes/:id', (req, res) => {
    const r = db.prepare('DELETE FROM classes WHERE id = ? AND user_id = ?').run(req.params.id, uid(res));
    if (!r.changes) return void res.status(404).json({ error: 'Class not found' });
    res.status(204).end();
  });

  // ---- Tasks ----
  app.get('/api/tasks', (req, res) => {
    const classId = typeof req.query.classId === 'string' ? req.query.classId : null;
    const rows = classId
      ? db.prepare(`${TASK_SQL} AND t.class_id = ? ORDER BY t.due, t.rowid`).all(uid(res), classId)
      : db.prepare(`${TASK_SQL} ORDER BY t.due, t.rowid`).all(uid(res));
    res.json(rows.map(toTask));
  });
  app.post('/api/tasks', (req, res) => {
    const p = taskBody.safeParse(req.body);
    if (!p.success) return invalid(res, p.error.issues);
    if (!getClass(p.data.classId, uid(res))) return void res.status(422).json({ error: 'Unknown classId' });
    const id = randomUUID();
    const t = p.data;
    db.prepare('INSERT INTO tasks (id, class_id, type, name, priority, status, due, grade) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, t.classId, t.type, t.name, t.priority, t.status, t.due, t.grade);
    res.status(201).json(getTask(id, uid(res)));
  });
  app.patch('/api/tasks/:id', (req, res) => {
    const p = taskBody.partial().safeParse(req.body);
    if (!p.success) return invalid(res, p.error.issues);
    if (!getTask(req.params.id, uid(res))) return void res.status(404).json({ error: 'Task not found' });
    if (p.data.classId && !getClass(p.data.classId, uid(res))) return void res.status(422).json({ error: 'Unknown classId' });
    update('tasks', TASK_COLS, req.params.id, p.data);
    res.json(getTask(req.params.id, uid(res)));
  });
  app.delete('/api/tasks/:id', (req, res) => {
    const r = db.prepare('DELETE FROM tasks WHERE id = ? AND class_id IN (SELECT id FROM classes WHERE user_id = ?)')
      .run(req.params.id, uid(res));
    if (!r.changes) return void res.status(404).json({ error: 'Task not found' });
    res.status(204).end();
  });

  app.use(express.static(fileURLToPath(new URL('../web/dist', import.meta.url))));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const badJson = err?.status === 400;
    res.status(badJson ? 400 : 500).json({ error: badJson ? 'Invalid JSON' : 'Server error' });
  });
  return app;
}
