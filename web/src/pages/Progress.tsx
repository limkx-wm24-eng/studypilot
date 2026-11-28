import { useEffect, useRef, useState } from 'react';
import { type Course, type User } from '../api';
import type { UpdateUser, UserUpdateSource } from '../useUserSession';
import type { Store } from '../store';
import type { Tab } from '../util';
import { CALENDAR_LABEL, SEMESTERS, currentSemester, kind, phase, teachingEnd } from '../calendar';
import { calculateCgpa, calculateGpa, neededAverage } from '../gradeCalc';
import { LETTER_GRADES, type LetterGrade } from '../gradeScale';
import { dayDifference } from '../dateOnly';
import EmptyState from '../EmptyState';
import { showToast } from '../toast';

type Props = Pick<Store, 'classes' | 'tasks' | 'summary' | 'courses' | 'addCourse' | 'patchCourse' | 'removeCourse' | 'isPending' | 'loads'> & { today: string; user: User; updateUser: UpdateUser; saving: boolean; isUserPending: (source: UserUpdateSource) => boolean; go: (t: Tab) => void };
const hrs = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;
const weekLabel = (start: string, weeks: number, today: string) => {
  if (!start) return null;
  const days = dayDifference(today, start);
  const week = Math.floor(days / 7) + 1;
  return week < 1 ? `This semester starts in ${-days} day${days === -1 ? '' : 's'}.` : week > weeks ? `The ${weeks} teaching weeks are over.` : `Week ${week} of ${weeks}.`;
};

