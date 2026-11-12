import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { findOverlaps, makeClassName, parseTimetableText, titleCase, to24h } from './timetableImport';
import { extractPdfText, pdfTextFromDocument, PdfImportError, type PdfDocLike } from './pdfText';

// All fixtures are synthetic. Never add a real timetable to this repo.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(join(here, 'fixtures', name)));

async function textOfPdf(name: string) {
  const doc = await getDocument({ data: fixture(name), verbosity: 0 }).promise;
  return pdfTextFromDocument(doc as unknown as PdfDocLike);
}

const slotLine = (day: string, t1: string, t2: string, type: string, hours: string, venue = 'B100A, Block B') =>
  `${day} , ${t1} ~ ${t2} ( ${type}: ${hours} ) ${venue} Ms Someone (Weekly)`;

const course = (code: string, title: string, ...slots: string[]) =>
  `1 90.0% (viewAttendance.jsp?crs=${code}) ${code} ${title} Course Plan (courseplan.jsp?fid=X&fcourse=${code}&fsession=202605&fcoursetype=LONG) Course Syllabus ${slots.join(' ')}`;

const rows = (r: ReturnType<typeof parseTimetableText>) =>
  r.slots.map((s) => [s.courseCode, s.kind, s.weekday, s.start, s.end, s.room]);

describe('to24h', () => {
  it('converts 12-hour times', () => {
    expect(to24h('8:00', 'AM')).toBe('08:00');
    expect(to24h('12:00', 'PM')).toBe('12:00');
    expect(to24h('12:00', 'AM')).toBe('00:00');
    expect(to24h('1:30', 'PM')).toBe('13:30');
    expect(to24h('11:59', 'pm')).toBe('23:59');
  });
});

describe('names', () => {
  it('title-cases but keeps acronyms, roman numerals and small words', () => {
    expect(titleCase('SAMPLE PROJECT II')).toBe('Sample Project II');
    expect(titleCase('INTRODUCTION TO IT')).toBe('Introduction to IT');
    expect(titleCase('DESIGN AND ANALYSIS OF ALGORITHMS')).toBe('Design and Analysis of Algorithms');
  });

  it('cuts long names to the limit with an ellipsis', () => {
    const n = makeClassName('BDEM2022', 'ADVANCED GADGET ENGINEERING AND APPLIED MEASUREMENT', 40);
    expect(n).toHaveLength(40);
    expect(n.endsWith('…')).toBe(true);
    expect(makeClassName('BDEM1011', 'SHORT TITLE', 40)).toBe('BDEM1011 Short Title');
  });
});

describe('parseTimetableText (pasted text)', () => {
  const pasted = [
    '1\t90.0% (viewAttendance.jsp?crs=BDEM1011) BDEM1011 WIDGET DESIGN FUNDAMENTALS',
    'Course Plan (courseplan.jsp?fid=1&fcourse=BDEM1011&fsession=202605&fcoursetype=LONG)',
    'Course Syllabus\tMon , 5:00 PM ~ 7:00 PM ( Lecture: 2.0 hours )',
    '( having replacement class )\tDK XYZ, DK Buildings\tDr Alpha Example (Weekly)',
    'Tue , 6:00 PM ~ 8:00 PM ( Practical: 2.0 hours )\tB100A, Block B\tMs Beta Sample (Weekly)',
    '2\t85.0% (viewAttendance.jsp?crs=BDEM2022) BDEM2022 SAMPLE PROJECT II',
    'Course Syllabus\tWed , 10:00 AM ~ 12:00 PM ( Tutorial: 2.0 hours )\tC301(A), Block C\tMr Gamma (Weekly)',
  ].join('\n');

  it('finds courses, sessions, semester and course type', () => {
    const r = parseTimetableText(pasted);
    expect(r.semesterCode).toBe('202605');
    expect(r.courseType).toBe('LONG');
    expect(r.problems).toEqual([]);
    expect(r.courses.map((c) => c.className)).toEqual([
      'BDEM1011 Widget Design Fundamentals',
      'BDEM2022 Sample Project II',
    ]);
    expect(rows(r)).toEqual([
      ['BDEM1011', 'Lecture', 1, '17:00', '19:00', 'DK XYZ'],
      ['BDEM1011', 'Practical', 2, '18:00', '20:00', 'B100A'],
      ['BDEM2022', 'Tutorial', 3, '10:00', '12:00', 'C301(A)'],
    ]);
    expect(r.slots.every((s) => s.errors.length === 0 && s.warnings.length === 0)).toBe(true);
  });
});

