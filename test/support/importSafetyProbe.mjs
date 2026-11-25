import { performance } from 'node:perf_hooks';
import { parseTimetableText } from '../../web/src/import/timetableImport.ts';

const [kind, size] = process.argv.slice(2);
const bytes = Number(size) * 1024 * 1024;
let text;
if (kind === 'capitals') text = 'BDEM1001 ' + 'A'.repeat(bytes - 9);
else if (kind === 'fragments') text = 'Mon , '.repeat(Math.ceil(bytes / 6)).slice(0, bytes);
else if (kind === 'brackets') text = 'BDEM1001 SYNTHETIC Course Plan ' + '('.repeat(Math.floor(bytes / 2)) + ')'.repeat(Math.floor(bytes / 2));
else if (kind === 'overlaps') {
  text = 'BDEM1001 SYNTHETIC COURSE Course Plan ';
  for (let i = 0; i < 400; i++) {
    const hour = Math.floor(i / 60), minute = i % 60;
    text += `Mon , ${hour % 12 || 12}:${String(minute).padStart(2, '0')} AM ~ 11:59 PM ( Lecture: 1.0 hours ) SYN 1, Block B `;
  }
  text += ' '.repeat(Math.max(0, bytes - text.length));
} else {
  const parts = [];
  let length = 0;
  for (let i = 10000; length < bytes; i++) {
    const part = ` BDEM${i} SYNTHETIC COURSE Course Plan Mon , 8:00 AM ~ 10:00 AM ( Lecture: 2.0 hours ) SYN 1, Block B Dr Synthetic (Weekly)`;
    parts.push(part); length += part.length;
  }
  text = parts.join('').slice(0, bytes);
}
text = text.slice(0, bytes);
const started = performance.now();
const result = parseTimetableText(text);
console.log(JSON.stringify({ kind, mib: Number(size), characters: text.length, parseMs: performance.now() - started, peakRssMiB: process.resourceUsage().maxRSS / 1024, courses: result.courses.length, slots: result.slots.length, problems: result.problems }));
