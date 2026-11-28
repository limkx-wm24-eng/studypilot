import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb, migrate } from '../src/db';
import { createApp } from '../src/app';
import { layout, layoutFixture, names, tab, taskName, widths } from './support/layout-fixture';

test.use({ serviceWorkers: 'block' });
for (const [width, height] of widths) test(`long-name reflow and reachable controls at ${width}x${height}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height }); const fixture = await layoutFixture(page); const results = [];
  for (const view of ['dash', 'classes', 'tasks', 'timetable', 'progress', 'profile']) {
    await tab(page, view); results.push({ view, ...await layout(page) });
    if (view === 'dash') { await expect(page.getByRole('heading', { name: 'Hi, ' + 'S'.repeat(40), exact: true })).toBeVisible(); await expect(page.getByText('Getting started', { exact: true })).toBeVisible(); }
    if (view === 'classes') {
      for (const name of names) { const text = page.locator('.grow b').filter({ hasText: name }); await expect(text).toHaveText(name); expect(await text.evaluate(e => { const r = document.createRange(); r.selectNodeContents(e); const parent = e.parentElement!.getBoundingClientRect(); return [...r.getClientRects()].every(rect => rect.left >= parent.left - .5 && rect.right <= parent.right + .5); })).toBe(true); }
      page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: `Delete ${names[0]}`, exact: true }).click(); expect((await (await page.request.get('/api/classes')).json()).length).toBe(4);
    }
    if (view === 'tasks') {
      const status = page.getByLabel(`Status of ${taskName}`, { exact: true }); await status.click(); await status.selectOption('In progress'); await status.press('Escape');
      const grade = page.getByLabel(`Grade for ${taskName}`, { exact: true }); await grade.click(); await grade.fill('61'); await grade.press('Tab');
      await expect.poll(async () => (await (await page.request.get('/api/tasks')).json()).find((t: { id: string }) => t.id === fixture.tasks[0].id)?.grade).toBe(61);
      expect((await (await page.request.get('/api/tasks')).json()).find((t: { id: string }) => t.id === fixture.tasks[0].id).status).toBe('In progress');
      await page.getByRole('button', { name: 'Calendar', exact: true }).click(); results.push({ view: 'calendar', ...await layout(page) });
      if (width <= 390) {
        const region = page.getByRole('region', { name: 'Calendar dates', exact: true }); await region.focus();
        // Browser-native scrolling, not an invented date-picker arrow-key model.
        for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
        await expect.poll(() => region.evaluate(e => e.scrollLeft + e.clientWidth >= e.scrollWidth - 1)).toBe(true);
        const sunday = await page.getByRole('columnheader', { name: 'Sun', exact: true }).boundingBox(); const bounds = await region.boundingBox(); expect(sunday!.x + sunday!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
      }
      const button = page.getByRole('button', { name: `${taskName}, Assignment, due 2026-11-25. Mark complete`, exact: true }); await button.scrollIntoViewIfNeeded(); await expect(button).toHaveText(taskName); expect(await button.evaluate(e => e.scrollWidth <= e.clientWidth && getComputedStyle(e).textOverflow !== 'ellipsis')).toBe(true); await page.getByRole('button', { name: 'List', exact: true }).click();
      await page.getByRole('button', { name: `Delete ${taskName}`, exact: true }).click(); await expect.poll(async () => (await (await page.request.get('/api/tasks')).json()).some((t: { id: string }) => t.id === fixture.tasks[0].id)).toBe(false);
    }
    if (view === 'timetable') {
      for (const name of names.slice(0, 3)) await expect(page.locator('.timetable-day .grow b').filter({ hasText: name })).toBeVisible();
      const present = page.getByRole('button', { name: 'Present', exact: true }).first(); await present.click(); await expect(present).toHaveAttribute('aria-pressed', 'true'); const marks = await (await page.request.get('/api/attendance?from=2026-11-23&to=2026-11-29')).json(); expect(marks).toHaveLength(1); await present.click(); await expect(present).toHaveAttribute('aria-pressed', 'false');
    }
    if (view === 'progress') { await expect(page.locator('.course-row b')).toHaveText('C'.repeat(80)); await page.getByLabel('Target CGPA', { exact: true }).click(); await page.keyboard.press('Control+A'); await page.keyboard.type('3.8'); await expect(page.getByLabel('Target CGPA', { exact: true })).toHaveValue('3.8'); }
    if (view === 'profile') { await expect(page.getByLabel('Programme (optional)', { exact: true })).toHaveValue('P'.repeat(60)); await page.getByLabel('Programme (optional)', { exact: true }).click(); await page.keyboard.press('End'); expect(await page.getByLabel('Programme (optional)', { exact: true }).inputValue()).toHaveLength(60); }
    if (width === 320 && ['dash', 'classes', 'timetable', 'profile'].includes(view)) await page.screenshot({ path: info.outputPath(`${view}-320.png`) });
  }
  await tab(page, 'timetable'); const opener = page.getByRole('button', { name: 'Import timetable', exact: true }); await opener.click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('tab', { name: 'Paste text' }).click(); await dialog.getByLabel('Semester Timetable By Course text').fill('BDEM2001 SYNTHETIC IMPORT Course Plan Tue , 10:00 AM ~ 11:00 AM ( Lecture: 1.0 hours ) ' + 'R'.repeat(30) + ', Block B'); await dialog.getByRole('button', { name: 'Review timetable' }).click(); await dialog.getByLabel('Class name for BDEM2001', { exact: true }).fill(names[0]);
  expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true); results.push({ view: 'import', ...await layout(page), dialog: await dialog.boundingBox() });
  await dialog.getByRole('button', { name: 'Close importer' }).focus(); await page.keyboard.press('Shift+Tab'); expect(await dialog.evaluate(e => e.contains(document.activeElement))).toBe(true); await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
  expect((await (await page.request.get('/api/classes')).json()).map((c: { name: string }) => c.name)).toEqual(fixture.classes.map(c => c.name));
  writeFileSync(info.outputPath('layout.json'), JSON.stringify(results, null, 2));
});

test('a genuine pre-migration 70-character legacy name reflows without rewriting data', async ({ browser }, info) => {
  const db = await openDb(':memory:', { databaseUrl: '', migrationsThrough: 9 });
  const server = createApp(db, { mailer: { enabled: false, async send() {} } }).listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Synthetic fixture unavailable');
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${address.port}`, serviceWorkers: 'block' }); const name = 'L'.repeat(70); const results = [];
  try {
    const response = await context.request.post('/api/auth/register', { data: { email: `legacy-layout-${randomUUID()}@example.test`, password: 'synthetic-password-123' } }); expect(response.status()).toBe(201); const user = await response.json(); const id = randomUUID(); await db.run('INSERT INTO classes(id,user_id,name,color) VALUES(?,?,?,?)', [id, user.id, name, '#0f766e']); await migrate(db, 'sqlite');
    const page = await context.newPage(); await page.goto('/'); await tab(page, 'classes');
    for (const [width, height] of widths) {
      await page.setViewportSize({ width, height }); results.push({ ...await layout(page), nameLength: name.length }); await expect(page.locator('.grow b')).toHaveText(name); const remove = page.getByRole('button', { name: `Delete ${name}`, exact: true });
      page.once('dialog', dialog => dialog.dismiss()); await remove.click();
      if (width === 320) { await page.screenshot({ path: info.outputPath('legacy-320.png') }); await remove.focus(); page.once('dialog', dialog => dialog.dismiss()); await page.keyboard.press('Enter'); }
      expect((await db.get('SELECT name FROM classes WHERE id=?', [id]))?.name).toBe(name);
    }
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: `Delete ${name}`, exact: true }).click(); await expect.poll(async () => (await (await context.request.get('/api/classes')).json()).length).toBe(0);
    writeFileSync(info.outputPath('legacy-layout.json'), JSON.stringify(results, null, 2));
  } finally { await context.close(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});

