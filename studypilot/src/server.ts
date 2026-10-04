import { createApp } from './app.js';
import { deleteExpiredSessions } from './auth.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const db = await openDb(process.env.DB_PATH ?? 'studypilot.db');
await deleteExpiredSessions(db);
const sessionCleanup = setInterval(() => {
  void deleteExpiredSessions(db).catch((error: unknown) => {
    console.error('Failed to delete expired sessions:', error);
  });
}, 60 * 60 * 1000);
sessionCleanup.unref();
createApp(db).listen(port, () => {
  console.log(`StudyPilot is running on http://localhost:${port}`);
});
