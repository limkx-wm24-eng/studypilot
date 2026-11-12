// Makes fixtures/image-only.pdf: a page with shapes but no text layer, like the
// output of "Microsoft Print to PDF". Used to test the "no text" message.
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const exe = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();
await page.setContent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300">
  <rect x="10" y="10" width="580" height="280" fill="none" stroke="#333"/>
  <path d="M30 60h200v20h-200z M30 110h400v20h-400z M30 160h300v20h-300z" fill="#666"/>
</svg>`);
await page.pdf({ path: resolve('web/src/import/fixtures/image-only.pdf'), format: 'A4' });
await browser.close();
console.log('wrote web/src/import/fixtures/image-only.pdf');
