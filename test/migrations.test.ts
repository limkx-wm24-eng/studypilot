import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { migrate, type Database } from '../src/db.js';
import { openTestDb, testDialect } from './support/database.js';

const tables = ['users', 'classes', 'slots', 'attendance', 'tasks'] as const;
const snapshot = async (db: Database) => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await db.all(`SELECT * FROM ${table} ORDER BY 1`)])));
const foreignKeys = async (db: Database) => testDialect === 'sqlite'
  ? Promise.all(['classes', 'slots', 'attendance', 'tasks'].map((table) => db.all(`PRAGMA foreign_key_list(${table})`)))
  : db.all('SELECT constraint_name, delete_rule, update_rule FROM information_schema.referential_constraints WHERE constraint_schema = current_schema() ORDER BY constraint_name');

test(`migrations (${testDialect}): every migration runs on an empty database and is repeatable`, async () => {
  const db = await openTestDb();
  try {
    const expected = (await readdir(new URL('../migrations/', import.meta.url)))
      .filter((file) => /^\d+_.+\.sql$/.test(file) && (!/\.(sqlite|postgres)\.sql$/.test(file) || file.endsWith(`.${testDialect}.sql`))).sort();
    assert.deepEqual((await db.all('SELECT id FROM schema_migrations ORDER BY id')).map((row) => row.id), expected);
    assert.equal(expected.length, testDialect === 'postgres' ? 11 : 10);
    for (const rows of Object.values(await snapshot(db))) assert.deepEqual(rows, []);
    await migrate(db, testDialect);
    assert.equal((await db.all('SELECT id FROM schema_migrations')).length, expected.length);
  } finally { await db.close(); }
});

test(`migrations (${testDialect}): 010 preserves populated classes, slots, attendance and foreign keys`, async () => {
  const db = await openTestDb(9);
  try {
    assert.equal((await db.all('SELECT id FROM schema_migrations')).length, 9);
    await db.run('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', ['synthetic-user', 'migration@example.test', 'synthetic-hash']);
    for (const [id, name] of [['synthetic-class', 'Synthetic Existing Class'], ['synthetic-legacy-class', 'x'.repeat(70)]]) {
      await db.run('INSERT INTO classes (id, user_id, name, color) VALUES (?, ?, ?, ?)', [id, 'synthetic-user', name, '#0f766e']);
    }
    await db.run('INSERT INTO slots (id, class_id, kind, weekday, start_time, end_time, room) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['synthetic-slot', 'synthetic-class', 'Lecture', 1, '08:00', '10:00', 'SYN 1']);
    await db.run('INSERT INTO attendance (slot_id, date, status) VALUES (?, ?, ?)', ['synthetic-slot', '2026-11-02', 'present']);
    await db.run('INSERT INTO tasks (id, class_id, type, name, priority, status, due) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['synthetic-task', 'synthetic-class', 'Homework', 'Synthetic task', 'Medium', 'Not started', '2026-11-02']);
    const before = await snapshot(db);
    const keysBefore = await foreignKeys(db);
    const sqliteDefinition = testDialect === 'sqlite' ? await db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classes'") : undefined;

    await migrate(db, testDialect, 10);
    await migrate(db, testDialect, 10); // Opening the 010 database again must be harmless.
    assert.deepEqual(await snapshot(db), before);
    assert.deepEqual(await foreignKeys(db), keysBefore);
    assert.equal((await db.all('SELECT id FROM schema_migrations')).length, 10);
    if (testDialect === 'sqlite') {
      // 010 uses triggers: there is no classes-table rebuild or foreign-key toggle.
      assert.deepEqual(await db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classes'"), sqliteDefinition);
      assert.equal((await db.get('PRAGMA foreign_keys'))?.foreign_keys, 1);
      assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
    }
    await assert.rejects(db.run('UPDATE classes SET name = ? WHERE id = ?', ['x'.repeat(61), 'synthetic-class']));
    await assert.rejects(db.run('INSERT INTO classes (id, user_id, name, color) VALUES (?, ?, ?, ?)', ['oversized-class', 'synthetic-user', 'x'.repeat(61), '#0f766e']));
    await assert.rejects(db.run('INSERT INTO classes (id, user_id, name, color) VALUES (?, ?, ?, ?)', ['orphan-class', 'missing-user', 'Synthetic orphan', '#0f766e']));
    await assert.rejects(db.run('INSERT INTO slots (id, class_id, kind, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)', ['orphan-slot', 'missing-class', 'Lecture', 1, '08:00', '10:00']));
    await assert.rejects(db.run('INSERT INTO attendance (slot_id, date, status) VALUES (?, ?, ?)', ['missing-slot', '2026-11-02', 'present']));
    assert.deepEqual(await snapshot(db), before);

    // Delete synthetic fixtures only, to verify that original cascades still work.
    await db.run('DELETE FROM classes WHERE id = ?', ['synthetic-class']);
    for (const table of ['slots', 'attendance', 'tasks']) assert.deepEqual(await db.all(`SELECT * FROM ${table}`), []);
    assert.equal((await db.all('SELECT * FROM users')).length, 1);
    assert.equal((await db.all('SELECT * FROM classes')).length, 1);
  } finally { await db.close(); }
});
