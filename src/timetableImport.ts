import type { Express, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import { className, CLASS_PALETTE } from './classSchema.js';
import { slotFields, validSlotOrder } from './timetable.js';

const body = z.object({
  classes: z.array(z.object({ name: className })).default([]),
  slots: z.array(slotFields.extend({ className }).refine(validSlotOrder, { message: 'The end time must be after the start time' })).max(200),
}).refine((data) => new Set([...data.classes.map((c) => c.name.toLowerCase()), ...data.slots.map((s) => s.className.toLowerCase())]).size <= 40,
  { message: 'Import at most 40 distinct classes' });
type Conflict = { row: number; with: number | 'existing' };
class ImportConflict extends Error {
  constructor(readonly conflicts: Conflict[]) { super('Some sessions overlap. Review the highlighted rows.'); }
}

export function timetableImportRoutes(app: Express, db: Database, auth: RequestHandler) {
  const attempts = new Map<string, number[]>();
  app.post('/api/import/timetable', auth, async (req, res) => {
    const userId = String(res.locals.userId);
    const now = Date.now();
    // Bound retained rate-limit state to active users in the last hour.
    for (const [key, times] of attempts) if (times[times.length - 1] <= now - 3_600_000) attempts.delete(key);
    const recent = (attempts.get(userId) ?? []).filter((time) => time > now - 3_600_000);
    if (recent.length >= 10) return void res.set('Retry-After', String(Math.max(1, Math.ceil((recent[0] + 3_600_000 - now) / 1000))))
      .status(429).json({ error: 'Try importing again in an hour.' });
    attempts.set(userId, [...recent, now]);
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Check the classes, days and times', errors: parsed.error.issues });
    try {
      const result = await db.transaction(async (tx) => {
        // Serialize imports for this user on PostgreSQL; SQLite transactions already serialize writers.
        await tx.run('UPDATE users SET id = id WHERE id = ?', [userId]);
        const classes = await tx.all('SELECT id, name FROM classes WHERE user_id = ? ORDER BY created_at, id', [userId]);
        const names = new Map(classes.map((c) => [String(c.name).toLowerCase(), String(c.id)]));
        const existing = await tx.all('SELECT s.*, c.name FROM slots s JOIN classes c ON c.id = s.class_id WHERE c.user_id = ?', [userId]);
        const seen = existing.map((s) => ({ name: String(s.name).toLowerCase(), weekday: Number(s.weekday), start: String(s.start_time), end: String(s.end_time), row: 0 }));
        const additions: typeof parsed.data.slots = [];
        const conflicts: Conflict[] = [];
        let skipped = 0;
        parsed.data.slots.forEach((slot, index) => {
          const name = slot.className.toLowerCase();
          if (seen.some((s) => s.name === name && s.weekday === slot.weekday && s.start === slot.start && s.end === slot.end)) { skipped++; return; }
          for (const other of seen) if (other.weekday === slot.weekday && slot.start < other.end && slot.end > other.start)
            conflicts.push({ row: index + 1, with: other.row || 'existing' });
          seen.push({ name, weekday: slot.weekday, start: slot.start, end: slot.end, row: index + 1 });
          additions.push(slot);
        });
        if (conflicts.length) throw new ImportConflict(conflicts);
        let createdClasses = 0;
        for (const name of [...parsed.data.classes.map((c) => c.name), ...additions.map((s) => s.className)]) {
          if (names.has(name.toLowerCase())) continue;
          const id = randomUUID();
          await tx.run('INSERT INTO classes (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
            [id, userId, name, CLASS_PALETTE[(classes.length + createdClasses) % CLASS_PALETTE.length], now]);
          names.set(name.toLowerCase(), id);
          createdClasses++;
        }
        for (const slot of additions) await tx.run('INSERT INTO slots (id, class_id, kind, weekday, start_time, end_time, room) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [randomUUID(), names.get(slot.className.toLowerCase())!, slot.kind, slot.weekday, slot.start, slot.end, slot.room]);
        return { createdClasses, createdSlots: additions.length, skipped };
      });
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof ImportConflict) return void res.status(409).json({ error: error.message, conflicts: error.conflicts });
      throw error;
    }
  });
}
