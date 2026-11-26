**Live demo:** https://studypilot-zsnh.onrender.com (free hosting: the first load after a quiet period can take up to a minute. Please don't enter real personal information.)

# StudyPilot

A study planner for students: classes, tasks (assignments, homework, exams, projects), deadlines, a task calendar, deadline reminders, grade and target tracking with a CGPA calculator, a weekly class timetable and an attendance log. Built with TypeScript on both sides.

## Features
- Track classes, tasks, deadlines and grades; view tasks in a list or calendar and receive browser deadline reminders.
- Calculate semester GPA and cumulative CGPA from courses, grades and credit hours.
- Plan a weekly timetable and monitor attendance allowances.
- Install the responsive app as a PWA; the static app shell is available offline.
- Offline mode provides the static app shell only. All API requests require a network connection; activating the updated worker removes legacy caches containing API responses.

Every web build checks the generated service worker for API caching, navigation fallback, legacy-cache cleanup and PDF precache exclusions. Run `npm run test:sw` to repeat that check after building.

<!-- Import screenshot placeholder: add a synthetic-data screenshot in docs/ after capturing the review screen. -->

## Import your timetable

On Timetable, choose **Import timetable** and select the TAR UMT portal's My Timetable PDF, or paste its **Semester Timetable By Course** table. Review and edit the classes and sessions before confirming. Projects and training without weekly sessions can also be created as classes.

Your PDF is read in your browser and never uploaded. Only the classes and sessions you confirm are sent to your account. From the portal, press Ctrl+P and choose **Save as PDF**, rather than **Microsoft Print to PDF**. Include the By Course table; any week works, including printing from a phone browser.

Limits: 10 MB, 20 PDF pages, 40 classes and 200 sessions per import. Everything is imported as weekly. Image-only PDFs need re-saving with a text layer or pasting the table; OCR is not supported. Identical sessions are skipped and overlapping sessions must be fixed or unchecked.

Source times must use hours 1–12, minutes 00–59 and AM/PM (case-insensitive; valid zero-padded hours are supported). Invalid source times remain visible with their original text and blank time fields; correct the 24-hour fields or exclude the session before importing. They are never normalized into other times, deduplicated away or included in overlap checks. Unreadable source rows are identified explicitly and require choosing the source again to correct them; other valid reviewed sessions can still be imported.

Pasted text and text extracted from a PDF are limited to 200,000 characters. Before overlap checks, the parser also rejects more than 60 courses or 400 sessions; the smaller 40-class and 200-session limits still apply when confirming an import.

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
npm --prefix web run test:import
npm run test:e2e
npm run build:all
npm start
```

`npm test` forces an isolated in-memory SQLite database and ignores inherited `DATABASE_URL` and `DB_PATH` settings. On Windows, to run Playwright with an installed Microsoft Edge instead of its bundled Chromium, set `$env:STUDYPILOT_E2E_CHANNEL = 'msedge'` before running the suite.

PostgreSQL verification is opt-in. Set `TEST_DATABASE_URL` explicitly to a disposable PostgreSQL database whose name contains `test`, then run `npm run test:pg`. The command never falls back to `DATABASE_URL`, refuses missing or non-test URLs, and never prints connection strings. It allows only the `sslmode` URL query parameter. The database role needs permission to create schemas.

The runner applies every migration in fresh, empty, isolated schemas, tests migration 010 against existing synthetic classes, slots, tasks and attendance, then runs the import API and security regression tests on PostgreSQL. It removes only the schemas it creates. The SQLite suite checks the same populated migration and foreign-key behavior. Migration 010 uses SQLite triggers, so no classes-table rebuild is needed. A separate CI job runs the PostgreSQL checks against a fresh PostgreSQL service container.

Build and run the Docker image:
```bash
docker build -t studypilot .
docker run -p 3000:3000 -v studypilot-data:/data studypilot
```
Set `DATABASE_URL` to use PostgreSQL; without it, local development continues to use SQLite. For a local PostgreSQL instance, run `docker compose up -d postgres`, then use `DATABASE_URL=postgresql://studypilot:studypilot@localhost:5432/studypilot` before starting the API. Migrations run automatically at startup.

Existing SQLite databases are migrated automatically on startup.

