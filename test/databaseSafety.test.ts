import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { requireTestDatabaseUrl } from './support/postgresSafety.js';

test('test preload ignores an inherited database URL and opens isolated SQLite', () => {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--import', './test/setup.ts', '--input-type=module', '-e',
    `import assert from 'node:assert/strict';
     const { openDb } = await import('./src/db.ts');
     assert.equal(process.env.DATABASE_URL, '');
     assert.equal(process.env.DB_PATH, ':memory:');
     assert.equal(process.env.STUDYPILOT_TEST_POSTGRES, '');
     const db = await openDb();
     try {
       assert.ok(await db.get('SELECT sqlite_version() AS version'));
       assert.equal((await db.all('SELECT * FROM users')).length, 0);
     } finally { await db.close(); }`,
  ], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/never_connect', DB_PATH: 'never-open.db', TEST_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic_test', STUDYPILOT_TEST_POSTGRES: '1' },
    encoding: 'utf8', timeout: 20_000,
  });
  // Do not include child output: inherited configuration must never appear in failures.
  assert.equal(result.error, undefined, 'Database safety subprocess must start');
  assert.equal(result.status, 0, 'Test setup must select isolated SQLite despite inherited database settings');
});

test('PostgreSQL opt-in rejects missing, non-test and overriding database URLs without exposing them', () => {
  for (const value of [undefined, '', 'not-a-url', 'https://localhost/synthetic_test', 'postgresql://synthetic:synthetic@localhost/production', 'postgresql://localhost/synthetic_test?database=production', 'postgresql://localhost/synthetic_test?dbname=production', 'postgresql://localhost/synthetic_test?options=-csearch_path=public']) {
    assert.throws(() => requireTestDatabaseUrl(value), (error: Error) => {
      assert.match(error.message, /TEST_DATABASE_URL/);
      assert.ok(!value || !error.message.includes(value));
      return true;
    });
  }
  assert.equal(requireTestDatabaseUrl('postgresql://localhost/synthetic_test'), 'postgresql://localhost/synthetic_test');
  assert.equal(requireTestDatabaseUrl('postgresql://localhost/SYNTHETIC_TEST?sslmode=require'), 'postgresql://localhost/SYNTHETIC_TEST?sslmode=require');
});

test('PostgreSQL command refuses to fall back to DATABASE_URL', () => {
  for (const explicit of ['', 'postgresql://synthetic:synthetic@127.0.0.1:1/production']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/test-pg.ts'], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, TEST_DATABASE_URL: explicit, DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/production' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /TEST_DATABASE_URL/);
    assert.doesNotMatch(result.stderr + result.stdout, /postgresql:\/\//);
  }
});
