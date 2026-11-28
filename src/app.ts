import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { authRoutes, makeRequireUser } from './auth.js';
import { type Database, type DbRow, type DbValue } from './db.js';
import { createMailer, emailEnabled, type Mailer } from './mailer.js';
import { timetableRoutes } from './timetable.js';
import { className } from './classSchema.js';
import { timetableImportRoutes } from './timetableImport.js';
import { calendarDate, resourceId, singleLineText } from './validation.js';
import { UserUnavailable, withUserTransaction } from './userTransaction.js';
import { checkRequestOrigin } from './requestOrigin.js';
import { PasswordQueueFull, AUTH_BUSY_MESSAGE, type PasswordService } from './passwords.js';
import { ingressBoundary, loadIngressConfig, type IngressConfig } from './ingress.js';

const TYPES = ['Assignment', 'Homework', 'Exam', 'Project', 'Others'] as const;
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'] as const;
const STATUSES = ['Not started', 'In progress', 'Complete'] as const;

const classBody = z.object({ name: className, color: z.string().regex(/^#[0-9a-f]{6}$/i) });
const taskBody = z.object({
  classId: z.string().min(1).max(64), type: z.enum(TYPES), name: singleLineText.min(1).max(60),
  priority: z.enum(PRIORITIES), status: z.enum(STATUSES), due: calendarDate, grade: z.number().min(0).max(100).nullable(),
});
const GRADES = ['A', 'A−', 'B+', 'B', 'B−', 'C+', 'C'] as const;
const courseBody = z.object({
  semesterLabel: singleLineText.min(1).max(40), courseName: singleLineText.min(1).max(80),
  creditHours: z.number().positive().max(12), grade: z.enum(GRADES).nullable(),
});
const CLASS_COLS = { name: 'name', color: 'color' };
const TASK_COLS = { classId: 'class_id', type: 'type', name: 'name', priority: 'priority', status: 'status', due: 'due', grade: 'grade' };
const TASK_SQL = 'SELECT t.* FROM tasks t JOIN classes c ON c.id = t.class_id WHERE c.user_id = ?';
const toTask = (r: DbRow) => ({
  id: r.id, classId: r.class_id, type: r.type, name: r.name, priority: r.priority, status: r.status, due: r.due, grade: r.grade,
});
const toCourse = (r: DbRow) => ({ id: r.id, semesterLabel: r.semester_label, courseName: r.course_name, creditHours: Number(r.credit_hours), grade: r.grade });
const toClass = (r: DbRow) => ({ id: r.id, name: r.name, color: r.color });
const invalid = (res: Response, issues: unknown) => void res.status(400).json({ error: 'Invalid input', errors: issues });

export function createApp(db: Database, options: { mailer?: Mailer; passwords?: PasswordService; ingress?: IngressConfig } = {}) {
  const app = express();
  const ingress = options.ingress ?? loadIngressConfig();
  const mailer = options.mailer ?? createMailer();
  app.set('trust proxy', false); // Forwarded Host/protocol never gain implicit trust.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        workerSrc: ["'self'"],
      },
    },
  }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(ingressBoundary(ingress));
  app.use('/api', checkRequestOrigin);
  app.use(express.json());
  app.param('id', (_req, res, next, value) => {
    const parsed = resourceId.safeParse(value);
    if (!parsed.success) return invalid(res, parsed.error.issues);
    next();
  });
  const uid = (res: Response) => res.locals.userId as string;
  const getClass = (id: string, user: string) => db.get('SELECT id, name, color FROM classes WHERE id = ? AND user_id = ?', [id, user]);
  const getTask = async (id: string, user: string) => {
    const row = await db.get(`${TASK_SQL} AND t.id = ?`, [user, id]);
    return row ? toTask(row) : undefined;
  };
  const update = async (transaction: Database, table: string, cols: Record<string, string>, rowId: string, data: Record<string, unknown>, ownership: string, userId: string) => {
    const keys = Object.keys(data).filter((key) => key in cols);
    if (!keys.length) return transaction.get(`SELECT * FROM ${table} WHERE id = ? AND ${ownership}`, [rowId, userId]);
    return transaction.get(`UPDATE ${table} SET ${keys.map((key) => `${cols[key]} = ?`).join(', ')} WHERE id = ? AND ${ownership} RETURNING *`, [...keys.map((key) => data[key] as DbValue), rowId, userId]);
  };

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/config', (_req, res) => { res.json({ emailEnabled: emailEnabled(mailer) }); });
  authRoutes(app, db, { mailer, passwords: options.passwords });
  const auth = makeRequireUser(db);
  app.use('/api/classes', auth);
  app.use('/api/tasks', auth);
  app.use('/api/courses', auth);
  timetableRoutes(app, db, auth);
  timetableImportRoutes(app, db, auth);

  app.get('/api/classes', async (_req, res) => {
    res.json(await db.all('SELECT id, name, color FROM classes WHERE user_id = ? ORDER BY created_at, id', [uid(res)]));
  });
  app.post('/api/classes', async (req, res) => {
    const parsed = classBody.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.issues);
    const id = randomUUID();
    await db.run('INSERT INTO classes (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)', [id, uid(res), parsed.data.name, parsed.data.color, Date.now()]);
    res.status(201).json(await getClass(id, uid(res)));
  });
  app.patch('/api/classes/:id', async (req, res) => {
    const parsed = classBody.partial().safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.issues);
    const row = await withUserTransaction(db, uid(res), (transaction) => update(transaction, 'classes', CLASS_COLS, req.params.id, parsed.data, 'user_id = ?', uid(res)));
    if (!row) return void res.status(404).json({ error: 'Class not found' });
    res.json(toClass(row));
  });
  app.delete('/api/classes/:id', async (req, res) => {
    const result = await withUserTransaction(db, uid(res), (transaction) => transaction.run('DELETE FROM classes WHERE id = ? AND user_id = ?', [req.params.id, uid(res)]));
    if (!result.changes) return void res.status(404).json({ error: 'Class not found' });
    res.status(204).end();
  });

  app.get('/api/tasks', async (req, res) => {
    const parsed = z.object({ classId: resourceId.optional() }).safeParse(req.query);
    if (!parsed.success) return invalid(res, parsed.error.issues);
    const classId = parsed.data.classId;
    const rows = classId
      ? await db.all(`${TASK_SQL} AND t.class_id = ? ORDER BY t.due, t.created_at, t.id`, [uid(res), classId])
      : await db.all(`${TASK_SQL} ORDER BY t.due, t.created_at, t.id`, [uid(res)]);
    res.json(rows.map(toTask));
  });
  app.post('/api/tasks', async (req, res) => {
    const parsed = taskBody.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.issues);
    if (!await getClass(parsed.data.classId, uid(res))) return void res.status(422).json({ error: 'Unknown classId' });
    const id = randomUUID();
    const task = parsed.data;
    await db.run('INSERT INTO tasks (id, class_id, type, name, priority, status, due, grade, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, task.classId, task.type, task.name, task.priority, task.status, task.due, task.grade, Date.now()]);
    res.status(201).json(await getTask(id, uid(res)));
  });
  app.patch('/api/tasks/:id', async (req, res) => {
    const parsed = taskBody.partial().safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.issues);
    const result = await withUserTransaction(db, uid(res), async (transaction) => {
      if (!await transaction.get(`${TASK_SQL} AND t.id = ?`, [uid(res), req.params.id])) return { status: 404, body: { error: 'Task not found' } };
      if (parsed.data.classId && !await transaction.get('SELECT 1 FROM classes WHERE id = ? AND user_id = ?', [parsed.data.classId, uid(res)])) return { status: 422, body: { error: 'Unknown classId' } };
      const row = await update(transaction, 'tasks', TASK_COLS, req.params.id, parsed.data, 'class_id IN (SELECT id FROM classes WHERE user_id = ?)', uid(res));
      return row ? { status: 200, body: toTask(row) } : { status: 404, body: { error: 'Task not found' } };
    });
    res.status(result.status).json(result.body);
  });
  app.delete('/api/tasks/:id', async (req, res) => {
    const result = await db.run('DELETE FROM tasks WHERE id = ? AND class_id IN (SELECT id FROM classes WHERE user_id = ?)', [req.params.id, uid(res)]);
    if (!result.changes) return void res.status(404).json({ error: 'Task not found' });
    res.status(204).end();
  });

  app.get('/api/courses', async (_req, res) => {
    res.json((await db.all('SELECT * FROM courses WHERE user_id = ? ORDER BY semester_label, course_name, id', [uid(res)])).map(toCourse));
  });
  app.post('/api/courses', async (req, res) => {
    const parsed = courseBody.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.issues);
    const id = randomUUID();
    await db.run('INSERT INTO courses (id, user_id, semester_label, course_name, credit_hours, grade) VALUES (?, ?, ?, ?, ?, ?)', [id, uid(res), parsed.data.semesterLabel, parsed.data.courseName, parsed.data.creditHours, parsed.data.grade]);
    res.status(201).json(toCourse((await db.get('SELECT * FROM courses WHERE id = ? AND user_id = ?', [id, uid(res)]))!));
  });
  app.patch('/api/courses/:id', async (req, res) => {
    const parsed = courseBody.partial().safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.issues);
    const columns = { semesterLabel: 'semester_label', courseName: 'course_name', creditHours: 'credit_hours', grade: 'grade' };
    const row = await withUserTransaction(db, uid(res), (transaction) => update(transaction, 'courses', columns, req.params.id, parsed.data, 'user_id = ?', uid(res)));
    if (!row) return void res.status(404).json({ error: 'Course not found' });
    res.json(toCourse(row));
  });
  app.delete('/api/courses/:id', async (req, res) => {
    const result = await db.run('DELETE FROM courses WHERE id = ? AND user_id = ?', [req.params.id, uid(res)]);
    if (!result.changes) return void res.status(404).json({ error: 'Course not found' });
    res.status(204).end();
  });

  const webDist = fileURLToPath(new URL('../web/dist', import.meta.url));
  app.get('/manifest.webmanifest', (_req, res) => { res.type('application/manifest+json').sendFile('manifest.webmanifest', { root: webDist }); });
  app.get('/sw.js', (_req, res) => { res.type('application/javascript').set('Cache-Control', 'no-store, max-age=0').sendFile('sw.js', { root: webDist }); });
  app.use(express.static(webDist));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof UserUnavailable) return void res.status(401).json({ error: 'Please log in' });
    if (err instanceof PasswordQueueFull) return void res.set('Retry-After', '1').status(503).json({ error: AUTH_BUSY_MESSAGE });
    const status = typeof err === 'object' && err !== null && 'status' in err ? err.status : undefined;
    const code = status === 400 || status === 413 ? status : 500;
    res.status(code).json({ error: code === 400 ? 'Invalid JSON' : code === 413 ? 'Request body too large' : 'Server error' });
  });
  return app;
}
