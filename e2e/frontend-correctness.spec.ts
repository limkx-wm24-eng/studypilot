import { expect, test, type Page, type Route } from '@playwright/test';
test.use({ serviceWorkers: 'block' });
const releases: (() => void)[] = [];
const barrier = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); releases.push(resolve); return { promise, resolve }; };
test.afterEach(() => { for (const release of releases.splice(0)) release(); });
async function setup(page: Page) {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  expect((await page.request.post('/api/auth/register', { data: { email: `frontend-${crypto.randomUUID()}@example.test`, password: 'synthetic-password-123' } })).status()).toBe(201);
  const klass = await (await page.request.post('/api/classes', { data: { name: 'Synthetic stored class', color: '#0f766e' } })).json();
  await page.request.patch('/api/auth/me', { data: { courseType: 'Degree', semesterStart: '2026-11-02' } });
  return { klass, errors };
}
async function task(page: Page, classId: string, name = 'Synthetic ordered task') {
  const response = await page.request.post('/api/tasks', { data: { classId, name, type: 'Homework', priority: 'Medium', status: 'Not started', due: '2026-11-30', grade: 50 } });
  expect(response.status()).toBe(201); return response.json();
}
async function tab(page: Page, name: string) { await page.getByRole('button', { name, exact: true }).click(); }

for (const kind of ['class', 'task', 'course'] as const) test(`${kind} creation keeps failed drafts, blocks duplicates and clears only after success`, async ({ page }) => {
  const { errors } = await setup(page);
  const path = kind === 'class' ? '/api/classes' : kind === 'task' ? '/api/tasks' : '/api/courses';
  const arrived = barrier(), release = barrier(); let count = 0;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const attempt = count++;
    if (attempt === 0) { arrived.resolve(); await release.promise; }
    if (attempt === 3) return route.abort('failed');
    if (attempt < 3) return route.fulfill({ status: [400, 409, 503][attempt], json: { error: ['Check the supplied values.', 'This conflicts with an existing record.', 'Server busy. Try again.'][attempt] } });
    return route.continue();
  });
  await page.goto('/'); await tab(page, kind === 'class' ? 'Classes' : kind === 'task' ? 'Tasks' : 'Progress');
  if (kind === 'task') await page.getByText('+ Add task', { exact: true }).click();
  const label = kind === 'class' ? 'Class name' : kind === 'task' ? 'Task name' : 'Course name';
  const input = page.getByLabel(label, { exact: true });
  const button = page.getByRole('button', { name: `Add ${kind}`, exact: true });
  await input.fill('Synthetic retained draft');
  if (kind === 'task') await page.getByLabel('Due date', { exact: true }).fill('2026-12-01');
  await button.click(); await arrived.promise;
  await expect(button).toBeDisabled();
  await input.locator('xpath=ancestor::form').dispatchEvent('submit');
  expect(count).toBe(1); release.resolve();
  await expect(page.getByRole('alert')).toContainText('Check the supplied values');
  for (let attempt = 1; attempt < 4; attempt++) {
    await expect(input).toHaveValue('Synthetic retained draft'); await expect(button).toBeEnabled();
    if (kind === 'task') await expect(page.getByLabel('Due date', { exact: true })).toHaveValue('2026-12-01');
    await button.click(); await expect.poll(() => count).toBe(attempt + 1); await expect(button).toBeEnabled();
  }
  await expect(input).toHaveValue('Synthetic retained draft');
  await button.click(); await expect(input).toHaveValue('');
  if (kind === 'task') await expect(page.getByLabel('Due date', { exact: true })).toHaveValue('');
  expect(count).toBe(5); expect(errors).toEqual([]);
});

