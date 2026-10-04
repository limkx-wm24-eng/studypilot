# StudyPilot

A study planner for students: classes, tasks (assignments, homework, exams, projects), deadlines, grades with a target-grade calculator, a weekly class timetable and an attendance log. Built with TypeScript on both sides.

## Stack
- **Frontend:** React 19 + TypeScript + Vite (`web/`)
- **API:** Node.js + Express 5 + TypeScript, zod request validation (`src/`)
- **Database:** PostgreSQL via `pg` in production, SQLite through Node's built-in `node:sqlite` for local development (Node 22.13 or newer)
- **Accounts:** email and password, scrypt password hashing, random session tokens stored hashed, httpOnly SameSite=Lax cookie
- **Security:** Helmet security headers and in-memory auth rate limiting
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
Set `DATABASE_URL` to use PostgreSQL; without it, local development continues to use SQLite. For a local PostgreSQL instance, run `docker compose up -d postgres`, then use `DATABASE_URL=postgresql://studypilot:studypilot@localhost:5432/studypilot` before starting the API. Migrations run automatically at startup.

Existing SQLite databases are migrated automatically on startup.

## Deploy

This project includes a [Render Blueprint](../render.yaml) for a free public web service and uses Neon for hosted PostgreSQL. Do not commit a `.env` file or paste a connection string into source control.

1. Push this repository to GitHub. The Blueprint is at the repository root and builds the app from `studypilot/`.
2. Create a Neon Free project, then copy its PostgreSQL connection string from the **Connect** panel. Use the connection string with `sslmode=require`.
3. In Render, select **New > Blueprint**, connect the GitHub repository, and select the branch containing `render.yaml`.
4. Set the prompted `DATABASE_URL` value to the Neon connection string. Render supplies `NODE_ENV=production` and `PORT=10000` from the Blueprint.
5. Create the Blueprint and wait for Render to report a passing `/api/health` check. Open the generated `https://<service>.onrender.com` URL and register an account. Database migrations run automatically on first startup.

For local environment-variable names, copy `.env.example` to a private `.env` file or set the variables in PowerShell. The app does not read `.env` automatically; use your shell or a host dashboard to provide values.

Free-tier notes verified in October 2026: Render Free web services spin down after 15 minutes without traffic, receive 750 free instance-hours per workspace each month, and can restart at any time. [Render's free-service limits](https://render.com/docs/free) apply. Neon's Free plan currently provides 1 GB storage and 100 CU-hours of compute per project each month; see [Neon's current Free plan announcement](https://neon.com/blog/neon-free-plan-1-gb-per-project). These limits make this suitable for a portfolio demo, not a production service.

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
- Authentication rate limits count five failed attempts per email and IP in a rolling 15-minute window. The in-memory counters reset on server restart and are not shared between server instances.
- No email verification or password reset yet.
- Free hosts can sleep or restart, and their limits can change. Use hosted PostgreSQL and review your provider's current plan before sharing the demo.

## Roadmap
- [x] Accounts and per-user data
- [x] React + TypeScript frontend
- [x] Class timetable
- [x] Attendance log (uses the course type from the profile)
- [ ] Calendar view, deadline notifications, .ics export
- [x] PostgreSQL and a free hosted deployment
- [ ] Browser tests with Playwright