describe('parseTimetableText (rules)', () => {
  it('maps lab to Practical and unknown types to Lecture with a warning', () => {
    const r = parseTimetableText(
      course(
        'BDEM1011',
        'WIDGETS',
        slotLine('Mon', '8:00 AM', '10:00 AM', 'Laboratory', '2.0 hours'),
        slotLine('Tue', '8:00 AM', '10:00 AM', 'Seminar', '2.0 hours'),
      ),
    );
    expect(r.slots[0].kind).toBe('Practical');
    expect(r.slots[0].warnings).toEqual([]);
    expect(r.slots[1].kind).toBe('Lecture');
    expect(r.slots[1].warnings[0]).toMatch(/Unknown class type "Seminar"/);
  });

  it('warns when the stated duration does not match the times', () => {
    const r = parseTimetableText(
      course('BDEM1011', 'WIDGETS', slotLine('Mon', '8:00 AM', '10:00 AM', 'Lecture', '3.0 hours')),
    );
    expect(r.slots[0].warnings[0]).toMatch(/3\.0 h but the times span 2 h/);
  });

  it('blocks a session whose end is not after its start', () => {
    const r = parseTimetableText(
      course('BDEM1011', 'WIDGETS', slotLine('Mon', '10:00 AM', '8:00 AM', 'Lecture', '2.0 hours')),
    );
    expect(r.slots[0].errors).toHaveLength(1);
  });

  it('drops a session printed twice', () => {
    const one = slotLine('Mon', '8:00 AM', '10:00 AM', 'Lecture', '2.0 hours');
    expect(parseTimetableText(course('BDEM1011', 'WIDGETS', one, one)).slots).toHaveLength(1);
  });

  it('warns about overlapping sessions on both rows, using the API clash rule', () => {
    const r = parseTimetableText(
      course(
        'BDEM1011',
        'WIDGETS',
        slotLine('Mon', '8:00 AM', '10:00 AM', 'Lecture', '2.0 hours'),
        slotLine('Mon', '9:00 AM', '11:00 AM', 'Practical', '2.0 hours'),
        slotLine('Mon', '10:00 AM', '12:00 PM', 'Tutorial', '2.0 hours', 'B100B, Block B'),
      ),
    );
    expect(findOverlaps(r.slots)).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(r.slots[0].warnings.join()).toMatch(/Overlaps with BDEM1011 09:00-11:00/);
    expect(r.slots[2].warnings).toHaveLength(1);
  });

  it('does not count sessions that only touch (one ends when the next starts)', () => {
    expect(
      findOverlaps([
        { weekday: 1, start: '08:00', end: '10:00' },
        { weekday: 1, start: '10:00', end: '12:00' },
        { weekday: 2, start: '08:00', end: '10:00' },
      ]),
    ).toEqual([]);
  });

  it('keeps the session but warns when no room can be read', () => {
    const r = parseTimetableText(
      '1 (viewAttendance.jsp?crs=BDEM1011) BDEM1011 WIDGETS Course Syllabus Mon , 8:00 AM ~ 10:00 AM ( Lecture: 2.0 hours ) Dr Nobody (Weekly)',
    );
    expect(r.slots).toHaveLength(1);
    expect(r.slots[0].room).toBe('');
    expect(r.slots[0].warnings[0]).toMatch(/Room not found/);
  });

  it('does not take a code inside a URL for a course', () => {
    const r = parseTimetableText(
      course('BDEM1011', 'WIDGETS', slotLine('Mon', '8:00 AM', '9:00 AM', 'Lecture', '1.0 hour')),
    );
    expect(r.courses.map((c) => c.code)).toEqual(['BDEM1011']);
  });

  it('reports a clear problem for empty or unrelated text', () => {
    expect(parseTimetableText('').problems[0]).toMatch(/no text/i);
    expect(parseTimetableText('hello world, nothing here').problems[0]).toMatch(/No courses found/);
    expect(parseTimetableText('1 BDEM1011 WIDGETS Course Plan nothing else').problems[0]).toMatch(/no class times/);
  });
});

