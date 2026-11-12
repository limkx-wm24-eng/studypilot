import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('test preload ignores an inherited database URL and opens isolated SQLite', () => {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--import', './test/setup.ts', '--input-type=module', '-e',
    `import assert from 'node:assert/strict';
     const { openDb } = await import('./src/db.ts');
     assert.equal(process.env.DATABASE_URL, '');
     assert.equal(process.env.DB_PATH, ':memory:');
     const db = await openDb();
     try {
       assert.ok(await db.get('SELECT sqlite_version() AS version'));
       assert.equal((await db.all('SELECT * FROM users')).length, 0);
     } finally { await db.close(); }`,
  ], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/never_connect', DB_PATH: 'never-open.db' },
    encoding: 'utf8', timeout: 20_000,
  });
  // Do not include child output: inherited configuration must never appear in failures.
  assert.equal(result.error, undefined, 'Database safety subprocess must start');
  assert.equal(result.status, 0, 'Test setup must select isolated SQLite despite inherited database settings');
});
