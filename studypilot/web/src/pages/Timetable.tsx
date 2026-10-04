import { useEffect, useState } from 'react';
import { api, KINDS, type Entry, type Mark, type Slot } from '../api';
import type { Store } from '../store';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MARKS: [Mark, string][] = [['present', 'Present'], ['absent', 'Absent'], ['leave', 'Leave']];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));

type Props = Pick<Store, 'classes' | 'slots' | 'addSlot' | 'removeSlot' | 'refreshSummary'>;

export default function Timetable({ classes, slots, addSlot, removeSlot, refreshSummary }: Props) {
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ classId: '', kind: 'Lecture' as Slot['kind'], weekday: 1, start: '09:00', end: '11:00', room: '' });
  const today = iso(new Date());

  useEffect(() => {
    api.get<Entry[]>(`/api/attendance?from=${iso(monday)}&to=${iso(addDays(monday, 6))}`)
      .then(setEntries).catch((e: Error) => setError(e.message));
  }, [monday]);

  if (!classes.length) return <p className="hint">Add a class first, then add its class times here.</p>;
  const classId = form.classId || classes[0].id;

  // Clicking the current mark again clears it.
  const mark = async (slot: Slot, date: string, status: Mark) => {
    const current = entries.find((e) => e.slotId === slot.id && e.date === date)?.status;
    const next = current === status ? null : status;
    try {
      await api.put('/api/attendance', { slotId: slot.id, date, status: next });
      setEntries((x) => [...x.filter((e) => !(e.slotId === slot.id && e.date === date)), ...(next ? [{ slotId: slot.id, date, status: next }] : [])]);
      setError('');
      refreshSummary();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <>
      <p className="hint">Add your weekly class times, then mark each class as present, absent or on approved leave. Approved leave counts as attended.</p>
      {error && <p className="bad" role="alert">{error}</p>}
      <div className="row">
        <button className="btn ghost" onClick={() => setMonday(addDays(monday, -7))}>Previous week</button>
        <button className="btn ghost" onClick={() => setMonday(mondayOf(new Date()))}>This week</button>
        <button className="btn ghost" onClick={() => setMonday(addDays(monday, 7))}>Next week</button>
        <b>{iso(monday)} to {iso(addDays(monday, 6))}</b>
      </div>
      {!slots.length && <p className="mut">No class times yet. Add your first one below.</p>}
      {DAYS.map((day, i) => {
        const todays = slots.filter((s) => s.weekday === i + 1).sort((a, b) => a.start.localeCompare(b.start));
        if (!todays.length) return null;
        const date = iso(addDays(monday, i));
        return (
          <section key={day}>
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
                        <button key={m} className={m} aria-pressed={status === m} disabled={date > today}
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

      <h3>Add a class time</h3>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); await addSlot({ ...form, classId }); }}>
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
      </form>
    </>
  );
}
