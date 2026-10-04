import { useState, type FormEvent } from 'react';
import { api, COURSE_TYPES, type User } from '../api';

export default function Profile({ user, setUser }: { user: User; setUser: (u: User | null) => void }) {
  const [form, setForm] = useState({ name: user.name, courseType: user.courseType, programme: user.programme });
  const [msg, setMsg] = useState('');
  const [confirming, setConfirming] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try { setUser(await api.patch<User>('/api/auth/me', form)); setMsg('Profile saved.'); }
    catch (err) { setMsg((err as Error).message); }
  };
  const leave = async (fn: () => Promise<void>) => { try { await fn(); setUser(null); } catch (err) { setMsg((err as Error).message); } };

  return (
    <>
      <p className="hint">Signed in as {user.email}. Your course type will be used by the attendance log.</p>
      <form className="row" onSubmit={save}>
        <label>Your name<input value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Course type
          <select value={form.courseType} onChange={(e) => setForm({ ...form, courseType: e.target.value })}>
            <option value="">Select</option>
            {COURSE_TYPES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>Programme (optional)
          <input value={form.programme} maxLength={60} placeholder="e.g. Bachelor of Software Engineering" onChange={(e) => setForm({ ...form, programme: e.target.value })} />
        </label>
        <button className="btn">Save profile</button>
      </form>
      {msg && <p role="status">{msg}</p>}

      <h2 style={{ marginTop: 28 }}>Account</h2>
      <p><button className="btn ghost" onClick={() => leave(() => api.post<void>('/api/auth/logout'))}>Log out</button></p>
      {confirming ? (
        <div className="banner" role="alertdialog" aria-label="Confirm account deletion">
          <span><strong>Delete your account?</strong> This permanently deletes your profile, classes and tasks. It cannot be undone.</span>
          <button className="btn danger" onClick={() => leave(() => api.del('/api/auth/me'))}>Yes, delete everything</button>
          <button className="btn ghost" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : <button className="btn ghost" onClick={() => setConfirming(true)}>Delete my account</button>}
    </>
  );
}
