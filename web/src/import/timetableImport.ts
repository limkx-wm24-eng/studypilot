/**
 * Timetable import — pure parsing, no dependencies, no DOM, no network.
 *
 * Input: plain text (from a PDF text layer or pasted by the user) of the
 * "Semester Timetable By Course" table on the TAR UMT student portal.
 * Output: classes + weekly sessions ready for a review screen.
 *
 * The parser works on the text flattened to one line, because PDF extraction
 * and copy-paste both split table cells across lines in different ways.
 */

export type SlotKind = 'Lecture' | 'Practical' | 'Tutorial';

export interface ParsedSlot {
  /** Display name for the class, e.g. "BMXX1001 Introduction to Widgets". */
  className: string;
  courseCode: string;
  kind: SlotKind;
  /** 1 = Monday ... 7 = Sunday (same as the API). */
  weekday: number;
  /** 24-hour "HH:MM". */
  start: string;
  end: string;
  room: string;
  /** Non-blocking notes for the review screen. */
  warnings: string[];
  /** Blocking problems; the row cannot be imported until fixed or removed. */
  errors: string[];
}

export interface ParsedCourse {
  code: string;
  title: string;
  className: string;
  /** How many weekly sessions were found for this course. */
  sessions: number;
  /** True for projects and training: the portal says "Course Without Class". */
  noClass: boolean;
}

export interface ParsedTimetable {
  /** e.g. "202605", read from the portal's own links; null if not present. */
  semesterCode: string | null;
  /** First and last teaching day of the semester ("YYYY-MM-DD"), from the page header; null if absent. */
  semesterStart: string | null;
  semesterEnd: string | null;
  /** "LONG" = 14 teaching weeks, "SHORT" = 7; null if not present. */
  courseType: 'LONG' | 'SHORT' | null;
  courses: ParsedCourse[];
  slots: ParsedSlot[];
  /** Whole-file problems, e.g. "no courses found". */
  problems: string[];
}

export interface ParseOptions {
  /** Longest class name the app accepts. Longer names are cut with "…". */
  maxNameLength?: number;
}

const DAY_INDEX: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};

const DAY = '(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*';
const TIME = '(\\d{1,2}:\\d{2})\\s*(AM|PM)';

/** "Mon , 5:00 PM ~ 7:00 PM ( Lecture: 2.0 hours )" */
const SLOT_RE = new RegExp(
  `\\b${DAY}\\s*,\\s*${TIME}\\s*[~\\-\\u2013]\\s*${TIME}\\s*\\(\\s*([A-Za-z ]+?)\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*hours?\\s*\\)`,
  'gi',
);

/** Text straight after a slot: optional replacement note, then "ROOM, Block X". */
const VENUE_RE =
  /^\s*(?:\(\s*having\s+replacement\s+class\s*\)\s*)?([A-Za-z0-9][A-Za-z0-9 ]{0,24}?(?:\([A-Za-z0-9]{1,4}\))?)\s*,\s*(?:Block\s+[A-Za-z0-9]+|[A-Za-z ]*Buildings?)/i;

/**
 * Where a course title stops: "Course Plan", "Course Syllabus", "Course Without Class",
 * a link in brackets, an attendance percentage, the next row number, or the first session.
 */
const TITLE_END =
  '(?=\\s+(?:Course\\s+(?:Plan|Syllabus|Without)\\b|\\(\\s*(?:courseplan|viewAttendance)|\\d{1,3}(?:\\.\\d+)?%|\\d+\\s+\\d{1,3}(?:\\.\\d+)?%)|\\s+' +
  DAY +
  '\\s*,\\s*\\d{1,2}:\\d{2}|$)';

/**
 * "BMXX1001 TITLE IN CAPITALS". The title must start with a capital letter and has no
 * brackets, so the week grid's "BMXX1001 (L) DK 4 ..." entries are not taken for headings.
 */
const COURSE_RE = new RegExp('(?<![=\\w])([A-Z]{3,5}\\d{3,5})\\s+([A-Z][^()]*?)' + TITLE_END, 'g');

/** The portal prints "(viewAttendance.jsp?crs=BMXX1001)" once at the start of every course row. */
const MARKER_RE = /crs=([A-Z]{3,5}\d{3,5})\s*\)/g;