describe('PDF text layer (Chrome-printed synthetic sample)', () => {
  it('extracts and parses every session', async () => {
    const { text, pages } = await textOfPdf('sample-timetable.pdf');
    expect(pages).toBe(1);
    const r = parseTimetableText(text, { maxNameLength: 40 });
    expect(r.semesterCode).toBe('202605');
    expect(r.courseType).toBe('LONG');
    expect(r.problems).toEqual([]);
    expect(rows(r)).toEqual([
      ['BDEM1011', 'Lecture', 1, '17:00', '19:00', 'DK XYZ'],
      ['BDEM1011', 'Practical', 2, '18:00', '20:00', 'B100A'],
      ['BDEM2022', 'Practical', 1, '12:00', '13:00', 'B100B'],
      ['BDEM2022', 'Lecture', 3, '10:00', '12:00', 'DK 4'],
      ['BDEM2022', 'Tutorial', 6, '11:00', '12:00', 'C301(A)'],
      ['BDEM3033', 'Practical', 4, '08:00', '10:00', 'TA210'],
      ['BDEM3033', 'Lecture', 5, '13:30', '15:30', 'DK ABA'],
    ]);
    expect(r.slots.every((s) => s.errors.length === 0 && s.warnings.length === 0)).toBe(true);
    expect(r.courses.every((c) => c.className.length <= 40)).toBe(true);
    expect(r.courses[2].className).toBe('BDEM3033 Sample Project II');
  });

  it('says there is no text when the PDF is only shapes or pictures', async () => {
    await expect(textOfPdf('image-only.pdf')).rejects.toMatchObject({
      name: 'PdfImportError',
      code: 'NO_TEXT',
      message: expect.stringContaining('Save as PDF'),
    });
  });
});

