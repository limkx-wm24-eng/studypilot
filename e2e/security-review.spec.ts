import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

test('QA XSS: class, task, room and pasted timetable markup remain text', async ({ page }) => {
  let dialogs = 0;
  page.on('dialog', async (dialog) => { dialogs++; await dialog.dismiss(); });
  await page.request.post('/api/auth/register', { data: { email: `xss-${Date.now()}@example.test`, password: 'synthetic-password-123' } });
  const payload = '<img src=x onerror=alert(1)>';
  const klass = await (await page.request.post('/api/classes', { data: { name: payload, color: '#0f766e' } })).json();
  await page.request.post('/api/tasks', { data: { classId: klass.id, name: payload, type: 'Homework', priority: 'Medium', status: 'Not started', due: '2026-12-31', grade: null } });
  await page.request.post('/api/slots', { data: { classId: klass.id, kind: 'Lecture', weekday: 1, start: '08:00', end: '10:00', room: payload } });
  await page.goto('/');
  for (const tab of ['Classes', 'Tasks', 'Timetable']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await expect(page.getByText(payload, { exact: false }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Import timetable', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Paste text' }).click();
  const pastedPayload = '<IMG SRC=X ONERROR=alert`1`>';
  await dialog.getByLabel('Semester Timetable By Course text').fill(`BDEM1001 SYNTHETIC ${pastedPayload} Course Plan Tue , 8:00 AM ~ 10:00 AM ( Lecture: 2.0 hours ) SYN 1, Block B Dr Synthetic (Weekly)`);
  await dialog.getByRole('button', { name: 'Review timetable' }).click();
  await expect(dialog.getByLabel('Class name for BDEM1001')).toHaveValue(/<img/i);
  await expect(dialog.locator('img')).toHaveCount(0);
  expect(dialogs).toBe(0);
});

test('QA PDF privacy: confirmation sends only reviewed JSON, never PDF bytes', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { email: `pdf-privacy-${Date.now()}@example.test`, password: 'synthetic-password-123' } });
  const writes: { contentType: string; body: string }[] = [];
  page.on('request', (request) => { if (['POST', 'PUT', 'PATCH'].includes(request.method())) writes.push({ contentType: request.headers()['content-type'] ?? '', body: request.postData() ?? '' }); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Timetable', exact: true }).click();
  await page.getByRole('button', { name: 'Import timetable', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Choose PDF').setInputFiles(fileURLToPath(new URL('../web/src/import/fixtures/sample-timetable-narrow.pdf', import.meta.url)));
  await expect(dialog.getByText('3 classes, 5 sessions', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  const sent = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/import/timetable'));
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  const request = await sent;
  expect(Object.keys(request.postDataJSON()).sort()).toEqual(['classes', 'slots']);
  await expect(dialog).not.toBeVisible();
  expect(writes.every((write) => write.contentType.includes('application/json') && !write.body.includes('%PDF-'))).toBe(true);
});

test('QA CSRF: a same-site foreign-origin form cannot log out the account', async ({ page, context, baseURL }) => {
  await context.request.post('/api/auth/register', { data: { email: `csrf-${Date.now()}@example.test`, password: 'synthetic-password-123' } });
  const attacker = createServer((_req, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><form method="post" action="${baseURL}/api/auth/logout"><button>Submit synthetic form</button></form>`);
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => attacker.once('listening', resolve));
  try {
    await page.goto(`http://127.0.0.1:${(attacker.address() as AddressInfo).port}`);
    const result = page.waitForResponse((response) => response.url() === `${baseURL}/api/auth/logout`);
    await page.getByRole('button', { name: 'Submit synthetic form' }).click();
    const response = await result;
    const stillLoggedIn = await context.request.get('/api/auth/me');
    test.info().annotations.push({ type: 'evidence', description: `Foreign-origin form logout returned ${response.status()}; subsequent session check returned ${stillLoggedIn.status()}.` });
    expect(stillLoggedIn.status()).toBe(200);
    expect(response.status()).toBe(403);
  } finally { await new Promise<void>((resolve) => attacker.close(() => resolve())); }
});
