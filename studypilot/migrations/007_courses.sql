CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  semester_label TEXT NOT NULL,
  course_name TEXT NOT NULL,
  credit_hours REAL NOT NULL,
  grade TEXT
);
