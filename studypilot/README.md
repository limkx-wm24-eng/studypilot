# StudyPilot

A study planner for students: classes, tasks (assignments, homework, exams, projects), deadlines, grades with a target-grade calculator, a weekly class timetable and an attendance log. Built with TypeScript on both sides.

## Stack
- **Frontend:** React 19 + TypeScript + Vite (`web/`)
- **API:** Node.js + Express 5 + TypeScript, zod request validation (`src/`)
- **Database:** SQLite through Node's built-in `node:sqlite` (Node 22.13 or newer)
- **Accounts:** email and password, scrypt password hashing, random session tokens stored hashed, httpOnly SameSite=Lax cookie
- **Quality:** automated API tests (Node test runner), Docker image, GitHub Actions CI

## Run
```bash
npm install && npm --prefix web install
npm run dev          # API on http://localhost:3000
npm run dev:web      # React dev server on http://localhost:5173 (proxies /api to :3000)
npm test
npm run build:all && npm start     # production build served by the API on :3000
docker build -t studypilot . && docker run -p 3000:3000 -v studypilot-data:/data studypilot
```
If you ran an earlier version, delete the old `studypilot.db`: the schema now has users.

## API
All `/api/classes` and `/api/tasks` routes need a logged-in session and only return the caller's own data.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | Create an account, log in, log out |
| GET, PATCH, DELETE | `/api/auth/me` | Read or update the profile, or delete the account and all its data |
| GET, POST | `/api/classes` | List or create classes |
| PATCH, DELETE | `/api/classes/:id` | Update or delete a class (deletes its tasks) |
| GET, POST | `/api/tasks` | List (`?classId=`) or create tasks |
| PATCH, DELETE | `/api/tasks/:id` | Update fields or delete |
| GET, POST | `/api/slots` | List or add weekly class times (a clash on the same day returns `409`) |
| DELETE | `/api/slots/:id` | Remove a class time and its attendance records |
| GET | `/api/attendance?from=&to=` | Attendance marks in a date range |
| PUT | `/api/attendance` | Mark a class `present`, `absent` or `leave` on a date (`null` clears it) |
| GET | `/api/attendance/summary` | Per-class allowance: hours you can still miss, attendance so far |

## Attendance rules
- Present and approved leave both count as attended. Only absences use up the allowance.
- Required attendance is 80% for Degree, Diploma and Foundation (`REQUIRED_PERCENT` in `src/timetable.ts`).
- Semester type sets the teaching weeks: long = 14, short = 7. Allowance = 20% of (weekly class hours x teaching weeks), rounded down to whole hours.
- `web/src/calendar.ts` holds the TAR UMT 2025/2026 calendar (undergraduate and postgraduate, November 2025 intake): First Semester (short, from 10 Nov 2025), Second Semester (long, from 26 Jan 2026) and Third Semester (long, from 15 Jun 2026). The page uses it to show where today falls and to set the semester in one click. TAR UMT says these dates may change, so update the file when the 2026/2027 calendar is published.
- An optional semester start date limits the log to that semester (from the start date for the number of teaching weeks), so old semesters do not count.
- These are estimates. Check them against your faculty's official rules.

## Known limits
- No rate limiting on login, email verification or password reset yet.
- SQLite needs a disk that survives restarts; many free hosts do not provide one, so move to hosted PostgreSQL before deploying.

## Roadmap
- [x] Accounts and per-user data
- [x] React + TypeScript frontend
- [x] Class timetable
- [x] Attendance log (uses the course type from the profile)
- [ ] Calendar view, deadline notifications, .ics export
- [ ] PostgreSQL and a free hosted deployment
- [ ] Browser tests with Playwright
