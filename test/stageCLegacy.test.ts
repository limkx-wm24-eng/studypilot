import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { migrate, type Database } from '../src/db.js';
import { openTestDb, testDialect } from './support/database.ts';

const migration = '011_class_name_legacy_updates.postgres.sql';
const legacyName = 'x'.repeat(70);
const snapshot = async (db: Database) => JSON.parse(JSON.stringify({
  users: await db.all('SELECT id, email, name FROM users ORDER BY id'),
  classes: await db.all('SELECT * FROM classes ORDER BY id'), tasks: await db.all('SELECT * FROM tasks ORDER BY id'),
  slots: await db.all('SELECT * FROM slots ORDER BY id'), attendance: await db.all('SELECT * FROM attendance ORDER BY slot_id, date'),
}));
async function fixture() {
  const db = await openTestDb(9);
  const server = createApp(db, { mailer: { enabled: false, async send() {} } }).listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = (method: string, path: string, body?: unknown, cookie?: string) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const register = async () => {
    const response = await send('POST', '/api/auth/register', { email: `legacy-${randomUUID()}@example.test`, password: 'synthetic-password-123' });
    assert.equal(response.status, 201);
    return { user: await response.json(), cookie: response.headers.getSetCookie()[0].split(';')[0] };
  };
  const owner = await register(), stranger = await register(), id = randomUUID();
  await db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)', [id, owner.user.id, legacyName, '#0f766e']);
  const task = await send('POST', '/api/tasks', { classId: id, name: 'Synthetic related task', type: 'Homework', priority: 'Medium', status: 'Not started', due: '2026-11-02', grade: 50 }, owner.cookie);
  assert.equal(task.status, 201);
  const response = await send('POST', '/api/slots', { classId: id, kind: 'Lecture', weekday: 1, start: '08:00', end: '10:00', room: 'SYN 1' }, owner.cookie);
  assert.equal(response.status, 201); const slot = await response.json();
  assert.equal((await send('PUT', '/api/attendance', { slotId: slot.id, date: '2026-11-02', status: 'present' }, owner.cookie)).status, 200);
  await migrate(db, testDialect, 10);
  return { db, send, owner, stranger, id, async close() { await new Promise<void>((done) => server.close(() => done())); await db.close(); } };
}

test(`Q2-C legacy (${testDialect}): 009→010→011 preserves data and fixes color-only PATCH without relaxing requested names`, async () => {
  const h = await fixture();
  try {
    const before = await snapshot(h.db);
    const reproduced = await h.send('PATCH', `/api/classes/${h.id}`, { color: '#112233' }, h.owner.cookie);
    assert.equal(reproduced.status, testDialect === 'postgres' ? 500 : 200, 'Reproduce the original 010 behavior');
    if (testDialect === 'sqlite') await h.db.run('UPDATE classes SET color = ? WHERE id = ?', ['#0f766e', h.id]);
    await migrate(h.db, testDialect);
    assert.deepEqual(await snapshot(h.db), before);
    const updated = await h.send('PATCH', `/api/classes/${h.id}`, { color: '#445566' }, h.owner.cookie);
    assert.equal(updated.status, 200); assert.deepEqual(await updated.json(), { id: h.id, name: legacyName, color: '#445566' });
    const expected = { ...before, classes: before.classes.map((row) => row.id === h.id ? { ...row, color: '#445566' } : row) };
    assert.deepEqual(await snapshot(h.db), expected);
    assert.equal((await h.send('PATCH', `/api/classes/${h.id}`, { color: '#abcdef' }, h.stranger.cookie)).status, 404);
    for (const name of ['', '   ', '\t', 'x'.repeat(61), legacyName]) {
      assert.equal((await h.send('PATCH', `/api/classes/${h.id}`, { name }, h.owner.cookie)).status, 400);
      assert.equal((await h.send('POST', '/api/classes', { name, color: '#0f766e' }, h.owner.cookie)).status, 400);
      assert.deepEqual(await snapshot(h.db), expected);
    }
    // UPDATE OF name must enforce even an assignment of the same legacy name.
    await assert.rejects(h.db.run('UPDATE classes SET name = name WHERE id = ?', [h.id]));
    for (const name of ['A', 'V'.repeat(60)]) {
      const renamed = await h.send('PATCH', `/api/classes/${h.id}`, { name }, h.owner.cookie);
      assert.equal(renamed.status, 200); assert.deepEqual(await renamed.json(), { id: h.id, name, color: '#445566' });
      assert.equal((await h.send('POST', '/api/classes', { name, color: '#0f766e' }, h.owner.cookie)).status, 201);
    }
    const after = await snapshot(h.db);
    for (const key of ['users', 'tasks', 'slots', 'attendance'] as const) assert.deepEqual(after[key], before[key]);
    if (testDialect === 'sqlite') { assert.equal((await h.db.get('PRAGMA foreign_keys'))!.foreign_keys, 1); assert.deepEqual(await h.db.all('PRAGMA foreign_key_check'), []); }
  } finally { await h.close(); }
});

