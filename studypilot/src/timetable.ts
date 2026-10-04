import type { Express, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';

// Minimum attendance by course type. Check these against your faculty's official rules.
export const REQUIRED_PERCENT: Record<string, number> = { Degree: 80, Diploma: 80, Foundation: 80 };

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slotBody = z
  .object({
    classId: z.string().min(1).max(64),
    kind: z.enum(['Lecture', 'Practical', 'Tutorial']),
    weekday: z.number().int().min(1).max(7), // 1 = Monday ... 7 = Sunday
    start: time,
    end: time,
    room: z.string().trim().max(30).default(''),
  })
  .refine((s) => s.end > s.start, { message: 'The end time must be after the start time' });
const markBody = z.object({
  slotId: z.string().min(1),
  date,
  status: z.enum(['present', 'absent', 'leave']).nullable(), // null clears the mark
});

const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const isoWeekday = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const hours = (m: number) => Math.round((m / 60) * 100) / 100;
const toSlot = (r: Record<string, any>) => ({
  id: r.id, classId: r.class_id, kind: r.kind, weekday: r.weekday, start: r.start_time, end: r.end_time, room: r.room,
});

export function timetableRoutes(app: Express, db: DatabaseSync, auth: RequestHandler) {
  const uid = (res: Response) => res.locals.userId as string;
  const SLOT_SQL = 'SELECT s.* FROM slots s JOIN classes c ON c.id = s.class_id WHERE c.user_id = ?';
  const getSlot = (id: string, user: string) => db.prepare(`${SLOT_SQL} AND s.id = ?`).get(user, id);
  app.use('/api/slots', auth);
  app.use('/api/attendance', auth);

  // ---- Weekly class times ----
  app.get('/api/slots', (_req, res) => {
    res.json(db.prepare(`${SLOT_SQL} ORDER BY s.weekday, s.start_time`).all(uid(res)).map(toSlot));
  });
  app.post('/api/slots', (req, res) => {
    const p = slotBody.safeParse(req.body);
    if (!p.success) {
      const custom = p.error.issues.find((i) => i.code === 'custom')?.message;
      return void res.status(400).json({ error: custom ?? 'Check the class, day and times' });
    }
    const s = p.data;
    if (!db.prepare('SELECT 1 FROM classes WHERE id = ? AND user_id = ?').get(s.classId, uid(res))) {
      return void res.status(422).json({ error: 'Unknown classId' });
    }
    const clash = db.prepare(`${SLOT_SQL} AND s.weekday = ? AND s.start_time < ? AND s.end_time > ?`).get(uid(res), s.weekday, s.end, s.start);
    if (clash) return void res.status(409).json({ error: 'This time overlaps another class on the same day' });
    const id = randomUUID();
    db.prepare('INSERT INTO slots (id, class_id, kind, weekday, start_time, end_time, room) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, s.classId, s.kind, s.weekday, s.start, s.end, s.room);
    res.status(201).json(toSlot(getSlot(id, uid(res))!));
  });
  app.delete('/api/slots/:id', (req, res) => {
    const r = db.prepare('DELETE FROM slots WHERE id = ? AND class_id IN (SELECT id FROM classes WHERE user_id = ?)').run(req.params.id, uid(res));
    if (!r.changes) return void res.status(404).json({ error: 'Class time not found' });
    res.status(204).end();
  });

  // ---- Attendance log ----
  app.get('/api/attendance', (req, res) => {
    const from = date.safeParse(req.query.from);
    const to = date.safeParse(req.query.to);
    if (!from.success || !to.success) return void res.status(400).json({ error: 'from and to must be YYYY-MM-DD dates' });
    res.json(
      db.prepare(
        `SELECT a.slot_id AS slotId, a.date, a.status FROM attendance a
         JOIN slots s ON s.id = a.slot_id JOIN classes c ON c.id = s.class_id
         WHERE c.user_id = ? AND a.date BETWEEN ? AND ? ORDER BY a.date`,
      ).all(uid(res), from.data, to.data),
    );
  });
  app.put('/api/attendance', (req, res) => {
    const p = markBody.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: 'Invalid input' });
    const slot = getSlot(p.data.slotId, uid(res));
    if (!slot) return void res.status(404).json({ error: 'Class time not found' });
    if (isoWeekday(p.data.date) !== slot.weekday) return void res.status(422).json({ error: 'That date is not on this class day' });
    if (p.data.status === null) {
      db.prepare('DELETE FROM attendance WHERE slot_id = ? AND date = ?').run(p.data.slotId, p.data.date);
    } else {
      db.prepare('INSERT INTO attendance (slot_id, date, status) VALUES (?, ?, ?) ON CONFLICT(slot_id, date) DO UPDATE SET status = excluded.status')
        .run(p.data.slotId, p.data.date, p.data.status);
    }
    res.json(p.data);
  });

  // Per-class allowance. Present and approved leave both count as attended; only absences use up the allowance.
  app.get('/api/attendance/summary', (_req, res) => {
    const user = db.prepare('SELECT course_type, semester_weeks, semester_start FROM users WHERE id = ?').get(uid(res))!;
    const required = REQUIRED_PERCENT[String(user.course_type)] ?? null;
    const weeks = Number(user.semester_weeks);
    // With a start date, only classes inside that semester's teaching weeks are counted.
    const start = String(user.semester_start);
    const endMs = new Date(`${start}T00:00:00Z`).getTime() + weeks * 7 * 864e5;
    const from = start || '0000-01-01';
    const to = start && !Number.isNaN(endMs) ? new Date(endMs).toISOString().slice(0, 10) : '9999-12-31';
    const per = new Map<string, { weekly: number; present: number; absent: number; leave: number }>();
    const entry = (id: string) => per.get(id) ?? per.set(id, { weekly: 0, present: 0, absent: 0, leave: 0 }).get(id)!;
    for (const r of db.prepare(SLOT_SQL).all(uid(res))) entry(String(r.class_id)).weekly += mins(String(r.end_time)) - mins(String(r.start_time));
    const logs = db.prepare(
      `SELECT s.class_id, a.status, s.start_time, s.end_time FROM attendance a
       JOIN slots s ON s.id = a.slot_id JOIN classes c ON c.id = s.class_id WHERE c.user_id = ? AND a.date >= ? AND a.date < ?`,
    ).all(uid(res), from, to);
    for (const l of logs) entry(String(l.class_id))[String(l.status) as 'present' | 'absent' | 'leave'] += mins(String(l.end_time)) - mins(String(l.start_time));

    const classes = [...per].map(([classId, v]) => {
      const total = v.weekly * weeks;
      const allowed = required === null ? null : Math.floor((total * (100 - required)) / 100 / 60) * 60; // whole hours
      const remaining = allowed === null ? null : allowed - v.absent;
      const logged = v.present + v.absent + v.leave;
      return {
        classId,
        weeklyHours: hours(v.weekly),
        totalHours: hours(total),
        allowedHours: allowed === null ? null : hours(allowed),
        absentHours: hours(v.absent),
        leaveHours: hours(v.leave),
        loggedHours: hours(logged),
        remainingHours: remaining === null ? null : hours(remaining),
        percent: logged ? Math.round(((logged - v.absent) / logged) * 1000) / 10 : null,
        state: remaining === null ? 'unknown' : remaining < 0 ? 'over' : remaining <= v.weekly ? 'careful' : 'ok',
      };
    });
    res.json({ requiredPercent: required, weeks, semesterStart: start, classes });
  });
}
