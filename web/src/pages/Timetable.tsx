import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { UpdateUser } from '../useUserSession';
import { api, KINDS, type Entry, type Mark, type Slot } from '../api';
import type { Store } from '../store';
import { addDays, mondayOf } from '../dateOnly';
import { usePeriodSelection } from '../usePeriodSelection';
import EmptyState from '../EmptyState';
import { showToast } from '../toast';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MARKS: [Mark, string][] = [['present', 'Present'], ['absent', 'Absent'], ['leave', 'Leave']];
const ImportTimetable = lazy(() => import('../import/ImportTimetable'));
type Props = Pick<Store, 'classes' | 'slots' | 'addSlot' | 'removeSlot' | 'refreshSummary' | 'refreshTimetable' | 'isPending'> & { updateUser: UpdateUser; today: string };

export default function Timetable({ classes, slots, addSlot, removeSlot, refreshSummary, refreshTimetable, updateUser, isPending, today }: Props) {
  const [importing, setImporting] = useState(false);
  const importButton = useRef<HTMLButtonElement>(null);
  const wasImporting = useRef(false);
  useEffect(() => {
    if (wasImporting.current && !importing) importButton.current?.focus();
    wasImporting.current = importing;
  }, [importing]);
  const importControls = <><button ref={importButton} className="btn" onClick={() => setImporting(true)}>Import timetable</button>
    {importing && <Suspense fallback={<p role="status">Loading importer...</p>}><ImportTimetable classes={classes} slots={slots} updateUser={updateUser} refresh={refreshTimetable} onClose={() => setImporting(false)} /></Suspense>}</>;
  const [entryResult, setEntryResult] = useState<{ week: string; rows: Entry[] }>({ week: '', rows: [] });
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [reload, setReload] = useState(0);
  const [marking, setMarking] = useState<Record<string, boolean>>({});
  const marksPending = useRef(new Set<string>());
  const requestId = useRef(0);
  const alive = useRef(true);
  const selection = usePeriodSelection<HTMLDivElement>(mondayOf(today), importing || isPending('addSlot') || slots.some(slot => isPending(`slot:${slot.id}`)) || Object.values(marking).some(Boolean));
  const week = selection.value;
  const currentWeek = useRef(week);
  currentWeek.current = week;
  const entries = entryResult.week === week ? entryResult.rows : [];
  const [error, setError] = useState('');
  const [form, setForm] = useState({ classId: '', kind: 'Lecture' as Slot['kind'], weekday: 1, start: '09:00', end: '11:00', room: '' });

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; requestId.current++; };
  }, []);
  useEffect(() => {
    let current = true;
    const id = ++requestId.current;
    setLoading(true); setReadError(''); setError('');
    api.get<Entry[]>(`/api/attendance?from=${week}&to=${addDays(week, 6)}`)
      .then((rows) => { if (current && id === requestId.current) setEntryResult({ week, rows }); })
      .catch((e: Error) => { if (current && id === requestId.current) setReadError(e.message); })
      .finally(() => { if (current && id === requestId.current) setLoading(false); });
    return () => { current = false; };
  }, [week, reload]);

  if (!classes.length) return <>{importControls}<EmptyState>Import your portal timetable, or add a class first to enter class times.</EmptyState></>;
  const classId = form.classId || classes[0].id;

  // Clicking the current mark again clears it.
  const mark = async (slot: Slot, date: string, status: Mark) => {
    const key = `${slot.id}:${date}`;
    if (marksPending.current.has(key)) return;
    marksPending.current.add(key); setMarking((old) => ({ ...old, [key]: true }));
    const requestedWeek = week, id = requestId.current;
    const current = entries.find((e) => e.slotId === slot.id && e.date === date)?.status;
    const next = current === status ? null : status;
    try {
      await api.put('/api/attendance', { slotId: slot.id, date, status: next });
      if (!alive.current) return;
      if (currentWeek.current === requestedWeek) {
        if (id === requestId.current) setEntryResult((old) => ({ week: requestedWeek, rows: [...old.rows.filter((e) => !(e.slotId === slot.id && e.date === date)), ...(next ? [{ slotId: slot.id, date, status: next }] : [])] }));
        else setReload((value) => value + 1);
        setError(''); showToast('Attendance saved.');
      }
      void refreshSummary();
    } catch (e) { if (alive.current && currentWeek.current === requestedWeek && id === requestId.current) setError((e as Error).message); }
    finally { marksPending.current.delete(key); if (alive.current) setMarking((old) => ({ ...old, [key]: false })); }
  };

  return (
    <>
      {importControls}
      <p className="hint">Add your weekly class times, then mark each class as present, absent or on approved leave. Approved leave counts as attended.</p>
      {error && <p className="bad" role="alert">{error}</p>}
      {loading && <p role="status">Loading attendance...</p>}
      {readError && <p className="bad" role="alert">{readError} <button className="link" onClick={() => setReload((value) => value + 1)}>Retry attendance</button></p>}
      <div ref={selection.scope} onFocusCapture={selection.onFocusCapture} onBlurCapture={selection.onBlurCapture}>
      <div className="row">
        <button className="btn ghost" onClick={() => selection.select(addDays(week, -7))}>Previous week</button>
        <button className="btn ghost" onClick={() => selection.select(mondayOf(today))}>This week</button>
        <button className="btn ghost" onClick={() => selection.select(addDays(week, 7))}>Next week</button>
        <b>{week} to {addDays(week, 6)}</b>
      </div>
      {!slots.length && <EmptyState>No class times yet. Add your first one below.</EmptyState>}
      {DAYS.map((day, i) => {
        const todays = slots.filter((s) => s.weekday === i + 1).sort((a, b) => a.start.localeCompare(b.start));
        if (!todays.length) return null;
        const date = addDays(week, i);
        return (
          <section className="timetable-day" key={day}>
            <h3>{day} <span className="mut">{date}{date === today ? ' (today)' : ''}</span></h3>
            <div className="list">
              {todays.map((s) => {
                const c = classes.find((k) => k.id === s.classId);
                const status = entries.find((e) => e.slotId === s.id && e.date === date)?.status;
                return (
                  <div className="item" key={s.id}>
                    <i className="dot" style={{ background: c?.color }} />
                    <div className="grow">
                      <b>{c?.name}</b> <span className="chip">{s.kind}</span><br />
                      <span className="mut">{s.start} to {s.end}{s.room && `, ${s.room}`}</span>
                    </div>
                    <div className="seg" role="group" aria-label={`Attendance for ${c?.name} on ${date}`}>
                      {MARKS.map(([m, label]) => (
                        <button key={m} className={m} aria-pressed={status === m} disabled={date > today || loading || Boolean(readError) || marking[`${s.id}:${date}`]}
                          title={date > today ? 'You can log this class once the day arrives' : undefined}
                          onClick={() => mark(s, date, m)}>{label}</button>
                      ))}
                    </div>
                    <button className="x" aria-label={`Remove ${c?.name} ${s.kind} on ${day}`}
                      onClick={() => { if (confirm(`Remove ${c?.name} ${s.kind} every ${day}? Its attendance records are deleted too.`)) removeSlot(s.id); }}>✕</button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      </div>
      <h3>Add a class time</h3>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); await addSlot({ ...form, classId }); }}>
        <fieldset className="app-content row" disabled={isPending('addSlot')} aria-busy={isPending('addSlot')}>
        <label>Class
          <select value={classId} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Type
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Slot['kind'] })}>
            {KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
        </label>
        <label>Day
          <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}>
            {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
          </select>
        </label>
        <label>Start<input type="time" required value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></label>
        <label>End<input type="time" required value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
        <label>Room (optional)<input value={form.room} maxLength={30} onChange={(e) => setForm({ ...form, room: e.target.value })} /></label>
        <button className="btn">Add class time</button>
        </fieldset>
      </form>
    </>
  );
}