/** "202609 Semester ( Monday, 2026-11-02 ~ Sunday, 2026-12-20 )" */
const SEMESTER_RE =
  /\b(\d{6})\s+Semester\s*\(\s*[A-Za-z]+\s*,\s*(\d{4}-\d{2}-\d{2})\s*~\s*[A-Za-z]+\s*,\s*(\d{4}-\d{2}-\d{2})\s*\)/;

interface Head {
  code: string;
  title: string;
  /** Where this course's own text begins and where its heading ends. */
  start: number;
  end: number;
}

function cleanTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function findHeads(text: string): Head[] {
  const markers = [...text.matchAll(MARKER_RE)];
  if (markers.length > 0) {
    // Row markers are the most reliable starts: every course row has one, even a
    // project with no classes, and they do not depend on how the title wraps.
    return markers.map((mk) => {
      const from = (mk.index ?? 0) + mk[0].length;
      const re = new RegExp(COURSE_RE.source, 'g');
      let title = '';
      for (const m of text.slice(from, from + 400).matchAll(re)) {
        if (m[1] === mk[1]) {
          title = cleanTitle(m[2]);
          break;
        }
      }
      return { code: mk[1], title, start: mk.index ?? 0, end: from };
    });
  }
  // No markers (for example, text copied without the link targets): use the titles.
  const heads: Head[] = [];
  for (const m of text.matchAll(COURSE_RE)) {
    const idx = m.index ?? 0;
    const title = cleanTitle(m[2]);
    if (title.length < 3) continue;
    heads.push({ code: m[1], title, start: idx, end: idx + m[0].length });
  }
  return heads;
}

const SMALL_WORDS = new Set(['and', 'of', 'to', 'in', 'for', 'the', 'on', 'a', 'an', 'with', 'at', 'by']);
const KEEP_UPPER = new Set([
  'IT', 'AI', 'UI', 'UX', 'OOP', 'SQL', 'ICT', 'HCI', 'API', 'PC', 'IOT', 'ML', 'DBMS', 'CSS', 'HTML',
  'I', 'II', 'III', 'IV', 'V', 'VI',
]);

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const bare = w.replace(/[^a-z0-9]/g, '').toUpperCase();
      if (KEEP_UPPER.has(bare)) return w.toUpperCase();
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

export function makeClassName(code: string, title: string, maxLength = 60): string {
  const full = `${code} ${titleCase(title)}`.trim();
  if (full.length <= maxLength) return full;
  return full.slice(0, Math.max(1, maxLength - 1)).trimEnd() + '…';
}

