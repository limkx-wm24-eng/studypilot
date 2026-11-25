import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityHarness } from './support/securityHarness.ts';
import { testDialect } from './support/database.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const configurations = [
  { resource: 'classes', field: 'klass', patch: { color: '#112233' }, keys: ['id', 'name', 'color'] },
  { resource: 'tasks', field: 'task', patch: { grade: 85 }, keys: ['id', 'classId', 'type', 'name', 'priority', 'status', 'due', 'grade'] },
  { resource: 'courses', field: 'course', patch: { grade: 'B+' }, keys: ['id', 'semesterLabel', 'courseName', 'creditHours', 'grade'] },
] as const;

if (testDialect === 'postgres') test('Q2-A PATCH (postgres): deletion after the task ownership read still returns 404', async () => {
  const h = await securityHarness(false, false);
  const transaction = h.db.transaction.bind(h.db), read = deferred(), release = deferred();
  let pending: Promise<Response> | undefined;
  try {
    const a = await h.register(), data = await h.seed(a.cookie, 'Delete after read');
    h.db.transaction = (operation) => transaction((tx) => operation({ ...tx, get: async (sql, values) => {
      const row = await tx.get(sql, values);
      if (sql.startsWith('SELECT t.*')) { read.resolve(); await release.promise; }
      return row;
    } }));
    pending = h.send('PATCH', `/api/tasks/${data.task.id}`, { grade: 85 }, a.cookie);
    await read.promise;
    assert.equal((await h.send('DELETE', `/api/tasks/${data.task.id}`, undefined, a.cookie)).status, 204);
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'Task not found' });
    assert.equal(await h.db.get('SELECT id FROM tasks WHERE id = ?', [data.task.id]), undefined);
  } finally { release.resolve(); await pending; h.db.transaction = transaction; await h.close(); }
});

for (const config of configurations) {
  test(`Q2-A PATCH (${testDialect}): ${config.resource} returns 404 if DELETE wins before the protected write`, async () => {
    const h = await securityHarness(false, false);
    const transaction = h.db.transaction.bind(h.db), entered = deferred(), release = deferred();
    let pending: Promise<Response> | undefined;
    try {
      const a = await h.register(), data = await h.seed(a.cookie, `Delete ${config.resource}`), row = data[config.field];
      let first = true;
      // Pause before acquiring a transaction/row lock, so deletion can legitimately win.
      h.db.transaction = async (operation) => { if (first) { first = false; entered.resolve(); await release.promise; } return transaction(operation); };
      pending = h.send('PATCH', `/api/${config.resource}/${row.id}`, config.patch, a.cookie);
      await entered.promise;
      assert.equal((await h.send('DELETE', `/api/${config.resource}/${row.id}`, undefined, a.cookie)).status, 204);
      release.resolve();
      const response = await pending;
      assert.equal(response.status, 404); assert.equal(typeof (await response.json()).error, 'string');
      assert.equal(await h.db.get(`SELECT id FROM ${config.resource} WHERE id = ?`, [row.id]), undefined);
    } finally { release.resolve(); await pending; h.db.transaction = transaction; await h.close(); }
  });

  test(`Q2-A PATCH (${testDialect}): ${config.resource} returns complete owned snapshots, preserves partial/empty updates and reverse order`, async () => {
    const h = await securityHarness(false, false);
    try {
      const a = await h.register(), b = await h.register(), data = await h.seed(a.cookie, `Patch ${config.resource}`), row = data[config.field];
      const path = `/api/${config.resource}/${row.id}`;
      assert.equal((await h.send('PATCH', path, config.patch, b.cookie)).status, 404);
      const response = await h.send('PATCH', path, config.patch, a.cookie);
      assert.equal(response.status, 200);
      const updated = await response.json();
      assert.deepEqual(Object.keys(updated).sort(), [...config.keys].sort());
      assert.deepEqual(updated, { ...row, ...config.patch });
      const empty = await h.send('PATCH', path, {}, a.cookie);
      assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), updated);
      assert.equal((await h.send('DELETE', path, undefined, a.cookie)).status, 204);
      assert.equal((await h.send('PATCH', path, config.patch, a.cookie)).status, 404);
    } finally { await h.close(); }
  });

  test(`Q2-A PATCH (${testDialect}): ${config.resource} rolls back a failed transaction and recovers`, async () => {
    const h = await securityHarness(false, false);
    const transaction = h.db.transaction.bind(h.db);
    try {
      const a = await h.register(), data = await h.seed(a.cookie, `Rollback ${config.resource}`), row = data[config.field];
      const before = await h.db.get(`SELECT * FROM ${config.resource} WHERE id = ?`, [row.id]);
      h.db.transaction = (operation) => transaction(async (tx) => { await operation(tx); throw new Error('Synthetic protected-write failure'); });
      const response = await h.send('PATCH', `/api/${config.resource}/${row.id}`, config.patch, a.cookie);
      assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: 'Server error' });
      assert.deepEqual(await h.db.get(`SELECT * FROM ${config.resource} WHERE id = ?`, [row.id]), before);
      h.db.transaction = transaction;
      assert.equal((await h.send('PATCH', `/api/${config.resource}/${row.id}`, config.patch, a.cookie)).status, 200);
    } finally { h.db.transaction = transaction; await h.close(); }
  });
}
