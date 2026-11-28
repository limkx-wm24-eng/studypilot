import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, COURSE_TYPES, type User } from '../api';
import { useEmailAvailability } from '../emailAvailability';
import type { UpdateUser } from '../useUserSession';

const fields = (user: User) => ({ name: user.name, courseType: user.courseType, programme: user.programme, reminderDays: user.reminderDays });
// The shell owns this editor so drafts and pending feedback survive tab changes.
// Password/email form state still belongs to the Profile page itself.
export function useProfileEditor(user: User, updateUser: UpdateUser) {
  const [form, setForm] = useState(() => fields(user));
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const previous = useRef(fields(user));
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const next = fields(user), old = previous.current;
    setForm((draft) => ({
      name: draft.name === old.name ? next.name : draft.name,
      courseType: draft.courseType === old.courseType ? next.courseType : draft.courseType,
      programme: draft.programme === old.programme ? next.programme : draft.programme,
      reminderDays: draft.reminderDays === old.reminderDays ? next.reminderDays : draft.reminderDays,
    }));
    previous.current = next;
  }, [user.name, user.courseType, user.programme, user.reminderDays]);
  useEffect(() => {
    if (msg !== 'Profile saved.') return;
    const timer = window.setTimeout(() => setMsg(''), 2600);
    return () => window.clearTimeout(timer);
  }, [msg]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setSaving(true); setMsg('');
    try {
      const next = await updateUser(form, 'profile');
      if (alive.current) { previous.current = fields(next); setForm(fields(next)); setMsg('Profile saved.'); }
    } catch (error) { if (alive.current) setMsg((error as Error).message); }
    finally { pending.current = false; if (alive.current) setSaving(false); }
  };
  return { form, setForm, msg, save, saving };
}

type Permission = NotificationPermission | 'unsupported';
export default function Profile({ user, editor, setUser, permission, requestNotifications }: { user: User; editor: ReturnType<typeof useProfileEditor>; setUser: () => void; permission: Permission; requestNotifications: () => Promise<void> }) {
  const { emailEnabled, notice } = useEmailAvailability();
  const { form, setForm, msg: profileMessage, save, saving } = editor;
  const [accountError, setAccountError] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailStatus, setEmailStatus] = useState('');
  const [pendingEmail, setPendingEmail] = useState(user.pendingEmail);
  const [confirming, setConfirming] = useState(false);
  const leave = async (fn: () => Promise<void>) => { try { await fn(); setUser(); } catch (error) { setAccountError((error as Error).message); } };
  const changeEmail = async (event: FormEvent) => {
    event.preventDefault();
    setEmailError('');
    setEmailStatus('');
    try {
      const result = await api.patch<{ message: string; pendingEmail: string }>('/api/auth/email', { newEmail, password: currentPassword });
      setNewEmail('');
      setPendingEmail(result.pendingEmail);
      setEmailStatus(result.message);
    } catch (error) {
      setEmailError((error as Error).message);
    } finally {
      setCurrentPassword('');
    }
  };
  return <><p className="hint">Signed in as {user.email}. Your course type will be used by the attendance log.</p><form className="row" onSubmit={save}>
    <fieldset className="app-content row" disabled={saving} aria-busy={saving}>
    <label>Your name<input value={form.name} maxLength={40} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
    <label>Course type<select value={form.courseType} onChange={(event) => setForm({ ...form, courseType: event.target.value })}><option value="">Select</option>{COURSE_TYPES.map((course) => <option key={course}>{course}</option>)}</select></label>
    <label>Programme (optional)<input value={form.programme} maxLength={60} placeholder="e.g. Bachelor of Software Engineering" onChange={(event) => setForm({ ...form, programme: event.target.value })} /></label>
    <label>Remind me<select value={form.reminderDays} onChange={(event) => setForm({ ...form, reminderDays: Number(event.target.value) })}><option value={0}>On the due date</option><option value={1}>1 day before</option><option value={2}>2 days before</option><option value={3}>3 days before</option><option value={7}>7 days before</option></select></label>
    <button className="btn">Save profile</button>
    </fieldset>
  </form>{saving ? <p role="status">Saving profile...</p> : profileMessage && <p className={profileMessage === 'Profile saved.' ? 'toast' : undefined} role="status">{profileMessage}</p>}
  {accountError && <p role="alert">{accountError}</p>}
  <section className="notification-setting">
    <h2>Account email</h2>
    <p>Current email: <b>{user.email}</b></p>
    {emailEnabled === true ? <p>Email verification: <b>{user.emailVerified ? 'Verified' : 'Not verified'}</b></p> : <p role="status">{emailEnabled === false ? 'Email verification is unavailable on this demo' : notice}</p>}
    {emailEnabled === true && pendingEmail && <p role="status">Confirmation sent to {pendingEmail}.</p>}
    {emailEnabled === false && <p>Changing email is unavailable because it requires an email confirmation.</p>}
    {emailEnabled === true && <form className="row account-email-form" onSubmit={changeEmail}>
      <label>New email<input type="email" autoComplete="email" required value={newEmail} onChange={(event) => setNewEmail(event.target.value)} /></label>
      <label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
      <button className="btn">Change email</button>
    </form>}
    {emailError && <p className="bad" role="alert">{emailError}</p>}
    {emailStatus && <p role="status">{emailStatus}</p>}
  </section>
  <section className="notification-setting"><h2>Browser reminders</h2><p className="hint">Reminders need HTTPS and an open StudyPilot tab. They are shown once per task each day and are never sent by email.</p>{permission === 'unsupported' ? <p className="mut">This browser does not support notifications.</p> : permission === 'granted' ? <p role="status">Browser reminders are on.</p> : <button className="btn ghost" onClick={requestNotifications}>{permission === 'denied' ? 'Notifications blocked in browser settings' : 'Turn on browser reminders'}</button>}</section>
  <h2 style={{ marginTop: 28 }}>Account</h2><p><button className="btn ghost" onClick={() => leave(() => api.post<void>('/api/auth/logout'))}>Log out</button></p>
  {confirming ? <div className="banner" role="alertdialog" aria-label="Confirm account deletion"><span><strong>Delete your account?</strong> This permanently deletes your profile, classes and tasks. It cannot be undone.</span><button className="btn danger" onClick={() => leave(() => api.del('/api/auth/me'))}>Yes, delete everything</button><button className="btn ghost" onClick={() => setConfirming(false)}>Cancel</button></div> : <button className="btn ghost" onClick={() => setConfirming(true)}>Delete my account</button>}</>;
}
