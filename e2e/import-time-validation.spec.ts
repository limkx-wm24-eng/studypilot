import { expect, test, type Page } from '@playwright/test';
test.use({ serviceWorkers: 'block' });
const source = (start: string, end: string) => `Mon , ${start} ~ ${end} ( Lecture: 1.0 hours ) SYN 1, Block B `;
async function review(page: Page, text: string) {
  expect((await page.request.post('/api/auth/register', { data: { email: `times-${crypto.randomUUID()}@example.test`, password: 'synthetic-password-123' } })).status()).toBe(201);
  await page.goto('/'); await page.getByRole('button', { name: 'Timetable', exact: true }).click();
  await page.getByRole('button', { name: 'Import timetable', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('tab', { name: 'Paste text' }).click();
  await dialog.getByLabel('Semester Timetable By Course text').fill(`BDEM1001 SYNTHETIC COURSE Course Plan ${text}`);
  await dialog.getByRole('button', { name: 'Review timetable' }).click(); return dialog;
}
test('invalid source times remain visible and selected imports require correction or explicit exclusion', async ({ page }) => {
  const dialog = await review(page, source('13:00 AM', '2:00 AM') + source('1:00 AM', '1:99 PM') + source('1:00 AM', '2:00 AM'));
  await expect(dialog.getByText('1 classes, 3 sessions', { exact: true })).toBeVisible();
  const first = dialog.getByRole('group', { name: 'Session 1', exact: true }), second = dialog.getByRole('group', { name: 'Session 2', exact: true });
  await expect(first.getByText(/Invalid source start time "13:00 AM"/)).toContainText('Enter a valid 24-hour start time or uncheck');
  await expect(second.getByText(/Invalid source end time "1:99 PM"/)).toBeVisible();
  await expect(first.getByLabel('Start', { exact: true })).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await expect(dialog.getByText('Overlaps another selected session.', { exact: true })).toHaveCount(0);
  expect(await (await page.request.get('/api/slots')).json()).toHaveLength(0);
  await first.getByRole('checkbox', { name: 'Include session 1' }).uncheck();
  await second.getByRole('checkbox', { name: 'Include session 2' }).uncheck();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click(); await expect(dialog).not.toBeVisible();
  const slots = await (await page.request.get('/api/slots')).json();
  expect(slots).toHaveLength(1); expect(slots[0]).toMatchObject({ start: '01:00', end: '02:00' });
});
test('source times with missing indicators can be corrected into adjacent valid sessions and reimported idempotently', async ({ page }) => {
  const dialog = await review(page, source('0:00', '1:60 XM') + source('01:00 am', '02:00 am'));
  const first = dialog.getByRole('group', { name: 'Session 1', exact: true });
  await expect(first.getByText(/Invalid source start time "0:00"/)).toBeVisible();
  await expect(first.getByText(/Invalid source end time "1:60 XM"/)).toBeVisible();
  await first.getByLabel('Start', { exact: true }).fill('00:00');
  await first.getByLabel('End', { exact: true }).fill('01:00');
  await expect(first.getByText(/Invalid source/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click(); await expect(dialog).not.toBeVisible();
  const classes = await (await page.request.get('/api/classes')).json();
  const slots = await (await page.request.get('/api/slots')).json();
  expect(slots).toHaveLength(2); expect(slots.map((slot: { start: string }) => slot.start).sort()).toEqual(['00:00', '01:00']);
  const repeated = await page.request.post('/api/import/timetable', { data: { slots: slots.map((slot: { kind: string; weekday: number; start: string; end: string; room: string }) => ({ className: classes[0].name, kind: slot.kind, weekday: slot.weekday, start: slot.start, end: slot.end, room: slot.room })) } });
  expect(repeated.status()).toBe(201); expect(await repeated.json()).toEqual({ createdClasses: 0, createdSlots: 0, skipped: 2 });
});
test('an unreadable source row is identified explicitly alongside usable sessions', async ({ page }) => {
  const dialog = await review(page, source('1'.repeat(170) + ' AM', '2:00 AM') + source('1:00 AM', '2:00 AM'));
  await expect(dialog.getByRole('status').filter({ hasText: /Could not read the session/ })).toContainText('Choose again and correct this source row; it will not be imported');
  await expect(dialog.getByText('1 classes, 1 sessions', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click(); await expect(dialog).not.toBeVisible();
  expect(await (await page.request.get('/api/slots')).json()).toHaveLength(1);
});
