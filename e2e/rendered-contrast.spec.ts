import { expect, test, type Locator } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { assertContrast, renderedContrast } from './support/rendered-contrast';
import { layoutFixture, tab } from './support/layout-fixture';

test.use({ serviceWorkers: 'block' });
for (const theme of ['light', 'dark'] as const) test(`rendered text and keyboard focus contrast in ${theme}`, async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' }); await layoutFixture(page);
  const rows: unknown[] = [];
  const settled = () => page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const text = async (name: string, locator: Locator) => { await expect(locator).toBeVisible(); await settled(); const result = await assertContrast(locator, 4.5); rows.push({ name, theme, threshold: 4.5, ...result }); return result; };
  const focus = async (name: string, locator: Locator) => {
    await page.keyboard.press('Tab'); await locator.focus(); await settled();
    const result = await assertContrast(locator, 3, true); expect(result.focusVisible).toBe(true); expect(result.outlineStyle).toBe('solid'); expect(parseFloat(result.outlineWidth)).toBeGreaterThanOrEqual(2); rows.push({ name, theme, threshold: 3, ...result }); return result;
  };
  await text('Today', page.locator('.due-chip.due-soon').filter({ hasText: /^Today$/ }).first()); await text('Upcoming', page.locator('.due-chip').filter({ hasText: 'in 4 days' }).first()); await text('Overdue', page.locator('.due-chip.overdue').first()); await text('Completed onboarding link', page.locator('.note .done .link').first()); await page.screenshot({ path: info.outputPath(`${theme}-dashboard.png`) });
  await tab(page, 'timetable'); for (const name of ['Lecture', 'Tutorial', 'Practical']) await text(name, page.locator('.timetable-day .chip').filter({ hasText: name }));
  const present = page.getByRole('button', { name: 'Present', exact: true }).first(); await present.click(); await expect(present).toHaveAttribute('aria-pressed', 'true'); await text('Selected present', present); const absent = page.getByRole('button', { name: 'Absent', exact: true }).first(); await absent.click(); await expect(absent).toHaveAttribute('aria-pressed', 'true'); await text('Selected absent', absent);
  await tab(page, 'progress'); for (const [i, p] of (await page.locator('.progress-card p').all()).entries()) await text(`Attendance status ${i}`, p);
  await tab(page, 'classes'); await focus('Class input outline', page.getByLabel('Class name', { exact: true })); await page.screenshot({ path: info.outputPath(`${theme}-focus.png`) }); const add = page.getByRole('button', { name: 'Add class', exact: true }); await focus('Button outline', add); await text('Button normal', add); await add.hover(); await text('Button hover', add); await page.mouse.down(); try { await text('Button active', add); } finally { await page.mouse.move(0, 0); await page.mouse.up(); }
  await tab(page, 'tasks'); await focus('Summary outline', page.locator('summary')); await focus('Select outline', page.getByLabel('Show type')); for (const type of ['Assignment', 'Homework', 'Exam', 'Project', 'Others']) await text(`Task ${type}`, page.locator(`tbody .t-${type}`).first());
  await page.getByRole('button', { name: 'Calendar', exact: true }).click(); for (const type of ['Assignment', 'Homework', 'Exam', 'Project', 'Others']) await text(`Calendar ${type}`, page.locator(`.calendar-chip.t-${type}`).first()); await focus('Calendar scroll outline', page.getByRole('region', { name: 'Calendar dates', exact: true }));
  const region = await renderedContrast(page.getByRole('region', { name: 'Calendar dates', exact: true }), true); const header = await renderedContrast(page.locator('.calendar-weekday').first());
  // The inset region outline also meets the threshold beside the header surface.
  const luminance = (c: number[]) => c.map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
  const a = luminance(region.foreground), b = luminance(header.background); expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toBeGreaterThanOrEqual(3);
  await tab(page, 'timetable'); const opener = page.getByRole('button', { name: 'Import timetable', exact: true }); await opener.click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('tab', { name: 'Paste text' }).click(); const source = dialog.getByLabel('Semester Timetable By Course text'); await focus('Import textarea outline', source); await source.fill('BDEM2001 SYNTHETIC CONTRAST Course Plan Tue , 10:00 AM ~ 11:00 AM ( Lecture: 1.0 hours ) SYN 1, Block B'); await dialog.getByRole('button', { name: 'Review timetable' }).click(); await focus('Import input outline', dialog.getByLabel('Class name for BDEM2001')); await focus('Import select outline', dialog.getByLabel('Type')); await focus('Import button outline', dialog.getByRole('button', { name: 'Close importer' })); await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
  await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set('verify', 'synthetic-invalid-action'); history.replaceState(null, '', url.pathname + url.search); }); await page.reload(); const link = page.getByRole('link', { name: 'Continue to StudyPilot', exact: true }); await focus('Link outline', link); await text('Link text', link); await link.click(); await expect(page.locator('header nav')).toBeVisible();
  expect(await page.locator('button').first().evaluate(e => parseFloat(getComputedStyle(e).transitionDuration))).toBeLessThanOrEqual(.001);
  writeFileSync(info.outputPath(`contrast-${theme}.json`), JSON.stringify(rows, null, 2));
});
