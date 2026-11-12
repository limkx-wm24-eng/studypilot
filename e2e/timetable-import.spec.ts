import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = (name: string) => fileURLToPath(new URL(`../web/src/import/fixtures/${name}`, import.meta.url));
async function register(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic Student');
  const email = `import-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password-123');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('button', { name: 'Timetable', exact: true }).click();
}

for (const [name, count] of [['sample-timetable-narrow.pdf', 5], ['sample-timetable.pdf', 7]] as const) {
  test(`imports and deduplicates synthetic ${name}`, async ({ page }) => {
    await register(page);
    const button = page.getByRole('button', { name: 'Import timetable', exact: true });
    await button.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Choose PDF').setInputFiles(fixture(name));
    await expect(dialog.getByText(`3 classes, ${count} sessions`, { exact: true })).toBeVisible();
    if (name.includes('narrow')) {
      await expect(dialog.getByRole('checkbox', { name: 'Also set my semester: 2026-11-02 to 2026-12-20, 7 teaching weeks' })).toBeChecked();
      await expect(dialog.getByRole('checkbox', { name: 'Create as a class' })).toBeChecked();
    }
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(button).toBeFocused();
    await expect(page.locator('.timetable-day .item')).toHaveCount(count);
    const classes = await (await page.request.get('/api/classes')).json();
    expect(classes).toHaveLength(3);
    if (name.includes('narrow')) {
      const user = await (await page.request.get('/api/auth/me')).json();
      expect(user.semesterStart).toBe('2026-11-02');
      expect(user.semesterWeeks).toBe(7);
    }
    await button.click();
    await dialog.getByLabel('Choose PDF').setInputFiles(fixture(name));
    await expect(dialog.getByText('Already in your timetable', { exact: true })).toHaveCount(count);
    await expect(dialog.getByRole('checkbox', { name: /Include session/, checked: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(button).toBeFocused();
  });
}

test('image-only PDF explains Save as PDF and switches to paste', async ({ page }) => {
  await register(page);
  await page.getByRole('button', { name: 'Import timetable', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Choose PDF').setInputFiles(fixture('image-only.pdf'));
  await expect(dialog.getByRole('status')).toContainText('Save as PDF');
  await expect(dialog.getByLabel('Semester Timetable By Course text')).toBeVisible();
});

test('phone paste review traps focus, validates edits and maps a concurrent conflict', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page);
  await page.getByRole('button', { name: 'Import timetable', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'PDF', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('tab', { name: 'Paste text' })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByLabel('Semester Timetable By Course text').fill('BDEM4044 SYNTHETIC WIDGETS Course Plan Mon , 8:00 AM ~ 10:00 AM ( Lecture: 2.0 hours ) DK 4, DK Buildings Dr A (Weekly)');
  await dialog.getByRole('button', { name: 'Review timetable' }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close importer' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Review timetable' }).click();
  await expect(dialog.getByText('1 classes, 1 sessions', { exact: true })).toBeVisible();
  const session = dialog.getByRole('group', { name: 'Session 1', exact: true });
  await session.getByLabel('End', { exact: true }).fill('07:00');
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await expect(session.getByText(/End must be after start/)).toBeVisible();
  await session.getByLabel('End', { exact: true }).fill('10:00');
  const concurrent = await page.request.post('/api/import/timetable', { data: { slots: [{ className: 'Synthetic Concurrent Class', kind: 'Lecture', weekday: 1, start: '08:00', end: '10:00', room: '' }] } });
  expect(concurrent.status()).toBe(201);
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(session.getByText(/The server found an overlap/)).toBeVisible();
  await session.getByLabel('End', { exact: true }).fill('12:00');
  await session.getByLabel('Start', { exact: true }).fill('10:00');
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.timetable-day .item')).toHaveCount(2);
});
