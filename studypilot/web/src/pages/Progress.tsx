import { useState } from 'react';
import { api, type User } from '../api';
import type { Store } from '../store';
import type { Tab } from '../util';
import { CALENDAR_LABEL, SEMESTERS, currentSemester, isoToday, kind, phase } from '../calendar';

type Props = Pick<Store, 'classes' | 'tasks' | 'summary'> & { user: User; onUser: (u: User) => void; go: (t: Tab) => void };
const hrs = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;
const weekLabel = (start: string, weeks: number) => {
  if (!start) return null;
  const now = new Date();
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(`${start}T00:00:00`).getTime()) / 864e5);
  const week = Math.floor(days / 7) + 1;
  return week < 1 ? `This semester starts in ${-days} day${days === -1 ? '' : 's'}.` : week > weeks ? `The ${weeks} teaching weeks are over.` : `Week ${week} of ${weeks}.`;
};

export default function Progress({ classes, tasks, summary, user, onUser, go }: Props) {
  const [targets, setTargets] = useState<Record<string, number>>({});
  const update = (patch: Partial<Pick<User, 'semesterWeeks' | 'semesterStart'>>) => api.patch<User>('/api/auth/me', patch).then(onUser).catch(() => {});
  const cur = currentSemester(isoToday());
  const preset = summary ? SEMESTERS.find((s) => s.start === summary.semesterStart && s.weeks === summary.weeks) : undefined;
  if (!classes.length) return <p className="hint">Add a class and some graded tasks to see your progress.</p>;

  return (
    <>
      <h2>Grades</h2>
      <p className="hint">Enter a grade (%) on your tasks to see your average per class and what you still need to hit your target. Every task counts equally.</p>
      {classes.map((c) => {
        const all = tasks.filter((t) => t.classId === c.id);
        const graded = all.filter((t) => t.grade !== null);
        const sum = graded.reduce((a, t) => a + (t.grade ?? 0), 0);
        const avg = graded.length ? sum / graded.length : null;
        const left = all.length - graded.length;
        const target = targets[c.id] ?? 80;
        const need = left ? (target * all.length - sum) / left : null;
        const s = left === 1 ? '' : 's';

        let advice = `Every task in this class has a grade, so your average is ${avg?.toFixed(1)}%.`;
        if (need !== null) {
          advice = need > 100 ? `Not reachable: even 100% on the remaining ${left} task${s} would only give ${((sum + 100 * left) / all.length).toFixed(1)}%.`
            : need <= 0 ? `Already secured: even 0% on the remaining ${left} task${s} keeps you at ${(sum / all.length).toFixed(1)}%.`
            : `To reach ${target}% you need an average of ${need.toFixed(1)}% on the remaining ${left} task${s} without a grade.`;
        }

        return (
          <div className="grade" key={c.id}>
            <i className="dot" style={{ background: c.color }} /><b>{c.name}</b>
            {avg === null ? <p className="mut">No grades yet. Enter a grade in Tasks.</p> : (
              <>
                <div><b>{avg.toFixed(1)}%</b> <span className="mut">average of {graded.length} graded task{graded.length > 1 ? 's' : ''}</span></div>
                <div className="bar"><i style={{ width: `${Math.min(avg, 100)}%` }} /></div>
                <div className="row" style={{ margin: '12px 0 0' }}>
                  <label>Target grade (%)
                    <input className="n" type="number" min={0} max={100} value={target}
                      onChange={(e) => setTargets({ ...targets, [c.id]: Math.min(100, Math.max(0, Number(e.target.value))) })} />
                  </label>
                </div>
                <p style={{ margin: '6px 0 0' }}>{advice}</p>
              </>
            )}
          </div>
        );
      })}

      <h2 style={{ marginTop: 32 }}>Attendance</h2>
      <p className="hint">Worked out from the classes you log in Timetable. Present and approved leave both count as attended.</p>
      {!summary || summary.requiredPercent === null ? (
        <p>Choose your course type in <button className="link" onClick={() => go('profile')}>Profile</button> to see your attendance requirement.</p>
      ) : (
        <>
          {cur
            ? <p>{CALENDAR_LABEL}: today is in the <b>{cur.name}</b>, a {kind(cur)} semester. <b>{phase(cur, isoToday())}.</b></p>
            : <p className="mut">The {CALENDAR_LABEL} has no semester running today. Set the start date yourself once the next one is published.</p>}
          <div className="row">
            <label>TAR UMT semester
              <select value={preset?.start ?? ''} onChange={(e) => {
                const s = SEMESTERS.find((x) => x.start === e.target.value);
                if (s) update({ semesterWeeks: s.weeks, semesterStart: s.start });
              }}>
                <option value="">Custom</option>
                {SEMESTERS.map((s) => <option key={s.start} value={s.start}>{s.name} ({kind(s)}, from {s.start})</option>)}
              </select>
            </label>
            <label>Semester type
              <select value={summary.weeks === 7 ? 7 : 14} onChange={(e) => update({ semesterWeeks: Number(e.target.value) })}>
                <option value={14}>Long semester (14 teaching weeks)</option>
                <option value={7}>Short semester (7 teaching weeks)</option>
              </select>
            </label>
            <label>Semester start date (optional)
              <input type="date" defaultValue={summary.semesterStart} key={summary.semesterStart}
                onBlur={(e) => { if (e.target.value !== summary.semesterStart) update({ semesterStart: e.target.value }); }} />
            </label>
          </div>
          <p className="mut">
            Requirement: {summary.requiredPercent}% for {user.courseType} courses. {weekLabel(summary.semesterStart, summary.weeks) ?? "Set the start date so only this semester's classes are counted."}
          </p>
          {!summary.classes.length && <p className="mut">No class times yet. Add them in <button className="link" onClick={() => go('timetable')}>Timetable</button>.</p>}
          {summary.classes.map((a) => {
            const k = classes.find((x) => x.id === a.classId);
            const rem = a.remainingHours ?? 0;
            const used = a.allowedHours ? Math.min(100, (a.absentHours / a.allowedHours) * 100) : a.absentHours > 0 ? 100 : 0;
            const msg = a.state === 'over' ? `You are ${hrs(-rem)} over the limit, so your attendance for this class may be below ${summary.requiredPercent}%. Talk to your lecturer or faculty office soon.`
              : rem === 0 ? 'No hours left to skip. Attend every remaining class.'
              : a.state === 'careful' ? `Careful: you can only miss ${hrs(rem)} more before reaching the limit.`
              : `You can still miss ${hrs(rem)} of the ${a.allowedHours} allowed.`;
            return (
              <div className="grade" key={a.classId}>
                <i className="dot" style={{ background: k?.color }} /><b>{k?.name}</b>
                <div className="bar"><i style={{ width: `${used}%`, background: a.state === 'over' ? 'var(--bad)' : undefined }} /></div>
                <p style={{ margin: '6px 0 0' }}>{msg}</p>
                <p className="mut" style={{ margin: 0 }}>
                  {a.percent === null ? 'No classes logged yet.' : `Attendance so far: ${a.percent}% from ${a.loggedHours} logged hours.`} {a.weeklyHours} hours a week, {a.totalHours} hours this semester.
                </p>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
