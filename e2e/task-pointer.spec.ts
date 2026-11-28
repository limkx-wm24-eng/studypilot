import { expect, test, type Locator } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
const viewports = [[320, 568], [375, 667], [390, 844], [768, 1024], [1024, 768], [1280, 720], [1366, 768], [1920, 1080]];
async function hit(locator: Locator) {
  expect(await locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
}
for (const [width, height] of viewports) test(`task pointers, scrolling and keyboard persist changes at ${width}x${height}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(new Date('2026-11-25T12:00:00+08:00'));
  expect((await page.request.post('/api/auth/register', { data: { email: `pointer-${crypto.randomUUID()}@example.test`, password: 'synthetic-password-123' } })).status()).toBe(201);
  const klass = await (await page.request.post('/api/classes', { data: { name: 'Synthetic ' + 'L'.repeat(50), color: '#0f766e' } })).json();
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(await (await page.request.post('/api/tasks', { data: { classId: klass.id, name: `Synthetic row ${String(i).padStart(2, '0')}`, type: 'Homework', priority: 'Medium', status: 'Not started', due: '2026-01-01', grade: null } })).json());
  await page.goto('/');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const index of [0, 10, 19]) {
    const row = rows[index];
    const status = page.getByLabel(`Status of ${row.name}`, { exact: true });
    const grade = page.getByLabel(`Grade for ${row.name}`, { exact: true });
    const remove = page.getByRole('button', { name: `Delete ${row.name}`, exact: true });
    await status.click(); await hit(status);
    await status.selectOption('In progress'); await status.press('Escape');
    await expect(status).toHaveValue('In progress');
    await grade.click(); await hit(grade); await grade.fill('73.5'); await grade.press('Tab');
    await expect.poll(async () => (await (await page.request.get('/api/tasks')).json()).find((item: { id: string }) => item.id === row.id)?.grade).toBe(73.5);
    const stored = (await (await page.request.get('/api/tasks')).json()).find((item: { id: string }) => item.id === row.id);
    expect(stored.status).toBe('In progress');
    if (width === 1280 && index === 0) await page.screenshot({ path: testInfo.outputPath('task-controls-1280-after.png') });
    // Normal clicks scroll both the document and tablet table into view.
    await remove.click(); await expect(remove).toHaveCount(0);
    expect((await (await page.request.get('/api/tasks')).json()).some((item: { id: string }) => item.id === row.id)).toBe(false);
  }
  if (width === 768 || width === 1024) expect(await page.locator('.tw').evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const keyboardRow = rows[1];
  const grade = page.getByLabel(`Grade for ${keyboardRow.name}`, { exact: true });
  await grade.scrollIntoViewIfNeeded(); await grade.focus(); await hit(grade);
  await page.keyboard.press('Tab');
  const remove = page.getByRole('button', { name: `Delete ${keyboardRow.name}`, exact: true });
  await expect(remove).toBeFocused(); await page.keyboard.press('Enter'); await expect(remove).toHaveCount(0);
  expect((await (await page.request.get('/api/tasks')).json()).some((item: { id: string }) => item.id === keyboardRow.id)).toBe(false);
  await page.evaluate(() => window.scrollTo(0, 0));
  const remaining = page.getByLabel(`Status of ${rows[2].name}`, { exact: true });
  await remaining.click(); await hit(remaining); await remaining.selectOption('Complete'); await remaining.press('Escape');
  await expect.poll(async () => (await (await page.request.get('/api/tasks')).json()).find((item: { id: string }) => item.id === rows[2].id)?.status).toBe('Complete');
});
