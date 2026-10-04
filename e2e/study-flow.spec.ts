import { expect, test } from '@playwright/test';

test('account setup and task progress persist across login', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  await page.goto('/');

  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('E2E Student');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByLabel('Course type').selectOption({ label: 'Degree' });
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('status')).toHaveText('Profile saved.');

  await page.getByRole('button', { name: 'Classes' }).click();
  await page.getByLabel('Class name').fill('E2E Databases');
  await page.getByRole('button', { name: 'Add class' }).click();
  await expect(page.getByText('E2E Databases')).toBeVisible();

  await page.getByRole('button', { name: 'Tasks' }).click();
  await page.getByLabel('Task name').fill('E2E coursework');
  await page.getByLabel('Due date').fill('2026-12-31');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByLabel('Status of E2E coursework').selectOption('Complete');
  await expect(page.getByLabel('Status of E2E coursework')).toHaveValue('Complete');

  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByLabel('Remember me').check();
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('button', { name: 'Dashboard' })).toBeVisible();
  const sessionCookie = (await page.context().cookies()).find(({ name }) => name === 'sp_session');
  expect(sessionCookie?.expires).toBeGreaterThan(Date.now() / 1000);

  await page.getByRole('button', { name: 'Tasks' }).click();
  await expect(page.getByRole('row', { name: /E2E coursework/ })).toBeVisible();
  await expect(page.getByLabel('Status of E2E coursework')).toHaveValue('Complete');
});
