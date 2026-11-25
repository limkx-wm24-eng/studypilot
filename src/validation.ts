import { z } from 'zod';

// All stored free-text fields are single-line labels; none accepts tabs or newlines.
// Check before trimming so controls at the edges cannot silently disappear.
export const singleLineText = z.string()
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/, 'Unsupported control characters')
  .trim();

export const resourceId = z.uuid({ version: 'v4' });

export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}, 'Use a valid YYYY-MM-DD calendar date');