Migration startup commits ledger initialization, all pending SQL and its history in one transaction. SQLite retains its shared-connection transaction queue and uses `BEGIN IMMEDIATE`; migration contention yields between retries for at most 15 seconds rather than blocking the event loop with synchronous waits. PostgreSQL pins one connection, takes a transaction-scoped advisory lock keyed by database and current schema before creating/checking the ledger, and rechecks history under that lock. Its migration lock wait is limited to 15 seconds and each statement to 60 seconds. Commit, rollback or connection loss releases the lock; errors propagate and a later startup can retry. Application transactions and per-user timetable locks are unchanged.

Only historical SQLite single-column migrations 002–006 and 009 may be recognized without history, after their declared type, nullability, default and non-primary-key status match. Duplicate-object messages are not generally suppressed. An unrecorded canonical fragment of 010 is explicitly recreated inside the transaction; an unexpected definition fails. Forward migration `012_class_name_guard_repair.sqlite.sql` restores both class-name triggers even if old 010 history incorrectly claims completion. It is safe to repeat, never rewrites names or related data, permits unrelated updates to legacy names and preserves the existing whitespace/code-point policy. PostgreSQL still ends at 011; SQLite applies 001–010 plus 012. Historical migrations 001–011 remain unchanged.

## Email
Email verification, password reset and the Brevo HTTPS sender are built and tested with fake mail delivery. Real delivery has not been tested. The live demo intentionally runs with email off: the free providers considered require organization details or a verified domain. Render's free tier blocks SMTP, so this project supports an HTTPS email API instead.

With no production `MAIL_API_KEY`, `/api/config` returns only `{ "emailEnabled": false }`. Accounts and study features remain usable without verification. Forgot-password sending, verification resend and initiating an email change are unavailable; the UI explains why instead of promising mail. Registration, forgot-password and resend create no unsendable tokens. Already-issued, valid links can still be consumed. Forgot-password and resend give the same disabled message regardless of the submitted email; rate limits remain in force.

The UI fetches this public flag once per page load and keeps it in memory only. It is never written to browser storage or cached by the service worker.

Verification resend retains its one-minute cooldown and five-per-day limit. With email enabled these limits are per user; with email disabled they are per IP, so the response does not depend on an account lookup. Forgot-password throttling and existing token-consumption limits remain unchanged.