test('independent initial data survives summary failure and retry recovers genuine empty data', async ({ page }) => {
  const { errors } = await setup(page); let failed = false;
  await page.route('**/api/attendance/summary', (route) => { if (!failed) { failed = true; return route.fulfill({ status: 503, json: { error: 'Server busy. Try again.' } }); } return route.continue(); });
  await page.goto('/'); await tab(page, 'Classes');
  await expect(page.getByText('Synthetic stored class', { exact: true })).toBeVisible();
  await expect(page.getByText(/No classes yet/)).toHaveCount(0);
  await tab(page, 'Progress'); await expect(page.getByText(/Attendance summary is unavailable/)).toBeVisible();
  await expect(page.getByText('Add completed courses to calculate your GPA and CGPA.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await expect(page.getByLabel('Semester start date (optional)')).toHaveValue('2026-11-02');
  await expect(page.getByRole('button', { name: 'Retry loading' })).toHaveCount(0); expect(errors).toEqual([]);
});
test('unavailable courses are not displayed as an empty dataset; retry restores the page', async ({ page }) => {
  await setup(page); let fail = true;
  await page.route('**/api/courses', (route) => fail ? route.fulfill({ status: 503, json: { error: 'Server busy.' } }) : route.continue());
  await page.goto('/'); await tab(page, 'Classes'); await expect(page.getByText('Synthetic stored class', { exact: true })).toBeVisible();
  await tab(page, 'Progress'); await expect(page.getByText('Some data is unavailable. Retry loading to continue.')).toBeVisible();
  await expect(page.getByText('Add completed courses to calculate your GPA and CGPA.')).toHaveCount(0);
  fail = false; await page.getByRole('button', { name: 'Retry loading' }).click();
  await expect(page.getByText('Add completed courses to calculate your GPA and CGPA.')).toBeVisible();
});
test('a class mutation replaces an obsolete initial timetable read without losing independent data', async ({ page }) => {
  await setup(page); const entered = barrier(), release = barrier(); let reads = 0;
  await page.route('**/api/slots', async (route) => {
    const response = await route.fetch();
    if (++reads === 1) { entered.resolve(); await release.promise; }
    await route.fulfill({ response });
  });
  await page.goto('/'); await entered.promise; await tab(page, 'Classes');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete Synthetic stored class', exact: true }).click();
  await expect(page.getByText('No classes yet. Add your first one above.')).toBeVisible();
  await expect.poll(() => reads).toBe(2);
  release.resolve(); await tab(page, 'Timetable');
  await expect(page.getByText('Import your portal timetable, or add a class first to enter class times.')).toBeVisible();
  await expect(page.getByText('Some data is unavailable. Retry loading to continue.')).toHaveCount(0);
});
test('semester settings keep an explicit unsaved draft after failure and retry synchronizes storage', async ({ page }) => {
  const { errors } = await setup(page); let failed = false;
  await page.route('**/api/auth/me', (route) => {
    if (route.request().method() === 'PATCH' && !failed) { failed = true; return route.fulfill({ status: 400, json: { error: 'Check the supplied date.' } }); }
    return route.continue();
  });
  await page.goto('/'); await tab(page, 'Progress');
  const date = page.getByLabel('Semester start date (optional)');
  await date.fill('2026-11-09'); await date.blur();
  await expect(page.getByRole('alert')).toContainText('Check the supplied date');
  await expect(date).toHaveValue('2026-11-09');
  await expect(page.getByText(/Unsaved attendance settings.*Saved semester start: 2026-11-02/)).toBeVisible();
  expect((await (await page.request.get('/api/auth/me')).json()).semesterStart).toBe('2026-11-02');
  await page.getByRole('button', { name: 'Retry settings' }).click();
  await expect(page.getByText(/Attendance settings saved.*Saved semester start: 2026-11-09/)).toBeVisible();
  expect((await (await page.request.get('/api/auth/me')).json()).semesterStart).toBe('2026-11-09'); expect(errors).toEqual([]);
});

test('ordered task mutations preserve status and grade, independent records, same-field order, deletion and recovery', async ({ page }) => {
  const { klass, errors } = await setup(page);
  const a = await task(page, klass.id), b = await task(page, klass.id, 'Synthetic independent task');
  let arrived = barrier(), release = barrier(); let requests = 0, hold = true, fail = false;
  await page.route(`**/api/tasks/${a.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    requests++;
    if (fail) { fail = false; return route.fulfill({ status: 404, json: { error: 'Task not found' } }); }
    const response = await route.fetch();
    if (hold) { hold = false; arrived.resolve(); await release.promise; }
    await route.fulfill({ response });
  });
  await page.goto('/'); await tab(page, 'Tasks');
  const status = page.getByLabel(`Status of ${a.name}`), grade = page.getByLabel(`Grade for ${a.name}`);
  await status.selectOption('Complete'); await arrived.promise;
  await grade.fill('85'); await grade.blur();
  await page.getByLabel(`Status of ${b.name}`).selectOption('Complete');
  await expect(page.getByLabel(`Status of ${b.name}`)).toHaveValue('Complete');
  expect(requests).toBe(1); release.resolve();
  await expect(status).toHaveValue('Complete'); await expect(grade).toHaveValue('85');
  let stored = (await (await page.request.get('/api/tasks')).json()).find((row: { id: string }) => row.id === a.id);
  expect(stored).toMatchObject({ status: 'Complete', grade: 85 });
  arrived = barrier(); release = barrier(); hold = true;
  await status.selectOption('In progress'); await arrived.promise; await status.selectOption('Not started');
  expect(requests).toBe(3); release.resolve();
  await expect(status).toHaveValue('Not started');
  await expect.poll(async () => (await (await page.request.get('/api/tasks')).json()).find((row: { id: string }) => row.id === a.id).status).toBe('Not started');
  fail = true; await status.selectOption('Complete'); await expect(page.getByRole('alert')).toContainText('Task not found');
  await grade.fill('90'); await grade.blur(); await expect(grade).toHaveValue('90');
  await expect.poll(async () => (await (await page.request.get('/api/tasks')).json()).find((row: { id: string }) => row.id === a.id).grade).toBe(90);
  const removed = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().endsWith(`/api/tasks/${a.id}`));
  await page.getByRole('button', { name: `Delete ${a.name}`, exact: true }).focus(); await page.keyboard.press('Enter'); await removed;
  await expect(status).toHaveCount(0); expect((await (await page.request.get('/api/tasks')).json()).map((row: { id: string }) => row.id)).toEqual([b.id]); expect(errors).toEqual([]);
});

test('queued deletion wins after a delayed PATCH and old-session mutations cannot repopulate a new account', async ({ page }) => {
  const { klass, errors } = await setup(page); const a = await task(page, klass.id);
  let entered = barrier(), release = barrier();
  await page.route(`**/api/tasks/${a.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response });
  });
  await page.goto('/'); await tab(page, 'Tasks');
  await page.getByLabel(`Status of ${a.name}`).selectOption('Complete'); await entered.promise;
  await page.getByRole('button', { name: `Delete ${a.name}`, exact: true }).focus(); await page.keyboard.press('Enter'); release.resolve();
  await expect(page.getByLabel(`Status of ${a.name}`)).toHaveCount(0);
  const another = await task(page, klass.id, 'Synthetic stale task');
  await page.reload(); await tab(page, 'Tasks');
  entered = barrier(); release = barrier();
  await page.route(`**/api/tasks/${another.id}`, async (route) => { const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response }); });
  await page.getByLabel(`Status of ${another.name}`).selectOption('Complete'); await entered.promise;
  await tab(page, 'Profile'); await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await page.request.post('/api/auth/register', { data: { email: `frontend-next-${crypto.randomUUID()}@example.test`, password: 'synthetic-password-123' } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible();
  release.resolve(); await tab(page, 'Tasks');
  await expect(page.getByText('Add a class first, then come back to add tasks.')).toBeVisible();
  await expect(page.getByText(another.name, { exact: true })).toHaveCount(0); expect(errors).toEqual([]);
});

