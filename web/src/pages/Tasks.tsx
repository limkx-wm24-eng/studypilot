import { useMemo, useState } from 'react';
import { PRIORITIES, TYPES, STATUSES, type Task } from '../api';
import type { Store } from '../store';
import { dueText, daysLeft } from '../util';
import EmptyState from '../EmptyState';
import { addDays, addMonths, daysInMonth, formatDateOnly, monthStart, weekday } from '../dateOnly';
import { usePeriodSelection } from '../usePeriodSelection';

type Props = Pick<Store, 'classes' | 'tasks' | 'addTask' | 'patchTask' | 'removeTask' | 'isPending'> & { today: string };
type View = 'list' | 'calendar';
const weekdaysMonday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const weekdaysSunday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Tasks({ classes, tasks, addTask, patchTask, removeTask, isPending, today }: Props) {
  const [form, setForm] = useState({ classId: '', type: 'Assignment' as Task['type'], name: '', priority: 'Medium' as Task['priority'], due: '' });
  const [filter, setFilter] = useState('All');
  const [view, setView] = useState<View>('list');
  if (!classes.length) return <EmptyState>Add a class first, then come back to add tasks.</EmptyState>;
  const classId = form.classId || classes[0].id;
  const shown = tasks.filter((task) => filter === 'All' || task.type === filter).sort((a, b) => a.due.localeCompare(b.due));

  return (
    <>
      <p className="hint">Add assignments, homework, exams and projects. Change a status or enter a grade right in the table.</p>
      <details className="add-task-card">
      <summary>+ Add task</summary>
      <form className="row" onSubmit={async (event) => { event.preventDefault(); if (await addTask({ ...form, classId })) setForm({ ...form, name: '', due: '' }); }}>
        <fieldset className="app-content row" disabled={isPending('addTask')} aria-busy={isPending('addTask')}>
        <label>Class<select value={classId} onChange={(event) => setForm({ ...form, classId: event.target.value })}>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Type<select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as Task['type'] })}>{TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
        <label>Task name<input value={form.name} required maxLength={60} placeholder="e.g. Assignment 2" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Priority<select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as Task['priority'] })}>{PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
        <label>Due date<input type="date" required value={form.due} onChange={(event) => setForm({ ...form, due: event.target.value })} /></label>
        <button className="btn">Add task</button>
        </fieldset>
      </form>
      </details>

      <div className="row task-controls">
        <label>Show type<select value={filter} onChange={(event) => setFilter(event.target.value)}>{['All', ...TYPES].map((type) => <option key={type}>{type}</option>)}</select></label>
        <div className="seg" aria-label="Task view">
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
          <button aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>Calendar</button>
        </div>
      </div>
      {view === 'calendar'
        ? <TaskCalendar tasks={shown} patchTask={patchTask} today={today} isPending={isPending} />
        : <TaskTable classes={classes} tasks={shown} patchTask={patchTask} removeTask={removeTask} today={today} />}
    </>
  );
}

function TaskTable({ classes, tasks, patchTask, removeTask, today }: Pick<Props, 'classes' | 'patchTask' | 'removeTask' | 'today'> & { tasks: Task[] }) {
  if (!tasks.length) return <EmptyState>No tasks yet. Add one above.</EmptyState>;
  return <div className="tw"><table><thead><tr><th>Task</th><th>Type</th><th>Priority</th><th>Due</th><th>Days left</th><th>Status</th><th>Grade %</th><th /></tr></thead><tbody>
    {tasks.map((task) => {
      const klass = classes.find((item) => item.id === task.classId);
      return <tr key={task.id}><td data-label="Task"><b>{task.name}</b><br /><span className="mut"><i className="dot" style={{ background: klass?.color }} />{klass?.name}</span></td><td data-label="Type"><span className={`chip t-${task.type}`}>{task.type}</span></td><td data-label="Priority">{task.priority}</td><td data-label="Due">{task.due}</td><td data-label="Days left" className={task.status !== 'Complete' && daysLeft(task.due, today) < 0 ? 'bad' : ''}>{task.status === 'Complete' ? 'Done' : dueText(task.due, today)}</td><td data-label="Status"><select value={task.status} aria-label={`Status of ${task.name}`} onChange={(event) => patchTask(task.id, { status: event.target.value as Task['status'] })}>{STATUSES.map((status) => <option key={status}>{status}</option>)}</select></td><td data-label="Grade %"><input className="n" type="number" min={0} max={100} aria-label={`Grade for ${task.name}`} key={`${task.id}-${task.grade}`} defaultValue={task.grade ?? ''} onBlur={(event) => { const grade = event.target.value === '' ? null : Number(event.target.value); if (grade !== task.grade) patchTask(task.id, { grade }); }} /></td><td data-label="Actions"><button className="x" aria-label={`Delete ${task.name}`} onClick={() => removeTask(task.id)}>Delete</button></td></tr>;
    })}
  </tbody></table></div>;
}

