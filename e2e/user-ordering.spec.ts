import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
const releases: (() => void)[] = [];
function barrier() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); releases.push(resolve); return { promise, resolve }; }
test.afterEach(() => { for (const release of releases.splice(0)) release(); });
async function tab(page: Page, name: string) { await page.locator(`header nav button[data-tab="${name}"]`).click(); }
async function setup(page: Page) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const email = `ordering-${crypto.randomUUID()}@example.test`;
  expect((await page.request.post('/api/auth/register', { data: { email, name: 'Synthetic Student', password: 'synthetic-password-123' } })).status()).toBe(201);
  await page.request.patch('/api/auth/me', { data: { courseType: 'Degree', semesterStart: '2026-06-15', semesterWeeks: 14 } });
  await page.request.post('/api/classes', { data: { name: 'Synthetic independent class', color: '#0f766e' } });
  await page.goto('/'); await tab(page, 'profile'); return { email, errors };
}
async function profile(page: Page, name: string, reminder = '7') {
  await page.getByLabel('Your name', { exact: true }).fill(name); await page.getByLabel('Remind me').selectOption(reminder); await page.getByRole('button', { name: 'Save profile', exact: true }).click();
}
async function agrees(page: Page, name: string, reminderDays: number) {
  const stored = await (await page.request.get('/api/auth/me')).json(); expect(stored.name).toBe(name); expect(stored.reminderDays).toBe(reminderDays);
  await tab(page, 'dash'); await expect(page.getByRole('heading', { name: `Hi, ${name}`, exact: true })).toBeVisible(); await expect(page.locator('.user-avatar')).toHaveText(name[0]);
  await tab(page, 'profile'); await expect(page.getByLabel('Your name', { exact: true })).toHaveValue(name); await expect(page.getByLabel('Remind me')).toHaveValue(String(reminderDays));
  return stored;
}

test('profile duplicates are prevented; pending draft survives navigation and Beta is saved after Alpha', async ({ page }) => {
  const { errors } = await setup(page); const arrived = barrier(), release = barrier(); let writes = 0;
  await page.route('**/api/auth/me', async route => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); if (++writes === 1) { arrived.resolve(); await release.promise; } await route.fulfill({ response }); });
  await profile(page, 'Alpha Synthetic', '1'); await arrived.promise;
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled(); await expect(page.getByLabel('Your name', { exact: true })).toBeDisabled(); await expect(page.getByRole('status').filter({ hasText: /^Saving profile/ })).toBeVisible();
  await page.getByLabel('Your name', { exact: true }).locator('xpath=ancestor::form').dispatchEvent('submit'); expect(writes).toBe(1);
  await tab(page, 'classes'); await page.getByLabel('Class name', { exact: true }).fill('Synthetic independent write'); await page.getByRole('button', { name: 'Add class', exact: true }).click(); await expect(page.getByText('Synthetic independent write', { exact: true })).toBeVisible();
  await tab(page, 'profile'); await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Alpha Synthetic'); await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled();
  release.resolve(); await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
  await profile(page, 'Beta Synthetic'); await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled(); await agrees(page, 'Beta Synthetic', 7); expect(writes).toBe(2); expect(errors).toEqual([]);
});

for (const failure of [503, 'network'] as const) test(`profile ${failure} retains drafts across navigation and releases pending state for retry`, async ({ page }) => {
  const { errors } = await setup(page); let attempts = 0;
  await page.route('**/api/auth/me', route => {
    if (route.request().method() !== 'PATCH' || ++attempts > 1) return route.continue();
    return failure === 'network' ? route.abort('failed') : route.fulfill({ status: failure, json: { error: 'Synthetic profile unavailable' } });
  });
  await profile(page, 'Beta Synthetic'); await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: failure === 'network' ? /fetch/i : 'Synthetic profile unavailable' })).toBeVisible();
  await tab(page, 'classes'); await tab(page, 'profile'); await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Beta Synthetic'); await expect(page.getByLabel('Remind me')).toHaveValue('7');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: /^Profile saved\.$/ })).toBeVisible(); await agrees(page, 'Beta Synthetic', 7); expect(attempts).toBe(2); expect(errors).toEqual([]);
});