async function attendanceSetup(page: Page) {
  const { klass } = await setup(page);
  await page.clock.setFixedTime(new Date('2026-11-25T12:00:00+08:00'));
  const slot = await (await page.request.post('/api/slots', { data: { classId: klass.id, kind: 'Lecture', weekday: 1, start: '08:00', end: '10:00', room: 'SYN 1' } })).json();
  for (const [date, status] of [['2026-11-23', 'absent'], ['2026-11-16', 'present']]) await page.request.put('/api/attendance', { data: { slotId: slot.id, date, status } });
  return { klass, slot };
}
test('reverse attendance responses and obsolete failures cannot overwrite the current week, including A-B-A', async ({ page }) => {
  const { klass } = await attendanceSetup(page);
  const aEntered = barrier(), aRelease = barrier(), bEntered = barrier(), bRelease = barrier(); let aCount = 0, holdB = false;
  await page.route('**/api/attendance?*', async (route: Route) => {
    const from = new URL(route.request().url()).searchParams.get('from');
    if (from === '2026-11-23' && aCount++ === 0) { aEntered.resolve(); await aRelease.promise; return route.fulfill({ json: [] }); }
    if (from === '2026-11-16' && holdB) { bEntered.resolve(); await bRelease.promise; return route.fulfill({ status: 503, json: { error: 'Obsolete week unavailable' } }); }
    return route.continue();
  });
  await page.goto('/'); await tab(page, 'Timetable'); await aEntered.promise;
  await page.getByRole('button', { name: 'Previous week' }).click();
  const b = page.getByRole('group', { name: `Attendance for ${klass.name} on 2026-11-16` });
  await expect(b.getByRole('button', { name: 'Present', exact: true })).toHaveAttribute('aria-pressed', 'true');
  aRelease.resolve();
  await expect(b.getByRole('button', { name: 'Present', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'This week' }).click();
  const a = page.getByRole('group', { name: `Attendance for ${klass.name} on 2026-11-23` });
  await expect(a.getByRole('button', { name: 'Absent', exact: true })).toHaveAttribute('aria-pressed', 'true');
  holdB = true; await page.getByRole('button', { name: 'Previous week' }).click(); await bEntered.promise;
  await page.getByRole('button', { name: 'This week' }).click();
  await expect(a.getByRole('button', { name: 'Absent', exact: true })).toHaveAttribute('aria-pressed', 'true');
  bRelease.resolve();
  await expect(a.getByRole('button', { name: 'Absent', exact: true })).toBeEnabled();
  await expect(page.getByText('Obsolete week unavailable')).toHaveCount(0);
});
test('attendance mutation completing after week navigation does not change the selected week', async ({ page }) => {
  const { klass } = await attendanceSetup(page), entered = barrier(), release = barrier();
  await page.route('**/api/attendance', async (route) => { const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response }); });
  await page.goto('/'); await tab(page, 'Timetable');
  const a = page.getByRole('group', { name: `Attendance for ${klass.name} on 2026-11-23` });
  await a.getByRole('button', { name: 'Leave', exact: true }).click(); await entered.promise;
  await page.getByRole('button', { name: 'Previous week' }).click();
  const b = page.getByRole('group', { name: `Attendance for ${klass.name} on 2026-11-16` });
  await expect(b.getByRole('button', { name: 'Present', exact: true })).toHaveAttribute('aria-pressed', 'true');
  release.resolve(); await expect(b.getByRole('button', { name: 'Present', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'This week' }).click();
  await expect(a.getByRole('button', { name: 'Leave', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('attendance loading can retry and an old response cannot populate a switched session', async ({ page }) => {
  await attendanceSetup(page);
  let fail = true, hold = false;
  const entered = barrier(), release = barrier();
  await page.route('**/api/attendance?*', async (route) => {
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'Attendance temporarily unavailable.' } }); }
    const response = await route.fetch();
    if (hold) { entered.resolve(); await release.promise; }
    return route.fulfill({ response });
  });
  await page.goto('/'); await tab(page, 'Timetable');
  await expect(page.getByRole('alert')).toContainText('Attendance temporarily unavailable');
  await page.getByRole('button', { name: 'Retry attendance' }).click();
  await expect(page.getByRole('button', { name: 'Absent', exact: true })).toBeEnabled();
  hold = true; await page.getByRole('button', { name: 'Previous week' }).click(); await entered.promise;
  await tab(page, 'Profile'); await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await page.request.post('/api/auth/register', { data: { email: `attendance-next-${crypto.randomUUID()}@example.test`, password: 'synthetic-password-123' } });
  // Recheck without navigation, so the old fetch actually completes in this document.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible();
  release.resolve(); await tab(page, 'Timetable');
  await expect(page.getByText('Import your portal timetable, or add a class first to enter class times.')).toBeVisible();
  await expect(page.getByRole('group', { name: /^Attendance for/ })).toHaveCount(0);
});
