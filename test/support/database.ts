import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { openDb, type Database } from '../../src/db.js';
import { requireTestDatabaseUrl } from './postgresSafety.js';

export const testDialect = process.env.STUDYPILOT_TEST_POSTGRES === '1' ? 'postgres' : 'sqlite';
const peers = new WeakMap<Database, () => Promise<Database>>();

/** A second application instance: a separate PostgreSQL pool in the same guarded
 * schema, or a second facade over SQLite's intentionally shared memory connection.
 * Close peers before closing the schema-owning database.
 */
export async function openTestPeer(database: Database): Promise<Database> {
  if (testDialect === 'sqlite') return {
    all: database.all.bind(database), get: database.get.bind(database), run: database.run.bind(database),
    exec: database.exec.bind(database), transaction: database.transaction.bind(database), close: async () => {},
  };
  const open = peers.get(database);
  if (!open) throw new Error('A peer requires an existing isolated test schema.');
  try { return await open(); }
  catch { throw new Error('Could not open the isolated PostgreSQL test peer.'); }
}

export async function openTestDb(migrationsThrough?: number): Promise<Database> {
  if (testDialect === 'sqlite') return openDb(':memory:', { databaseUrl: '', migrationsThrough });
  const databaseUrl = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const schema = `studypilot_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, max: 1 });
  let db: Database | undefined;
  let created = false;
  try {
    const actual = await admin.query<{ name: string }>('SELECT current_database() AS name');
    if (actual.rows[0].name !== decodeURIComponent(new URL(databaseUrl).pathname.slice(1))) throw new Error();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const count = await admin.query<{ count: string }>('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = $1', [schema]);
    if (count.rows[0].count !== '0') throw new Error();
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
    db = await openDb(':memory:', { databaseUrl: isolatedUrl.toString(), migrationsThrough });
    peers.set(db, () => openDb(':memory:', { databaseUrl: isolatedUrl.toString(), migrationsThrough }));
  } catch {
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await admin.end();
    throw new Error('Could not initialize the isolated PostgreSQL test schema. Check that the disposable test database is running and its role can create schemas.');
  }
  const database = db;
  const close = database.close.bind(database);
  database.close = async () => {
    try { await close(); }
    finally {
      try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  };
  return database;
}
