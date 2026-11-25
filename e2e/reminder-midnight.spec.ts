import { expect, test, type Page } from '@playwright/test';
test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Kuala_Lumpur' });
type Delivery = { body: string; closed: boolean };
async function stub(page: Page, permission: NotificationPermission = 'granted') {
  await page.addInitScript((permission) => {
    const deliveries: { body: string; closed: boolean }[] = [];
    (window as unknown as { deliveries: typeof deliveries }).deliveries = deliveries;
    class FakeNotification {
      static permission = permission;
      static requestPermission = async () => permission;
      onclose?: () => void;
      row: { body: string; closed: boolean };
      constructor(_title: string, options: NotificationOptions) { this.row = { body: options.body ?? '', closed: false }; deliveries.push(this.row); }
      close() { this.row.closed = true; this.onclose?.(); }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification });
  }, permission);
}
const deliveries = (page: Page) => page.evaluate(() => (window as unknown as { deliveries: Delivery[] }).deliveries);
async function account(page: Page, name: string, dates: string[]) {
  expect((await page.request.post('/api/auth/register', { data: { email: `reminder-${crypto.randomUUID()}@example.test`, password: 'synthetic-password-123' } })).status()).toBe(201);
  await page.request.patch('/api/auth/me', { data: { reminderDays: 0 } });
  const klass = await (await page.request.post('/api/classes', { data: { name: 'Synthetic reminders', color: '#0f766e' } })).json();
  for (const due of dates) await page.request.post('/api/tasks', { data: { classId: klass.id, name: `${name} ${due}`, due, type: 'Homework', status: 'Not started', priority: 'Medium', grade: null } });
}
async function clock(page: Page, date: string) { const now = new Date(`${date}T23:59:00+08:00`); await page.clock.install({ time: now }); await page.clock.pauseAt(now); }

test('open app reevaluates at consecutive Malaysia midnights, with no premature or duplicate delivery', async ({ page }) => {
  await stub(page); await account(page, 'Synthetic due', ['2026-11-03', '2026-11-04']); await clock(page, '2026-11-02');
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic due 2026-11-03', { exact: true }).first()).toBeVisible();
  expect(await deliveries(page)).toHaveLength(0);
  await page.clock.runFor(59_000); expect(await deliveries(page)).toHaveLength(0);
  await page.clock.runFor(61_000); await expect.poll(async () => (await deliveries(page)).length).toBe(1);
  expect((await deliveries(page))[0].body).toBe('Synthetic due 2026-11-03: Today');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible();
  expect(await deliveries(page)).toHaveLength(1);
  await page.clock.runFor(86_400_000); await expect.poll(async () => (await deliveries(page)).length).toBe(3);
  await page.clock.runFor(86_400_000); await expect.poll(async () => (await deliveries(page)).length).toBe(5);
});
test('year boundary and delayed wake-up reevaluate the actual current day once', async ({ page }) => {
  await stub(page); await account(page, 'Synthetic year', ['2027-01-01']); await clock(page, '2026-12-31');
  await page.goto('/'); await expect(page.getByText('Synthetic year 2027-01-01', { exact: true }).first()).toBeVisible();
  await page.clock.fastForward(3 * 86_400_000);
  await expect.poll(async () => (await deliveries(page)).length).toBe(1);
  expect((await deliveries(page))[0].body).toBe('Synthetic year 2027-01-01: 2d overdue');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(await deliveries(page)).toHaveLength(1);
  await page.clock.runFor(86_400_000); await expect.poll(async () => (await deliveries(page)).length).toBe(2);
});
for (const permission of ['denied', 'default'] as const) test(`permission ${permission} never delivers a desktop reminder`, async ({ page }) => {
  await stub(page, permission); await account(page, 'Synthetic permission', ['2026-11-03']); await clock(page, '2026-11-02');
  await page.goto('/'); await expect(page.getByText('Synthetic permission 2026-11-03', { exact: true }).first()).toBeVisible();
  await page.clock.runFor(2 * 86_400_000); expect(await deliveries(page)).toHaveLength(0);
});
test('logout and account switching cancel the previous account midnight scheduler', async ({ page }) => {
  await stub(page); await account(page, 'Synthetic old account', ['2026-11-03']); await clock(page, '2026-11-02');
  await page.goto('/'); await expect(page.getByText('Synthetic old account 2026-11-03', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Profile', exact: true }).click(); await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await account(page, 'Synthetic next account', ['2026-11-03']);
  // Stay in the same document to catch any timer that survived logout.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Synthetic next account 2026-11-03', { exact: true }).first()).toBeVisible();
  await page.clock.runFor(120_000); await expect.poll(async () => (await deliveries(page)).length).toBe(1);
  expect((await deliveries(page))[0].body).toBe('Synthetic next account 2026-11-03: Today');
});
