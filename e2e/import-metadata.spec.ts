import { expect, test, type Page } from '@playwright/test';

const source = (kind = 'Lecture', room = 'SYN 1') => `Mon , 8:00 AM ~ 10:00 AM ( ${kind}: 2.0 hours ) ${room}, Block B`;
async function setup(page: Page) {
  const response = await page.request.post('/api/auth/register', { data: { email: `metadata-${crypto.randomUUID()}@example.test`, password: 'synthetic-password-123' } });
  expect(response.status()).toBe(201);
  await page.goto('/');
  await page.getByRole('button', { name: 'Timetable', exact: true }).click();
}
async function review(page: Page, text: string) {
  await page.getByRole('button', { name: 'Import timetable', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Paste text' }).click();
  await dialog.getByLabel('Semester Timetable By Course text').fill(`BDEM1001 SYNTHETIC COURSE Course Plan ${text}`);
  await dialog.getByRole('button', { name: 'Review timetable' }).click();
  return dialog;
}

test('metadata review retains both source sessions and requires an explicit selection', async ({ page }) => {
  await setup(page);
  const dialog = await review(page, `${source()} ${source('Practical', 'SYN 2')}`);
  await expect(dialog.getByText('1 classes, 2 sessions', { exact: true })).toBeVisible();
  const first = dialog.getByRole('group', { name: 'Session 1', exact: true });
  const second = dialog.getByRole('group', { name: 'Session 2', exact: true });
  await expect(first.getByRole('combobox', { name: 'Type', exact: true })).toHaveValue('Lecture');
  await expect(second.getByRole('combobox', { name: 'Type', exact: true })).toHaveValue('Practical');
  await expect(first.getByText(/Metadata conflict/)).toContainText('SYN 1 versus Practical, room SYN 2');
  await expect(second.getByLabel('Room', { exact: true })).toHaveValue('SYN 2');
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await second.getByRole('checkbox', { name: 'Include session 2' }).uncheck();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const slots = await (await page.request.get('/api/slots')).json();
  expect(slots).toHaveLength(1);
  expect(slots[0]).toMatchObject({ kind: 'Lecture', room: 'SYN 1' });
});

for (const concurrent of [false, true]) test(`metadata review explains ${concurrent ? 'server-side concurrent' : 'already stored'} conflicts without overwriting`, async ({ page }) => {
  await setup(page);
  const seed = async (className: string) => {
    const response = await page.request.post('/api/import/timetable', { data: { slots: [{ className, kind: 'Lecture', weekday: 1, start: '08:00', end: '10:00', room: 'SYN 1' }] } });
    expect(response.status()).toBe(201);
  };
  if (!concurrent) { await seed('BDEM1001 Synthetic Course'); await page.reload(); await page.getByRole('button', { name: 'Timetable', exact: true }).click(); }
  const dialog = await review(page, source('Practical', 'SYN 2'));
  const session = dialog.getByRole('group', { name: 'Session 1', exact: true });
  await expect(session.getByRole('checkbox', { name: 'Include session 1' })).toBeChecked();
  await expect(session.getByText('Already in your timetable', { exact: true })).toHaveCount(0);
  if (concurrent) {
    const className = await dialog.getByLabel('Class name for BDEM1001').inputValue();
    await seed(className);
    const response = page.waitForResponse((response) => response.url().endsWith('/api/import/timetable') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    expect((await response).status()).toBe(409);
  }
  await expect(session.getByText(/Metadata conflict/)).toContainText('Lecture, room SYN 1');
  await expect(session.getByText(/Metadata conflict/)).toContainText('Practical, room SYN 2');
  await expect(session.getByText(/Metadata conflict/)).toContainText('Edit or uncheck this row');
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  const slots = await (await page.request.get('/api/slots')).json();
  expect(slots).toHaveLength(1); expect(slots[0]).toMatchObject({ kind: 'Lecture', room: 'SYN 1' });
  expect(await (await page.request.get('/api/classes')).json()).toHaveLength(1);
});
