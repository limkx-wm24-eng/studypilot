import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import type { Database } from '../src/db.js';
import { securityHarness } from './support/securityHarness.ts';
import { openTestPeer, testDialect } from './support/database.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Controlled test interleaving timed out')), 10_000); })]); }
  finally { clearTimeout(timer!); }
}
async function fixture() {
  const h = await securityHarness(false, false);
  const peer = await openTestPeer(h.db);
  const server = createApp(peer, { mailer: { enabled: false, async send() {} } }).listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  const address = server.address() as { port: number };
  const second = (method: string, path: string, body?: unknown, cookie?: string) => fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ...h, peer, second, async close() { await new Promise<void>((done) => server.close(() => done())); await peer.close(); await h.close(); } };
}
const classBody = (name: string) => ({ name, color: '#0f766e' });
const manual = (classId: string, overrides = {}) => ({ classId, kind: 'Lecture', weekday: 1, start: '08:00', end: '10:00', room: 'SYN 1', ...overrides });
const imported = (className: string, overrides = {}) => ({ slots: [{ className, kind: 'Lecture', weekday: 1, start: '08:00', end: '10:00', room: 'SYN 1', ...overrides }] });

// Pause after the first real row lock, and observe the competing application
// reaching its transaction. PostgreSQL backend IDs prove distinct connections.
function protectInterleaving(first: Database, second: Database) {
  const locked = deferred(), release = deferred(), competitor = deferred();
  const originalFirst = first.transaction.bind(first), originalSecond = second.transaction.bind(second);
  const originalGet = second.get.bind(second);
  const pids = new Set<unknown>();
  let pause = true;
  first.transaction = (operation) => originalFirst(async (transaction) => {
    const run = transaction.run.bind(transaction);
    if (testDialect === 'postgres') pids.add((await transaction.get('SELECT pg_backend_pid() AS id'))!.id);
    const wrapped: Database = { ...transaction, run: async (sql, values) => {
      const result = await run(sql, values);
      if (pause && sql === 'UPDATE users SET id = id WHERE id = ?') { pause = false; locked.resolve(); await release.promise; }
      return result;
    } };
    return operation(wrapped);
  });
  second.transaction = (operation) => { competitor.resolve(); return originalSecond(async (transaction) => {
    if (testDialect === 'postgres') pids.add((await transaction.get('SELECT pg_backend_pid() AS id'))!.id);
    return operation(transaction);
  }); };
  // SQLite also queues authentication reads behind the active transaction.
  // Observe that entry rather than waiting for a transaction it cannot yet reach.
  if (testDialect === 'sqlite') second.get = (sql, values) => { competitor.resolve(); return originalGet(sql, values); };
  return { locked, release, competitor, pids, restore() { first.transaction = originalFirst; second.transaction = originalSecond; second.get = originalGet; } };
}

for (const [name, firstImport, secondImport, start, end, expected] of [
  ['identical', false, false, '08:00', '10:00', 409],
  ['partially overlapping', false, false, '09:00', '11:00', 409],
  ['non-overlapping', false, false, '12:00', '14:00', 201],
  ['adjacent', false, false, '10:00', '12:00', 201],
  ['manual then import', false, true, '09:00', '11:00', 409],
  ['import then manual', true, false, '09:00', '11:00', 409],
  ['manual then conflicting-metadata import', false, true, '08:00', '10:00', 409],
  ['import then conflicting-metadata manual', true, false, '08:00', '10:00', 409],
] as const) test(`Q2-A timetable (${testDialect}): serialized ${name} writes across applications`, async () => {
  const h = await fixture();
  let control: ReturnType<typeof protectInterleaving> | undefined;
  const pending: Promise<Response>[] = [];
  try {
    const a = await h.register();
    const c = await (await h.send('POST', '/api/classes', classBody('Synthetic atomic timetable'), a.cookie)).json();
    control = protectInterleaving(h.db, h.peer);
    pending.push(h.send('POST', firstImport ? '/api/import/timetable' : '/api/slots', firstImport ? imported(c.name) : manual(c.id), a.cookie));
    await within(control.locked.promise);
    let completed = false;
    const metadata = name.includes('conflicting-metadata') ? { kind: 'Practical', room: 'SYN 2' } : {};
    pending.push(h.second('POST', secondImport ? '/api/import/timetable' : '/api/slots', secondImport ? imported(c.name, { start, end, ...metadata }) : manual(c.id, { start, end, ...metadata }), a.cookie).then((response) => { completed = true; return response; }));
    await within(control.competitor.promise);
    await new Promise((done) => setImmediate(done));
    assert.equal(completed, false, 'Competitor cannot pass the held database lock');
    control.release.resolve();
    const responses = await within(Promise.all(pending));
    assert.equal(responses[0].status, 201); assert.equal(responses[1].status, expected);
    if (secondImport && name.includes('conflicting-metadata')) assert.equal((await responses[1].json()).conflicts[0].reason, 'metadata');
    if (testDialect === 'postgres') assert.equal(control.pids.size, 2, 'Separate PostgreSQL backends must participate');
    const slots = await h.db.all('SELECT id FROM slots');
    assert.equal(slots.length, expected === 409 ? 1 : 2);
    if (name.includes('conflicting-metadata')) assert.deepEqual({ ...await h.db.get('SELECT kind, room FROM slots') }, { kind: 'Lecture', room: 'SYN 1' });
    const summary = await (await h.send('GET', '/api/attendance/summary', undefined, a.cookie)).json();
    assert.equal(summary.classes[0].weeklyHours, expected === 409 ? 2 : 4);
  } finally { control?.release.resolve(); await Promise.allSettled(pending); control?.restore(); await h.close(); }
});