To enable delivery later, configure `MAIL_PROVIDER=brevo`, `MAIL_API_KEY`, `MAIL_FROM` (an authorized sender address) and `APP_URL` (the app's public HTTPS URL), then restart the service and reload the app. Do not put keys in source control. Availability reports configuration, not proof of successful provider delivery. No provider or domain setup is required for the demo.

When running the Vite development server, set `APP_URL=http://localhost:5173` so local token links open the running frontend. Reset and verification emails are implemented; the console provider prints only their links, never recipient details.

Password-reset links expire after **30 minutes**; verification links expire after **24 hours**. Reset tokens are single-use, and resetting a password revokes existing sessions. Console email output is disabled when `NODE_ENV=production`, including mailers constructed before the environment changes. Production never falls back to development token links.

For local development, use `MAIL_PROVIDER=console` with `NODE_ENV=development` (or unset); usable token links print only to your local API console, without recipient information. Console links are suppressed in test and production modes. If the production key is missing, email stays disabled and the server logs one warning. Keep `MAIL_API_KEY` private.

## Deploy

This project includes a [Render Blueprint](https://github.com/limkx-wm24-eng/studypilot/blob/main/render.yaml) for a free public web service and uses Neon for hosted PostgreSQL. Do not commit a `.env` file or paste a connection string into source control.

For reproducible release builds use `npm ci`, then `npm --prefix web ci`, followed by `npm run build:all`; the earlier `npm install` commands are for development. The Blueprint explicitly sets `dockerContext: .` and `dockerfilePath: ./Dockerfile`, relative to the repository root. `node scripts/check-blueprint.mjs --build` validates and builds those actual paths. The guard supports this project's one-service Blueprint and simple scalar path fields; unsupported syntax or a structure change requires extending the guard first. It rejects missing paths, wrong file types, duplicates and paths/links escaping the repository. CI runs the guard and its negative regressions without a YAML dependency.

Before deployment, an authorized owner must privately verify the intended hosted PostgreSQL target, TLS configuration, migration permissions and reachability. An absent `DATABASE_URL` still selects SQLite; that fallback is inappropriate for persistent data on ephemeral free hosting. Keep `NODE_ENV=production` and the hosting-provided `PORT`. The live demo intentionally leaves `MAIL_API_KEY` unset; no mail-provider setup is required. Actual Render settings and HTTPS cookie behavior have not been verified by local Docker tests.

Main automatically deploys according to the owner's configuration. Merge authorization and deployment authorization must be coordinated: a merge-only operation requires the owner to verify auto-deployment is suspended first. No repository test changes hosting settings or deploys the application.

1. Push this repository to GitHub. The Blueprint is at the repository root and builds the app from the repository root.
2. Create a Neon Free project, then copy its PostgreSQL connection string from the **Connect** panel. Use the connection string with `sslmode=require`.
3. In Render, select **New > Blueprint**, connect the GitHub repository, and select the branch containing `render.yaml`.
4. Set the prompted `DATABASE_URL` value to the Neon connection string. Render supplies `NODE_ENV=production` and `PORT=10000` from the Blueprint.
5. Create the Blueprint and wait for Render to report a passing `/api/health` check. Open the generated `https://<service>.onrender.com` URL and register an account. Database migrations run automatically on first startup.

Use `.env.example` as a reference for local environment-variable names and replace its placeholders when setting values. The app does not read `.env` automatically; set variables in PowerShell or in your host dashboard. Do not commit real credentials.

Free-tier notes verified in October 2026: Render Free web services spin down after 15 minutes without traffic, receive 750 free instance-hours per workspace each month, and can restart at any time. [Render's free-service limits](https://render.com/docs/free) apply. Neon's Free plan currently provides 1 GB storage and 100 CU-hours of compute per project each month; see [Neon's current Free plan announcement](https://neon.com/blog/neon-free-plan-1-gb-per-project). These limits make this suitable for a portfolio demo, not a production service.

## Recovery and rollback

Never blindly revert to old main `ac4f510258ffe95203d153d6eefd285b5ed77d3e` after versioned password records have been written: its legacy-only reader returns HTTP 500 for those accounts. Do not downgrade stored hashes or require blanket resets to work around this.

The selected recovery target is immutable Q3 Stage 3 commit **`14614752e81f6e4d6a78f93210b9eb7c9c447939`**. It retains the Q1–Q3 fixes, current/legacy/supported older password readers and normal upgrades. Run `node scripts/test-rollback.mjs` from the candidate checkout to build candidate, rollback and negative old-main images. Historical builds use `git archive` of the exact SHAs and their own manifests/lockfiles, with Docker's `npm ci`; no host dependency installation or branch update is performed. CI also runs this smoke against disposable SQLite and PostgreSQL data. It exercises candidate → rollback → candidate, registration, legacy/older upgrades, existing sessions, incorrect credentials, ownership, study-data writes and database guards. Raw credentials, cookies and password records are never logged. The script prints its temporary evidence directory, containing `images.json`, each `*-image.id`, build logs and sanitized results. Record and retain the tested rollback image ID before release; do not substitute an untested rebuild. These are local image identities, not published registry images. The Docker base is floating Node 22, so an identical original historical binary is not asserted.

The selected target still has the old migration runner and the old Blueprint paths. It is a recovery application only **after the corrected candidate has committed every migration and the ledger, both class-name guards and foreign keys have been independently verified**. Halt writes and concurrent startup during the handoff. Use the corrected repository-root Docker paths; do not apply the old Blueprint. Start only one rollback instance, with no pending, interrupted or competing migrations. It accepts the completed 012 SQLite ledger and the existing 011 PostgreSQL schema without reverting either. If these prerequisites cannot be established, use a forward corrective release instead.

Before any separately authorized deployment, take an access-controlled backup and prove restoration into an approved isolated database. For PostgreSQL, use a custom-format `pg_dump`, inspect it with `pg_restore --list`, restore with `pg_restore --exit-on-error`, and verify schema history, guard behavior, row/ownership relationships and critical workflows. For SQLite, stop writers and take a consistent database backup, not an arbitrary copy during a write. Keep the backup separate from application storage and credentials out of commands/logs. Local synthetic PostgreSQL restore and subsequent upgrade were tested; production backups and hosting recovery remain unverified.

Recovery succeeds only when compatible accounts can log in, existing sessions and ownership checks work, study data remains readable/writable, guards and history remain correct, and the corrected candidate can restart without password downgrade or data loss. Migration 011 and repair 012 do not require a destructive schema downgrade. Restore a database only with explicit authorization and an accepted plan for post-backup writes; do not overwrite newer data merely to restore an older image. Actual hosted PostgreSQL selection, HTTPS cookie round trips, proxy forwarding, resource limits and auto-deploy suspension still require separate production verification. No test authorizes a merge or deployment.

## API
All `/api/classes`, `/api/tasks`, `/api/courses`, `/api/slots` and `/api/attendance` routes need a logged-in session and only return or change the caller's own data. The app also provides a task calendar, browser deadline reminders and a CGPA tracker.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | Create an account, log in, log out |
| POST | `/api/auth/forgot`, `/api/auth/reset` | Request a password reset link or set a new password |
| POST | `/api/auth/verify-email`, `/api/auth/resend-verification` | Verify an email or resend its verification message |
| POST | `/api/auth/confirm-email-change` | Confirm an account email change from the new inbox |
| GET, PATCH, DELETE | `/api/auth/me` | Read or update the profile, or delete the account and all its data |
| PATCH | `/api/auth/email` | Change the account email after password confirmation |
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

PostgreSQL forward migration `011_class_name_legacy_updates.postgres.sql` replaces migration 010's NOT VALID name-length CHECK with insert and name-update triggers in one atomic DO statement, under an exclusive classes-table lock. Existing names are never rewritten. Legacy over-limit names can receive unrelated updates, including color-only PATCH; any requested name assignment must satisfy the existing limit, even if assigning the same value. Valid renames and new names still require 1–60 characters. Migration failure rolls back the enforcement replacement; its DDL is also repeatable if migration bookkeeping needs retrying. SQLite already has these trigger semantics and needs no 011 migration. Migration 010 and earlier files remain unchanged.

The existing database guards trim ASCII spaces and count Unicode code points on both databases. The installed API validator also counts code points, but trims Unicode whitespace and rejects control characters. Thus direct SQL can still store a tab-only or non-breaking-space name that the API rejects; 011 preserves those existing database rules rather than broadening or silently changing validation. Browser length limits and some import preview checks use UTF-16 units and can restrict non-BMP names earlier than the API; that existing distinction is unchanged.

Dates supplied for task deadlines, semester starts and attendance (including attendance query bounds) must be real Gregorian `YYYY-MM-DD` dates; impossible dates return `400` without writes. The optional semester start can still be cleared with `""`. Valid date strings retain their exact date without timezone conversion; existing invalid stored records are not rewritten.

Timetable creation and imports perform their authoritative overlap checks and writes in one transaction. They acquire the same user-row lock before reading timetable/class data. PostgreSQL holds this database lock across connections and app instances, independently for each user; SQLite uses its existing queued shared connection and `BEGIN IMMEDIATE` single-writer transaction. Class renames/deletions and slot deletions coordinate with imports through the same lock. Transactions commit before responses and roll back/release locks on errors. Ordinary overlaps still return `409`, while adjacent sessions remain allowed.

Imports deduplicate only exact sessions: case-insensitive class name, day, start/end, session type and trimmed room must agree. Identical re-imports still count as skipped. Same scheduling identity with different type or room returns `409` with `{ error, conflicts }`; metadata entries add `reason: "metadata"`, `fields` (`kind` and/or `room`), and `existing`/`incoming` objects containing those values. `row` is 1-based; `with` is a 1-based payload row or `"existing"`. Ordinary overlap entries keep their existing `{ row, with }` shape. No part of a conflicting import is committed. The preview retains conflicting source rows, identifies both sets of metadata and requires editing or excluding rows before import; it never overwrites stored metadata.

PATCH on classes, tasks and courses uses an ownership-filtered atomic update returning the complete changed row. If concurrent deletion wins, PATCH returns the existing JSON `404` error; if PATCH wins, its complete snapshot remains a valid success even if deletion follows. Empty and partial patches and foreign-class `422`/missing-record `404` behavior remain supported. Frontend error handling must account for date `400`, metadata/clash `409` and missing-record `404` responses.

- Present and approved leave both count as attended. Only absences use up the allowance.
- Required attendance is 80% for Degree, Diploma and Foundation (`REQUIRED_PERCENT` in `src/timetable.ts`).
- Semester type sets the teaching weeks: long = 14, short = 7. Allowance = 20% of (weekly class hours x teaching weeks), rounded down to whole hours.
- `web/src/calendar.ts` holds the TAR UMT 2025/2026 calendar (undergraduate and postgraduate, November 2025 intake): First Semester (short, from 10 Nov 2025), Second Semester (long, from 26 Jan 2026) and Third Semester (long, from 15 Jun 2026). The page uses it to show where today falls and to set the semester in one click. TAR UMT says these dates may change, so update the file when the 2026/2027 calendar is published.
- Semester 202609 has seven teaching weeks, from 2 November to 20 December 2026. Its exam and holiday dates remain unknown and are displayed as such.
- An optional semester start date limits the log to that semester (from the start date for the number of teaching weeks), so old semesters do not count.
- These are estimates. Check them against your faculty's official rules.

## Security notes

Registration intentionally returns 409 for an existing email, which reveals whether an account exists; concealing registration would require an email-based flow, and email is disabled on the demo.

Passwords use asynchronous scrypt with random 16-byte salts and 64-byte derived keys. New records contain `scrypt$v1$N=16384,r=8,p=1$<salt>$<key>`. The version defines the salt/key lengths; the record stores the cost parameters. Legacy `salt:key` records continue verifying with their original N=16384/r=8/p=1 settings and are upgraded to the versioned format after a successful login. Supported older v1 N=8192/r=8/p=1 records are also upgraded. Unsupported versions/costs are rejected before allocation; upgrades never replace a concurrently reset password or downgrade a supported stronger record.

The selected policy deliberately retains the legacy cost: increasing it did not consistently meet the local 300 ms login budget. The estimated scrypt working buffers are **16.003 MiB per operation**, below the 32 MiB budget; `maxmem=34 MiB` is an allocation ceiling allowing overhead, not a measurement of usage. Node/process overhead is additional. One process-wide queue permits **two active operations and eight waiting** across registration, verification, dummy work, resets and upgrades. Saturation returns generic 503 with `Retry-After: 1`; reset tokens and sessions remain intact. Queueing delays and upgrade work can exceed 300 ms.

Candidate raw-hash medians measured locally (three measured samples after warm-up; machine load varied between passes):

| N | r | p | Observed median range (ms) | Estimated buffers (MiB) |
|---|---|---|---|---|
| 16384 | 8 | 1 | 46–209 | 16.003 |
| 16384 | 8 | 2 | 424 | 16.004 |
| 16384 | 8 | 3 | 137–620 | 16.005 |
| 16384 | 8 | 4 | 841 | 16.006 |
| 16384 | 8 | 5 | 220–527 | 16.007 |
| 16384 | 8 | 6 | 265–594 | 16.008 |
| 16384 | 8 | 7 | 541–802 | 16.009 |
| 16384 | 8 | 8 | 348–980 | 16.010 |
| 32768 | 8 | 2 | 181–502 | 32.004 |
| 32768 | 8 | 3 | 268–689 | 32.005 |
| 32768 | 8 | 4 | 358–967 | 32.006 |

Larger-N candidates exceed the strict 32 MiB estimated-buffer budget once overhead is included. Stronger candidates sometimes ran below 300 ms but failed that target in later measurements; no stronger measured r=8 profile stayed within both budgets. With the selected policy, the final in-memory SQLite HTTP benchmark measured normal login at **159 ms median (137–182 ms)** and legacy upgrade at **390 ms (322–406 ms)**. Current/legacy/unknown failed-login medians were 184/180/173 ms. These local measurements are not a production guarantee. Run `node --import tsx scripts/benchmark-passwords.ts` (or add `--shortlist`) and `node --import tsx scripts/benchmark-auth.ts` to repeat them with synthetic inputs; neither prints passwords or hashes.

This policy **does not meet OWASP's listed scrypt minimum**: its closest same-memory recommendation is N=16384/r=8/p=5, versus our p=1. That difference is a cost-setting shortfall, not a claim that password resistance scales linearly. See [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt). The choice favors the measured latency/resource limits on a CPU-constrained, approximately 512 MB Render instance; Render performance has not been measured. Before raising the policy, repeat the benchmark and revisit the latency budget or hosting resources. The explicit version/parameters allow a later upgrade.

Legacy/current/unknown login failures perform the same supported scrypt profile; older N=8192 records receive bounded dummy work to reduce timing differences. This does not promise identical wall-clock timing over a network.

## Known limits
Frontend mutations report success or failure explicitly. Failed class, task and course creation retains the draft; pending submissions are disabled and are never retried automatically. Initial datasets load independently, with unavailable data distinguished from an empty result and a Retry loading action. Semester edits remain visibly unsaved after failure. Task and course mutations are ordered per record and use authoritative server snapshots; obsolete attendance-week and previous-session responses are ignored.

Password-reset links open the reset form whether signed in or signed out. The link identifies the account being reset, which may differ from the current session. The existing 30-minute expiry, single-use and session-invalidation rules remain unchanged; after success the frontend removes the reset URL parameter and rechecks the current session. Cancellation returns to the current application/login state. Email-disabled demo recovery remains unavailable.

Calendar features use the Asia/Kuala_Lumpur day in every browser timezone. Dashboard, its navigation badge, Tasks, Timetable and Progress share one day subscription per authenticated shell; it reevaluates at Malaysia midnight and on focus/visibility recovery. Date-only deadlines, attendance and semester dates stay `YYYY-MM-DD`, with UTC calendar arithmetic and date-only formatting that cannot shift them into another day. The current week/month follows rollovers; deliberately selected periods stay selected until This week/This month is used. Automatic period replacement waits while focus is inside that period, or its task/attendance mutation or timetable import is pending, then catches up when that work finishes and focus leaves. Form drafts and open dialogs remain intact. No polling or server/API date conversion is involved.

Deadline reminders reevaluate at Malaysia midnight while the application is open, and on focus/visibility recovery. Each check uses the current day, so delayed execution after sleep catches up without replaying missed days. Per-user, per-task daily deduplication remains in place; timers are cancelled on dependency changes, logout and unmount. Browser throttling can delay delivery. Reminders are not guaranteed while the browser or application is closed; real operating-system delivery and Render behavior have not been verified by the automated, stubbed notification tests.

Logout and account changes are synchronized across tabs using BroadcastChannel with a storage-event fallback. Messages carry only an event type and random nonce, never account data. Focus and visibility checks hide the account view until the session is verified; a changed or invalid session discards the previous account state. If both browser mechanisms are blocked, focus/visibility checks still protect returning tabs.

Notification deduplication history uses only the opaque user ID in its storage key. The old shared key is removed on startup and logout. The app closes notifications it created when an account is cleared, where the browser API permits; the operating system's notification history is outside the app's control.

- Login limits count five failed attempts per normalized email/IP pair and 30 per IP across emails in a rolling 15-minute window. A successful login clears only its own pair, preserving aggregate and other-client counters. In-flight attempts reserve capacity; temporary saturation returns 429 with `Retry-After: 1`, while actual lockouts report their remaining window. Pair/IP maps each retain at most 4,096 keys; capacity pressure rejects new keys with 429 and `Retry-After: 60` rather than evicting active limits. Idle expired entries are reclaimed. Registration, forgot-password and email-change checks retain their separate existing throttling and responses. These counters are in memory, per instance, and reset on every restart/deploy; they are not distributed. IP protection depends on trustworthy resolved client IPs; live Render forwarding behavior remains unverified.
- Reset and email-verification token consumption each allow ten attempts per IP per 15 minutes, including malformed requests. Limited requests return 429 with `Retry-After`.
- Free hosts can sleep or restart, and their limits can change. Use hosted PostgreSQL and review your provider's current plan before sharing the demo.

## Known dev-tooling audit findings

The production-only audits report **0 production findings**. After the approved Vite 8.3.3, fast-uri 3.1.9 and serialize-javascript 7.1.3 patch updates, the web audit still reports four moderate dev-only findings: glob, minimatch, and their workbox-build / vite-plugin-pwa dependency chain. These tools run during development/builds, not in the deployed Express runtime. Fixing the remaining chain requires versions outside the current parent ranges or an incompatible plugin downgrade; those changes have not been applied or approved. No forced audit fix or major override was used.

## Roadmap
- [x] Q3 task-control pointer access, session recovery, responsive layout, contrast, native calendar semantics and live Malaysia-date consistency.
- [x] Accounts and per-user data
- [x] React + TypeScript frontend
- [x] Class timetable
- [x] Attendance log (uses the course type from the profile)
- [x] Calendar view and deadline reminders
- [ ] .ics export
- [x] Email verification
- [x] Password reset
- [x] PostgreSQL and a free hosted deployment
- [x] Browser test with Playwright
