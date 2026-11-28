import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { securityHarness } from './support/securityHarness.ts';

test('Stage 1 controls: all single-line labels reject C0/C1 controls before database writes', async () => {
  const h = await securityHarness(true);
  try {
    const a = await h.register(), data = await h.seed(a.cookie, 'Control matrix');
    const before = await h.snapshot();
    const controls = [0, 1, 8, 9, 10, 11, 12, 13, 31, 127, 128, 133, 159, 0x2028, 0x2029];
    for (const [i, code] of controls.entries()) {
      const text = `SYN${String.fromCharCode(code)}TEXT`;
      const requests: [string, string, unknown][] = [
        ['POST', '/api/classes', { name: text, color: '#0f766e' }],
        ['PATCH', `/api/classes/${data.klass.id}`, { name: text }],
        ['PATCH', `/api/tasks/${data.task.id}`, { name: text }],
        ['POST', '/api/slots', { ...data.slot, weekday: 3, room: text }],
        ['PATCH', '/api/auth/me', { name: text }], ['PATCH', '/api/auth/me', { programme: text }],
        ['POST', '/api/courses', { semesterLabel: text, courseName: 'Synthetic', creditHours: 3, grade: null }],
        ['POST', '/api/courses', { semesterLabel: 'Synthetic', courseName: text, creditHours: 3, grade: null }],
        ['POST', '/api/auth/register', { email: `control-${i}@example.test`, password: 'synthetic-password-123', name: text }],
      ];
      for (const [method, path, body] of requests) {
        const result = await h.send(method, path, body, a.cookie, { 'X-StudyPilot-Test-Client': `192.0.2.${10 + i}` });
        assert.equal(result.status, 400, `${method} ${path}: control U+${code.toString(16)}`);
        assert.equal(result.headers.get('Cache-Control'), 'no-store');
        const error = await result.json();
        assert.equal(typeof error.error, 'string'); assert.equal('stack' in error, false);
      }
    }
    // Import has its own rate limit; cover both class and room schemas without exhausting it.
    for (const body of [
      { classes: [{ name: 'SYN\u0000CLASS' }], slots: [] },
      { slots: [{ className: 'Synthetic', kind: 'Lecture', weekday: 1, start: '08:00', end: '10:00', room: 'SYN\u001bROOM' }] },
    ]) assert.equal((await h.send('POST', '/api/import/timetable', body, a.cookie)).status, 400);
    assert.deepEqual(await h.snapshot(), before);
    const valid = await h.send('PATCH', '/api/auth/me', { name: '合成 😀', programme: 'Études 合成' }, a.cookie);
    assert.equal(valid.status, 200); assert.equal((await valid.json()).name, '合成 😀');
    assert.equal((await h.send('POST', '/api/courses', { semesterLabel: '合成 😀', courseName: 'Études 😀', creditHours: 3, grade: null }, a.cookie)).status, 201);
  } finally { await h.close(); }
});

test('Stage 1 Origin: same-host requests and non-browser clients work without APP_URL', async () => {
  const h = await securityHarness(true);
  try {
    const a = await h.register();
    delete process.env.APP_URL;
    const origin = new URL(h.base);
    const cases: [Record<string, string>, number][] = [
      [{ Origin: origin.origin }, 200],
      [{ Origin: `https://${origin.host}` }, 200],
      [{}, 200], [{ 'Sec-Fetch-Site': 'same-origin' }, 200], [{ 'Sec-Fetch-Site': 'none' }, 200],
      [{ Origin: 'https://foreign.example.test' }, 403],
      [{ Origin: `http://${origin.hostname}:${Number(origin.port) === 5174 ? 5175 : 5174}` }, 403],
      [{ Origin: 'null' }, 403], [{ Origin: 'not an origin' }, 403],
      [{ Origin: `http://user@${origin.host}` }, 403],
      [{ 'Sec-Fetch-Site': 'cross-site' }, 403], [{ 'Sec-Fetch-Site': 'same-site' }, 403],
      [{ Origin: origin.origin, 'Sec-Fetch-Site': 'cross-site' }, 200],
      [{ Origin: 'https://foreign.example.test', 'X-Forwarded-Host': 'foreign.example.test' }, 403],
    ];
    for (const [headers, status] of cases) {
      const result = await h.send('PATCH', '/api/auth/me', {}, a.cookie, headers);
      assert.equal(result.status, status, JSON.stringify(headers));
      assert.equal(result.headers.get('Cache-Control'), 'no-store');
      if (status === 403) assert.deepEqual(await result.json(), { error: 'Request not allowed' });
    }
    assert.equal((await h.send('GET', '/api/auth/me', undefined, a.cookie, { Origin: 'https://foreign.example.test' })).status, 200);
  } finally { await h.close(); }
});

