import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT ?? 3000);
createApp(openDb(process.env.DB_PATH ?? 'studypilot.db')).listen(port, () => {
  console.log(`StudyPilot is running on http://localhost:${port}`);
});
