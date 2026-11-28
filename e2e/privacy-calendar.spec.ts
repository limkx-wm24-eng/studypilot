import { expect, test } from '@playwright/test';

test('worker activation removes legacy API caches and offline API navigation never becomes app HTML', async ({ page, context }) => {
  await page.goto('/api/health');
  await page.evaluate(async () => {
    await caches.open('api-network-first');
    for (const name of ['old-auth-cache', 'mixed-user-cache']) {
      const cache = await caches.open(name);
      await cache.put('/api/auth/me', new Response('{"synthetic":"previous-user"}'));
    }
    await (await caches.open('static-synthetic')).put('/synthetic-static.css', new Response('body{}'));
    await (await caches.open('redirected-api-cache')).put('/legacy-view', await fetch('/api/health'));
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (worker && worker.state !== 'activated') await new Promise<void>((resolve) => worker.addEventListener('statechange', () => { if (worker.state === 'activated') resolve(); }));
  });
  const names = await page.evaluate(() => caches.keys());
  expect(names).not.toContain('api-network-first');
  expect(names).not.toContain('old-auth-cache');
  expect(names).not.toContain('mixed-user-cache');
  expect(names).not.toContain('redirected-api-cache');
  expect(names).toContain('static-synthetic');
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.evaluate(async () => { await fetch('/api/health'); await fetch('/api/config'); await fetch('/api/classes'); });
  expect(await page.evaluate(async () => {
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) {
      if (/^\/api(?:\/|$)/i.test(new URL(request.url).pathname)) return false;
    }
    return true;
  })).toBe(true);
  await context.setOffline(true);
  expect(await page.evaluate(() => fetch('/api/health').then(() => false, () => true))).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.getByText('previous-user')).toHaveCount(0);
  for (const path of ['/api/health', '/api?synthetic=1']) {
    const apiPage = await context.newPage();
    const navigationFailed = await apiPage.goto(path).then(() => false, () => true);
    expect(navigationFailed).toBe(true);
    await apiPage.close();
  }
  await context.setOffline(false);
});

test('dashboard and attendance settings handle 202609 without invented exams or holidays', async ({ page }) => {
  const registered = await page.request.post('/api/auth/register', { data: { email: `calendar-${Date.now()}@example.test`, password: 'synthetic-password-123' } });
  expect(registered.status()).toBe(201);
  await page.request.patch('/api/auth/me', { data: { courseType: 'Degree', semesterStart: '2026-11-02', semesterWeeks: 7 } });
  await page.clock.setFixedTime(new Date('2026-11-13T12:00:00+08:00'));
  await page.goto('/');
  await expect(page.locator('.semester-chip')).toContainText('Semester 202609');
  await expect(page.locator('.semester-chip')).toContainText('Teaching week 2 of 7');
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await expect(page.getByLabel('TAR UMT semester')).toHaveValue('2026-11-02');
  await expect(page.getByText('Teaching ends 2026-12-20. Exams: unknown. Holidays: unknown.')).toBeVisible();
});
