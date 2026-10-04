import type { Store } from '../store';
import { daysLeft, dueText, type Tab } from '../util';

type Props = Pick<Store, 'classes' | 'tasks' | 'slots'> & { name: string; go: (t: Tab) => void };

export default function Dashboard({ name, classes, tasks, slots, go }: Props) {
  const open = tasks.filter((t) => t.status !== 'Complete').sort((a, b) => a.due.localeCompare(b.due));
  const overdue = open.filter((t) => daysLeft(t.due) < 0).length;
  const thisWeek = open.filter((t) => daysLeft(t.due) >= 0 && daysLeft(t.due) <= 7).length;
  const pct = tasks.length ? Math.round(((tasks.length - open.length) / tasks.length) * 100) : 0;
  const steps: [string, boolean, Tab][] = [
    ['Add your classes', classes.length > 0, 'classes'],
    ['Add your first task', tasks.length > 0, 'tasks'],
    ['Add your class times', slots.length > 0, 'timetable'],
    ['Enter a grade to see your progress', tasks.some((t) => t.grade !== null), 'tasks'],
  ];

  return (
    <>
      {name && <h2>Hi, {name}</h2>}
      {steps.some(([, done]) => !done) && (
        <section className="note">
          <b>Getting started</b>
          <ol>
            {steps.map(([label, done, to]) => (
              <li key={label} className={done ? 'done' : ''}>
                {done ? '✓ ' : ''}<button className="link" onClick={() => go(to)}>{label}</button>
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="stats">
        <div><b>{open.length}</b><span>open tasks</span></div>
        <div><b>{thisWeek}</b><span>due in 7 days</span></div>
        <div><b className={overdue ? 'bad' : ''}>{overdue}</b><span>overdue</span></div>
        <div><b>{pct}%</b><span>completed</span></div>
      </div>
      <h2>Up next</h2>
      <div className="list">
        {open.slice(0, 6).map((t) => {
          const c = classes.find((k) => k.id === t.classId);
          return (
            <div className="item" key={t.id}>
              <i className="dot" style={{ background: c?.color }} />
              <div className="grow"><b>{t.name}</b><br /><span className="mut">{c?.name}</span></div>
              <span className={`chip t-${t.type}`}>{t.type}</span>
              <span className={daysLeft(t.due) < 0 ? 'bad' : ''}>{dueText(t.due)}</span>
            </div>
          );
        })}
        {!open.length && <p className="mut">Nothing due. Add a task in Tasks.</p>}
      </div>
    </>
  );
}
