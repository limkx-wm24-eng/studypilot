import { expect, test, type Page } from '@playwright/test';

// Session-response race tests intercept HTTP directly; real-worker privacy has its own suite.
test.use({ serviceWorkers: 'block' });

async function login(page: Page, email: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password-123');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible();
}

for (const fallback of [false, true]) {
  test(`logout clears both tabs and account switching cannot restore old data (${fallback ? 'storage fallback' : 'BroadcastChannel'})`, async ({ context, page }) => {
    await context.addInitScript(({ fallback }) => {
      if (fallback) Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true });
      else {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key === 'studypilot-session-event') throw new Error('Synthetic blocked session-event storage');
          return setItem.call(this, key, value);
        };
      }
      const counter = { created: 0, closed: 0 };
      (window as unknown as { notificationCounter: typeof counter }).notificationCounter = counter;
      class SyntheticNotification {
        static permission = 'granted';
        static requestPermission = async () => 'granted';
        onclose?: () => void;
        private closed = false;
        constructor() { counter.created++; }
        close() { if (!this.closed) { this.closed = true; counter.closed++; this.onclose?.(); } }
      }
      Object.defineProperty(window, 'Notification', { value: SyntheticNotification });
      localStorage.setItem('studypilot-notification-days', '{"synthetic-legacy":"2026-11-25"}');
    }, { fallback });
    const emailA = `logout-a-${Date.now()}@example.test`;
    const emailB = `logout-b-${Date.now()}@example.test`;
    const registered = await context.request.post('/api/auth/register', { data: { email: emailA, password: 'synthetic-password-123' } });
    const userA = await registered.json();
    const klass = await (await context.request.post('/api/classes', { data: { name: 'Synthetic Private A', color: '#0f766e' } })).json();
    await context.request.post('/api/tasks', { data: { classId: klass.id, name: 'Synthetic Private Task A', type: 'Homework', priority: 'Medium', status: 'Not started', due: '2026-01-01', grade: null } });
    await page.goto('/');
    await expect(page.getByText('Synthetic Private Task A').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { notificationCounter: { created: number } }).notificationCounter.created)).toBeGreaterThan(0);
    const second = await context.newPage();
    await second.goto('/');
    await expect(second.getByText('Synthetic Private Task A').first()).toBeVisible();
    expect(await second.evaluate(() => localStorage.getItem('studypilot-notification-days'))).toBeNull();
    expect(await second.evaluate((id) => localStorage.getItem(`studypilot-notification-days:${id}`), userA.id)).not.toBeNull();
    await page.bringToFront();
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
    await expect(second.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
    await expect(second.getByText('Synthetic Private Task A')).toHaveCount(0);
    for (const tab of [page, second]) expect(await tab.evaluate(() => {
      const counter = (window as unknown as { notificationCounter: { created: number; closed: number } }).notificationCounter;
      return counter.created === counter.closed;
    })).toBe(true);

    const next = await context.request.post('/api/auth/register', { data: { email: emailB, password: 'synthetic-password-123' } });
    const userB = await next.json();
    await context.request.post('/api/classes', { data: { name: 'Synthetic Private B', color: '#6366f1' } });
    await login(page, emailB);
    await second.bringToFront();
    await expect(second.getByRole('button', { name: 'Classes', exact: true })).toBeVisible();
    await second.getByRole('button', { name: 'Classes', exact: true }).click();
    await expect(second.getByText('Synthetic Private B', { exact: true })).toBeVisible();
    await expect(second.getByText('Synthetic Private A', { exact: true })).toHaveCount(0);
    await expect(second.getByText('Synthetic Private Task A')).toHaveCount(0);
    expect(await second.evaluate((id) => localStorage.getItem(`studypilot-notification-days:${id}`), userB.id)).not.toBeNull();
    expect(await second.evaluate(() => localStorage.getItem('studypilot-session-event'))).toBeNull();
  });
}

test('focus hides stale account data until an external session switch has been verified', async ({ context, page }) => {
  await context.request.post('/api/auth/register', { data: { email: `focus-a-${Date.now()}@example.test`, password: 'synthetic-password-123' } });
  await context.request.post('/api/classes', { data: { name: 'Synthetic Focus A', color: '#0f766e' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Classes', exact: true }).click();
  await expect(page.getByText('Synthetic Focus A', { exact: true })).toBeVisible();
  // Direct HTTP requests change the shared cookie without any client broadcast.
  await context.request.post('/api/auth/logout');
  await context.request.post('/api/auth/register', { data: { email: `focus-b-${Date.now()}@example.test`, password: 'synthetic-password-123' } });
  await context.request.post('/api/classes', { data: { name: 'Synthetic Focus B', color: '#6366f1' } });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/auth/me', async (route) => { await blocked; await route.continue(); });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Synthetic Focus A', { exact: true })).not.toBeVisible();
  release();
  await expect(page.getByRole('button', { name: 'Classes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Classes', exact: true }).click();
  await expect(page.getByText('Synthetic Focus B', { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic Focus A', { exact: true })).toHaveCount(0);
  await context.request.post('/api/auth/logout');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic Focus B', { exact: true })).toHaveCount(0);
});

test('an in-flight session response cannot restore an account after another tab logs out', async ({ context, page }) => {
  await context.request.post('/api/auth/register', { data: { email: `late-session-${Date.now()}@example.test`, password: 'synthetic-password-123' } });
  await context.request.post('/api/classes', { data: { name: 'Synthetic Late Account', color: '#0f766e' } });
  const oldSession = await (await context.request.get('/api/auth/me')).json();
  await page.goto('/');
  await page.getByRole('button', { name: 'Classes', exact: true }).click();
  await expect(page.getByText('Synthetic Late Account', { exact: true })).toBeVisible();
  const second = await context.newPage();
  await second.goto('/');
  await second.getByRole('button', { name: 'Profile', exact: true }).click();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/auth/me', async (route) => { await blocked; await route.fulfill({ json: oldSession }); });
  const pending = page.waitForRequest('**/api/auth/me');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pending;
  await second.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  const finished = page.waitForResponse('**/api/auth/me');
  release();
  await finished;
  // Rendering callbacks queued behind the response run before this evaluation.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic Late Account', { exact: true })).toHaveCount(0);
});
