// Regenerates the two sample PDFs from their synthetic HTML using the same engine as
// Chrome's "Save as PDF" (so the PDFs have a real text layer).
// Usage (from the repo root): node scripts/make-fixture-pdf.mjs
// Uses playwright-core (or change the import to '@playwright/test').
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const dir = 'web/src/import/fixtures';
const jobs = [
  { html: 'sample-timetable.html', pdf: 'sample-timetable.pdf', format: 'A4' },
  { html: 'sample-timetable-narrow.html', pdf: 'sample-timetable-narrow.pdf', format: 'Letter' },
];
const exe = process.env.CHROMIUM_PATH || undefined;

const browser = await chromium.launch(exe ? { executablePath: exe } : {});
for (const j of jobs) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(resolve(dir, j.html)).href);
  await page.pdf({
    path: resolve(dir, j.pdf),
    format: j.format,
    margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
  });
  console.log('wrote', `${dir}/${j.pdf}`);
  await page.close();
}
await browser.close();
