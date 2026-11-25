import { expect, test } from '@playwright/test';

// One synthetic text-only page. No browser printing, external files or real timetable.
function textPdf(text: string) {
  const stream = `BT /F1 1 Tf 0 50 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 3000000 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

test('import caps: oversized paste is explained without truncation, and exactly 200,000 characters can be reviewed', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { email: `paste-cap-${Date.now()}@example.test`, password: 'synthetic-password-123' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Timetable', exact: true }).click();
  await page.getByRole('button', { name: 'Import timetable', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Paste text' }).click();
  const input = dialog.getByLabel('Semester Timetable By Course text');
  await expect(input).toHaveAttribute('maxlength', '200000');
  await input.fill('Synthetic retained input');
  await input.evaluate((element) => {
    const data = new DataTransfer(); data.setData('text/plain', 'A'.repeat(200_001));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(dialog.getByRole('status')).toContainText('at most 200,000 characters');
  await expect(input).toHaveValue('Synthetic retained input');
  const valid = 'BDEM1001 SYNTHETIC COURSE Course Plan Mon , 8:00 AM ~ 10:00 AM ( Lecture: 2.0 hours ) SYN 1, Block B';
  await input.fill(valid.padEnd(200_000, ' '));
  await dialog.getByRole('button', { name: 'Review timetable' }).click();
  await expect(dialog.getByText('1 classes, 1 sessions', { exact: true })).toBeVisible();
});

test('import caps: oversized PDF text gets the same friendly notice without uploading data', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { email: `pdf-cap-${Date.now()}@example.test`, password: 'synthetic-password-123' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Timetable', exact: true }).click();
  await page.getByRole('button', { name: 'Import timetable', exact: true }).click();
  const writes: string[] = [];
  page.on('request', (request) => { if (['POST', 'PUT', 'PATCH'].includes(request.method())) writes.push(request.url()); });
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Choose PDF').setInputFiles({ name: 'synthetic-large-text.pdf', mimeType: 'application/pdf', buffer: textPdf('A'.repeat(200_001)) });
  await expect(dialog.getByRole('status')).toContainText('at most 200,000 characters');
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});
