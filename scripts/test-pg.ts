import { spawnSync } from 'node:child_process';
import { requireTestDatabaseUrl } from '../test/support/postgresSafety.js';

let databaseUrl: string;
try { databaseUrl = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL); }
catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const env = { ...process.env, DATABASE_URL: '', DB_PATH: ':memory:', NODE_ENV: 'test', INGRESS_MODE: 'direct', TRUSTED_PROXY_CIDRS: '', STUDYPILOT_TEST_POSTGRES: '1', TEST_DATABASE_URL: databaseUrl };
// Exercise migrations, imports and security regressions on isolated PostgreSQL schemas.
for (const args of [
  ['test/migrations.test.ts', 'test/migrationReliability.test.ts'],
  ['--test-name-pattern=timetable import|database rejects', 'test/api.test.ts'],
  ['test/securityReview.test.ts', 'test/securityFixes.test.ts', 'test/stage2Auth.test.ts'],
  ['test/passwordCompatibility.test.ts', 'test/passwordActivation.test.ts'],
  ['test/ingress.test.ts'],
  ['test/stageAData.test.ts', 'test/stageADates.test.ts', 'test/stageAPatch.test.ts'],
  ['test/stageCLegacy.test.ts'],
]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...args], {
    cwd: new URL('../', import.meta.url), env, stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    console.error('PostgreSQL verification failed.');
    process.exit(result.status || 1);
  }
}
