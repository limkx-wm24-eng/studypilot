import { spawnSync } from 'node:child_process';
import { requireTestDatabaseUrl } from '../test/support/postgresSafety.js';

let databaseUrl: string;
try { databaseUrl = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL); }
catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const env = { ...process.env, DATABASE_URL: '', DB_PATH: ':memory:', NODE_ENV: 'test', STUDYPILOT_TEST_POSTGRES: '1', TEST_DATABASE_URL: databaseUrl };
// First exercise every migration on fresh schemas, then the same import tests as SQLite.
for (const args of [
  ['test/migrations.test.ts'],
  ['--test-name-pattern=timetable import|database rejects', 'test/api.test.ts'],
]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...args], {
    cwd: new URL('../', import.meta.url), env, stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    console.error('PostgreSQL verification failed.');
    process.exit(result.status || 1);
  }
}