test(`Q2-A timetable (${testDialect}): unrelated users and class updates use the right lock scope`, async () => {
  const h = await fixture();
  let control: ReturnType<typeof protectInterleaving> | undefined;
  let rename: Promise<Response> | undefined;
  let importing: Promise<Response> | undefined;
  try {
    const a = await h.register(), b = await h.register();
    const ca = await (await h.send('POST', '/api/classes', classBody('Synthetic A'), a.cookie)).json();
    const cb = await (await h.send('POST', '/api/classes', classBody('Synthetic B'), b.cookie)).json();
    control = protectInterleaving(h.db, h.peer);
    rename = h.send('PATCH', `/api/classes/${ca.id}`, { name: 'Synthetic renamed A' }, a.cookie);
    await within(control.locked.promise);
    if (testDialect === 'postgres') assert.equal((await within(h.second('POST', '/api/slots', manual(cb.id), b.cookie))).status, 201, 'Another user must not wait for A');
    const queued = deferred();
    if (testDialect === 'postgres') {
      const original = h.peer.transaction.bind(h.peer);
      h.peer.transaction = (operation) => { queued.resolve(); return original(operation); };
    } else {
      const original = h.peer.get.bind(h.peer);
      h.peer.get = (sql, values) => { queued.resolve(); return original(sql, values); };
    }
    importing = h.second('POST', '/api/import/timetable', imported('Synthetic renamed A'), a.cookie);
    await within(queued.promise);
    control.release.resolve(); assert.equal((await rename).status, 200);
    if (testDialect === 'sqlite') assert.equal((await h.second('POST', '/api/slots', manual(cb.id), b.cookie)).status, 201);
    const result = await importing;
    assert.equal(result.status, 201); assert.equal((await result.json()).createdClasses, 0);
    assert.equal((await h.db.all('SELECT id FROM classes')).length, 2);
  } finally { control?.release.resolve(); await rename; await importing; control?.restore(); await h.close(); }
});

test(`Q2-A timetable (${testDialect}): class deletion coordinates with a competing manual write`, async () => {
  const h = await fixture();
  let control: ReturnType<typeof protectInterleaving> | undefined;
  const pending: Promise<Response>[] = [];
  try {
    const a = await h.register();
    const c = await (await h.send('POST', '/api/classes', classBody('Synthetic removed parent'), a.cookie)).json();
    control = protectInterleaving(h.db, h.peer);
    pending.push(h.send('DELETE', `/api/classes/${c.id}`, undefined, a.cookie));
    await within(control.locked.promise);
    pending.push(h.second('POST', '/api/slots', manual(c.id), a.cookie));
    await within(control.competitor.promise); control.release.resolve();
    const responses = await within(Promise.all(pending));
    assert.equal(responses[0].status, 204); assert.equal(responses[1].status, 422);
    assert.equal((await h.db.all('SELECT id FROM slots')).length, 0);
  } finally { control?.release.resolve(); await Promise.allSettled(pending); control?.restore(); await h.close(); }
});

