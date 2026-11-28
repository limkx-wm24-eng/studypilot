import type { Database } from './db.js';

export class UserUnavailable extends Error {}

/** All timetable writers acquire this lock before reading classes or slots.
 * PostgreSQL holds a real user-row lock across pools/processes; SQLite's
 * transaction adapter queues its shared connection and uses BEGIN IMMEDIATE.
 */
export function withUserTransaction<T>(db: Database, userId: string, operation: (transaction: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (transaction) => {
    const locked = await transaction.run('UPDATE users SET id = id WHERE id = ?', [userId]);
    if (!locked.changes) throw new UserUnavailable();
    return operation(transaction);
  });
}