for (const first of ['profile', 'semester'] as const) test(`${first} and independent user settings serialize across navigation without losing fields`, async ({ page }) => {
  const { errors } = await setup(page); const arrived = barrier(), release = barrier(); let writes = 0;
  await page.route('**/api/auth/me', async route => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); if (++writes === 1) { arrived.resolve(); await release.promise; } await route.fulfill({ response }); });
  if (first === 'profile') { await profile(page, 'Beta Synthetic'); await arrived.promise; await tab(page, 'progress'); await page.getByLabel('Semester type').selectOption('7'); }
  else { await tab(page, 'progress'); await page.getByLabel('Semester type').selectOption('7'); await arrived.promise; await tab(page, 'profile'); await profile(page, 'Beta Synthetic'); }
  await expect(page.getByRole('status').filter({ hasText: first === 'profile' ? /^Saving attendance/ : /^Saving profile/ })).toBeVisible();
  expect(writes).toBe(1, 'the second user write must not start until the first response completes');
  release.resolve(); await expect.poll(() => writes).toBe(2);
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json()).semesterWeeks).toBe(7);
  await tab(page, 'profile'); await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled(); const stored = await agrees(page, 'Beta Synthetic', 7); expect(stored.semesterWeeks).toBe(7); expect(stored.courseType).toBe('Degree');
  await tab(page, 'progress'); await expect(page.getByLabel('Semester type')).toHaveValue('7'); expect(errors).toEqual([]);
});

test('imported semester settings share the profile queue and preserve newer profile fields', async ({ page }) => {
  const { errors } = await setup(page); const arrived = barrier(), release = barrier(); let writes = 0;
  await page.route('**/api/auth/me', async route => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); if (++writes === 1) { arrived.resolve(); await release.promise; } await route.fulfill({ response }); });
  await profile(page, 'Beta Synthetic'); await arrived.promise; await tab(page, 'timetable'); await page.getByRole('button', { name: 'Import timetable', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('tab', { name: 'Paste text' }).click();
  await dialog.getByLabel('Semester Timetable By Course text').fill('202609 Semester ( Monday, 2026-11-02 ~ Sunday, 2026-12-20 ) BDEM2001 SYNTHETIC IMPORT Course Plan Mon , 8:00 AM ~ 9:00 AM ( Lecture: 1.0 hours ) SYN 1, Block B');
  await dialog.getByRole('button', { name: 'Review timetable' }).click(); await expect(dialog.getByRole('checkbox', { name: /Also set my semester/ })).toBeChecked(); const imported = page.waitForResponse('**/api/import/timetable'); await dialog.getByRole('button', { name: 'Import', exact: true }).click(); expect((await imported).status()).toBe(201);
  expect(writes).toBe(1); release.resolve(); await expect(dialog).not.toBeVisible(); expect(writes).toBe(2);
  const stored = await agrees(page, 'Beta Synthetic', 7); expect(stored.semesterStart).toBe('2026-11-02'); expect(stored.semesterWeeks).toBe(7);
  await tab(page, 'progress'); await expect(page.getByText('Teaching ends 2026-12-20. Exams: unknown. Holidays: unknown.', { exact: true })).toBeVisible(); await expect(page.getByText(/1 hours a week, 7 hours this semester/)).toBeVisible(); expect(errors).toEqual([]);
});

test('session revalidation waits for the pending profile write and cannot restore an earlier user snapshot', async ({ page }) => {
  const { errors } = await setup(page); const arrived = barrier(), release = barrier(); let reads = 0;
  await page.route('**/api/auth/me', async route => { if (route.request().method() === 'GET') { reads++; return route.continue(); } const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); });
  await profile(page, 'Beta Synthetic'); await arrived.promise; await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); }); await expect(page.getByLabel('Your name', { exact: true })).not.toBeVisible(); expect(reads).toBe(0);
  release.resolve(); await expect(page.getByLabel('Your name', { exact: true })).toBeVisible(); expect(reads).toBe(1); await agrees(page, 'Beta Synthetic', 7); expect(errors).toEqual([]);
});

for (const switched of [false, true]) test(`verification prevents unsent queued drafts using an unverified cookie (${switched ? 'changed account' : 'same-account retry'})`, async ({ page }) => {
  const { errors } = await setup(page); const arrived = barrier(), release = barrier(); let writes = 0;
  await page.route('**/api/auth/me', async route => { if (route.request().method() !== 'PATCH') return route.continue(); writes++; const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); });
  await profile(page, 'Alpha Synthetic'); await arrived.promise; await tab(page, 'progress'); await page.getByLabel('Semester type').selectOption('7'); await expect(page.getByRole('status').filter({ hasText: /^Saving attendance/ })).toBeVisible(); expect(writes).toBe(1);
  if (switched) await page.request.post('/api/auth/register', { data: { email: `unbroadcast-switch-${crypto.randomUUID()}@example.test`, name: 'Beta Synthetic', password: 'synthetic-password-123' } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByLabel('Semester type')).not.toBeVisible(); release.resolve();
  if (switched) { await expect(page.getByRole('heading', { name: 'Hi, Beta Synthetic', exact: true })).toBeVisible(); expect((await (await page.request.get('/api/auth/me')).json()).semesterWeeks).toBe(14); expect(writes).toBe(1); }
  else {
    await expect(page.getByRole('alert').filter({ hasText: 'Verify your session before saving.' })).toBeVisible(); await expect(page.getByRole('status').filter({ hasText: /^Unsaved attendance settings/ })).toBeVisible(); expect(writes).toBe(1);
    await page.getByRole('button', { name: 'Retry settings', exact: true }).click(); await expect.poll(() => writes).toBe(2); await expect(page.getByRole('status').filter({ hasText: /^Attendance settings saved\. Saved semester start:/ })).toBeVisible(); expect((await (await page.request.get('/api/auth/me')).json()).semesterWeeks).toBe(7); await agrees(page, 'Alpha Synthetic', 7);
  }
  expect(errors).toEqual([]);
});