export default function Progress({ classes, tasks, summary, courses, addCourse, patchCourse, removeCourse, isPending, loads, today, user, updateUser, saving, isUserPending, go }: Props) {
  const [targets, setTargets] = useState<Record<string, number>>({});
  const [courseForm, setCourseForm] = useState({ semesterLabel: 'Semester 1', courseName: '', creditHours: 3, grade: '' });
  const [cgpaTarget, setCgpaTarget] = useState(3.5);
  const [futureCredits, setFutureCredits] = useState(20);
  const [semesterDraft, setSemesterDraft] = useState({ semesterStart: user.semesterStart, semesterWeeks: user.semesterWeeks });
  const [settingsError, setSettingsError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSemesterDraft({ semesterStart: user.semesterStart, semesterWeeks: user.semesterWeeks }); }, [user.semesterStart, user.semesterWeeks]);
  const update = async (patch: Partial<Pick<User, 'semesterWeeks' | 'semesterStart'>>) => {
    if (isUserPending('semester')) return;
    setSettingsError('');
    try {
      await updateUser(patch, 'semester');
      if (alive.current) showToast('Attendance settings saved.');
    } catch (failure) { if (alive.current) setSettingsError((failure as Error).message); }
  };
  const unsaved = semesterDraft.semesterStart !== user.semesterStart || semesterDraft.semesterWeeks !== user.semesterWeeks;
  const cur = currentSemester(today);
  const preset = summary ? SEMESTERS.find((s) => s.start === summary.semesterStart && s.weeks === summary.weeks) : undefined;
  const cgpa = calculateCgpa(courses);
  const need = neededAverage(cgpa, cgpaTarget, futureCredits);
  const semesters = [...new Set(courses.map((course) => course.semesterLabel))];

  return (
    <>
      <h2>CGPA tracker</h2>
      <p className="hint">Uses the official TAR UMT grade points. GPA and CGPA are shown to four decimal places.</p>
      <form className="row" onSubmit={async (event) => { event.preventDefault(); if (await addCourse({ ...courseForm, creditHours: Number(courseForm.creditHours), grade: courseForm.grade ? courseForm.grade as LetterGrade : null })) setCourseForm({ ...courseForm, courseName: '' }); }}>
        <fieldset className="app-content row" disabled={isPending('addCourse')} aria-busy={isPending('addCourse')}>
        <label>Semester<input required maxLength={40} value={courseForm.semesterLabel} onChange={(event) => setCourseForm({ ...courseForm, semesterLabel: event.target.value })} /></label>
        <label>Course name<input required maxLength={80} value={courseForm.courseName} onChange={(event) => setCourseForm({ ...courseForm, courseName: event.target.value })} /></label>
        <label>Credit hours<input className="n" type="number" min={0.5} max={12} step={0.5} value={courseForm.creditHours} onChange={(event) => setCourseForm({ ...courseForm, creditHours: Number(event.target.value) })} /></label>
        <label>Grade<select value={courseForm.grade} onChange={(event) => setCourseForm({ ...courseForm, grade: event.target.value })}><option value="">Not yet</option>{LETTER_GRADES.map((grade) => <option key={grade}>{grade}</option>)}</select></label>
        <button className="btn">Add course</button>
        </fieldset>
      </form>
      <div className="stats cgpa-stats"><div><b>{cgpa.gpa?.toFixed(4) ?? '—'}</b><span>cumulative CGPA</span></div><div><b>{cgpa.credits}</b><span>graded credit hours</span></div></div>
      {semesters.map((semester) => {
        const rows = courses.filter((course) => course.semesterLabel === semester);
        const gpa = calculateGpa(rows);
        return <section className="grade" key={semester}><h3>{semester} <span className="mut">GPA {gpa.gpa?.toFixed(4) ?? '—'}</span></h3>{rows.map((course) => <div className="course-row" key={course.id}><span className="grow"><b>{course.courseName}</b><br /><span className="mut">{course.creditHours} credit hours</span></span><label className="course-grade">Grade<select value={course.grade ?? ''} aria-label={`Grade for ${course.courseName}`} onChange={(event) => patchCourse(course.id, { grade: event.target.value ? event.target.value as LetterGrade : null })}><option value="">Not yet</option>{LETTER_GRADES.map((grade) => <option key={grade}>{grade}</option>)}</select></label><button className="x" aria-label={`Delete ${course.courseName}`} onClick={() => removeCourse(course.id)}>Delete</button></div>)}</section>;
      })}
      {!courses.length && <EmptyState>Add completed courses to calculate your GPA and CGPA.</EmptyState>}
      <section className="note calculator"><h3>What do I need?</h3><div className="row"><label>Target CGPA<input className="n" type="number" min={0} max={4} step={0.0001} value={cgpaTarget} onChange={(event) => setCgpaTarget(Number(event.target.value))} /></label><label>More credit hours<input className="n" type="number" min={1} step={0.5} value={futureCredits} onChange={(event) => setFutureCredits(Number(event.target.value))} /></label></div>{need.needed === null ? <p>Add at least one graded course and future credit hours to calculate this.</p> : need.reachable ? <p>To reach {cgpaTarget.toFixed(4)}, you need an average grade point of <b>{need.needed.toFixed(4)}</b> over the next {futureCredits} credit hours.</p> : <p>Not reachable: you would need an average grade point of {need.needed.toFixed(4)} over the next {futureCredits} credit hours. The TAR UMT maximum is 4.0000.</p>}</section>

      <h2 style={{ marginTop: 32 }}>Task grades</h2>
      <p className="hint">Enter a grade (%) on your tasks to see your average per class and what you still need to hit your target. Every task counts equally.</p>
      {!classes.length && <EmptyState>Add a class and graded tasks to use this separate task-grade view.</EmptyState>}
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
      {!loads.summary.loaded ? <p role="status">Attendance summary is {loads.summary.loading ? 'loading' : 'unavailable'}. Use Retry loading if needed.</p> : !summary || summary.requiredPercent === null ? (
        <p>Choose your course type in <button className="link" onClick={() => go('profile')}>Profile</button> to see your attendance requirement.</p>
      ) : (
        <>
          {cur
            ? <p>{CALENDAR_LABEL}: today is in the <b>{cur.name}</b>, a {kind(cur)} semester. <b>{phase(cur, today)}.</b></p>
            : <p className="mut">The {CALENDAR_LABEL} has no semester running today. Set the start date yourself once the next one is published.</p>}
          <fieldset className="app-content row" disabled={saving} aria-busy={saving}>
            <label>TAR UMT semester
              <select value={preset?.start ?? ''} onChange={(e) => {
                const s = SEMESTERS.find((x) => x.start === e.target.value);
                if (s) { setSemesterDraft({ semesterWeeks: s.weeks, semesterStart: s.start }); void update({ semesterWeeks: s.weeks, semesterStart: s.start }); }
              }}>
                <option value="">Custom</option>
                {SEMESTERS.map((s) => <option key={s.start} value={s.start}>{s.name} ({kind(s)}, from {s.start})</option>)}
              </select>
            </label>
            {preset && <p>Teaching ends {teachingEnd(preset)}. Exams: {preset.exam?.join(' to ') ?? 'unknown'}. Holidays: {preset.holidays?.join(' to ') ?? 'unknown'}.</p>}
            <label>Semester type
              <select value={semesterDraft.semesterWeeks} onChange={(e) => { const semesterWeeks = Number(e.target.value); setSemesterDraft({ ...semesterDraft, semesterWeeks }); void update({ semesterWeeks }); }}>
                <option value={14}>Long semester (14 teaching weeks)</option>
                <option value={7}>Short semester (7 teaching weeks)</option>
              </select>
            </label>
            <label>Semester start date (optional)
              <input type="date" value={semesterDraft.semesterStart} onChange={(e) => setSemesterDraft({ ...semesterDraft, semesterStart: e.target.value })}
                onBlur={() => { if (semesterDraft.semesterStart !== user.semesterStart) void update(semesterDraft); }} />
            </label>
          </fieldset>
          <p role="status">{saving ? 'Saving attendance settings...' : unsaved ? 'Unsaved attendance settings.' : 'Attendance settings saved.'} Saved semester start: {user.semesterStart || 'not set'}.</p>
          {settingsError && <p className="bad" role="alert">{settingsError} <button className="link" disabled={saving} onClick={() => void update(semesterDraft)}>Retry settings</button></p>}
          <p className="mut">
            Requirement: {summary.requiredPercent}% for {user.courseType} courses. {weekLabel(summary.semesterStart, summary.weeks, today) ?? "Set the start date so only this semester's classes are counted."}
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
              <div className={`grade progress-card progress-${a.state}`} key={a.classId}>
                <i className="dot" style={{ background: k?.color }} /><b>{k?.name}</b>
                <div className="bar"><i style={{ width: `${used}%`, background: a.state === 'over' ? 'var(--bad)' : a.state === 'careful' ? 'var(--warning)' : 'var(--pri)' }} /></div>
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
