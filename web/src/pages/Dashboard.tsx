import { useState } from 'react';
import type { Store } from '../store';
import { daysLeft, dueText, type Tab } from '../util';
import { api } from '../api';

type Props = Pick<Store, 'classes' | 'tasks' | 'slots' | 'patchTask'> & { name: string; reminderDays: number; emailVerified: boolean; go: (tab: Tab) => void };
export default function Dashboard({ name, classes, tasks, slots, patchTask, reminderDays, emailVerified, go }: Props) {
  const [verificationMessage, setVerificationMessage] = useState('');
  const [verificationError, setVerificationError] = useState('');
  const [resending, setResending] = useState(false);
  const open = tasks.filter((task) => task.status !== 'Complete').sort((a, b) => a.due.localeCompare(b.due));
  const attention = open.filter((task) => daysLeft(task.due) < 0 || daysLeft(task.due) <= reminderDays);
  const overdue = open.filter((task) => daysLeft(task.due) < 0).length;
  const thisWeek = open.filter((task) => daysLeft(task.due) >= 0 && daysLeft(task.due) <= 7).length;
  const pct = tasks.length ? Math.round(((tasks.length - open.length) / tasks.length) * 100) : 0;
  const steps: [string, boolean, Tab][] = [['Add your classes', classes.length > 0, 'classes'], ['Add your first task', tasks.length > 0, 'tasks'], ['Add your class times', slots.length > 0, 'timetable'], ['Enter a grade to see your progress', tasks.some((task) => task.grade !== null), 'tasks']];
  const taskList = (items: typeof open, done = false) => <div className="list">{items.slice(0, 6).map((task) => { const klass = classes.find((item) => item.id === task.classId); return <div className="item" key={task.id}><i className="dot" style={{ background: klass?.color }} /><div className="grow"><b>{task.name}</b><br /><span className="mut">{klass?.name}</span></div><span className={`chip t-${task.type}`}>{task.type}</span><span className={daysLeft(task.due) < 0 ? 'bad' : ''}>{dueText(task.due)}</span>{done && <button className="btn ghost small" onClick={() => patchTask(task.id, { status: 'Complete' })}>Mark done</button>}</div>; })}{!items.length && <p className="mut">Nothing needs attention right now.</p>}</div>;
  const resendVerification = async () => {
    setResending(true);
    setVerificationError('');
    setVerificationMessage('');
    try {
      const result = await api.post<{ message: string }>('/api/auth/resend-verification');
      setVerificationMessage(result.message);
    } catch (error) {
      setVerificationError((error as Error).message);
    } finally {
      setResending(false);
    }
  };
  return <>
    {name && <h2>Hi, {name}</h2>}
    {!emailVerified && <section className="offline-banner" aria-label="Email verification">
      <b>Please verify your email</b>{' '}
      <button className="link" disabled={resending} onClick={resendVerification}>{resending ? 'Sending…' : 'Resend'}</button>
      {verificationMessage && <p role="status">{verificationMessage}</p>}
      {verificationError && <p role="alert">{verificationError}</p>}
    </section>}
    {steps.some(([, done]) => !done) && <section className="note"><b>Getting started</b><ol>{steps.map(([label, done, to]) => <li key={label} className={done ? 'done' : ''}>{done ? 'Done: ' : ''}<button className="link" onClick={() => go(to)}>{label}</button></li>)}</ol></section>}
    <div className="stats"><div><b>{open.length}</b><span>open tasks</span></div><div><b>{thisWeek}</b><span>due in 7 days</span></div><div><b className={overdue ? 'bad' : ''}>{overdue}</b><span>overdue</span></div><div><b>{pct}%</b><span>completed</span></div></div>
    <h2>Needs attention</h2>{taskList(attention, true)}
    <h2 className="section-heading">Up next</h2>{taskList(open)}
  </>;
}
