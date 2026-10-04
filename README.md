# StudyPilot

A study planner for students: classes, tasks (assignments, homework, exams, projects), deadlines, a task calendar, deadline reminders, grade and target tracking with a CGPA calculator, a weekly class timetable and an attendance log. Built with TypeScript on both sides.

## Features
- Track classes, tasks, deadlines and grades; view tasks in a list or calendar and receive browser deadline reminders.
- Calculate semester GPA and cumulative CGPA from courses, grades and credit hours.
- Plan a weekly timetable and monitor attendance allowances.
- Install the responsive app as a PWA; saved screens are available offline in read-only mode.

## Stack
- **Frontend:** React 19 + TypeScript + Vite (`web/`)
- **API:** Node.js + Express 5 + TypeScript, zod request validation (`src/`)
- **Database:** PostgreSQL via `pg` in production, SQLite through Node's built-in `node:sqlite` for local development (Node 22.13 or newer)
- **Accounts:** email and password, scrypt password hashing, random session tokens stored hashed, httpOnly SameSite=Lax cookie
- **Security:** Helmet security headers and in-memory auth rate limiting
- **Quality:** automated API tests (Node test runner), Docker image, GitHub Actions CI

## Run
```bash
npm install
npm --prefix web install
```

Start the API and web development server in separate PowerShell terminals:
```bash
npm run dev
```
```bash
npm run dev:web
```
The API runs on http://localhost:3000. The web server runs on http://localhost:5173 and proxies `/api` requests to the API.

Run tests and build/start the production app:
```bash
npm test
npm run test:e2e
npm run build:all
npm start
```

Build and run the Docker image:
```bash
docker build -t studypilot .
docker run -p 3000:3000 -v studypilot-data:/data studypilot
```
Set `DATABASE_URL` to use PostgreSQL; without it, local development continues to use SQLite. For a local PostgreSQL instance, run `docker compose up -d postgres`, then use `DATABASE_URL=postgresql://studypilot:studypilot@localhost:5432/studypilot` before starting the API. Migrations run automatically at startup.

Existing SQLite databases are migrated automatically on startup.

## Deploy

This project includes a [Render Blueprint](https://github.com/limkx-wm24-eng/studypilot-ts/blob/main/render.yaml) for a free public web service and uses Neon for hosted PostgreSQL. Do not commit a `.env` file or paste a connection string into source control.

1. Push this repository to GitHub. The Blueprint is at the repository root and builds the app from the repository root.
2. Create a Neon Free project, then copy its PostgreSQL connection string from the **Connect** panel. Use the connection string with `sslmode=require`.
3. In Render, select **New > Blueprint**, connect the GitHub repository, and select the branch containing `render.yaml`.
4. Set the prompted `DATABASE_URL` value to the Neon connection string. Render supplies `NODE_ENV=production` and `PORT=10000` from the Blueprint.
5. Create the Blueprint and wait for Render to report a passing `/api/health` check. Open the generated `https://<service>.onrender.com` URL and register an account. Database migrations run automatically on first startup.

Use `.env.example` as a reference for local environment-variable names and replace its placeholders when setting values. The app does not read `.env` automatically; set variables in PowerShell or in your host dashboard. Do not commit real credentials.

Free-tier notes verified in October 2026: Render Free web services spin down after 15 minutes without traffic, receive 750 free instance-hours per workspace each month, and can restart at any time. [Render's free-service limits](https://render.com/docs/free) apply. Neon's Free plan currently provides 1 GB storage and 100 CU-hours of compute per project each month; see [Neon's current Free plan announcement](https://neon.com/blog/neon-free-plan-1-gb-per-project). These limits make this suitable for a portfolio demo, not a production service.

## API
All `/api/classes`, `/api/tasks`, `/api/courses`, `/api/slots` and `/api/attendance` routes need a logged-in session and only return or change the caller's own data. The app also provides a task calendar, browser deadline reminders and a CGPA tracker.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | Create an account, log in, log out |
| GET, PATCH, DELETE | `/api/auth/me` | Read or update the profile, or delete the account and all its data |
| GET, POST | `/api/classes` | List or create classes |
| PATCH, DELETE | `/api/classes/:id` | Update or delete a class (deletes its tasks) |
| GET, POST | `/api/tasks` | List (`?classId=`) or create tasks |
| PATCH, DELETE | `/api/tasks/:id` | Update fields or delete |
| GET, POST | `/api/courses` | List or add courses for GPA/CGPA tracking |
| PATCH, DELETE | `/api/courses/:id` | Update or delete a course |
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
- [x] Calendar view and deadline reminders
- [ ] .ics export
- [ ] Email verification
- [ ] Password reset
- [x] PostgreSQL and a free hosted deployment
- [x] Browser test with Playwright
