import type { Express, NextFunction, Request, Response } from 'express';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type Database, type DbRow, type DbValue } from './db.js';

const COOKIE = 'sp_session';
const SESSION_DAYS = 14;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const credentials = z.object({ email: z.string().trim().toLowerCase().email().max(120), password: z.string().min(8).max(72) });
const registerBody = credentials.extend({ name: z.string().trim().max(40).default('') });
const profileBody = z.object({
  name: z.string().trim().max(40), courseType: z.enum(['', 'Degree', 'Diploma', 'Foundation']), programme: z.string().trim().max(60),
  semesterWeeks: z.union([z.literal(7), z.literal(14)]), semesterStart: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
}).partial();
const toUser = (row: DbRow) => ({
  id: row.id, email: row.email, name: row.name, courseType: row.course_type, programme: row.programme,
  semesterWeeks: row.semester_weeks, semesterStart: row.semester_start,
});
const readToken = (req: Request) => req.headers.cookie?.split(';').map((cookie) => cookie.trim().split('=')).find(([key]) => key === COOKIE)?.[1];

export const makeRequireUser = (db: Database) => async (req: Request, res: Response, next: NextFunction) => {
  const token = readToken(req);
  const session = token ? await db.get('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?', [sha(token), Date.now()]) : undefined;
  if (!session) return void res.status(401).json({ error: 'Please log in' });
  res.locals.userId = String(session.user_id);
  next();
};

export function authRoutes(app: Express, db: Database) {
  const requireUser = makeRequireUser(db);
  const getUser = async (id: string) => toUser((await db.get('SELECT * FROM users WHERE id = ?', [id]))!);
  const startSession = async (res: Response, userId: string) => {
    const token = randomBytes(32).toString('base64url');
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [sha(token), userId, Date.now() + SESSION_DAYS * 864e5]);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_DAYS * 864e5 });
  };

  app.post('/api/auth/register', async (req, res) => {
    const parsed = registerBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Enter a valid email and a password of 8 to 72 characters' });
    const id = randomUUID();
    try {
      await db.run('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)', [id, parsed.data.email, parsed.data.name, hashPassword(parsed.data.password)]);
    } catch {
      return void res.status(409).json({ error: 'That email is already registered' });
    }
    await startSession(res, id);
    res.status(201).json(await getUser(id));
  });

  app.post('/api/auth/login', async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    const row = parsed.success ? await db.get('SELECT * FROM users WHERE email = ?', [parsed.data.email]) : undefined;
    if (!parsed.success || !row || !checkPassword(parsed.data.password, String(row.password_hash))) return void res.status(401).json({ error: 'Invalid email or password' });
    await startSession(res, String(row.id));
    res.json(toUser(row));
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = readToken(req);
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha(token)]);
    res.clearCookie(COOKIE).status(204).end();
  });
  app.get('/api/auth/me', requireUser, async (_req, res) => { res.json(await getUser(res.locals.userId)); });
  app.patch('/api/auth/me', requireUser, async (req, res) => {
    const parsed = profileBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid profile details' });
    const columns = { name: 'name', courseType: 'course_type', programme: 'programme', semesterWeeks: 'semester_weeks', semesterStart: 'semester_start' } as const;
    const keys = (Object.keys(parsed.data) as (keyof typeof columns)[]).filter((key) => key in columns);
    if (keys.length) await db.run(`UPDATE users SET ${keys.map((key) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`, [...keys.map((key) => parsed.data[key] as DbValue), res.locals.userId]);
    res.json(await getUser(res.locals.userId));
  });
  app.delete('/api/auth/me', requireUser, async (_req, res) => {
    await db.run('DELETE FROM users WHERE id = ?', [res.locals.userId]);
    res.clearCookie(COOKIE).status(204).end();
  });
}
