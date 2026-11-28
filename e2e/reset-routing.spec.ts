import { expect, test, type Browser, type Page } from '@playwright/test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { securityHarness } from '../test/support/securityHarness';

// Local in-memory SQLite and the existing fake mailer only. Tokens are never
// included in assertions, test titles or console output.
async function fixture(browser: Browser) {
  const h = await securityHarness(false, true);
  const context = await browser.newContext({ baseURL: h.base, serviceWorkers: 'block' });
  const page = await context.newPage();
  const register = async () => {
    const email = `reset-routing-${randomUUID()}@example.test`;
    const response = await context.request.post('/api/auth/register', { data: { email, password: 'synthetic-password-123' } });
    expect(response.status()).toBe(201); const user = await response.json(); return { email, user };
  };
  const tokenFor = async (userId: string, state: 'valid' | 'expired' | 'used' = 'valid') => {
    const token = randomBytes(32).toString('base64url');
    await h.db.run('INSERT INTO auth_tokens (id,user_id,purpose,token_hash,created_at,expires_at,used_at) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, 'password_reset', createHash('sha256').update(token).digest('hex'), Date.now(), Date.now() + (state === 'expired' ? -1 : 30 * 60_000), state === 'used' ? Date.now() : null]);
    return token;
  };
  const open = async (token: string) => {
    await page.goto('/');
    await page.evaluate((value) => { const url = new URL(location.href); url.searchParams.set('reset', value); history.replaceState(null, '', url.pathname + url.search); }, token);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  };
  return { h, context, page, register, tokenFor, open, async close() { await context.close(); await h.close(); } };
}
async function submit(page: Page) {
  await page.getByLabel('New password', { exact: true }).fill('synthetic-new-password-456');
  await page.getByLabel('Confirm new password', { exact: true }).fill('synthetic-new-password-456');
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
}
for (const mode of ['signed out', 'same account', 'different account'] as const) test(`reset routing works when ${mode} and follows backend session invalidation`, async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const owner = await f.register(), token = await f.tokenFor(owner.user.id);
    if (mode === 'signed out') await f.context.request.post('/api/auth/logout');
    if (mode === 'different account') await f.register();
    const expectedSession = mode === 'different account' ? (await (await f.context.request.get('/api/auth/me')).json()).id : null;
    await f.open(token); await submit(f.page);
    await expect(f.page.getByText('Password updated.', { exact: true })).toBeVisible();
    expect(await f.page.evaluate(() => new URL(location.href).searchParams.has('reset'))).toBe(false);
    await f.page.getByRole('button', { name: 'Continue to StudyPilot' }).click();
    if (expectedSession) {
      await expect(f.page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible();
      expect((await (await f.context.request.get('/api/auth/me')).json()).id).toBe(expectedSession);
    } else await expect(f.page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
    expect((await f.context.request.post('/api/auth/login', { data: { email: owner.email, password: 'synthetic-password-123' } })).status()).toBe(401);
    expect((await f.context.request.post('/api/auth/login', { data: { email: owner.email, password: 'synthetic-new-password-456' } })).status()).toBe(200);
    await f.open(token); await submit(f.page);
    await expect(f.page.getByRole('alert')).toContainText('This reset link is invalid or has expired.');
  } finally { await f.close(); }
});
for (const state of ['invalid', 'expired', 'used'] as const) test(`reset routing handles ${state} links with recovery and cancellation`, async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const owner = await f.register();
    const token = state === 'invalid' ? randomBytes(32).toString('base64url') : await f.tokenFor(owner.user.id, state);
    await f.open(token); await submit(f.page);
    await expect(f.page.getByRole('alert')).toContainText('This reset link is invalid or has expired.');
    await expect(f.page.getByRole('button', { name: 'Reset password', exact: true })).toBeEnabled();
    await f.page.getByRole('button', { name: 'Cancel password reset' }).click();
    await expect(f.page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible();
    expect(await f.page.evaluate(() => new URL(location.href).searchParams.has('reset'))).toBe(false);
  } finally { await f.close(); }
});
test('reset failure is retryable, refresh preserves the workflow and success does not resubmit', async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const owner = await f.register(), token = await f.tokenFor(owner.user.id);
    await f.open(token); await f.page.reload();
    let attempts = 0;
    await f.page.route('**/api/auth/reset', (route) => ++attempts === 1 ? route.fulfill({ status: 503, json: { error: 'Server busy. Try again.' } }) : route.continue());
    await submit(f.page); await expect(f.page.getByRole('alert')).toContainText('Server busy');
    await f.page.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(f.page.getByText('Password updated.', { exact: true })).toBeVisible();
    await f.page.reload(); await expect(f.page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
    await f.page.goto('/?synthetic-navigation=1'); await f.page.goBack();
    await expect(f.page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
    expect(attempts).toBe(2);
  } finally { await f.close(); }
});
