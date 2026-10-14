import type { Express, NextFunction, Request, Response } from 'express';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type Database, type DbRow, type DbValue } from './db.js';
import { createMailer, type Mailer } from './mailer.js';

const COOKIE = 'sp_session';
const SESSION_DAYS = 14;
const RESET_TOKEN_MINUTES = 30;
const EMAIL_TOKEN_HOURS = 24;
const RESEND_MINUTE_MS = 60_000;
const RESEND_DAY_MS = 24 * 60 * 60_000;
const FORGOT_MESSAGE = 'If an account exists for that email, we sent a reset link.';
const RESET_INVALID_MESSAGE = 'This reset link is invalid or has expired.';
const AUTH_FAILURE_LIMIT = 5;
const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export interface AuthFailureStore {
  retryAfter(email: string | undefined, ip: string, now: number): number | undefined;
  recordFailure(email: string | undefined, ip: string, now: number): number | undefined;
  clearEmail(email: string | undefined): void;
}

export class InMemoryAuthFailureStore implements AuthFailureStore {
  private readonly failures = new Map<string, number[]>();

  private keys(email: string | undefined, ip: string): string[] {
    return [...(email ? [`email:${email}`] : []), `ip:${ip}`];
  }

  private activeFailures(key: string, now: number): number[] {
    const active = (this.failures.get(key) ?? []).filter((time) => time > now - AUTH_FAILURE_WINDOW_MS);
    if (active.length) this.failures.set(key, active);
    else this.failures.delete(key);
    return active;
  }

  retryAfter(email: string | undefined, ip: string, now: number): number | undefined {
    const retries = this.keys(email, ip).flatMap((key) => {
      const active = this.activeFailures(key, now);
      return active.length >= AUTH_FAILURE_LIMIT
        ? [Math.max(1, Math.ceil((active[0] + AUTH_FAILURE_WINDOW_MS - now) / 1000))]
        : [];
    });
    return retries.length ? Math.max(...retries) : undefined;
  }

  recordFailure(email: string | undefined, ip: string, now: number): number | undefined {
    for (const key of this.keys(email, ip)) {
      const active = this.activeFailures(key, now);
      active.push(now);
      this.failures.set(key, active);
    }
    return this.retryAfter(email, ip, now);
  }

  clearEmail(email: string | undefined): void {
    if (email) this.failures.delete(`email:${email}`);
  }
}

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
const loginBody = credentials.extend({ rememberMe: z.boolean().default(false) });
const registerBody = credentials.extend({ name: z.string().trim().max(40).default('') });
const forgotBody = z.object({ email: credentials.shape.email });
const resetBody = z.object({ token: z.string().min(1).max(128), newPassword: credentials.shape.password });
const emailChangeBody = z.object({ newEmail: credentials.shape.email, password: z.string().max(72) });
const profileBody = z.object({
  name: z.string().trim().max(40), courseType: z.enum(['', 'Degree', 'Diploma', 'Foundation']), programme: z.string().trim().max(60),
  semesterWeeks: z.union([z.literal(7), z.literal(14)]), semesterStart: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  reminderDays: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(7)]),
}).partial();
const toUser = (row: DbRow) => ({
  id: row.id, email: row.email, name: row.name, courseType: row.course_type, programme: row.programme,
  semesterWeeks: row.semester_weeks, semesterStart: row.semester_start, reminderDays: row.reminder_days,
  emailVerified: row.email_verified_at !== null && row.email_verified_at !== undefined,
});
const readToken = (req: Request) => req.headers.cookie?.split(';').map((cookie) => cookie.trim().split('=')).find(([key]) => key === COOKIE)?.[1];
const getAttemptEmail = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object' || !('email' in body) || typeof body.email !== 'string') return undefined;
  const email = body.email.trim().toLowerCase();
  return email && email.length <= 120 ? email : undefined;
};
const getClientIp = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';
const isUniqueConstraintViolation = (error: unknown) => {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === '23505' || error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT_UNIQUE';
};

