import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

export type DbValue = SQLInputValue;
export type DbRow = Record<string, unknown>;

export interface Database {
  all<T extends DbRow = DbRow>(sql: string, values?: readonly DbValue[]): Promise<T[]>;
  get<T extends DbRow = DbRow>(sql: string, values?: readonly DbValue[]): Promise<T | undefined>;
  run(sql: string, values?: readonly DbValue[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

class SqliteDatabase implements Database {
  constructor(private readonly db: DatabaseSync) {}

  async all<T extends DbRow>(sql: string, values: readonly DbValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...values) as T[];
  }

  async get<T extends DbRow>(sql: string, values: readonly DbValue[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...values) as T | undefined;
  }

  async run(sql: string, values: readonly DbValue[] = []): Promise<{ changes: number }> {
    return { changes: Number(this.db.prepare(sql).run(...values).changes) };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PostgresDatabase implements Database {
  constructor(private readonly pool: Pool) {}

  private query(sql: string, values: readonly DbValue[] = []) {
    let index = 0;
    // Route SQL uses one neutral placeholder syntax; only this adapter knows PostgreSQL uses $1, $2, ... .
    const postgresSql = sql.replace(/\?/g, () => `$${++index}`);
    return this.pool.query(postgresSql, [...values]);
  }

  async all<T extends DbRow>(sql: string, values: readonly DbValue[] = []): Promise<T[]> {
    return (await this.query(sql, values)).rows as T[];
  }

  async get<T extends DbRow>(sql: string, values: readonly DbValue[] = []): Promise<T | undefined> {
    return (await this.query(sql, values)).rows[0] as T | undefined;
  }

  async run(sql: string, values: readonly DbValue[] = []): Promise<{ changes: number }> {
    return { changes: (await this.query(sql, values)).rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const migrationsPath = fileURLToPath(new URL('../migrations/', import.meta.url));
const duplicateColumn = (error: unknown) => error instanceof Error && /duplicate column|already exists/i.test(error.message);

async function migrate(db: Database): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
  const files = (await readdir(migrationsPath)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of files) {
    if (await db.get('SELECT id FROM schema_migrations WHERE id = ?', [file])) continue;
    const sql = await readFile(`${migrationsPath}/${file}`, 'utf8');
    try {
      await db.exec(sql);
    } catch (error) {
      // Older SQLite files have no migration history. A duplicate ADD COLUMN means that repair was already made.
      if (!duplicateColumn(error)) throw error;
    }
    await db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [file, Date.now()]);
  }
}

export async function openDb(path = ':memory:'): Promise<Database> {
  const database = process.env.DATABASE_URL
    ? new PostgresDatabase(new Pool({ connectionString: process.env.DATABASE_URL }))
    : new SqliteDatabase(new DatabaseSync(path, { enableForeignKeyConstraints: true }));
  await migrate(database);
  return database;
}