test('records browser zoom support separately from reflow-equivalent viewports', async ({ page }, info) => {
  await page.setViewportSize({ width: 1366, height: 768 }); await layoutFixture(page);
  const metrics = () => page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport!.scale }));
  const before = await metrics(); for (let i = 0; i < 5; i++) await page.keyboard.press('Control++'); const attempt200 = await metrics(); await page.keyboard.press('Control+0'); for (let i = 0; i < 8; i++) await page.keyboard.press('Control++'); const attempt400 = await metrics(); await page.keyboard.press('Control+0');
  const results = [];
  for (const [width, height] of [[683, 384], [341, 192]]) { await page.setViewportSize({ width, height }); for (const view of ['dash', 'classes', 'tasks', 'timetable', 'progress', 'profile']) { await tab(page, view); results.push({ view, ...await layout(page) }); } }
  writeFileSync(info.outputPath('zoom-and-reflow.json'), JSON.stringify({ before, attempt200, attempt400, actual200Verified: Math.abs(attempt200.dpr / before.dpr - 2) < .05 && Math.abs(before.width / attempt200.width - 2) < .05, actual400Verified: Math.abs(attempt400.dpr / before.dpr - 4) < .05 && Math.abs(before.width / attempt400.width - 4) < .05, viewportApproximations: results }, null, 2));
});
