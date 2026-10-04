import type { Express, NextFunction, Request, Response } from 'express';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const COOKIE = 'sp_session';
const SESSION_DAYS = 14;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function checkPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const a = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(8).max(72),
});
const registerBody = credentials.extend({ name: z.string().trim().max(40).default('') });
const profileBody = z
  .object({
    name: z.string().trim().max(40),
    courseType: z.enum(['', 'Degree', 'Diploma', 'Foundation']),
    programme: z.string().trim().max(60),
    semesterWeeks: z.union([z.literal(7), z.literal(14)]), // short semester = 7 teaching weeks, long = 14
    semesterStart: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  })
  .partial();

const toUser = (r: Record<string, any>) => ({
  id: r.id, email: r.email, name: r.name, courseType: r.course_type, programme: r.programme, semesterWeeks: r.semester_weeks, semesterStart: r.semester_start,
});
const readToken = (req: Request) =>
  req.headers.cookie?.split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1];

export const makeRequireUser = (db: DatabaseSync) => (req: Request, res: Response, next: NextFunction) => {
  const token = readToken(req);
  const s = token
    ? db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha(token), Date.now())
    : undefined;
  if (!s) return void res.status(401).json({ error: 'Please log in' });
  res.locals.userId = String(s.user_id);
  next();
};

export function authRoutes(app: Express, db: DatabaseSync) {
  const requireUser = makeRequireUser(db);
  const getUser = (id: string) => toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)!);
  const startSession = (res: Response, userId: string) => {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_DAYS * 864e5,
    });
  };

  app.post('/api/auth/register', (req, res) => {
    const p = registerBody.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: 'Enter a valid email and a password of 8 to 72 characters' });
    const id = randomUUID();
    try {
      db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
        .run(id, p.data.email, p.data.name, hashPassword(p.data.password));
    } catch {
      return void res.status(409).json({ error: 'That email is already registered' });
    }
    startSession(res, id);
    res.status(201).json(getUser(id));
  });

  app.post('/api/auth/login', (req, res) => {
    const p = credentials.safeParse(req.body);
    const row = p.success ? db.prepare('SELECT * FROM users WHERE email = ?').get(p.data.email) : undefined;
    if (!p.success || !row || !checkPassword(p.data.password, String(row.password_hash))) {
      return void res.status(401).json({ error: 'Invalid email or password' });
    }
    startSession(res, String(row.id));
    res.json(toUser(row));
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = readToken(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
    res.clearCookie(COOKIE).status(204).end();
  });

  app.get('/api/auth/me', requireUser, (_req, res) => { res.json(getUser(res.locals.userId)); });

  app.patch('/api/auth/me', requireUser, (req, res) => {
    const p = profileBody.safeParse(req.body);
    if (!p.success) return void res.status(400).json({ error: 'Invalid profile details' });
    const cols = { name: 'name', courseType: 'course_type', programme: 'programme', semesterWeeks: 'semester_weeks', semesterStart: 'semester_start' } as const;
    const keys = (Object.keys(p.data) as (keyof typeof cols)[]).filter((k) => k in cols);
    if (keys.length) {
      db.prepare(`UPDATE users SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => p.data[k] as string | number), res.locals.userId);
    }
    res.json(getUser(res.locals.userId));
  });

  app.delete('/api/auth/me', requireUser, (_req, res) => {
    db.prepare('DELETE FROM users WHERE id = ?').run(res.locals.userId); // sessions, classes and tasks cascade
    res.clearCookie(COOKIE).status(204).end();
  });
}