/** "5:00" + "PM" -> "17:00"; "12:00 AM" -> "00:00"; "12:30 PM" -> "12:30". */
export function to24h(hm: string, ampm: string): string {
  const [hStr, mStr] = hm.split(':');
  let h = Number(hStr) % 12;
  if (ampm.toUpperCase() === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${mStr}`;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function kindFrom(raw: string): { kind: SlotKind; warning?: string } {
  const k = raw.trim().toLowerCase();
  if (k.startsWith('lec')) return { kind: 'Lecture' };
  if (k.startsWith('tut')) return { kind: 'Tutorial' };
  if (k.startsWith('prac') || k.startsWith('lab')) return { kind: 'Practical' };
  return { kind: 'Lecture', warning: `Unknown class type "${raw.trim()}" — set to Lecture, please check.` };
}

export function flatten(text: string): string {
  // The portal puts icon-font glyphs (private-use characters, invisible in the PDF text)
  // in front of "Course Plan" and similar links; they must not end up in a class name.
  return text
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F-​-‍﻿]/g, ' ')
    .replace(/[ \s]+/g, ' ')
    .trim();
}

/** Same clash rule as the API: same weekday and start < otherEnd && end > otherStart. */
export function findOverlaps(
  slots: Pick<ParsedSlot, 'weekday' | 'start' | 'end'>[],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i];
      const b = slots[j];
      if (a.weekday === b.weekday && a.start < b.end && a.end > b.start) out.push([i, j]);
    }
  }
  return out;
}

export function parseTimetableText(raw: string, opts: ParseOptions = {}): ParsedTimetable {
  const maxName = opts.maxNameLength ?? 60;
  const text = flatten(raw);
  const result: ParsedTimetable = {
    semesterCode: null,
    semesterStart: null,
    semesterEnd: null,
    courseType: null,
    courses: [],
    slots: [],
    problems: [],
  };

  if (!text) {
    result.problems.push('There is no text to read.');
    return result;
  }

  // Long link texts wrap anywhere in a PDF ("fcoursetype=SHOR T"), so allow gaps inside them.
  const sem = text.match(/fsession=\s*(\d(?:\s?\d){5})/) ?? text.match(/\b(\d{6})\s+Semester\b/);
  if (sem) result.semesterCode = sem[1].replace(/\s/g, '');
  const ct = text.match(/fcoursetype=\s*(L\s?O\s?N\s?G|S\s?H\s?O\s?R\s?T)/i);
  if (ct) result.courseType = ct[1].replace(/\s/g, '').toUpperCase() as 'LONG' | 'SHORT';
  const range = text.match(SEMESTER_RE);
  if (range) {
    result.semesterCode ??= range[1];
    result.semesterStart = range[2];
    result.semesterEnd = range[3];
    if (!result.courseType) {
      // The header covers the teaching weeks only: 7 weeks = short semester, 14 = long.
      const weeks = Math.round(
        ((Date.parse(range[3]) - Date.parse(range[2])) / 86_400_000 + 1) / 7,
      );
      if (weeks === 7) result.courseType = 'SHORT';
      else if (weeks === 14) result.courseType = 'LONG';
    }
  }

  // 1) Find the course headings and the text that belongs to each.
  const heads = findHeads(text);

  if (heads.length === 0) {
    result.problems.push(
      'No courses found. Make sure the text comes from the "Semester Timetable By Course" table.',
    );
    return result;
  }

  const seenCourse = new Set<string>();
  const seenSlot = new Set<string>();

  heads.forEach((h, i) => {
    const className = makeClassName(h.code, h.title, maxName);
    const segEnd = i + 1 < heads.length ? heads[i + 1].start : text.length;
    const seg = text.slice(h.end, segEnd);
    if (!seenCourse.has(h.code)) {
      seenCourse.add(h.code);
      result.courses.push({
        code: h.code,
        title: titleCase(h.title),
        className,
        sessions: 0,
        noClass: /Course\s+Without\s+Class/i.test(seg),
      });
    }

    for (const m of seg.matchAll(SLOT_RE)) {
      const [whole, dayWord, sh, sap, eh, eap, typeWord, hoursStr] = m;
      const warnings: string[] = [];
      const errors: string[] = [];

      const weekday = DAY_INDEX[dayWord.slice(0, 3).toLowerCase()];
      const start = to24h(sh, sap);
      const end = to24h(eh, eap);
      const { kind, warning } = kindFrom(typeWord);
      if (warning) warnings.push(warning);

      if (end <= start) errors.push('The end time must be after the start time.');
      else {
        const span = (minutes(end) - minutes(start)) / 60;
        if (Math.abs(span - Number(hoursStr)) > 0.01) {
          warnings.push(`The portal says ${hoursStr} h but the times span ${span} h — please check.`);
        }
      }

      const after = seg.slice((m.index ?? 0) + whole.length);
      const v = after.match(VENUE_RE);
      const room = v ? v[1].replace(/\s+/g, ' ').trim().slice(0, 30) : '';
      if (!v) warnings.push('Room not found — you can type it in.');

      const key = `${h.code}|${weekday}|${start}|${end}`;
      if (seenSlot.has(key)) continue; // same session printed twice
      seenSlot.add(key);

      result.slots.push({
        className,
        courseCode: h.code,
        kind,
        weekday,
        start,
        end,
        room,
        warnings,
        errors,
      });
    }
  });

  for (const c of result.courses) {
    c.sessions = result.slots.filter((s) => s.courseCode === c.code).length;
    if (c.sessions > 0) c.noClass = false;
  }

  if (result.slots.length === 0) {
    result.problems.push('Courses were found, but no class times. Is this the right table?');
  }

  const overlaps = findOverlaps(result.slots);
  for (const [a, b] of overlaps) {
    const note = (o: ParsedSlot) => `${o.courseCode} ${o.start}-${o.end}`;
    result.slots[a].warnings.push(`Overlaps with ${note(result.slots[b])}.`);
    result.slots[b].warnings.push(`Overlaps with ${note(result.slots[a])}.`);
  }

  return result;
}