for (const patch of [{ room: 'SYN 2' }, { kind: 'Practical' }, { room: 'SYN 2', kind: 'Practical' }]) {
  test(`Q2-A metadata (${testDialect}): ${JSON.stringify(patch)} conflicts explicitly with stored records`, async () => {
    const h = await fixture();
    try {
      const a = await h.register();
      const initial = await h.send('POST', '/api/import/timetable', imported('Synthetic metadata'), a.cookie);
      assert.equal(initial.status, 201);
      const original = await h.db.all('SELECT class_id, kind, weekday, start_time, end_time, room FROM slots');
      const response = await h.second('POST', '/api/import/timetable', imported('SYNTHETIC METADATA', patch), a.cookie);
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.conflicts[0].row, 1); assert.equal(body.conflicts[0].with, 'existing');
      assert.equal(body.conflicts[0].reason, 'metadata');
      assert.deepEqual(body.conflicts[0].fields.sort(), Object.keys(patch).sort());
      assert.deepEqual(body.conflicts[0].existing, { kind: 'Lecture', room: 'SYN 1' });
      assert.deepEqual(body.conflicts[0].incoming, { kind: patch.kind ?? 'Lecture', room: patch.room ?? 'SYN 1' });
      assert.deepEqual(await h.db.all('SELECT class_id, kind, weekday, start_time, end_time, room FROM slots'), original);
      const same = await h.second('POST', '/api/import/timetable', imported('Synthetic metadata', { room: '  SYN 1  ' }), a.cookie);
      assert.equal(same.status, 201); assert.deepEqual(await same.json(), { createdClasses: 0, createdSlots: 0, skipped: 1 });
    } finally { await h.close(); }
  });
}

test(`Q2-A metadata (${testDialect}): conflicting payload rows reject the whole import; exact duplicates still skip`, async () => {
  const h = await fixture();
  try {
    const a = await h.register();
    const slot = imported('Synthetic conflicting payload').slots[0];
    const response = await h.send('POST', '/api/import/timetable', { classes: [{ name: 'Synthetic unwritten project' }], slots: [slot, { ...slot, kind: 'Practical', room: 'SYN 2' }] }, a.cookie);
    assert.equal(response.status, 409); const body = await response.json();
    assert.equal(body.conflicts[0].row, 2); assert.equal(body.conflicts[0].with, 1); assert.equal(body.conflicts[0].reason, 'metadata');
    assert.equal((await h.db.all('SELECT id FROM classes')).length, 0); assert.equal((await h.db.all('SELECT id FROM slots')).length, 0);
    const exact = await h.second('POST', '/api/import/timetable', { slots: [slot, slot] }, a.cookie);
    assert.equal(exact.status, 201); assert.deepEqual(await exact.json(), { createdClasses: 1, createdSlots: 1, skipped: 1 });
  } finally { await h.close(); }
});

test(`Q2-A timetable (${testDialect}): failed manual/import writes roll back and release locks`, async () => {
  const h = await fixture();
  const transaction = h.db.transaction.bind(h.db);
  try {
    const a = await h.register();
    const c = await (await h.send('POST', '/api/classes', classBody('Synthetic rollback'), a.cookie)).json();
    for (const useImport of [false, true]) {
      let fail = true;
      h.db.transaction = (operation) => transaction((tx) => operation({ ...tx,
        get: async (sql, values) => { const row = await tx.get(sql, values); if (fail && sql.startsWith('INSERT INTO slots')) { fail = false; throw new Error('Synthetic slot failure'); } return row; },
        run: async (sql, values) => { const result = await tx.run(sql, values); if (fail && sql.startsWith('INSERT INTO slots')) { fail = false; throw new Error('Synthetic slot failure'); } return result; },
      }));
      const result = await h.send('POST', useImport ? '/api/import/timetable' : '/api/slots', useImport ? imported('Synthetic rolled-back import') : manual(c.id), a.cookie);
      assert.equal(result.status, 500);
      assert.equal((await h.db.all('SELECT id FROM slots')).length, 0);
      assert.equal((await h.db.all('SELECT id FROM classes')).length, 1);
      h.db.transaction = transaction;
    }
    assert.equal((await within(h.second('POST', '/api/slots', manual(c.id), a.cookie))).status, 201);
  } finally { h.db.transaction = transaction; await h.close(); }
});
