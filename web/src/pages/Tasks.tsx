import { useMemo, useState } from 'react';
import { PRIORITIES, TYPES, STATUSES, type Task } from '../api';
import type { Store } from '../store';
import { dueText, daysLeft } from '../util';

type Props = Pick<Store, 'classes' | 'tasks' | 'addTask' | 'patchTask' | 'removeTask'>;
type View = 'list' | 'calendar';
const weekdaysMonday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const weekdaysSunday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export default function Tasks({ classes, tasks, addTask, patchTask, removeTask }: Props) {
  const [form, setForm] = useState({ classId: '', type: 'Assignment' as Task['type'], name: '', priority: 'Medium' as Task['priority'], due: '' });
  const [filter, setFilter] = useState('All');
  const [view, setView] = useState<View>('list');
  if (!classes.length) return <p className="hint">Add a class first, then come back to add tasks.</p>;
  const classId = form.classId || classes[0].id;
  const shown = tasks.filter((task) => filter === 'All' || task.type === filter).sort((a, b) => a.due.localeCompare(b.due));

  return (
    <>
      <p className="hint">Add assignments, homework, exams and projects. Change a status or enter a grade right in the table.</p>
      <form className="row" onSubmit={async (event) => { event.preventDefault(); await addTask({ ...form, classId }); setForm({ ...form, name: '', due: '' }); }}>
        <label>Class<select value={classId} onChange={(event) => setForm({ ...form, classId: event.target.value })}>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Type<select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as Task['type'] })}>{TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
        <label>Task name<input value={form.name} required maxLength={60} placeholder="e.g. Assignment 2" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Priority<select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as Task['priority'] })}>{PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
        <label>Due date<input type="date" required value={form.due} onChange={(event) => setForm({ ...form, due: event.target.value })} /></label>
        <button className="btn">Add task</button>
      </form>

      <div className="row task-controls">
        <label>Show type<select value={filter} onChange={(event) => setFilter(event.target.value)}>{['All', ...TYPES].map((type) => <option key={type}>{type}</option>)}</select></label>
        <div className="seg" aria-label="Task view">
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
          <button aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>Calendar</button>
        </div>
      </div>
      {view === 'calendar'
        ? <TaskCalendar tasks={shown} patchTask={patchTask} />
        : <TaskTable classes={classes} tasks={shown} patchTask={patchTask} removeTask={removeTask} />}
    </>
  );
}

function TaskTable({ classes, tasks, patchTask, removeTask }: Pick<Props, 'classes' | 'patchTask' | 'removeTask'> & { tasks: Task[] }) {
  return <div className="tw"><table><thead><tr><th>Task</th><th>Type</th><th>Priority</th><th>Due</th><th>Days left</th><th>Status</th><th>Grade %</th><th /></tr></thead><tbody>
    {tasks.map((task) => {
      const klass = classes.find((item) => item.id === task.classId);
      return <tr key={task.id}><td><b>{task.name}</b><br /><span className="mut"><i className="dot" style={{ background: klass?.color }} />{klass?.name}</span></td><td><span className={`chip t-${task.type}`}>{task.type}</span></td><td>{task.priority}</td><td>{task.due}</td><td className={task.status !== 'Complete' && daysLeft(task.due) < 0 ? 'bad' : ''}>{task.status === 'Complete' ? 'Done' : dueText(task.due)}</td><td><select value={task.status} aria-label={`Status of ${task.name}`} onChange={(event) => patchTask(task.id, { status: event.target.value as Task['status'] })}>{STATUSES.map((status) => <option key={status}>{status}</option>)}</select></td><td><input className="n" type="number" min={0} max={100} aria-label={`Grade for ${task.name}`} key={`${task.id}-${task.grade}`} defaultValue={task.grade ?? ''} onBlur={(event) => { const grade = event.target.value === '' ? null : Number(event.target.value); if (grade !== task.grade) patchTask(task.id, { grade }); }} /></td><td><button className="x" aria-label={`Delete ${task.name}`} onClick={() => removeTask(task.id)}>Delete</button></td></tr>;
    })}
    {!tasks.length && <tr><td colSpan={8} className="mut">No tasks yet. Add one above.</td></tr>}
  </tbody></table></div>;
}

function TaskCalendar({ tasks, patchTask }: Pick<Props, 'patchTask'> & { tasks: Task[] }) {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [sundayFirst, setSundayFirst] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const dates = useMemo(() => new Map(tasks.map((task) => [task.due, tasks.filter((item) => item.due === task.due)])), [tasks]);
  const firstOffset = sundayFirst ? month.getDay() : (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((firstOffset + days) / 7) * 7 }, (_, index) => index - firstOffset + 1);
  const labels = sundayFirst ? weekdaysSunday : weekdaysMonday;
  const today = dateKey(new Date());
  const move = (delta: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));

  return <section className="calendar" aria-label="Task deadline calendar">
    <div className="calendar-head"><div><button className="btn ghost" aria-label="Previous month" onClick={() => move(-1)}>Previous</button><button className="btn ghost" aria-label="This month" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>This month</button><button className="btn ghost" aria-label="Next month" onClick={() => move(1)}>Next</button></div><h2 aria-live="polite">{month.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</h2><label className="calendar-option"><input type="checkbox" checked={sundayFirst} onChange={(event) => setSundayFirst(event.target.checked)} /> Sunday first</label></div>
    <div className="calendar-grid" role="grid" aria-label={`${month.toLocaleString(undefined, { month: 'long', year: 'numeric' })} deadlines`}>
      {labels.map((label) => <div className="calendar-weekday" role="columnheader" key={label}>{label}</div>)}
      {cells.map((day, index) => {
        if (day < 1 || day > days) return <div className="calendar-day empty" role="gridcell" key={`empty-${index}`} aria-hidden="true" />;
        const key = dateKey(new Date(month.getFullYear(), month.getMonth(), day));
        const dayTasks = dates.get(key) ?? [];
        const shown = expanded.includes(key) ? dayTasks : dayTasks.slice(0, 3);
        return <div className={`calendar-day ${key === today ? 'today' : ''}`} role="gridcell" aria-label={`${key}, ${dayTasks.length} tasks`} key={key}><b>{day}</b><div className="calendar-chips">{shown.map((task) => <button className={`calendar-chip t-${task.type}`} key={task.id} onClick={() => patchTask(task.id, { status: task.status === 'Complete' ? 'Not started' : 'Complete' })} aria-label={`${task.name}, ${task.type}, due ${task.due}. ${task.status === 'Complete' ? 'Mark not started' : 'Mark complete'}`}>{task.name}</button>)}</div>{dayTasks.length > shown.length && <button className="more" onClick={() => setExpanded([...expanded, key])}>+{dayTasks.length - shown.length} more</button>}</div>;
      })}
    </div>
  </section>;
}
