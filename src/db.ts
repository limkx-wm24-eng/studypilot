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

// Only these historical, single-column SQLite upgrades may predate the ledger.
const legacyColumns: Record<string, [string, string, string, number, string | null]> = {
  '002_users_semester_weeks.sql': ['users', 'semester_weeks', 'INTEGER', 1, '14'],
  '003_users_semester_start.sql': ['users', 'semester_start', 'TEXT', 1, "''"],
  '004_classes_created_at.sql': ['classes', 'created_at', 'BIGINT', 1, '0'],
  '005_tasks_created_at.sql': ['tasks', 'created_at', 'BIGINT', 1, '0'],
  '006_users_reminder_days.sql': ['users', 'reminder_days', 'INTEGER', 1, '1'],
  '009_users_email_verified_at.sql': ['users', 'email_verified_at', 'BIGINT', 0, null],
};
const normalizedSql = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
async function existingLegacyColumn(db: Database, file: string): Promise<boolean> {
  const expected = legacyColumns[file];
  if (!expected) return false;
  const [table, name, type, required, defaultValue] = expected;
  const column = (await db.all(`PRAGMA table_info("${table}")`)).find((row) => row.name === name);
  if (!column) return false;
  if (String(column.type).toUpperCase() !== type || Number(column.notnull) !== required || Number(column.pk) !== 0 || column.dflt_value !== defaultValue) {
    throw new Error(`Legacy SQLite column ${table}.${name} does not match migration ${file}`);
  }
  return true;
}

async function prepareSqliteGuards(db: Database, file: string, sql: string) {
  if (!['010_class_name_limit.sqlite.sql', '012_class_name_guard_repair.sqlite.sql'].includes(file)) return;
  for (const name of ['classes_name_insert_limit', 'classes_name_update_limit']) {
    const trigger = await db.get("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", [name]);
    if (!trigger) continue;
    if (trigger.tbl_name !== 'classes') throw new Error('Unexpected table for a SQLite class-name guard');
    if (file.startsWith('010_')) {
      // Recover only a canonical fragment left by the old non-atomic 010 runner.
      // Arbitrary duplicate objects/definitions still fail without recording 010.
      const definition = [...sql.matchAll(/CREATE TRIGGER ([a-z_]+)[\s\S]+?END;/g)].find((match) => match[1] === name)?.[0];
      if (!definition || normalizedSql(String(trigger.sql)) !== normalizedSql(definition)) throw new Error('Unexpected definition for an unrecorded SQLite class-name guard');
      await db.exec(`DROP TRIGGER "${name}"`);
    }
  }
}

export async function migrate(db: Database, dialect: 'sqlite' | 'postgres', through = Infinity): Promise<void> {
  const files = (await readdir(migrationsPath)).filter((file) => /^\d+_.+\.sql$/.test(file)
    && Number(file.split('_')[0]) <= through
    && (!/\.(sqlite|postgres)\.sql$/.test(file) || file.endsWith(`.${dialect}.sql`))).sort();
  const sources = await Promise.all(files.map(async (file) => ({ file, sql: await readFile(`${migrationsPath}/${file}`, 'utf8') })));
  const deadline = performance.now() + 15_000;
  for (;;) {
    try {
      await db.transaction(async (transaction) => {
        if (dialect === 'postgres') {
          await transaction.exec("SET LOCAL lock_timeout = '15s'; SET LOCAL statement_timeout = '60s'");
          // One transaction/pinned connection, including ledger initialization.
          // Database + schema scope keeps disposable test schemas independent.
          await transaction.get("SELECT pg_advisory_xact_lock(hashtext('studypilot:migrations:' || current_database()), hashtext(current_schema()))");
        }
        await transaction.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
        for (const { file, sql } of sources) {
          if (await transaction.get('SELECT id FROM schema_migrations WHERE id = ?', [file])) continue;
          if (dialect === 'sqlite') await prepareSqliteGuards(transaction, file, sql);
          if (dialect !== 'sqlite' || !await existingLegacyColumn(transaction, file)) await transaction.exec(sql);
          await transaction.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [file, Date.now()]);
        }
      });
      return;
    } catch (error) {
      const busy = dialect === 'sqlite' && typeof error === 'object' && error !== null && 'errcode' in error && [5, 6].includes(Number(error.errcode));
      if (!busy) throw error;
      if (performance.now() >= deadline) throw new Error('SQLite migration startup remained busy for 15 seconds');
      // Yield rather than synchronously waiting on another in-process connection.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function openDb(path = ':memory:', options: { databaseUrl?: string; migrationsThrough?: number } = {}): Promise<Database> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const database = databaseUrl
    ? new PostgresDatabase(new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 }))
    : new SqliteDatabase(new DatabaseSync(path, { enableForeignKeyConstraints: true }));
  try {
    await migrate(database, databaseUrl ? 'postgres' : 'sqlite', options.migrationsThrough);
  } catch (error) {
    await database.close();
    throw error;
  }
  return database;
}
