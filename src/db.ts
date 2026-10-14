import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

export type DbValue = SQLInputValue;
export type DbRow = Record<string, unknown>;

export interface Database {
  all<T extends DbRow = DbRow>(sql: string, values?: readonly DbValue[]): Promise<T[]>;
  get<T extends DbRow = DbRow>(sql: string, values?: readonly DbValue[]): Promise<T | undefined>;
  run(sql: string, values?: readonly DbValue[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  transaction<T>(operation: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class SqliteDatabase implements Database {
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private readonly db: DatabaseSync) {}

  async all<T extends DbRow>(sql: string, values: readonly DbValue[] = []): Promise<T[]> {
    await this.transactionTail;
    return this.db.prepare(sql).all(...values) as T[];
  }

  async get<T extends DbRow>(sql: string, values: readonly DbValue[] = []): Promise<T | undefined> {
    await this.transactionTail;
    return this.db.prepare(sql).get(...values) as T | undefined;
  }

  async run(sql: string, values: readonly DbValue[] = []): Promise<{ changes: number }> {
    await this.transactionTail;
    return { changes: Number(this.db.prepare(sql).run(...values).changes) };
  }

  async exec(sql: string): Promise<void> {
    await this.transactionTail;
    this.db.exec(sql);
  }

  async transaction<T>(operation: (db: Database) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const transactionDb: Database = {
      all: async <R extends DbRow>(sql: string, values: readonly DbValue[] = []) => this.db.prepare(sql).all(...values) as R[],
      get: async <R extends DbRow>(sql: string, values: readonly DbValue[] = []) => this.db.prepare(sql).get(...values) as R | undefined,
      run: async (sql: string, values: readonly DbValue[] = []) => ({ changes: Number(this.db.prepare(sql).run(...values).changes) }),
      exec: async (sql: string) => { this.db.exec(sql); },
      transaction: async <R>(nested: (db: Database) => Promise<R>) => nested(transactionDb),
      close: async () => {},
    };
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await operation(transactionDb);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    await this.transactionTail;
    this.db.close();
  }
}

class PostgresDatabase implements Database {
  constructor(private readonly pool: Pool) {}

  private query(client: Pool | PoolClient, sql: string, values: readonly DbValue[] = []) {
    let index = 0;
    // Route SQL uses one neutral placeholder syntax; only this adapter knows PostgreSQL uses $1, $2, ... .
    const postgresSql = sql.replace(/\?/g, () => `$${++index}`);
    return client.query(postgresSql, [...values]);
  }

  async all<T extends DbRow>(sql: string, values: readonly DbValue[] = []): Promise<T[]> {
    return (await this.query(this.pool, sql, values)).rows as T[];
  }

  async get<T extends DbRow>(sql: string, values: readonly DbValue[] = []): Promise<T | undefined> {
    return (await this.query(this.pool, sql, values)).rows[0] as T | undefined;
  }

  async run(sql: string, values: readonly DbValue[] = []): Promise<{ changes: number }> {
    return { changes: (await this.query(this.pool, sql, values)).rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(operation: (db: Database) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const transactionDb: Database = {
      all: async <R extends DbRow>(sql: string, values: readonly DbValue[] = []) => (await this.query(client, sql, values)).rows as R[],
      get: async <R extends DbRow>(sql: string, values: readonly DbValue[] = []) => (await this.query(client, sql, values)).rows[0] as R | undefined,
      run: async (sql: string, values: readonly DbValue[] = []) => ({ changes: (await this.query(client, sql, values)).rowCount ?? 0 }),
      exec: async (sql: string) => { await client.query(sql); },
      transaction: async <R>(nested: (db: Database) => Promise<R>) => nested(transactionDb),
      close: async () => {},
    };
    try {
      await client.query('BEGIN');
      const result = await operation(transactionDb);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
