import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const db = await openDb(process.env.DB_PATH ?? 'studypilot.db');
createApp(db).listen(port, () => {
  console.log(`StudyPilot is running on http://localhost:${port}`);
});
