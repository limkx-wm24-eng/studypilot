import { useState } from 'react';
import { PRIORITIES, TYPES, STATUSES, type Task } from '../api';
import type { Store } from '../store';
import { dueText, daysLeft } from '../util';

type Props = Pick<Store, 'classes' | 'tasks' | 'addTask' | 'patchTask' | 'removeTask'>;

export default function Tasks({ classes, tasks, addTask, patchTask, removeTask }: Props) {
  const [form, setForm] = useState({ classId: '', type: 'Assignment' as Task['type'], name: '', priority: 'Medium' as Task['priority'], due: '' });
  const [filter, setFilter] = useState('All');
  if (!classes.length) return <p className="hint">Add a class first, then come back to add tasks.</p>;

  const classId = form.classId || classes[0].id;
  const shown = tasks.filter((t) => filter === 'All' || t.type === filter).sort((a, b) => a.due.localeCompare(b.due));

  return (
    <>
      <p className="hint">Add assignments, homework, exams and projects. Change a status or enter a grade right in the table.</p>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); await addTask({ ...form, classId }); setForm({ ...form, name: '', due: '' }); }}>
        <label>Class
          <select value={classId} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Type
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Task['type'] })}>
            {TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label>Task name
          <input value={form.name} required maxLength={60} placeholder="e.g. Assignment 2" onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>Priority
          <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Task['priority'] })}>
            {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label>Due date
          <input type="date" required value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
        </label>
        <button className="btn">Add task</button>
      </form>

      <div className="row">
        <label>Show type
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {['All', ...TYPES].map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
      </div>
      <div className="tw">
        <table>
          <thead><tr><th>Task</th><th>Type</th><th>Priority</th><th>Due</th><th>Days left</th><th>Status</th><th>Grade %</th><th /></tr></thead>
          <tbody>
            {shown.map((t) => {
              const c = classes.find((k) => k.id === t.classId);
              return (
                <tr key={t.id}>
                  <td><b>{t.name}</b><br /><span className="mut"><i className="dot" style={{ background: c?.color }} />{c?.name}</span></td>
                  <td><span className={`chip t-${t.type}`}>{t.type}</span></td>
                  <td>{t.priority}</td>
                  <td>{t.due}</td>
                  <td className={t.status !== 'Complete' && daysLeft(t.due) < 0 ? 'bad' : ''}>{t.status === 'Complete' ? 'Done' : dueText(t.due)}</td>
                  <td>
                    <select value={t.status} aria-label={`Status of ${t.name}`} onChange={(e) => patchTask(t.id, { status: e.target.value as Task['status'] })}>
                      {STATUSES.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                  <td>
                    <input className="n" type="number" min={0} max={100} aria-label={`Grade for ${t.name}`}
                      key={`${t.id}-${t.grade}`} defaultValue={t.grade ?? ''}
                      onBlur={(e) => {
                        const grade = e.target.value === '' ? null : Number(e.target.value);
                        if (grade !== t.grade) patchTask(t.id, { grade });
                      }} />
                  </td>
                  <td><button className="x" aria-label={`Delete ${t.name}`} onClick={() => removeTask(t.id)}>✕</button></td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={8} className="mut">No tasks yet. Add one above.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