for (const switchAccount of [false, true]) test(`delayed profile response cannot restore user state after ${switchAccount ? 'account switching' : 'logout'}`, async ({ page }) => {
  const { errors } = await setup(page); const arrived = barrier(), release = barrier();
  await page.route('**/api/auth/me', async route => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); });
  await profile(page, 'Alpha Synthetic'); await arrived.promise; await page.getByRole('button', { name: 'Log out', exact: true }).click(); await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  if (switchAccount) { const email = `ordering-next-${crypto.randomUUID()}@example.test`; await page.request.post('/api/auth/register', { data: { email, name: 'Beta Synthetic', password: 'synthetic-password-123' } }); await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill('synthetic-password-123'); await page.getByRole('button', { name: 'Log in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Hi, Beta Synthetic', exact: true })).toBeVisible(); }
  const finished = page.waitForResponse(r => r.url().endsWith('/api/auth/me') && r.request().method() === 'PATCH'); release.resolve(); await finished; await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())));
  if (switchAccount) { await agrees(page, 'Beta Synthetic', 1); expect((await (await page.request.get('/api/auth/me')).json()).semesterStart).toBe(''); }
  else await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.getByText('Hi, Alpha Synthetic', { exact: true })).toHaveCount(0); expect(errors).toEqual([]);
});

test('a delayed import cannot apply semester settings or feedback to a replacement account', async ({ page, context }) => {
  const { errors } = await setup(page); const second = await context.newPage(); await second.goto('/'); await tab(second, 'profile'); await page.bringToFront();
  const arrived = barrier(), release = barrier();
  await page.route('**/api/import/timetable', async route => { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); });
  await tab(page, 'timetable'); await page.getByRole('button', { name: 'Import timetable', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('tab', { name: 'Paste text' }).click();
  await dialog.getByLabel('Semester Timetable By Course text').fill('202609 Semester ( Monday, 2026-11-02 ~ Sunday, 2026-12-20 ) BDEM2001 SYNTHETIC IMPORT Course Plan Mon , 8:00 AM ~ 9:00 AM ( Lecture: 1.0 hours ) SYN 1, Block B'); await dialog.getByRole('button', { name: 'Review timetable' }).click(); await dialog.getByRole('button', { name: 'Import', exact: true }).click(); await arrived.promise;
  await second.bringToFront(); await second.getByRole('button', { name: 'Log out', exact: true }).click(); await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  const email = `import-replacement-${crypto.randomUUID()}@example.test`; await second.request.post('/api/auth/register', { data: { email, name: 'Beta Synthetic', password: 'synthetic-password-123' } }); await second.getByLabel('Email', { exact: true }).fill(email); await second.getByLabel('Password', { exact: true }).fill('synthetic-password-123'); await second.getByRole('button', { name: 'Log in', exact: true }).click(); await expect(second.getByRole('heading', { name: 'Hi, Beta Synthetic', exact: true })).toBeVisible();
  await page.bringToFront(); await expect(page.getByRole('heading', { name: 'Hi, Beta Synthetic', exact: true })).toBeVisible();
  let writes = 0; await page.route('**/api/auth/me', async route => { if (route.request().method() === 'PATCH') writes++; await route.continue(); }); const finished = page.waitForResponse('**/api/import/timetable'); release.resolve(); await finished; await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())));
  const stored = await agrees(page, 'Beta Synthetic', 1); expect(stored.semesterStart).toBe(''); expect(stored.semesterWeeks).toBe(14); expect(writes).toBe(0); await expect(page.locator('.toast').filter({ hasText: /Imported/ })).toHaveCount(0); expect(errors).toEqual([]); await second.close();
});