test(`Q2-C legacy (${testDialect}): direct insert/name-update guards retain boundaries and existing whitespace/Unicode semantics`, async () => {
  const h = await fixture();
  try {
    await migrate(h.db, testDialect);
    for (const name of ['', '   ', 'x'.repeat(61), '🧪'.repeat(61)]) {
      await assert.rejects(h.db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)', [randomUUID(), h.owner.user.id, name, '#0f766e']));
      await assert.rejects(h.db.run('UPDATE classes SET name = ? WHERE id = ?', [name, h.id]));
      assert.equal((await h.db.get('SELECT name FROM classes WHERE id = ?', [h.id]))!.name, legacyName);
    }
    for (const name of ['A', 'x'.repeat(60), ` ${'x'.repeat(60)} `, '\t', '\u00a0', '🧪'.repeat(31), '🧪'.repeat(60)]) {
      const id = randomUUID();
      await h.db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)', [id, h.owner.user.id, name, '#0f766e']);
      await h.db.run('UPDATE classes SET name = ? WHERE id = ?', [name, id]);
      assert.equal((await h.db.get('SELECT name FROM classes WHERE id = ?', [id]))!.name, name);
    }
    // Both databases and the installed validator count Unicode code points.
    // API Unicode trimming/control rejection remains stricter than DB ASCII trim.
    for (const name of ['\t', '\u00a0', '🧪'.repeat(61)]) assert.equal((await h.send('PATCH', `/api/classes/${h.id}`, { name }, h.owner.cookie)).status, 400);
    for (const name of ['🧪'.repeat(31), '🧪'.repeat(60)]) assert.equal((await h.send('PATCH', `/api/classes/${h.id}`, { name }, h.owner.cookie)).status, 200);
    await assert.rejects(h.db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)', [randomUUID(), randomUUID(), 'Synthetic orphan', '#0f766e']));
    const beforeDelete = await snapshot(h.db);
    assert.equal((await h.send('DELETE', `/api/classes/${h.id}`, undefined, h.owner.cookie)).status, 204);
    for (const table of ['tasks', 'slots', 'attendance']) assert.deepEqual(await h.db.all(`SELECT * FROM ${table}`), []);
    assert.deepEqual((await snapshot(h.db)).users, beforeDelete.users);
  } finally { await h.close(); }
});

test(`Q2-C migrations (${testDialect}): fresh and existing-010 paths apply once and preserve migration ledger`, async () => {
  for (const through of [undefined, 10]) {
    const db = await openTestDb(through);
    try {
      await migrate(db, testDialect);
      const ledger = await db.all('SELECT id, applied_at FROM schema_migrations ORDER BY id');
      assert.equal(ledger.length, testDialect === 'postgres' ? 11 : 10);
      assert.equal(ledger.filter((row) => row.id === migration).length, testDialect === 'postgres' ? 1 : 0);
      await migrate(db, testDialect); assert.deepEqual(await db.all('SELECT id, applied_at FROM schema_migrations ORDER BY id'), ledger);
      if (testDialect === 'postgres') {
        assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM pg_trigger WHERE tgrelid = 'classes'::regclass AND NOT tgisinternal"))!.count, 2);
        assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM pg_constraint WHERE conrelid = 'classes'::regclass AND conname = 'classes_name_length'"))!.count, 0);
      }
    } finally { await db.close(); }
  }
});

if (testDialect === 'postgres') test('Q2-C PostgreSQL: failure after dropping the CHECK rolls back all enforcement DDL', async () => {
  const h = await fixture(), exec = h.db.exec.bind(h.db);
  try {
    const source = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
    const failing = source.replace('END;\n$migration$;', "RAISE EXCEPTION 'Synthetic migration failure';\nEND;\n$migration$;");
    assert.notEqual(failing, source);
    h.db.exec = (sql) => exec(sql === source ? failing : sql);
    await assert.rejects(migrate(h.db, 'postgres'), /Synthetic migration failure/);
    h.db.exec = exec;
    assert.equal((await h.db.get('SELECT id FROM schema_migrations WHERE id = ?', [migration])), undefined);
    assert.equal((await h.db.get("SELECT COUNT(*)::int AS count FROM pg_constraint WHERE conrelid = 'classes'::regclass AND conname = 'classes_name_length'"))!.count, 1);
    assert.equal((await h.db.get("SELECT COUNT(*)::int AS count FROM pg_trigger WHERE tgrelid = 'classes'::regclass AND NOT tgisinternal"))!.count, 0);
    await assert.rejects(h.db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)', [randomUUID(), h.owner.user.id, 'x'.repeat(61), '#0f766e']));
    await assert.rejects(h.db.run('UPDATE classes SET color = ? WHERE id = ?', ['#112233', h.id]));
    await migrate(h.db, 'postgres');
    assert.equal((await h.send('PATCH', `/api/classes/${h.id}`, { color: '#445566' }, h.owner.cookie)).status, 200);
  } finally { h.db.exec = exec; await h.close(); }
});
