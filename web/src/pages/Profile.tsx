import { useState, type FormEvent } from 'react';
import { api, COURSE_TYPES, type User } from '../api';

type Permission = NotificationPermission | 'unsupported';
export default function Profile({ user, setUser, permission, requestNotifications }: { user: User; setUser: (u: User | null) => void; permission: Permission; requestNotifications: () => Promise<void> }) {
  const [form, setForm] = useState({ name: user.name, courseType: user.courseType, programme: user.programme, reminderDays: user.reminderDays });
  const [msg, setMsg] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailStatus, setEmailStatus] = useState('');
  const [confirming, setConfirming] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try { setUser(await api.patch<User>('/api/auth/me', form)); setMsg('Profile saved.'); }
    catch (error) { setMsg((error as Error).message); }
  };
  const leave = async (fn: () => Promise<void>) => { try { await fn(); setUser(null); } catch (error) { setMsg((error as Error).message); } };
  const changeEmail = async (event: FormEvent) => {
    event.preventDefault();
    setEmailError('');
    setEmailStatus('');
    try {
      setUser(await api.patch<User>('/api/auth/email', { newEmail, password: currentPassword }));
      setNewEmail('');
      setEmailStatus('Account email updated.');
    } catch (error) {
      setEmailError((error as Error).message);
    } finally {
      setCurrentPassword('');
    }
  };
  return <><p className="hint">Signed in as {user.email}. Your course type will be used by the attendance log.</p><form className="row" onSubmit={save}>
    <label>Your name<input value={form.name} maxLength={40} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
    <label>Course type<select value={form.courseType} onChange={(event) => setForm({ ...form, courseType: event.target.value })}><option value="">Select</option>{COURSE_TYPES.map((course) => <option key={course}>{course}</option>)}</select></label>
    <label>Programme (optional)<input value={form.programme} maxLength={60} placeholder="e.g. Bachelor of Software Engineering" onChange={(event) => setForm({ ...form, programme: event.target.value })} /></label>
    <label>Remind me<select value={form.reminderDays} onChange={(event) => setForm({ ...form, reminderDays: Number(event.target.value) })}><option value={0}>On the due date</option><option value={1}>1 day before</option><option value={2}>2 days before</option><option value={3}>3 days before</option><option value={7}>7 days before</option></select></label>
    <button className="btn">Save profile</button>
  </form>{msg && <p role="status">{msg}</p>}
  <section className="notification-setting">
    <h2>Account email</h2>
    <p>Current email: <b>{user.email}</b></p>
    <form className="row account-email-form" onSubmit={changeEmail}>
      <label>New email<input type="email" autoComplete="email" required value={newEmail} onChange={(event) => setNewEmail(event.target.value)} /></label>
      <label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
      <button className="btn">Change email</button>
    </form>
    {emailError && <p className="bad" role="alert">{emailError}</p>}
    {emailStatus && <p role="status">{emailStatus}</p>}
  </section>
  <section className="notification-setting"><h2>Browser reminders</h2><p className="hint">Reminders need HTTPS and an open StudyPilot tab. They are shown once per task each day and are never sent by email.</p>{permission === 'unsupported' ? <p className="mut">This browser does not support notifications.</p> : permission === 'granted' ? <p role="status">Browser reminders are on.</p> : <button className="btn ghost" onClick={requestNotifications}>{permission === 'denied' ? 'Notifications blocked in browser settings' : 'Turn on browser reminders'}</button>}</section>
  <h2 style={{ marginTop: 28 }}>Account</h2><p><button className="btn ghost" onClick={() => leave(() => api.post<void>('/api/auth/logout'))}>Log out</button></p>
  {confirming ? <div className="banner" role="alertdialog" aria-label="Confirm account deletion"><span><strong>Delete your account?</strong> This permanently deletes your profile, classes and tasks. It cannot be undone.</span><button className="btn danger" onClick={() => leave(() => api.del('/api/auth/me'))}>Yes, delete everything</button><button className="btn ghost" onClick={() => setConfirming(false)}>Cancel</button></div> : <button className="btn ghost" onClick={() => setConfirming(true)}>Delete my account</button>}</>;
}
