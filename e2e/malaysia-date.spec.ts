import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Kuala_Lumpur', locale: 'en-US' });
const DAY = 86_400_000;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const nav = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });
const dashboard = (page: Page) => page.getByRole('navigation').getByRole('button', { name: /^Dashboard/ });
const calendar = (page: Page) => page.getByRole('region', { name: 'Task deadline calendar', exact: true });
const dateCell = (page: Page, day: string) => calendar(page).getByRole('cell', { name: new RegExp(`^${day},`) });
const attendance = (page: Page, day: string) => page.getByRole('group', { name: `Attendance for Synthetic Malaysia class on ${day}`, exact: true });
const deliveries = (page: Page) => page.evaluate(() => (window as unknown as { deliveries: { body: string; closed: boolean }[] }).deliveries);

async function notifications(page: Page, permission: 'granted' | 'denied' | 'unsupported' = 'granted') {
  await page.addInitScript(permission => {
    const rows: { body: string; closed: boolean }[] = [];
    (window as unknown as { deliveries: typeof rows }).deliveries = rows;
    if (permission === 'unsupported') { delete (window as unknown as { Notification?: unknown }).Notification; return; }
    class FakeNotification {
      static permission = permission;
      static requestPermission = async () => permission;
      onclose?: () => void;
      row: { body: string; closed: boolean };
      constructor(_title: string, options: NotificationOptions) { this.row = { body: options.body ?? '', closed: false }; rows.push(this.row); }
      close() { this.row.closed = true; this.onclose?.(); }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification });
  }, permission);
}
async function seed(page: Page, dates = ['2026-11-03'], start = '2026-11-02') {
  expect((await page.request.post('/api/auth/register', { data: { email: `malaysia-${crypto.randomUUID()}@example.test`, password: 'synthetic-password-123' } })).status()).toBe(201);
  expect((await page.request.patch('/api/auth/me', { data: { reminderDays: 0, courseType: 'Degree', semesterStart: start, semesterWeeks: 7 } })).ok()).toBe(true);
  const klass = await (await page.request.post('/api/classes', { data: { name: 'Synthetic Malaysia class', color: '#0f766e' } })).json();
  for (const due of dates) expect((await page.request.post('/api/tasks', { data: { classId: klass.id, name: `Synthetic due ${due}`, due, type: 'Homework', status: 'Not started', priority: 'Medium', grade: null } })).status()).toBe(201);
  const slots: { id: string; weekday: number }[] = [];
  for (const weekday of [1, 2, 3, 7]) {
    const response = await page.request.post('/api/slots', { data: { classId: klass.id, weekday, kind: 'Lecture', start: '09:00', end: '10:00', room: 'Synthetic room' } });
    expect(response.status()).toBe(201); slots.push(await response.json());
  }
  return { klass, slots };
}
async function pause(page: Page, instant: string) {
  const now = new Date(instant);
  await page.clock.install({ time: now }); await page.clock.pauseAt(now);
}
async function open(page: Page, instant = '2026-11-02T23:59:00+08:00') {
  await pause(page, instant); await page.goto('/'); await expect(nav(page, 'Tasks')).toBeVisible();
  await expect(page.locator('.stat-card').first()).toBeVisible();
}
async function taskCalendar(page: Page) { await nav(page, 'Tasks').click(); await page.getByRole('button', { name: 'Calendar', exact: true }).click(); await expect(calendar(page)).toBeVisible(); }
async function expectDue(page: Page, due: string, text: string) { await expect(page.locator('.dashboard-task').filter({ hasText: `Synthetic due ${due}` }).last().locator('.due-chip')).toHaveText(text); }

