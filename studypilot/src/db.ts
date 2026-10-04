import { DatabaseSync } from 'node:sqlite';

export function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      course_type TEXT NOT NULL DEFAULT '',
      programme TEXT NOT NULL DEFAULT '',
      semester_weeks INTEGER NOT NULL DEFAULT 14,
      semester_start TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      due TEXT NOT NULL,
      grade REAL
    );
    CREATE TABLE IF NOT EXISTS slots (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      weekday INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      room TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS attendance (
      slot_id TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (slot_id, date)
    );
  `);
  // Databases created before timetables existed need the new column.
  const cols = (db.prepare('PRAGMA table_info(users)').all() as unknown as { name: string }[]).map((c) => c.name);
  if (!cols.includes('semester_weeks')) db.exec('ALTER TABLE users ADD COLUMN semester_weeks INTEGER NOT NULL DEFAULT 14');
  if (!cols.includes('semester_start')) db.exec("ALTER TABLE users ADD COLUMN semester_start TEXT NOT NULL DEFAULT ''");
  return db;
}
