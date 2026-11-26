import { expect, type Page } from '@playwright/test';

export const widths = [[320, 568], [375, 667], [390, 844], [768, 1024], [1024, 768], [1280, 720], [1366, 768], [1920, 1080]];
export const names = ['L'.repeat(60), ('Synthetic class with ordinary spaces '.repeat(2)).slice(0, 59) + 'Z', '📚'.repeat(60), '课程'.repeat(30)];
export const taskName = 'Task ' + 'T'.repeat(55);
export async function layoutFixture(page: Page) {
  await page.clock.setFixedTime(new Date('2026-11-25T12:00:00+08:00'));
  expect((await page.request.post('/api/auth/register', { data: { email: `layout-${crypto.randomUUID()}@example.test`, name: 'S'.repeat(40), password: 'synthetic-password-123' } })).status()).toBe(201);
  await page.request.patch('/api/auth/me', { data: { courseType: 'Degree', semesterStart: '2026-11-02', semesterWeeks: 7, programme: 'P'.repeat(60), reminderDays: 0 } });
  const classes = [];
  for (const name of names) { const response = await page.request.post('/api/classes', { data: { name, color: '#0f766e' } }); expect(response.status()).toBe(201); classes.push(await response.json()); }
  const tasks = [];
  for (const [i, type] of ['Assignment', 'Homework', 'Exam', 'Project', 'Others'].entries()) {
    const response = await page.request.post('/api/tasks', { data: { classId: classes[i % classes.length].id, name: i === 0 ? taskName : `Synthetic ${type}`, type, priority: 'Medium', status: 'Not started', due: i === 1 ? '2026-11-24' : i === 2 ? '2026-11-29' : '2026-11-25', grade: null } }); expect(response.status()).toBe(201); tasks.push(await response.json());
  }
  for (const [i, kind] of ['Lecture', 'Tutorial', 'Practical'].entries()) expect((await page.request.post('/api/slots', { data: { classId: classes[i].id, kind, weekday: [1, 3, 5][i], start: '08:00', end: '09:00', room: 'R'.repeat(30) } })).status()).toBe(201);
  expect((await page.request.post('/api/courses', { data: { semesterLabel: 'Semester ' + 'S'.repeat(31), courseName: 'C'.repeat(80), creditHours: 3, grade: 'A' } })).status()).toBe(201);
  await page.goto('/'); await expect(page.locator('header nav')).toBeVisible();
  return { classes, tasks };
}
export async function tab(page: Page, name: string) {
  await page.locator(`header nav button[data-tab="${name}"]`).click();
  await expect(page.locator('.loading-screen')).toHaveCount(0);
  if (name === 'timetable') await expect(page.getByText('Loading attendance...', { exact: true })).toHaveCount(0);
}
export async function layout(page: Page) {
  const result = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, regions: [...document.querySelectorAll('.tw,.calendar-scroll')].map(element => ({ name: element.className, client: element.clientWidth, scroll: element.scrollWidth })), outside: [...document.querySelectorAll('main .grow,main .grade,main input,main select,main button,main textarea')].filter(e => e.getClientRects().length && !e.closest('.tw,.calendar-scroll')).map(e => ({ tag: e.tagName, rect: e.getBoundingClientRect().toJSON() })).filter(e => e.rect.left < -.5 || e.rect.right > innerWidth + .5) }));
  expect(result.document).toBe(result.viewport); expect(result.outside).toEqual([]);
  return result;
}