for (const zone of ['Asia/Kuala_Lumpur', 'UTC', 'America/Los_Angeles']) test.describe(`Malaysia agreement in ${zone}`, () => {
  test.use({ timezoneId: zone });
  test('original instant agrees across every consumer and fake reminders', async ({ page }) => {
    await notifications(page); await seed(page, ['2026-11-03', '2026-11-10']);
    await open(page, '2026-11-02T16:30:00Z');
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(zone);
    expect(await page.evaluate(() => new Date().getDate())).toBe(zone === 'Asia/Kuala_Lumpur' ? 3 : 2);
    await expect(page.locator('.dashboard-hero')).toContainText('Tuesday, November 3, 2026');
    await expectDue(page, '2026-11-03', 'Today'); await expect(dashboard(page)).toHaveText('Dashboard (1)');
    await expect(page.locator('.semester-chip')).toContainText('Teaching week 1 of 7');
    await expect(page.locator('.stat-card').filter({ hasText: 'due in 7 days' }).locator('b')).toHaveText('2');
    await expect.poll(async () => (await deliveries(page)).map(row => row.body)).toEqual(['Synthetic due 2026-11-03: Today']);
    await nav(page, 'Tasks').click();
    const row = page.getByRole('row').filter({ hasText: 'Synthetic due 2026-11-03' });
    await expect(row.locator('[data-label="Due"]')).toHaveText('2026-11-03');
    await expect(row.locator('[data-label="Days left"]')).toHaveText('Today');
    await page.getByRole('button', { name: 'Calendar', exact: true }).click();
    await expect(dateCell(page, '2026-11-03')).toHaveClass(/today/);
    await expect(dateCell(page, '2026-11-03')).toHaveAttribute('headers', 'calendar-weekday-Tue');
    await nav(page, 'Timetable').click();
    await expect(page.getByText('2026-11-02 to 2026-11-08', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tuesday 2026-11-03 (today)' })).toBeVisible();
    await expect(attendance(page, '2026-11-03').getByRole('button', { name: 'Present', exact: true })).toBeEnabled();
    await expect(attendance(page, '2026-11-04').getByRole('button', { name: 'Present', exact: true })).toBeDisabled();
    await nav(page, 'Progress').click();
    await expect(page.getByText(/today is in the.*Semester 202609/)).toBeVisible();
    await expect(page.getByText(/Requirement:.*Week 1 of 7/)).toBeVisible();
    expect((await (await page.request.get('/api/tasks')).json()).map((task: { due: string }) => task.due)).toEqual(['2026-11-03', '2026-11-10']);
    expect(await deliveries(page)).toHaveLength(1);
  });
});

test('stationary Dashboard and badge update at consecutive midnights without duplicate reminders', async ({ page }) => {
  await notifications(page); await seed(page, ['2026-11-03', '2026-11-10']); await open(page);
  await expectDue(page, '2026-11-03', 'Tomorrow'); await expect(dashboard(page)).toHaveText('Dashboard');
  await expect(page.locator('.stat-card').filter({ hasText: 'due in 7 days' }).locator('b')).toHaveText('1');
  await page.clock.runFor(120_000);
  await expect(page.locator('.dashboard-hero')).toContainText('Tuesday, November 3, 2026');
  await expectDue(page, '2026-11-03', 'Today'); await expect(dashboard(page)).toHaveText('Dashboard (1)');
  await expect(page.locator('.stat-card').filter({ hasText: 'due in 7 days' }).locator('b')).toHaveText('2');
  await expect.poll(async () => (await deliveries(page)).map(row => row.body)).toEqual(['Synthetic due 2026-11-03: Today']);
  await page.clock.runFor(DAY);
  await expectDue(page, '2026-11-03', '1d overdue');
  await expect(page.locator('.stat-card').filter({ hasText: /^1overdue$/ }).locator('b')).toHaveText('1');
  expect((await deliveries(page)).map(row => row.body)).toEqual(['Synthetic due 2026-11-03: Today', 'Synthetic due 2026-11-03: 1d overdue']);
});

test('stationary task list updates overdue styling and retains completed Done treatment', async ({ page }) => {
  await notifications(page, 'denied'); await seed(page, ['2026-11-02', '2026-11-03', '2026-11-04']);
  const tasks = await (await page.request.get('/api/tasks')).json();
  const done = tasks.find((task: { due: string }) => task.due === '2026-11-04');
  expect((await page.request.patch(`/api/tasks/${done.id}`, { data: { status: 'Complete' } })).ok()).toBe(true);
  await open(page); await nav(page, 'Tasks').click();
  const remaining = (day: string) => page.getByRole('row').filter({ hasText: `Synthetic due ${day}` }).locator('[data-label="Days left"]');
  await expect(remaining('2026-11-02')).toHaveText('Today');
  await expect(remaining('2026-11-03')).toHaveText('Tomorrow');
  await page.clock.runFor(120_000);
  await expect(remaining('2026-11-02')).toHaveText('1d overdue'); await expect(remaining('2026-11-02')).toHaveClass('bad');
  await expect(remaining('2026-11-03')).toHaveText('Today'); await expect(remaining('2026-11-04')).toHaveText('Done');
  expect(await deliveries(page)).toHaveLength(0);
});

test('stationary task calendar changes Today without replacing native table semantics', async ({ page }) => {
  await notifications(page, 'unsupported'); await seed(page); await open(page); await taskCalendar(page);
  await expect(dateCell(page, '2026-11-02')).toHaveClass(/today/); await page.clock.runFor(120_000);
  await expect(dateCell(page, '2026-11-03')).toHaveClass(/today/); await expect(dateCell(page, '2026-11-02')).not.toHaveClass(/today/);
  await expect(calendar(page).getByRole('table')).toHaveCount(1); await expect(calendar(page).getByRole('columnheader')).toHaveCount(7);
  await expect(page.getByRole('grid')).toHaveCount(0); expect(await deliveries(page)).toHaveLength(0);
});

test('stationary timetable enables newly arrived day and persists marks without same-week refetch', async ({ page }) => {
  await notifications(page, 'denied'); await seed(page); await open(page); let reads = 0;
  page.on('request', request => { if (request.method() === 'GET' && request.url().includes('/api/attendance?')) reads++; });
  await nav(page, 'Timetable').click();
  const present = attendance(page, '2026-11-03').getByRole('button', { name: 'Present', exact: true });
  await expect(present).toBeDisabled();
  await attendance(page, '2026-11-02').getByRole('button', { name: 'Present', exact: true }).click();
  await expect(attendance(page, '2026-11-02').getByRole('button', { name: 'Present', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const before = reads; await page.clock.runFor(120_000);
  await expect(page.getByRole('heading', { name: 'Tuesday 2026-11-03 (today)' })).toBeVisible(); await expect(present).toBeEnabled();
  await expect(attendance(page, '2026-11-02').getByRole('button', { name: 'Present', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(reads).toBe(before); await present.click(); await expect(present).toHaveAttribute('aria-pressed', 'true');
  const rows = await (await page.request.get('/api/attendance?from=2026-11-02&to=2026-11-08')).json();
  expect(rows.map((row: { date: string }) => row.date).sort()).toEqual(['2026-11-02', '2026-11-03']);
});

test('stationary Progress updates saved countdown while preserving focused unsaved settings', async ({ page }) => {
  await notifications(page, 'denied'); await seed(page, [], '2026-11-03'); await open(page); await nav(page, 'Progress').click();
  await expect(page.getByText(/This semester starts in 1 day/)).toBeVisible();
  const draft = page.getByLabel('Semester start date (optional)'); await draft.fill('2026-11-05');
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved attendance settings' })).toBeVisible();
  await page.clock.runFor(120_000);
  await expect(page.getByText(/Requirement:.*Week 1 of 7/)).toBeVisible();
  await expect(draft).toHaveValue('2026-11-05'); await expect(draft).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Saved semester start: 2026-11-03' })).toBeVisible();
});

for (const [before, after, month] of [
  ['2026-11-30', '2026-12-01', 'December 2026'], ['2026-12-31', '2027-01-01', 'January 2027'],
  ['2028-02-28', '2028-02-29', 'February 2028'], ['2028-02-29', '2028-03-01', 'March 2028'],
] as const) test(`calendar follows current period across ${before} midnight`, async ({ page }) => {
  await notifications(page, 'denied'); await seed(page, [after]); await open(page, `${before}T23:59:00+08:00`); await taskCalendar(page);
  await page.clock.runFor(120_000); await expect(calendar(page).getByRole('heading')).toHaveText(month);
  await expect(dateCell(page, after)).toHaveClass(/today/);
  await expect(dateCell(page, after)).toContainText(`Synthetic due ${after}`);
  const column = new Date(`${after}T00:00:00Z`).getUTCDay();
  await expect(dateCell(page, after)).toHaveAttribute('headers', `calendar-weekday-${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][column]}`);
  await expect(calendar(page).getByRole('columnheader')).toHaveCount(7);
});

for (const direction of ['Previous', 'Next']) test(`deliberate ${direction.toLowerCase()} month survives rollover; This month restores following`, async ({ page }) => {
  await notifications(page, 'denied'); await seed(page, []); await open(page, '2026-12-31T23:59:00+08:00'); await taskCalendar(page);
  await page.getByRole('button', { name: `${direction} month`, exact: true }).click();
  await nav(page, 'Tasks').focus(); const selected = await calendar(page).getByRole('heading').textContent();
  await page.clock.runFor(120_000); await expect(calendar(page).getByRole('heading')).toHaveText(selected!);
  await page.getByRole('button', { name: 'This month', exact: true }).click();
  await expect(calendar(page).getByRole('heading')).toHaveText('January 2027');
  await nav(page, 'Tasks').focus(); await page.clock.fastForward(16 * DAY); await page.clock.fastForward(15 * DAY);
  await expect(calendar(page).getByRole('heading')).toHaveText('February 2027');
});

test('calendar defers automatic month replacement while a task has keyboard focus', async ({ page }) => {
  await notifications(page, 'denied'); await seed(page, ['2026-11-30']); await open(page, '2026-11-30T23:59:00+08:00'); await taskCalendar(page);
  const task = calendar(page).getByRole('button', { name: /Synthetic due 2026-11-30/ }); await task.focus();
  await page.clock.runFor(120_000); await expect(task).toBeFocused(); await expect(calendar(page).getByRole('heading')).toHaveText('November 2026');
  await nav(page, 'Tasks').focus(); await expect(calendar(page).getByRole('heading')).toHaveText('December 2026');
});

test('Sunday rollover follows current week and obsolete reads cannot populate it', async ({ page }) => {
  await notifications(page, 'denied'); const { slots } = await seed(page, []); await open(page, '2026-11-08T23:59:00+08:00');
  const requested = deferred(), release = deferred();
  await page.route('**/api/attendance?*', async route => {
    if (!route.request().url().includes('from=2026-11-02')) return route.continue();
    requested.resolve(); await release.promise;
    await route.fulfill({ json: [{ slotId: slots[0].id, date: '2026-11-09', status: 'absent' }] });
  });
  await nav(page, 'Timetable').click(); await requested.promise;
  try {
    await page.clock.runFor(120_000);
    await expect(page.getByText('2026-11-09 to 2026-11-15', { exact: true })).toBeVisible();
    const present = attendance(page, '2026-11-09').getByRole('button', { name: 'Present', exact: true });
    await expect(present).toBeEnabled();
    const obsoleteResponse = page.waitForResponse(response => response.url().includes('/api/attendance?from=2026-11-02'));
    release.resolve(); await obsoleteResponse; await page.clock.runFor(50);
    await expect(attendance(page, '2026-11-09').getByRole('button', { name: 'Absent', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await present.click(); await expect(present).toHaveAttribute('aria-pressed', 'true');
    expect((await (await page.request.get('/api/attendance?from=2026-11-09&to=2026-11-15')).json())[0].date).toBe('2026-11-09');
  } finally { release.resolve(); }
});

for (const direction of ['Previous', 'Next']) test(`deliberate ${direction.toLowerCase()} week stays selected across Monday`, async ({ page }) => {
  await notifications(page, 'denied'); await seed(page, []); await open(page, '2026-11-08T23:59:00+08:00'); await nav(page, 'Timetable').click();
  await page.getByRole('button', { name: `${direction} week`, exact: true }).click(); await nav(page, 'Timetable').focus();
  const selected = direction === 'Previous' ? '2026-10-26 to 2026-11-01' : '2026-11-09 to 2026-11-15';
  await page.clock.runFor(120_000); await expect(page.getByText(selected, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'This week', exact: true }).click(); await expect(page.getByText('2026-11-09 to 2026-11-15', { exact: true })).toBeVisible();
});

test('pending attendance holds the old week, saves once, then follows safely; class-time draft survives', async ({ page }) => {
  await notifications(page, 'denied'); await seed(page, []); await open(page, '2026-11-08T23:59:00+08:00'); await nav(page, 'Timetable').click();
  await page.getByLabel('Room (optional)').fill('Synthetic unsaved draft');
  const requested = deferred(), release = deferred();
  await page.route('**/api/attendance', async route => { if (route.request().method() !== 'PUT') return route.continue(); requested.resolve(); await release.promise; await route.continue(); });
  const present = attendance(page, '2026-11-08').getByRole('button', { name: 'Present', exact: true });
  await present.click(); await requested.promise; await nav(page, 'Timetable').focus();
  try {
    await page.clock.runFor(120_000); await expect(page.getByText('2026-11-02 to 2026-11-08', { exact: true })).toBeVisible();
    release.resolve(); await expect(page.getByText('2026-11-09 to 2026-11-15', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Room (optional)')).toHaveValue('Synthetic unsaved draft');
    const rows = await (await page.request.get('/api/attendance?from=2026-11-02&to=2026-11-08')).json();
    expect(rows).toHaveLength(1); expect(rows[0].date).toBe('2026-11-08'); expect(rows[0].status).toBe('present');
  } finally { release.resolve(); }
});

test('import dialog stays open across week rollover and returns to current week on close', async ({ page }) => {
  await notifications(page, 'denied'); await seed(page, []); await open(page, '2026-11-08T23:59:00+08:00'); await nav(page, 'Timetable').click();
  await page.getByRole('button', { name: 'Import timetable', exact: true }).click();
  const dialog = page.getByRole('dialog');
  // React's lazy-import fallback also uses the controlled clock.
  await expect.poll(async () => { await page.clock.runFor(100); return dialog.isVisible(); }).toBe(true);
  await page.clock.runFor(120_000); await expect(dialog).toBeVisible();
  await expect(page.getByText('2026-11-02 to 2026-11-08', { exact: true })).toBeAttached();
  await dialog.getByRole('button', { name: 'Close importer', exact: true }).click();
  await expect(page.getByText('2026-11-09 to 2026-11-15', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import timetable', exact: true })).toBeFocused();
});

test('slot deletion holds week while pending and removing its focused control releases following', async ({ page }) => {
  await notifications(page, 'denied'); const { slots } = await seed(page, []);
  await open(page, '2026-11-08T23:59:00+08:00'); await nav(page, 'Timetable').click();
  const requested = deferred(), release = deferred();
  await page.route(`**/api/slots/${slots[0].id}`, async route => { requested.resolve(); await release.promise; await route.continue(); });
  page.on('dialog', dialog => dialog.accept());
  const remove = page.getByRole('button', { name: 'Remove Synthetic Malaysia class Lecture on Monday', exact: true });
  await remove.click(); await requested.promise;
  // Losing focus while a write is pending must not advance the selected week.
  await nav(page, 'Timetable').focus();
  try {
    await page.clock.runFor(120_000); await expect(page.getByText('2026-11-02 to 2026-11-08', { exact: true })).toBeVisible();
    await remove.focus(); release.resolve(); await expect(remove).toHaveCount(0);
    await expect(page.getByText('2026-11-09 to 2026-11-15', { exact: true })).toBeVisible();
  } finally { release.resolve(); }
});

test('sleep, focus and visibility recalculate actual day and deduplicate repeated checks', async ({ page }) => {
  await notifications(page); await seed(page, ['2027-01-01']); await open(page, '2026-12-31T23:59:00+08:00');
  await page.clock.fastForward(3 * DAY);
  await expect(page.locator('.dashboard-hero')).toContainText('Sunday, January 3, 2027'); await expectDue(page, '2027-01-01', '2d overdue');
  await expect.poll(async () => (await deliveries(page)).length).toBe(1);
  await page.clock.setSystemTime(new Date('2027-01-05T00:01:00+08:00'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.dashboard-hero')).toContainText('Tuesday, January 5, 2027');
  await expectDue(page, '2027-01-01', '4d overdue'); await expect.poll(async () => (await deliveries(page)).length).toBe(2);
  await page.clock.setSystemTime(new Date('2027-01-06T00:01:00+08:00'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.dashboard-hero')).toContainText('Wednesday, January 6, 2027');
  await expect.poll(async () => (await deliveries(page)).length).toBe(3);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(nav(page, 'Tasks')).toBeVisible();
  }
  expect(await deliveries(page)).toHaveLength(3);
});

test('no tasks and unsupported notifications do not prevent clock-change recovery', async ({ page }) => {
  await notifications(page, 'unsupported'); await seed(page, []); await open(page);
  await page.clock.runFor(120_000); await expect(page.locator('.dashboard-hero')).toContainText('Tuesday, November 3, 2026');
  await page.clock.setSystemTime(new Date('2026-11-01T23:59:00+08:00'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.dashboard-hero')).toContainText('Sunday, November 1, 2026');
  await page.clock.runFor(120_000); await expect(page.locator('.dashboard-hero')).toContainText('Monday, November 2, 2026');
  expect(await deliveries(page)).toHaveLength(0);
});

test('transient session failure hides private data across midnight and safe retry uses actual day', async ({ page }) => {
  await notifications(page); await seed(page, ['2026-11-03']); await open(page);
  await page.route('**/api/auth/me', route => route.fulfill({ status: 503, json: { error: 'Synthetic unavailable' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Retry session', exact: true })).toBeVisible(); await expect(page.locator('.dashboard-hero')).toBeHidden();
  await page.clock.runFor(120_000); expect(await deliveries(page)).toHaveLength(0);
  await page.unroute('**/api/auth/me'); await page.getByRole('button', { name: 'Retry session', exact: true }).click();
  await expect(page.locator('.dashboard-hero')).toContainText('Tuesday, November 3, 2026'); await expectDue(page, '2026-11-03', 'Today');
  await expect.poll(async () => (await deliveries(page)).length).toBe(1);
});

test('logout removes old midnight work and account switching starts with current day', async ({ page }) => {
  await notifications(page); await seed(page, ['2026-11-03']); await open(page);
  await nav(page, 'Profile').click(); await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await page.clock.runFor(120_000); expect(await deliveries(page)).toHaveLength(0); await expect(page.locator('.dashboard-hero')).toHaveCount(0);
  await seed(page, ['2026-11-04']); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.dashboard-hero')).toContainText('Tuesday, November 3, 2026'); await expectDue(page, '2026-11-04', 'Tomorrow');
  await expect(page.getByText('Synthetic due 2026-11-03', { exact: true })).toHaveCount(0);
  await page.clock.runFor(DAY); await expectDue(page, '2026-11-04', 'Today');
  expect((await deliveries(page)).map(row => row.body)).toEqual(['Synthetic due 2026-11-04: Today']);
});

for (const [before, after, wording] of [
  ['2026-11-08', '2026-11-09', 'Week 2 of 7.'],
  ['2026-12-20', '2026-12-21', 'The 7 teaching weeks are over.'],
] as const) test(`Progress teaching boundary ${before} updates without navigation`, async ({ page }) => {
  await notifications(page, 'denied'); await seed(page, []); await open(page, `${before}T23:59:00+08:00`); await nav(page, 'Progress').click();
  await expect(page.getByText(/Requirement:/)).not.toContainText(wording);
  await page.clock.runFor(120_000); await expect(page.getByText(/Requirement:/)).toContainText(wording);
  if (after === '2026-12-21') await expect(page.getByText(/has no semester running today/)).toBeVisible();
});

test('Dashboard current semester changes from known holidays to teaching at midnight', async ({ page }) => {
  await notifications(page, 'denied'); await seed(page, []); await open(page, '2026-11-01T23:59:00+08:00');
  await expect(page.locator('.semester-chip')).toHaveText('Third Semester · Semester holidays');
  await page.clock.runFor(120_000); await expect(page.locator('.semester-chip')).toHaveText('Semester 202609 · Teaching week 1 of 7');
});

test('offline midnight updates locally and reconnect safely verifies the current day', async ({ page, context }) => {
  await notifications(page, 'denied'); await seed(page); await open(page);
  await context.setOffline(true); await expect(page.getByText(/You are offline/)).toBeVisible();
  await page.clock.runFor(120_000); await expectDue(page, '2026-11-03', 'Today');
  await context.setOffline(false); await expect(page.getByText(/You are offline/)).toHaveCount(0);
  await expect(page.locator('.dashboard-hero')).toContainText('Tuesday, November 3, 2026'); await expectDue(page, '2026-11-03', 'Today');
  expect(await deliveries(page)).toHaveLength(0);
});