export const makeRequireUser = (db: Database) => async (req: Request, res: Response, next: NextFunction) => {
  const token = readToken(req);
  const session = token ? await db.get('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?', [sha(token), Date.now()]) : undefined;
  if (!session) return void res.status(401).json({ error: 'Please log in' });
  res.locals.userId = String(session.user_id);
  next();
};

export function authRoutes(
  app: Express,
  db: Database,
  options: { mailer?: Mailer } = {},
  failures: AuthFailureStore = new InMemoryAuthFailureStore(),
) {
  const mailer = options.mailer ?? createMailer();
  const requireUser = makeRequireUser(db);
  const getUser = async (id: string) => toUser((await db.get('SELECT * FROM users WHERE id = ?', [id]))!);
  const getProfile = async (id: string) => {
    const user = await getUser(id);
    const pending = await db.get(
      "SELECT new_email FROM auth_tokens WHERE user_id = ? AND purpose = 'change_email' AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
      [id, Date.now()],
    );
    return { ...user, pendingEmail: pending ? String(pending.new_email) : null };
  };
  const emailExists = async (email: string, excludingUserId?: string, database: Database = db) => Boolean(await database.get(
    excludingUserId
      ? 'SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?'
      : 'SELECT id FROM users WHERE LOWER(email) = LOWER(?)',
    excludingUserId ? [email, excludingUserId] : [email],
  ));
  const rejectIfLimited = (res: Response, email: string | undefined, ip: string) => {
    const retryAfter = failures.retryAfter(email, ip, Date.now());
    if (retryAfter === undefined) return false;
    res.set('Retry-After', String(retryAfter)).status(429).json({ error: 'Too many failed authentication attempts. Try again later.' });
    return true;
  };
  const failAuthentication = (res: Response, email: string | undefined, ip: string, status: number, message: string) => {
    const retryAfter = failures.recordFailure(email, ip, Date.now());
    if (retryAfter !== undefined) {
      res.set('Retry-After', String(retryAfter)).status(429).json({ error: 'Too many failed authentication attempts. Try again later.' });
      return;
    }
    res.status(status).json({ error: message });
  };
  const startSession = async (res: Response, userId: string, rememberMe = true) => {
    const token = randomBytes(32).toString('base64url');
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [sha(token), userId, Date.now() + SESSION_DAYS * 864e5]);
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      ...(rememberMe ? { maxAge: SESSION_DAYS * 864e5 } : {}),
    });
  };
  const createAuthToken = async (userId: string, purpose: 'verify' | 'change_email', newEmail: string | null = null) => {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const created = await db.transaction(async (transaction) => {
      const locked = await transaction.run('UPDATE users SET id = id WHERE id = ?', [userId]);
      if (!locked.changes) return false;
      await transaction.run('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL', [userId, purpose]);
      await transaction.run(
        'INSERT INTO auth_tokens (id, user_id, purpose, token_hash, new_email, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [randomUUID(), userId, purpose, sha(token), newEmail, now + EMAIL_TOKEN_HOURS * 60 * 60_000, null, now],
      );
      return true;
    });
    return created ? token : undefined;
  };
  const appLink = (param: 'reset' | 'verify' | 'confirm-email', token: string) => {
    const configuredUrl = process.env.APP_URL?.trim() || (process.env.NODE_ENV === 'production' ? '' : `http://localhost:${process.env.PORT ?? 3000}`);
    if (!configuredUrl) throw new Error('APP_URL is required to send account emails');
    const appUrl = new URL(configuredUrl);
    if (appUrl.protocol !== 'https:' && appUrl.hostname !== 'localhost') throw new Error('APP_URL must use HTTPS');
    return `${appUrl.toString().replace(/\/+$/, '')}/?${param}=${token}`;
  };
  const sendLinkEmail = async (to: string, purpose: 'verify' | 'change_email', token: string) => {
    const verification = purpose === 'verify';
    const param = verification ? 'verify' : 'confirm-email';
    const subject = verification ? 'Verify your StudyPilot email' : 'Confirm your new StudyPilot email';
    const text = verification
      ? `Confirm your email address using this link. It expires in 24 hours:\n\n${appLink(param, token)}`
      : `Confirm this email address change using this link. It expires in 24 hours:\n\n${appLink(param, token)}`;
    await mailer.send({ to, subject, text });
  };
  const sendInBackground = (operation: () => Promise<unknown>, action: string) => {
    void Promise.resolve().then(operation).catch(() => console.error(`Unable to ${action}.`));
  };
  const resendAttempts = new Map<string, number[]>();
  const recordResend = (userId: string, now: number): number | undefined => {
    const recent = (resendAttempts.get(userId) ?? []).filter((time) => time > now - RESEND_DAY_MS);
    const minuteLimited = recent.filter((time) => time > now - RESEND_MINUTE_MS);
    if (minuteLimited.length) return Math.max(1, Math.ceil((minuteLimited[0] + RESEND_MINUTE_MS - now) / 1000));
    if (recent.length >= 5) return Math.max(1, Math.ceil((recent[0] + RESEND_DAY_MS - now) / 1000));
    recent.push(now);
    resendAttempts.set(userId, recent);
    return undefined;
  };
  const sendResetEmail = async (email: string) => {
    const user = await db.get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]);
    if (!user) return;
    const userId = String(user.id);
    const token = randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    const created = await db.transaction(async (transaction) => {
      // Lock the user row so concurrent requests cannot leave two unused reset tokens.
      const locked = await transaction.run('UPDATE users SET id = id WHERE id = ?', [userId]);
      if (!locked.changes) return false;
      await transaction.run("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'password_reset' AND used_at IS NULL", [userId]);
      await transaction.run(
        'INSERT INTO auth_tokens (id, user_id, purpose, token_hash, new_email, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [randomUUID(), userId, 'password_reset', sha(token), null, createdAt + RESET_TOKEN_MINUTES * 60_000, null, createdAt],
      );
      return true;
    });
    if (!created) return;
    await mailer.send({
      to: email,
      subject: 'Reset your StudyPilot password',
      text: `Use this link to choose a new password. It expires in 30 minutes:\n\n${appLink('reset', token)}`,
    });
  };

  app.post('/api/auth/forgot', (req, res) => {
    const parsed = forgotBody.safeParse(req.body);
    const email = parsed.success ? parsed.data.email : getAttemptEmail(req.body);
    const ip = getClientIp(req);
    const limited = failures.retryAfter(email, ip, Date.now()) !== undefined;
    if (!limited) {
      const retryAfter = failures.recordFailure(email, ip, Date.now());
      if (retryAfter !== undefined) {
        res.status(200).json({ message: FORGOT_MESSAGE });
        return;
      }
    }
    res.status(200).json({ message: FORGOT_MESSAGE });
    if (parsed.success && !limited) {
      sendInBackground(() => sendResetEmail(parsed.data.email), 'process password reset email');
    }
  });

  app.post('/api/auth/reset', async (req, res) => {
    const parsed = resetBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: RESET_INVALID_MESSAGE });
    const tokenHash = sha(parsed.data.token);
    const now = Date.now();
    const reset = await db.transaction(async (transaction) => {
      const token = await transaction.get(
        "SELECT id, user_id FROM auth_tokens WHERE token_hash = ? AND purpose = 'password_reset' AND used_at IS NULL AND expires_at > ?",
        [tokenHash, now],
      );
      if (!token) return false;
      const marked = await transaction.run(
        "UPDATE auth_tokens SET used_at = ? WHERE id = ? AND purpose = 'password_reset' AND used_at IS NULL AND expires_at > ?",
        [now, token.id as string, now],
      );
      if (marked.changes !== 1) return false;
      await transaction.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(parsed.data.newPassword), token.user_id as string]);
      await transaction.run('DELETE FROM sessions WHERE user_id = ?', [token.user_id as string]);
      return true;
    });
    if (!reset) return void res.status(400).json({ error: RESET_INVALID_MESSAGE });
    res.json({ message: 'Password updated.' });
  });

  app.post('/api/auth/verify-email', async (req, res) => {
    const parsed = z.object({ token: z.string().min(1).max(128) }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    const now = Date.now();
    const verified = await db.transaction(async (transaction) => {
      const token = await transaction.get(
        "SELECT id, user_id FROM auth_tokens WHERE token_hash = ? AND purpose = 'verify' AND used_at IS NULL AND expires_at > ?",
        [sha(parsed.data.token), now],
      );
      if (!token) return false;
      const marked = await transaction.run(
        "UPDATE auth_tokens SET used_at = ? WHERE id = ? AND purpose = 'verify' AND used_at IS NULL AND expires_at > ?",
        [now, token.id as string, now],
      );
      if (marked.changes !== 1) return false;
      const updated = await transaction.run(
        'UPDATE users SET email_verified_at = ? WHERE id = ?',
        [now, token.user_id as string],
      );
      return updated.changes === 1;
    });
    if (!verified) return void res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    res.json({ message: 'Email verified.' });
  });

  app.post('/api/auth/resend-verification', requireUser, async (_req, res) => {
    const userId = String(res.locals.userId);
    const user = await db.get('SELECT email, email_verified_at FROM users WHERE id = ?', [userId]);
    if (!user) return void res.status(401).json({ error: 'Please log in' });
    if (user.email_verified_at !== null && user.email_verified_at !== undefined) {
      return void res.status(409).json({ error: 'Email already verified.' });
    }
    const retryAfter = recordResend(userId, Date.now());
    if (retryAfter !== undefined) {
      return void res.set('Retry-After', String(retryAfter)).status(429).json({ error: `Please wait ${retryAfter} seconds before requesting another verification email.` });
    }
    const token = await createAuthToken(userId, 'verify');
    if (!token) return void res.status(401).json({ error: 'Please log in' });
    res.status(202).json({ message: 'Verification email sent.' });
    sendInBackground(() => sendLinkEmail(String(user.email), 'verify', token), 'send email verification message');
  });

  app.post('/api/auth/confirm-email-change', async (req, res) => {
    const parsed = z.object({ token: z.string().min(1).max(128) }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'This email confirmation link is invalid or has expired.' });
    const now = Date.now();
    const cookieToken = readToken(req);
    let oldEmail = '';
    const result = await db.transaction(async (transaction) => {
      const token = await transaction.get(
        "SELECT id, user_id, new_email FROM auth_tokens WHERE token_hash = ? AND purpose = 'change_email' AND used_at IS NULL AND expires_at > ?",
        [sha(parsed.data.token), now],
      );
      if (!token || typeof token.new_email !== 'string') return 'invalid';
      const userId = String(token.user_id);
      const user = await transaction.get('SELECT email FROM users WHERE id = ?', [userId]);
      if (!user) return 'invalid';
      const newEmail = String(token.new_email);
      if (await emailExists(newEmail, userId, transaction)) return 'taken';
      const marked = await transaction.run(
        "UPDATE auth_tokens SET used_at = ? WHERE id = ? AND purpose = 'change_email' AND used_at IS NULL AND expires_at > ?",
        [now, token.id as string, now],
      );
      if (marked.changes !== 1) return 'invalid';
      const updated = await transaction.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', [newEmail, now, userId]);
      if (updated.changes !== 1) return 'invalid';
      oldEmail = String(user.email);
      const activeSession = cookieToken
        ? await transaction.get('SELECT token_hash FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?', [sha(cookieToken), userId, now])
        : undefined;
      if (activeSession) await transaction.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [userId, activeSession.token_hash as string]);
      else await transaction.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
      return 'confirmed';
    });
    if (result === 'taken') return void res.status(409).json({ error: 'That email is already registered.' });
    if (result !== 'confirmed') return void res.status(400).json({ error: 'This email confirmation link is invalid or has expired.' });
    res.json({ message: 'Email address confirmed.' });
    sendInBackground(
      () => mailer.send({ to: oldEmail, subject: 'Your StudyPilot email was changed', text: 'The email address for your StudyPilot account was changed. If you did not make this change, please reset your password.' }),
      'send email change notice',
    );
  });

  app.post('/api/auth/register', async (req, res) => {
    const email = getAttemptEmail(req.body);
    const ip = getClientIp(req);
    if (rejectIfLimited(res, email, ip)) return;
    const parsed = registerBody.safeParse(req.body);
    if (!parsed.success) return failAuthentication(res, email, ip, 400, 'Enter a valid email and a password of 8 to 72 characters');
    if (await emailExists(parsed.data.email)) return failAuthentication(res, email, ip, 409, 'That email is already registered');
    const id = randomUUID();
    try {
      await db.run('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)', [id, parsed.data.email, parsed.data.name, hashPassword(parsed.data.password)]);
    } catch {
      return failAuthentication(res, email, ip, 409, 'That email is already registered');
    }
    failures.clearEmail(email);
    const verificationToken = await createAuthToken(id, 'verify');
    await startSession(res, id);
    res.status(201).json(await getProfile(id));
    if (verificationToken) sendInBackground(() => sendLinkEmail(parsed.data.email, 'verify', verificationToken), 'send email verification message');
  });

  app.post('/api/auth/login', async (req, res) => {
    const email = getAttemptEmail(req.body);
    const ip = getClientIp(req);
    if (rejectIfLimited(res, email, ip)) return;
    const parsed = loginBody.safeParse(req.body);
    const row = parsed.success ? await db.get('SELECT * FROM users WHERE email = ?', [parsed.data.email]) : undefined;
    if (!parsed.success || !row || !checkPassword(parsed.data.password, String(row.password_hash))) {
      return failAuthentication(res, email, ip, 401, 'Invalid email or password');
    }
    failures.clearEmail(email);
    await startSession(res, String(row.id), parsed.data.rememberMe);
    res.json(await getProfile(String(row.id)));
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = readToken(req);
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha(token)]);
    res.clearCookie(COOKIE).status(204).end();
  });
  app.get('/api/auth/me', requireUser, async (_req, res) => { res.json(await getProfile(res.locals.userId)); });
  app.patch('/api/auth/email', requireUser, async (req, res) => {
    const parsed = emailChangeBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Enter a valid email and password' });

    const userId = String(res.locals.userId);
    const user = await db.get('SELECT email, password_hash FROM users WHERE id = ?', [userId]);
    if (!user) return void res.status(401).json({ error: 'Please log in' });
    const currentEmail = String(user.email).trim().toLowerCase();
    const ip = getClientIp(req);
    if (rejectIfLimited(res, currentEmail, ip)) return;
    if (!checkPassword(parsed.data.password, String(user.password_hash))) {
      failures.recordFailure(currentEmail, ip, Date.now());
      return void res.status(401).json({ error: 'Incorrect password' });
    }
    failures.clearEmail(currentEmail);
    if (parsed.data.newEmail === currentEmail) return void res.status(400).json({ error: 'That is already your email' });
    if (await emailExists(parsed.data.newEmail, userId)) return void res.status(409).json({ error: 'That email is already registered' });

    const token = await createAuthToken(userId, 'change_email', parsed.data.newEmail);
    if (!token) return void res.status(401).json({ error: 'Please log in' });
    res.status(202).json({ message: 'Check your new inbox to confirm.', pendingEmail: parsed.data.newEmail });
    sendInBackground(() => sendLinkEmail(parsed.data.newEmail, 'change_email', token), 'send email change confirmation');
  });
  app.patch('/api/auth/me', requireUser, async (req, res) => {
    const parsed = profileBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid profile details' });
    const columns = { name: 'name', courseType: 'course_type', programme: 'programme', semesterWeeks: 'semester_weeks', semesterStart: 'semester_start', reminderDays: 'reminder_days' } as const;
    const keys = (Object.keys(parsed.data) as (keyof typeof columns)[]).filter((key) => key in columns);
    if (keys.length) await db.run(`UPDATE users SET ${keys.map((key) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`, [...keys.map((key) => parsed.data[key] as DbValue), res.locals.userId]);
    res.json(await getProfile(res.locals.userId));
  });
  app.delete('/api/auth/me', requireUser, async (_req, res) => {
    await db.run('DELETE FROM users WHERE id = ?', [res.locals.userId]);
    res.clearCookie(COOKIE).status(204).end();
  });
}

export async function deleteExpiredSessions(db: Database): Promise<void> {
  await db.run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
}
