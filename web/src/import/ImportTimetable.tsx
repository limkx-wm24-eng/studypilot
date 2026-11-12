import { useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError, KINDS, type Klass, type Slot, type User } from '../api';
import { showToast } from '../toast';
import { findOverlaps, parseTimetableText, type ParsedSlot, type ParsedTimetable } from './timetableImport';
import { extractPdfText, PDF_ERROR_HELP, PdfImportError } from './pdfText';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
type Row = ParsedSlot & { included: boolean };
type Props = { classes: Klass[]; slots: Slot[]; refresh: () => Promise<void>; onUser: (user: User) => void; onClose: () => void };
export default function ImportTimetable({ classes, slots, refresh, onUser, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState('PDF');
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedTimetable | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<string[]>([]);
  const [semester, setSemester] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [serverErrors, setServerErrors] = useState<number[]>([]);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    const element = dialog.current;
    element?.showModal();
    return () => { alive.current = false; element?.close(); };
  }, []);
  const already = (row: ParsedSlot) => slots.some((s) => classes.find((c) => c.id === s.classId)?.name.toLowerCase() === row.className.trim().toLowerCase() && s.weekday === row.weekday && s.start === row.start && s.end === row.end);
  const load = (value: string) => {
    const result = parseTimetableText(value, { maxNameLength: 60 });
    setParsed(result); setNames(Object.fromEntries(result.courses.map((c) => [c.code, c.className])));
    setRows(result.slots.map((s) => ({ ...s, included: !already(s) })));
    setProjects(result.courses.filter((c) => c.noClass).map((c) => c.code));
    setServerErrors([]); setMessage('');
  };
  const read = async (file?: File) => {
    if (!file || busy) return;
    setBusy(true); setMessage('');
    try { const result = await extractPdfText(await file.arrayBuffer()); if (alive.current) load(result.text); }
    catch (error) {
      if (!alive.current) return;
      setMessage(error instanceof PdfImportError ? PDF_ERROR_HELP[error.code] : PDF_ERROR_HELP.UNREADABLE);
      if (error instanceof PdfImportError && error.code === 'NO_TEXT') setTab('Paste text');
    } finally { if (alive.current) setBusy(false); }
  };
  const edited = rows.map((r) => ({ ...r, className: (names[r.courseCode] ?? r.className).trim() }));
  const selected = edited.map((r, i) => ({ r, i })).filter(({ r }) => r.included);
  const errors: string[][] = edited.map((r, i) => {
    const out: string[] = [];
    if (!r.className || r.className.length > 60) out.push('Class name must have 1 to 60 characters.');
    if (!KINDS.includes(r.kind)) out.push('Choose a session type.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.end) || r.end <= r.start) out.push('End must be after start, using valid times.');
    if (r.room.length > 30) out.push('Room must have at most 30 characters.');
    if (!already(r) && slots.some((s) => s.weekday === r.weekday && r.start < s.end && r.end > s.start)) out.push('Overlaps an existing session.');
    if (serverErrors.includes(i)) out.push('The server found an overlap. Edit or uncheck this row.');
    return out;
  });
  for (const [a, b] of findOverlaps(selected.map(({ r }) => r))) {
    errors[selected[a].i].push('Overlaps another selected session.'); errors[selected[b].i].push('Overlaps another selected session.');
  }
  const projectNames = projects.map((code) => (names[code] ?? '').trim());
  const classCount = new Set([...selected.map(({ r }) => r.className.toLowerCase()), ...projectNames.map((name) => name.toLowerCase())]).size;
  const invalid = selected.some(({ i }) => errors[i].length) || projectNames.some((name) => !name || name.length > 60) || selected.length > 200 || classCount > 40;
  const weeks = parsed?.courseType === 'SHORT' ? 7 : parsed?.courseType === 'LONG' ? 14 : parsed?.semesterStart && parsed.semesterEnd && (Date.parse(parsed.semesterEnd) - Date.parse(parsed.semesterStart)) / 86400000 < 60 ? 7 : 14;
  const update = (index: number, patch: Partial<Row>) => { setRows(rows.map((r, i) => i === index ? { ...r, ...patch } : r)); setServerErrors([]); };
  const confirm = async () => {
    if (invalid || busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.post<{ createdClasses: number; createdSlots: number; skipped: number }>('/api/import/timetable', {
        classes: projectNames.map((name) => ({ name })),
        slots: selected.map(({ r }) => ({ className: r.className, kind: r.kind, weekday: r.weekday, start: r.start, end: r.end, room: r.room })),
      });
      let notice = '';
      if (semester && parsed?.semesterStart) {
        try { onUser(await api.patch<User>('/api/auth/me', { semesterStart: parsed.semesterStart, semesterWeeks: weeks })); }
        catch { notice = ' Semester settings could not be saved; update them in Progress.'; }
      }
      try { await refresh(); }
      catch { notice += ' Reload the page to see your imported sessions.'; }
      showToast(`Imported ${result.createdClasses} classes and ${result.createdSlots} sessions.${notice}`);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setServerErrors(error.conflicts.flatMap((c) => [selected[c.row - 1]?.i, typeof c.with === 'number' ? selected[c.with - 1]?.i : undefined]).filter((i): i is number => i !== undefined));
      setMessage(error instanceof Error ? error.message : 'Import failed. Please try again.');
    } finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="timetable-import" aria-labelledby="import-heading" onCancel={(event) => { if (busy) event.preventDefault(); else onClose(); }} onKeyDown={(event) => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button,input,select,textarea,summary,[tabindex]'))
      .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!controls.length) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>
    <div className="row"><h2 id="import-heading">Import timetable</h2><button className="btn ghost" disabled={busy} onClick={onClose} aria-label="Close importer">Close</button></div>
    <p>Your PDF is read in this browser and never uploaded.</p>
    <details><summary>How to get a PDF that works</summary><p>Open My Timetable on the portal, press Ctrl+P, choose <b>Save as PDF</b> (not “Microsoft Print to PDF”), and save. Any week works as long as the Semester Timetable By Course table is included. Printing from a phone browser works too.</p></details>
    <p role="status" aria-live="polite">{busy ? 'Working...' : message}</p>
    {!parsed ? <>
      <div className="seg" role="tablist" aria-label="Import source">{['PDF', 'Paste text'].map((label, index) => <button key={label} id={`import-source-${index}`} role="tab" aria-selected={tab === label} aria-controls="import-source-panel" tabIndex={tab === label ? 0 : -1} disabled={busy} onClick={() => setTab(label)} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
        setTab(next === 0 ? 'PDF' : 'Paste text');
        dialog.current?.querySelector<HTMLButtonElement>(`#import-source-${next}`)?.focus();
      }}>{label}</button>)}</div>
      <div id="import-source-panel" role="tabpanel" aria-labelledby={`import-source-${tab === 'PDF' ? 0 : 1}`}>
      {tab === 'PDF' ? <div className="import-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void read(event.dataTransfer.files[0]); }}><label>Choose PDF<input type="file" accept="application/pdf,.pdf" disabled={busy} onChange={(event) => { void read(event.target.files?.[0]); event.target.value = ''; }} /></label><p>Or drag and drop a PDF here.</p></div>
        : <><label>Semester Timetable By Course text<textarea rows={8} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} /></label><button className="btn" disabled={busy || !text.trim()} onClick={() => load(text)}>Review timetable</button></>}
      </div>
    </> : <>
      <h3>Review timetable</h3><p>{parsed.courses.length} classes, {rows.length} sessions</p>
      {parsed.problems.map((p, i) => <p key={i} role="status">⚠ {p}</p>)}
      {parsed.courses.filter((c) => !c.noClass).map((course) => <section key={course.code}>
        <label>Class name for {course.code}<input maxLength={60} value={names[course.code] ?? ''} disabled={busy} onChange={(e) => { setNames({ ...names, [course.code]: e.target.value }); setServerErrors([]); }} /></label>
        {edited.map((row, i) => row.courseCode !== course.code ? null : <fieldset key={i} className="import-session" disabled={busy}>
          <legend>Session {i + 1}</legend>
          <label><input type="checkbox" checked={row.included} onChange={(e) => update(i, { included: e.target.checked })} />Include session {i + 1}</label>
          {already(row) && <p>Already in your timetable</p>}
          <div className="import-fields"><label>Type<select value={row.kind} onChange={(e) => update(i, { kind: e.target.value as Slot['kind'] })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
            <label>Day<select value={row.weekday} onChange={(e) => update(i, { weekday: Number(e.target.value) })}>{DAYS.map((d, n) => <option key={d} value={n + 1}>{d}</option>)}</select></label>
            <label>Start<input type="time" value={row.start} onChange={(e) => update(i, { start: e.target.value })} /></label>
            <label>End<input type="time" value={row.end} onChange={(e) => update(i, { end: e.target.value })} /></label>
            <label>Room<input maxLength={30} value={row.room} onChange={(e) => update(i, { room: e.target.value })} /></label></div>
          {row.warnings.filter((w) => !w.startsWith('Overlaps with ')).map((w, n) => <p key={n}>⚠ {w}</p>)}{row.included && errors[i].map((error, n) => <p key={n} className="bad">⚠ {error}</p>)}
        </fieldset>)}
      </section>)}
      {parsed.courses.some((c) => c.noClass) && <section><h3>No weekly classes (projects, training)</h3>{parsed.courses.filter((c) => c.noClass).map((c) => <div key={c.code}>
        <label>Class name for {c.code}<input maxLength={60} value={names[c.code] ?? ''} disabled={busy} onChange={(e) => setNames({ ...names, [c.code]: e.target.value })} /></label>
        {projects.includes(c.code) && (!(names[c.code] ?? '').trim() || names[c.code].trim().length > 60) && <p className="bad">⚠ Class name must have 1 to 60 characters.</p>}
        <label><input type="checkbox" disabled={busy} checked={projects.includes(c.code)} onChange={(e) => setProjects(e.target.checked ? [...projects, c.code] : projects.filter((code) => code !== c.code))} />Create as a class</label>
      </div>)}</section>}
      {parsed.semesterStart && <label><input type="checkbox" checked={semester} disabled={busy} onChange={(e) => setSemester(e.target.checked)} />Also set my semester: {parsed.semesterStart} to {parsed.semesterEnd ?? 'unknown'}, {weeks} teaching weeks</label>}
      <p>Selected: {classCount} classes, {selected.length} sessions. Maximum 40 classes and 200 sessions.</p>
      <div className="row"><button className="btn ghost" disabled={busy} onClick={() => { setParsed(null); setMessage(''); }}>Choose again</button><button className="btn" disabled={busy || invalid || (!selected.length && !projects.length)} onClick={() => void confirm()}>Import</button></div>
    </>}
  </dialog>;
}
