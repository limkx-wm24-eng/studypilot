import type { Express, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Database, type DbRow } from './db.js';

export const REQUIRED_PERCENT: Record<string, number> = { Degree: 80, Diploma: 80, Foundation: 80 };
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slotBody = z.object({
  classId: z.string().min(1).max(64), kind: z.enum(['Lecture', 'Practical', 'Tutorial']), weekday: z.number().int().min(1).max(7),
  start: time, end: time, room: z.string().trim().max(30).default(''),
}).refine((slot) => slot.end > slot.start, { message: 'The end time must be after the start time' });
const markBody = z.object({ slotId: z.string().min(1), date, status: z.enum(['present', 'absent', 'leave']).nullable() });
const mins = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const isoWeekday = (value: string) => ((new Date(`${value}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
const toSlot = (row: DbRow) => ({ id: row.id, classId: row.class_id, kind: row.kind, weekday: row.weekday, start: row.start_time, end: row.end_time, room: row.room });

export function timetableRoutes(app: Express, db: Database, auth: RequestHandler) {
  const uid = (res: Response) => res.locals.userId as string;
  const SLOT_SQL = 'SELECT s.* FROM slots s JOIN classes c ON c.id = s.class_id WHERE c.user_id = ?';
  const getSlot = (id: string, user: string) => db.get(`${SLOT_SQL} AND s.id = ?`, [user, id]);
  app.use('/api/slots', auth);
  app.use('/api/attendance', auth);

  app.get('/api/slots', async (_req, res) => {
    res.json((await db.all(`${SLOT_SQL} ORDER BY s.weekday, s.start_time`, [uid(res)])).map(toSlot));
  });
  app.post('/api/slots', async (req, res) => {
    const parsed = slotBody.safeParse(req.body);
    if (!parsed.success) {
      const custom = parsed.error.issues.find((issue) => issue.code === 'custom')?.message;
      return void res.status(400).json({ error: custom ?? 'Check the class, day and times' });
    }
    const slot = parsed.data;
    if (!await db.get('SELECT 1 FROM classes WHERE id = ? AND user_id = ?', [slot.classId, uid(res)])) return void res.status(422).json({ error: 'Unknown classId' });
    const clash = await db.get(`${SLOT_SQL} AND s.weekday = ? AND s.start_time < ? AND s.end_time > ?`, [uid(res), slot.weekday, slot.end, slot.start]);
    if (clash) return void res.status(409).json({ error: 'This time overlaps another class on the same day' });
    const id = randomUUID();
    await db.run('INSERT INTO slots (id, class_id, kind, weekday, start_time, end_time, room) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, slot.classId, slot.kind, slot.weekday, slot.start, slot.end, slot.room]);
    res.status(201).json(toSlot((await getSlot(id, uid(res)))!));
  });
  app.delete('/api/slots/:id', async (req, res) => {
    const result = await db.run('DELETE FROM slots WHERE id = ? AND class_id IN (SELECT id FROM classes WHERE user_id = ?)', [req.params.id, uid(res)]);
    if (!result.changes) return void res.status(404).json({ error: 'Class time not found' });
    res.status(204).end();
  });

  app.get('/api/attendance', async (req, res) => {
    const from = date.safeParse(req.query.from);
    const to = date.safeParse(req.query.to);
    if (!from.success || !to.success) return void res.status(400).json({ error: 'from and to must be YYYY-MM-DD dates' });
    res.json(await db.all(`SELECT a.slot_id AS "slotId", a.date, a.status FROM attendance a JOIN slots s ON s.id = a.slot_id JOIN classes c ON c.id = s.class_id WHERE c.user_id = ? AND a.date BETWEEN ? AND ? ORDER BY a.date`, [uid(res), from.data, to.data]));
  });
  app.put('/api/attendance', async (req, res) => {
    const parsed = markBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid input' });
    const slot = await getSlot(parsed.data.slotId, uid(res));
    if (!slot) return void res.status(404).json({ error: 'Class time not found' });
    if (isoWeekday(parsed.data.date) !== Number(slot.weekday)) return void res.status(422).json({ error: 'That date is not on this class day' });
    if (parsed.data.status === null) await db.run('DELETE FROM attendance WHERE slot_id = ? AND date = ?', [parsed.data.slotId, parsed.data.date]);
    else await db.run('INSERT INTO attendance (slot_id, date, status) VALUES (?, ?, ?) ON CONFLICT(slot_id, date) DO UPDATE SET status = excluded.status', [parsed.data.slotId, parsed.data.date, parsed.data.status]);
    res.json(parsed.data);
  });

  app.get('/api/attendance/summary', async (_req, res) => {
    const user = (await db.get('SELECT course_type, semester_weeks, semester_start FROM users WHERE id = ?', [uid(res)]))!;
    const required = REQUIRED_PERCENT[String(user.course_type)] ?? null;
    const weeks = Number(user.semester_weeks);
    const start = String(user.semester_start);
    const endMs = new Date(`${start}T00:00:00Z`).getTime() + weeks * 7 * 864e5;
    const from = start || '0000-01-01';
    const to = start && !Number.isNaN(endMs) ? new Date(endMs).toISOString().slice(0, 10) : '9999-12-31';
    const per = new Map<string, { weekly: number; present: number; absent: number; leave: number }>();
    const entry = (id: string) => per.get(id) ?? per.set(id, { weekly: 0, present: 0, absent: 0, leave: 0 }).get(id)!;
    for (const row of await db.all(SLOT_SQL, [uid(res)])) entry(String(row.class_id)).weekly += mins(String(row.end_time)) - mins(String(row.start_time));
    const logs = await db.all(`SELECT s.class_id, a.status, s.start_time, s.end_time FROM attendance a JOIN slots s ON s.id = a.slot_id JOIN classes c ON c.id = s.class_id WHERE c.user_id = ? AND a.date >= ? AND a.date < ?`, [uid(res), from, to]);
    for (const log of logs) entry(String(log.class_id))[String(log.status) as 'present' | 'absent' | 'leave'] += mins(String(log.end_time)) - mins(String(log.start_time));
    const classes = [...per].map(([classId, value]) => {
      const total = value.weekly * weeks;
      const allowed = required === null ? null : Math.floor((total * (100 - required)) / 100 / 60) * 60;
      const remaining = allowed === null ? null : allowed - value.absent;
      const logged = value.present + value.absent + value.leave;
      return { classId, weeklyHours: hours(value.weekly), totalHours: hours(total), allowedHours: allowed === null ? null : hours(allowed), absentHours: hours(value.absent), leaveHours: hours(value.leave), loggedHours: hours(logged), remainingHours: remaining === null ? null : hours(remaining), percent: logged ? Math.round(((logged - value.absent) / logged) * 1000) / 10 : null, state: remaining === null ? 'unknown' : remaining < 0 ? 'over' : remaining <= value.weekly ? 'careful' : 'ok' };
    });
    res.json({ requiredPercent: required, weeks, semesterStart: start, classes });
  });
}
