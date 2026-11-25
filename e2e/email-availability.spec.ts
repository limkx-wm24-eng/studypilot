import { expect, test } from '@playwright/test';

// Intercept the config and mail API directly; worker behavior has its own real-worker test.
test.use({ serviceWorkers: 'block' });

for (const enabled of [false, true]) {
  test(`email availability ${enabled}: honest notices and controls, configuration fetched once`, async ({ page }) => {
    let configRequests = 0;
    await page.route('**/api/config', async (route) => {
      configRequests++;
      await route.fulfill({ json: { emailEnabled: enabled } });
    });
    await page.route('**/api/auth/forgot', (route) => route.fulfill({ json: { message: 'If an account exists for that email, we sent a reset link.' } }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    const send = page.getByRole('button', { name: 'Send reset link' });
    if (enabled) {
      await expect(send).toBeEnabled();
      await page.getByLabel('Email', { exact: true }).fill('synthetic@example.test');
      await send.click();
      await expect(page.getByRole('status')).toContainText('If an account exists');
    } else {
      await expect(page.getByRole('status')).toContainText('Email is not set up on this demo');
      await expect(send).toBeDisabled();
    }
    await page.getByRole('button', { name: 'Back to log in' }).click();
    const registered = await page.request.post('/api/auth/register', { data: { email: `email-ui-${enabled}-${Date.now()}@example.test`, password: 'synthetic-password-123' } });
    expect(registered.status()).toBe(201);
    // Log in without reloading, so the app must reuse its in-memory flag.
    await page.getByLabel('Email', { exact: true }).fill((await registered.json()).email);
    await page.getByLabel('Password', { exact: true }).fill('synthetic-password-123');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    if (enabled) await expect(page.getByRole('button', { name: 'Resend', exact: true })).toBeVisible();
    else {
      await expect(page.getByRole('button', { name: 'Resend', exact: true })).toHaveCount(0);
      await expect(page.getByText('Email verification is unavailable on this demo')).toBeVisible();
    }
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    if (enabled) await expect(page.getByRole('button', { name: 'Change email', exact: true })).toBeVisible();
    else {
      await expect(page.getByText('Email verification is unavailable on this demo')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Change email', exact: true })).toHaveCount(0);
      await expect(page.getByText(/Confirmation sent/)).toHaveCount(0);
    }
    expect(configRequests).toBe(1);
    expect(await page.evaluate(() => {
      const values = [localStorage, sessionStorage].flatMap((storage) => Object.keys(storage).map((key) => `${key}:${storage.getItem(key)}`));
      return values.some((value) => /emailEnabled|emailAvailability/.test(value));
    })).toBe(false);
  });
}

test('configuration failure disables email sending without blocking account access', async ({ page }) => {
  await page.route('**/api/config', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic unavailable configuration' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('status')).toContainText('Email availability could not be checked');
  await expect(page.getByRole('button', { name: 'Send reset link' })).toBeDisabled();
  await page.getByRole('button', { name: 'Back to log in' }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Create an account' })).toBeEnabled();
});
