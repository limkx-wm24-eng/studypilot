import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'allow' });
test('real worker preserves offline privacy and authoritative 401 recovery', async ({ page, context }) => {
  await page.request.post('/api/auth/register', { data: { email: `worker-session-${crypto.randomUUID()}@example.test`, password: 'synthetic-password-123' } });
  await page.request.post('/api/classes', { data: { name: 'Synthetic worker private class', color: '#0f766e' } });
  await page.goto('/'); await page.waitForFunction(() => navigator.serviceWorker.controller !== null); await page.getByRole('button', { name: 'Classes', exact: true }).click(); await expect(page.getByText('Synthetic worker private class', { exact: true })).toBeVisible();
  await context.setOffline(true); await expect(page.getByRole('button', { name: 'Add class', exact: true })).toBeDisabled(); await expect(page.getByText(/You are offline\. Saved app screens/)).toBeVisible();
  await page.request.post('/api/auth/logout'); // Actual server-side invalidation, no browser signal.
  await context.setOffline(false); await expect(page.getByRole('button', { name: 'Add class', exact: true })).toBeEnabled(); await page.getByLabel('Class name', { exact: true }).fill('Synthetic expired write'); const response = page.waitForResponse(r => r.url().endsWith('/api/classes') && r.request().method() === 'POST'); await page.getByRole('button', { name: 'Add class', exact: true }).click(); expect((await response).status()).toBe(401);
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible(); await expect(page.getByText('Synthetic worker private class', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(async () => { const urls = []; for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) if (/^\/api(?:\/|$)/i.test(new URL(request.url).pathname)) urls.push(new URL(request.url).pathname); return urls; })).toEqual([]);
  await context.setOffline(true); await page.reload(); await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeDisabled(); await expect(page.getByText('Synthetic worker private class', { exact: true })).toHaveCount(0); await context.setOffline(false);
});
