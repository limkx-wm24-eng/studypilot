/**
 * Reads the text layer of a PDF in the browser. Nothing is uploaded.
 *
 * `pdfTextFromDocument` is separate from the loader so tests can run it in
 * Node with pdf.js's legacy build; `extractPdfText` is what the UI calls.
 */

export type PdfImportErrorCode = 'NOT_PDF' | 'TOO_BIG' | 'TOO_MANY_PAGES' | 'ENCRYPTED' | 'NO_TEXT' | 'UNREADABLE';

export class PdfImportError extends Error {
  readonly code: PdfImportErrorCode;
  constructor(code: PdfImportErrorCode, message: string) {
    super(message);
    this.name = 'PdfImportError';
    this.code = code;
  }
}

export interface PdfTextResult {
  text: string;
  pages: number;
}

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 20;

/** Friendly copy for each failure, shown under the file picker. */
export const PDF_ERROR_HELP: Record<PdfImportErrorCode, string> = {
  NOT_PDF: 'That file is not a PDF.',
  TOO_BIG: 'That PDF is larger than 10 MB. A timetable is usually under 1 MB.',
  TOO_MANY_PAGES: 'That PDF has more than 20 pages, so it is probably not a timetable.',
  ENCRYPTED: 'That PDF is password-protected. Save an unprotected copy and try again.',
  NO_TEXT:
    'This PDF is a picture of the page, so there is no text to read. ' +
    'Open the timetable in your browser, press Ctrl+P, choose "Save as PDF" as the printer ' +
    '(not "Microsoft Print to PDF"), then import that file. Or copy the table and paste it instead.',
  UNREADABLE: 'Could not read that PDF. Try saving it again, or paste the table text instead.',
};

interface TextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  hasEOL?: boolean;
}
interface PageLike {
  getTextContent(): Promise<{ items: unknown[] }>;
}
export interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PageLike>;
}

/**
 * Joins text items in the order the PDF draws them. Browsers print table cells
 * one after another, so each cell's text stays together. Items on the same line
 * that touch are glued (no space) so words are not split.
 */
export async function pdfTextFromDocument(doc: PdfDocLike): Promise<PdfTextResult> {
  if (doc.numPages > MAX_PDF_PAGES) {
    throw new PdfImportError('TOO_MANY_PAGES', PDF_ERROR_HELP.TOO_MANY_PAGES);
  }
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let out = '';
    let prevEnd: number | null = null;
    let prevY: number | null = null;
    for (const raw of content.items) {
      const item = raw as TextItemLike;
      if (typeof item.str !== 'string') continue;
      const x = item.transform?.[4] ?? 0;
      const y = item.transform?.[5] ?? 0;
      if (item.str === '') {
        if (item.hasEOL) out += '\n';
        continue;
      }
      const sameLine = prevY !== null && Math.abs(y - prevY) < 2;
      const touching = sameLine && prevEnd !== null && x - prevEnd < 0.8;
      if (out && !out.endsWith('\n') && !touching) out += ' ';
      out += item.str;
      prevEnd = x + (item.width ?? 0);
      prevY = y;
      if (item.hasEOL) {
        out += '\n';
        prevEnd = null;
        prevY = null;
      }
    }
    pages.push(out);
  }
  const text = pages.join('\n');
  if (text.replace(/\s/g, '').length < 20) {
    throw new PdfImportError('NO_TEXT', PDF_ERROR_HELP.NO_TEXT);
  }
  return { text, pages: doc.numPages };
}

/** Browser entry point. pdf.js is loaded on demand so it stays out of the main bundle. */
export async function extractPdfText(data: ArrayBuffer): Promise<PdfTextResult> {
  if (data.byteLength > MAX_PDF_BYTES) throw new PdfImportError('TOO_BIG', PDF_ERROR_HELP.TOO_BIG);
  const head = new TextDecoder('latin1').decode(new Uint8Array(data, 0, Math.min(1024, data.byteLength)));
  if (!head.includes('%PDF-')) throw new PdfImportError('NOT_PDF', PDF_ERROR_HELP.NOT_PDF);

  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  // Needs pdfjs-dist 4.2.67 or newer (older versions had a script-injection bug, CVE-2024-4367).
  const task = pdfjs.getDocument({ data: new Uint8Array(data) });
  try {
    const doc = await task.promise;
    return await pdfTextFromDocument(doc as unknown as PdfDocLike);
  } catch (err) {
    if (err instanceof PdfImportError) throw err;
    if ((err as { name?: string })?.name === 'PasswordException') {
      throw new PdfImportError('ENCRYPTED', PDF_ERROR_HELP.ENCRYPTED);
    }
    throw new PdfImportError('UNREADABLE', PDF_ERROR_HELP.UNREADABLE);
  } finally {
    await task.destroy();
  }
}