test('Stage 1 development Origin: Vite loopback origins work only in development', async () => {
  const h = await securityHarness();
  try {
    const a = await h.register();
    for (const mode of ['development', 'production', 'test']) {
      process.env.NODE_ENV = mode;
      for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
        assert.equal((await h.send('PATCH', '/api/auth/me', {}, a.cookie, { Origin: origin })).status, mode === 'development' ? 200 : 403);
      }
      assert.equal((await h.send('PATCH', '/api/auth/me', {}, a.cookie, { Origin: 'http://localhost:5174' })).status, 403);
    }
  } finally { await h.close(); }
});

test('Stage 1 IDs: malformed path IDs and class filters return 400; valid foreign IDs retain their behavior', async () => {
  const h = await securityHarness();
  try {
    const a = await h.register(), b = await h.register();
    const own = await h.seed(a.cookie, 'IDs A'), other = await h.seed(b.cookie, 'IDs B');
    const before = await h.snapshot();
    const invalid = ['not-an-id', '11111111-1111-1111-8111-111111111111', `${randomUUID()}suffix`, "' OR 1=1--", 'a/b'];
    for (const id of invalid) {
      for (const resource of ['classes', 'tasks', 'courses', 'slots']) {
        for (const method of resource === 'slots' ? ['DELETE'] : ['PATCH', 'DELETE']) {
          assert.equal((await h.send(method, `/api/${resource}/${encodeURIComponent(id)}`, method === 'PATCH' ? {} : undefined, a.cookie)).status, 400);
        }
      }
      assert.equal((await h.send('GET', `/api/tasks?classId=${encodeURIComponent(id)}`, undefined, a.cookie)).status, 400);
    }
    for (const query of ['', `${own.klass.id}&classId=${other.klass.id}`]) assert.equal((await h.send('GET', `/api/tasks?classId=${query}`, undefined, a.cookie)).status, 400);
    assert.equal((await h.send('DELETE', `/api/classes/${other.klass.id}`, undefined, a.cookie)).status, 404);
    assert.deepEqual(await (await h.send('GET', `/api/tasks?classId=${other.klass.id}`, undefined, a.cookie)).json(), []);
    assert.equal((await (await h.send('GET', `/api/tasks?classId=${own.klass.id}`, undefined, a.cookie)).json()).length, 1);
    assert.deepEqual(await h.snapshot(), before);
  } finally { await h.close(); }
});

test('Stage 1 API errors: authentication, validation, Origin, missing records, conflicts and limits are no-store', async () => {
  const h = await securityHarness();
  try {
    const a = await h.register(), data = await h.seed(a.cookie, 'Errors');
    const responses: [Response, number][] = [
      [await h.send('GET', '/api/classes'), 401],
      [await h.send('POST', '/api/classes', {}, a.cookie), 400],
      [await h.send('POST', '/api/classes', {}, a.cookie, { Origin: 'https://foreign.example.test' }), 403],
      [await h.send('DELETE', `/api/classes/${randomUUID()}`, undefined, a.cookie), 404],
      [await h.send('POST', '/api/slots', data.slot, a.cookie), 409],
    ];
    for (let i = 0; i < 10; i++) await h.send('POST', '/api/auth/reset', {});
    responses.push([await h.send('POST', '/api/auth/reset', {}), 429]);
    for (const [response, status] of responses) {
      assert.equal(response.status, status);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal('stack' in await response.json(), false);
    }
  } finally { await h.close(); }
});