describe('phone-style print (narrow columns, week grid first, project with no classes)', () => {
  it('reads every course and session, and the semester dates from the page header', async () => {
    const { text } = await textOfPdf('sample-timetable-narrow.pdf');
    const r = parseTimetableText(text, { maxNameLength: 60 });

    expect(r.problems).toEqual([]);
    expect(r.semesterCode).toBe('202609');
    expect(r.courseType).toBe('SHORT');
    expect(r.semesterStart).toBe('2026-11-02');
    expect(r.semesterEnd).toBe('2026-12-20');

    expect(r.courses.map((c) => [c.code, c.sessions, c.noClass])).toEqual([
      ['BDEM1011', 0, true],
      ['BDEM2022', 2, false],
      ['BDEM3033', 3, false],
    ]);
    expect(r.courses[0].className).toBe('BDEM1011 Sample Project I');
    expect(r.courses[1].className).toBe('BDEM2022 Advanced Gadget Engineering and Applied Measurement');

    expect(rows(r)).toEqual([
      ['BDEM2022', 'Lecture', 1, '13:00', '15:00', 'DK 4'],
      ['BDEM2022', 'Lecture', 3, '16:00', '18:00', 'DK SG 4'],
      ['BDEM3033', 'Tutorial', 2, '12:00', '13:00', 'TA244'],
      ['BDEM3033', 'Tutorial', 2, '11:00', '12:00', 'TA244'],
      ['BDEM3033', 'Practical', 4, '14:00', '15:00', 'D303A'],
    ]);
    expect(r.slots.every((s) => s.errors.length === 0 && s.warnings.length === 0)).toBe(true);
  });

  it('never lets icon-font or control characters into a class name', async () => {
    const { text } = await textOfPdf('sample-timetable-narrow.pdf');
    for (const c of parseTimetableText(text).courses) {
      expect(c.className).toMatch(/^[\x20-\x7e]+$/);
      expect(c.className).toBe(c.className.trim());
    }
    const dirty = parseTimetableText(
      course('BDEM1011', 'WIDGETS \u0000', slotLine('Mon', '8:00 AM', '9:00 AM', 'Lecture', '1.0 hour')),
    );
    expect(dirty.courses[0].className).toBe('BDEM1011 Widgets');
  });

  it('does not take the week grid ("BDEM2022 (L) DK 4 ...") for course headings', () => {
    const gridOnly =
      'My Timetable Mon 2026-11-16 BDEM2022 (L) DK 4 Dr Alpha 1:00 PM - 3:00 PM Tue 2026-11-17 BDEM3033 (T) TA244 Mr Gamma 11:00 AM - 12:00 PM';
    expect(parseTimetableText(gridOnly).problems[0]).toMatch(/No courses found/);
  });

  it('finds a project with no classes even when its title wraps and no Course Plan follows', () => {
    const t =
      '1 0% (viewAttendance.jsp?crs=BDEM1011) BDEM1011 SAMPLE PROJECT I Course Without Class ( Project/Industrial Training Class ) NIL Ms Delta (weekly) ' +
      course('BDEM2022', 'WIDGETS', slotLine('Mon', '8:00 AM', '10:00 AM', 'Lecture', '2.0 hours'));
    const r = parseTimetableText(t);
    expect(r.courses.map((c) => [c.code, c.title, c.sessions, c.noClass])).toEqual([
      ['BDEM1011', 'Sample Project I', 0, true],
      ['BDEM2022', 'Widgets', 1, false],
    ]);
    expect(r.slots.map((s) => s.courseCode)).toEqual(['BDEM2022']);
  });

  it('works without the hidden link texts, using the titles', () => {
    const t =
      'BDEM1011 WIDGETS Course Plan Mon , 8:00 AM ~ 10:00 AM ( Lecture: 2.0 hours ) DK 4, DK Buildings Dr A (Weekly) ' +
      'BDEM2022 GADGETS Course Syllabus Tue , 8:00 AM ~ 9:00 AM ( Tutorial: 1.0 hour ) TA244, Block TA Dr B (Weekly)';
    const r = parseTimetableText(t);
    expect(rows(r)).toEqual([
      ['BDEM1011', 'Lecture', 1, '08:00', '10:00', 'DK 4'],
      ['BDEM2022', 'Tutorial', 2, '08:00', '09:00', 'TA244'],
    ]);
  });

  it('works out the semester type from the header when the link text is cut off', () => {
    const header = (a: string, b: string) => `202609 Semester ( Monday, ${a} ~ Sunday, ${b} ) `;
    const body = course('BDEM1011', 'WIDGETS', slotLine('Mon', '8:00 AM', '9:00 AM', 'Lecture', '1.0 hour')).replace(
      /&fsession=\d+&fcoursetype=\w+/,
      '',
    );
    expect(parseTimetableText(header('2026-11-02', '2026-12-20') + body).courseType).toBe('SHORT');
    expect(parseTimetableText(header('2026-06-15', '2026-09-20') + body).courseType).toBe('LONG');
    expect(parseTimetableText(header('2026-06-15', '2026-07-26') + body).courseType).toBeNull();
  });
});

describe('extractPdfText guards', () => {
  it('rejects a file that is not a PDF', async () => {
    const bytes = new TextEncoder().encode('just some text, not a pdf').buffer as ArrayBuffer;
    const err = await extractPdfText(bytes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfImportError);
    expect((err as PdfImportError).code).toBe('NOT_PDF');
  });

  it('rejects a file over 10 MB', async () => {
    const err = await extractPdfText(new ArrayBuffer(10 * 1024 * 1024 + 1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfImportError);
    expect((err as PdfImportError).code).toBe('TOO_BIG');
  });
});
