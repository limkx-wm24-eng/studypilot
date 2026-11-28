import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { openTestDb } from './database.js';
import type { Email } from '../../src/mailer.js';
import type { AddressInfo } from 'node:net';
import type { PasswordService } from '../../src/passwords.js';
import { loadIngressConfig } from '../../src/ingress.js';
import { startSyntheticIngress, syntheticIngressConfig } from './syntheticIngress.ts';

export async function securityHarness(production = false, mailEnabled = true, passwords?: PasswordService, ingressMode: 'synthetic-proxy' | 'direct' = 'synthetic-proxy') {
  const previousMode = process.env.NODE_ENV;
  const previousUrl = process.env.APP_URL;
  process.env.NODE_ENV = production ? 'production' : 'test';
  process.env.APP_URL = 'https://synthetic.example.test';
  const db = await openTestDb();
  const messages: Email[] = [];
  const app = createApp(db, { passwords, ingress: ingressMode==='direct'?loadIngressConfig({INGRESS_MODE:'direct'}):syntheticIngressConfig(), mailer: { enabled: mailEnabled, async send(message) { messages.push(message); } } });
  const proxy = ingressMode==='synthetic-proxy'?await startSyntheticIngress(app):undefined;
  const server = proxy?.server ?? app.listen(0, '127.0.0.1');
  if(!proxy) await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = proxy?.base ?? `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const register = async (suffix = randomUUID()) => {
    const email = `synthetic-${suffix}@example.test`;
    const response = await send('POST', '/api/auth/register', { email, password: 'synthetic-password-123' });
    assert.equal(response.status, 201);
    const cookie = response.headers.getSetCookie()[0].split(';')[0];
    return { user: await response.json(), cookie, email, response };
  };
  const seed = async (cookie: string, label: string, weekday = 1) => {
    const klass = await (await send('POST', '/api/classes', { name: `Synthetic ${label}`, color: '#0f766e' }, cookie)).json();
    const task = await (await send('POST', '/api/tasks', { classId: klass.id, type: 'Homework', name: 'Synthetic task', priority: 'Medium', status: 'Not started', due: '2026-11-30', grade: 50 }, cookie)).json();
    const course = await (await send('POST', '/api/courses', { semesterLabel: 'Synthetic semester', courseName: 'Synthetic course', creditHours: 3, grade: 'A' }, cookie)).json();
    const slot = await (await send('POST', '/api/slots', { classId: klass.id, kind: 'Lecture', weekday, start: '08:00', end: '10:00', room: 'SYN 1' }, cookie)).json();
    const marked = await send('PUT', '/api/attendance', { slotId: slot.id, date: weekday === 1 ? '2026-11-02' : '2026-11-03', status: 'present' }, cookie);
    assert.equal(marked.status, 200);
    for (const row of [klass, task, course, slot]) assert.equal(typeof row.id, 'string');
    return { klass, task, course, slot };
  };
  const snapshot = async () => Object.fromEntries(await Promise.all(
    ['users', 'sessions', 'auth_tokens', 'classes', 'tasks', 'courses', 'slots', 'attendance'].map(async (table) => [table, await db.all(`SELECT * FROM ${table} ORDER BY 1`)]),
  ));
  return { db, app, base, send, register, seed, snapshot, messages,
    async close() {
      if(proxy) await proxy.close(); else await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
      if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
      if (previousUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = previousUrl;
    },
  };
}
