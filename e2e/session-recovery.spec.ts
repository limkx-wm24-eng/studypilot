import { expect, test, type Page } from '@playwright/test';
import { securityHarness } from '../test/support/securityHarness';

test.use({ serviceWorkers: 'block' });
const releases: (() => void)[] = [];
function barrier() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); releases.push(resolve); return { promise, resolve }; }
test.afterEach(() => { for (const release of releases.splice(0)) release(); });
async function setup(page: Page) {
  const email = `session-${crypto.randomUUID()}@example.test`;
  expect((await page.request.post('/api/auth/register', { data: { email, name: 'Synthetic Session', password: 'synthetic-password-123' } })).status()).toBe(201);
  const klass = await (await page.request.post('/api/classes', { data: { name: 'Synthetic private class', color: '#0f766e' } })).json();
  await page.goto('/'); await page.getByRole('button', { name: 'Classes', exact: true }).click();
  await expect(page.getByText(klass.name, { exact: true })).toBeVisible();
  return { email, klass };
}
async function draft(page: Page) {
  await page.getByLabel('Class name', { exact: true }).fill('Synthetic pending class');
  await page.getByRole('button', { name: 'Add class', exact: true }).click();
}
test('an actual expired-session 401 hides private content and verifies once without focus', async ({ page }) => {
  await page.addInitScript(() => {
    const counts = { created: 0, closed: 0 }; (window as unknown as { notificationCounts: typeof counts }).notificationCounts = counts;
    class FakeNotification { static permission = 'granted'; constructor() { counts.created++; } close() { counts.closed++; } }
    Object.defineProperty(window, 'Notification', { value: FakeNotification });
  });
  const { klass } = await setup(page);
  await page.request.post('/api/tasks', { data: { classId: klass.id, name: 'Synthetic private deadline', type: 'Homework', priority: 'Medium', status: 'Not started', due: '2026-01-01', grade: null } });
  await page.reload(); await page.getByRole('button', { name: 'Classes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { notificationCounts: { created: number } }).notificationCounts.created)).toBe(1);
  const release = barrier(); let reads = 0;
  await page.route('**/api/auth/me', async (route) => { reads++; await release.promise; await route.continue(); });
  await page.request.post('/api/auth/logout'); // No client broadcast.
  const response = page.waitForResponse(r => r.url().endsWith('/api/classes') && r.request().method() === 'POST');
  await draft(page); expect((await response).status()).toBe(401);
  await expect.poll(() => reads).toBe(1);
  await expect(page.getByText(klass.name, { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Profile', exact: true })).not.toBeVisible();
  release.resolve(); await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.getByText(klass.name, { exact: true })).toHaveCount(0);
  expect(reads).toBe(1); // /auth/me 401 must not recurse.
  expect(await page.evaluate(() => { const c = (window as unknown as { notificationCounts: { created: number; closed: number } }).notificationCounts; return c.created === c.closed; })).toBe(true);
});

test('simultaneous protected 401s coalesce into one authoritative check', async ({ page }) => {
  const { klass } = await setup(page); const rows = [];
  for (let i = 0; i < 2; i++) rows.push(await (await page.request.post('/api/tasks', { data: { classId: klass.id, name: `Synthetic simultaneous ${i}`, type: 'Homework', priority: 'Medium', status: 'Not started', due: '2026-11-30', grade: null } })).json());
  await page.reload(); await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  const errors = barrier(), verify = barrier(); let writes = 0, reads = 0;
  await page.route('**/api/tasks/*', async route => { writes++; await errors.promise; await route.fulfill({ status: 401, json: { error: 'Please log in' } }); });
  await page.route('**/api/auth/me', async route => { reads++; await verify.promise; await route.continue(); });
  for (const row of rows) await page.getByLabel(`Status of ${row.name}`, { exact: true }).selectOption('Complete');
  await expect.poll(() => writes).toBe(2); await page.request.post('/api/auth/logout'); errors.resolve();
  await expect.poll(() => reads).toBe(1);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); });
  expect(reads).toBe(1); verify.resolve();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible(); expect(reads).toBe(1);
});

test('incorrect login credentials remain an ordinary error without verification', async ({ page }) => {
  const { email } = await setup(page); await page.getByRole('button', { name: 'Profile', exact: true }).click(); await page.getByRole('button', { name: 'Log out', exact: true }).click();
  let reads = 0; await page.route('**/api/auth/me', async route => { reads++; await route.continue(); });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill('incorrect-synthetic-123'); await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password'); expect(reads).toBe(0);
});

test('incorrect email-change password verifies a valid session without logging out', async ({ browser }) => {
  const h = await securityHarness(false, true); const context = await browser.newContext({ baseURL: h.base, serviceWorkers: 'block' });
  try {
    await context.request.post('/api/auth/register', { data: { email: `password-check-${crypto.randomUUID()}@example.test`, password: 'synthetic-password-123' } });
    const page = await context.newPage(); await page.goto('/'); await page.getByRole('button', { name: 'Profile', exact: true }).click(); let reads = 0;
    await page.route('**/api/auth/me', async route => { reads++; await route.continue(); });
    await page.getByLabel('New email', { exact: true }).fill('synthetic-new@example.test'); await page.getByLabel('Current password', { exact: true }).fill('incorrect-synthetic-123'); await page.getByRole('button', { name: 'Change email', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Incorrect password'); await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeVisible(); expect(reads).toBe(1); expect((await context.request.get('/api/auth/me')).status()).toBe(200);
  } finally { await context.close(); await h.close(); }
});

for (const failure of [429, 503, 'network'] as const) test(`${failure} on a normal request does not imply session expiry`, async ({ page }) => {
  const { klass } = await setup(page); let reads = 0;
  await page.route('**/api/auth/me', async route => { reads++; await route.continue(); });
  await page.route('**/api/classes', route => route.request().method() === 'POST' ? failure === 'network' ? route.abort('failed') : route.fulfill({ status: failure, json: { error: 'Synthetic retryable failure' } }) : route.continue());
  await draft(page); await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByText(klass.name, { exact: true })).toBeVisible(); expect(reads).toBe(0);
});

for (const failure of [429, 503, 'network'] as const) test(`${failure} during verification protects content and permits safe retry`, async ({ page }) => {
  const { klass } = await setup(page); let reads = 0;
  await page.route('**/api/classes', route => route.request().method() === 'POST' ? route.fulfill({ status: 401, json: { error: 'Please log in' } }) : route.continue());
  await page.route('**/api/auth/me', async route => { reads++; if (reads > 1) return route.continue(); return failure === 'network' ? route.abort('failed') : route.fulfill({ status: failure, json: { error: 'Synthetic verification unavailable' } }); });
  await draft(page); await expect(page.getByText('Could not verify your session. Check your connection and retry.', { exact: false })).toBeVisible();
  await expect(page.getByText(klass.name, { exact: true })).not.toBeVisible(); await expect(page.getByRole('button', { name: 'Log in', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
  await page.getByRole('button', { name: 'Retry session', exact: true }).click(); await expect(page.getByText(klass.name, { exact: true })).toBeVisible(); expect(reads).toBe(2);
});

test('a delayed old-session 401 cannot invalidate a newly logged-in account', async ({ page }) => {
  const { klass } = await setup(page); const task = await (await page.request.post('/api/tasks', { data: { classId: klass.id, name: 'Synthetic old request', type: 'Homework', priority: 'Medium', status: 'Not started', due: '2026-11-30', grade: null } })).json();
  await page.reload(); await page.getByRole('button', { name: 'Tasks', exact: true }).click(); const arrived = barrier(), release = barrier();
  await page.route(`**/api/tasks/${task.id}`, async route => { arrived.resolve(); await release.promise; await route.fulfill({ status: 401, json: { error: 'Please log in' } }); });
  await page.getByLabel(`Status of ${task.name}`).selectOption('Complete'); await arrived.promise;
  await page.getByRole('button', { name: 'Profile', exact: true }).click(); await page.getByRole('button', { name: 'Log out', exact: true }).click();
  const email = `new-session-${crypto.randomUUID()}@example.test`; await page.request.post('/api/auth/register', { data: { email, name: 'Beta Synthetic', password: 'synthetic-password-123' } });
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill('synthetic-password-123'); await page.getByRole('button', { name: 'Log in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Hi, Beta Synthetic', exact: true })).toBeVisible();
  let reads = 0; await page.route('**/api/auth/me', async route => { reads++; await route.continue(); }); const finished = page.waitForResponse(`**/api/tasks/${task.id}`); release.resolve(); await finished;
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r()))); await expect(page.getByRole('heading', { name: 'Hi, Beta Synthetic', exact: true })).toBeVisible(); expect(reads).toBe(0); await expect(page.getByText(klass.name, { exact: true })).toHaveCount(0);
});

test('delayed successful account reads cannot repopulate a confirmed invalid session', async ({ page }) => {
  await setup(page); const arrived = barrier(), release = barrier();
  await page.route('**/api/classes', async route => { if (route.request().method() !== 'GET') return route.continue(); const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); });
  await page.reload(); await arrived.promise; await page.getByRole('button', { name: 'Profile', exact: true }).click(); await page.request.post('/api/auth/logout');
  await page.getByLabel('Your name', { exact: true }).fill('Synthetic stale save'); await page.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  const finished = page.waitForResponse('**/api/classes'); release.resolve(); await finished; await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())));
  await expect(page.getByText('Synthetic private class', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
});