function TaskCalendar({ tasks, patchTask, today, isPending }: Pick<Props, 'patchTask' | 'today' | 'isPending'> & { tasks: Task[] }) {
  const selection = usePeriodSelection<HTMLElement>(monthStart(today), isPending('addTask') || tasks.some(task => isPending(`task:${task.id}`)));
  const month = selection.value;
  const [sundayFirst, setSundayFirst] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const dates = useMemo(() => new Map(tasks.map((task) => [task.due, tasks.filter((item) => item.due === task.due)])), [tasks]);
  const firstOffset = sundayFirst ? weekday(month) : (weekday(month) + 6) % 7;
  const days = daysInMonth(month);
  const cells = Array.from({ length: Math.ceil((firstOffset + days) / 7) * 7 }, (_, index) => index - firstOffset + 1);
  const labels = sundayFirst ? weekdaysSunday : weekdaysMonday;
  const move = (delta: number) => selection.select(addMonths(month, delta));

  return <section className="calendar" aria-label="Task deadline calendar" ref={selection.scope} onFocusCapture={selection.onFocusCapture} onBlurCapture={selection.onBlurCapture}>
    <div className="calendar-head"><div><button className="btn ghost" aria-label="Previous month" onClick={() => move(-1)}>Previous</button><button className="btn ghost" aria-label="This month" onClick={() => selection.select(monthStart(today))}>This month</button><button className="btn ghost" aria-label="Next month" onClick={() => move(1)}>Next</button></div><h2 aria-live="polite">{formatDateOnly(month, { month: 'long', year: 'numeric' })}</h2><label className="calendar-option"><input type="checkbox" checked={sundayFirst} onChange={(event) => setSundayFirst(event.target.checked)} /> Sunday first</label></div>
    <div className="calendar-scroll" role="region" aria-label="Calendar dates" tabIndex={0}>
    <table className="calendar-table" aria-label={`${formatDateOnly(month, { month: 'long', year: 'numeric' })} deadlines`}>
      <thead><tr>{labels.map((label) => <th className="calendar-weekday" scope="col" id={`calendar-weekday-${label}`} key={label}>{label}</th>)}</tr></thead>
      <tbody>{Array.from({ length: cells.length / 7 }, (_, week) => <tr key={week}>{cells.slice(week * 7, week * 7 + 7).map((day, column) => {
        const index = week * 7 + column;
        const headers = `calendar-weekday-${labels[column]}`;
        if (day < 1 || day > days) return <td className="calendar-day empty" headers={headers} key={`empty-${index}`} />;
        const key = addDays(month, day - 1);
        const dayTasks = dates.get(key) ?? [];
        const shown = expanded.includes(key) ? dayTasks : dayTasks.slice(0, 3);
        const weekend = [0, 6].includes(weekday(key));
        return <td className={`calendar-day ${key === today ? 'today' : ''} ${weekend ? 'weekend' : ''}`} headers={headers} aria-label={`${key}, ${dayTasks.length} tasks`} key={key}><b>{day}</b><div className="calendar-chips">{shown.map((task) => <button className={`calendar-chip t-${task.type}`} key={task.id} onClick={() => patchTask(task.id, { status: task.status === 'Complete' ? 'Not started' : 'Complete' })} aria-label={`${task.name}, ${task.type}, due ${task.due}. ${task.status === 'Complete' ? 'Mark not started' : 'Mark complete'}`}>{task.name}</button>)}</div>{dayTasks.length > shown.length && <button className="more" aria-label={`Show ${dayTasks.length - shown.length} more tasks on ${key}`} onClick={() => setExpanded([...expanded, key])}>+{dayTasks.length - shown.length} more</button>}</td>;
      })}</tr>)}</tbody>
    </table>
    </div>
  </section>;
}
