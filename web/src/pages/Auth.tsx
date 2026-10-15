import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { api, type User } from '../api';

type View = 'login' | 'register' | 'forgot';

export default function Auth({ onUser, online }: { onUser: (u: User) => void; online: boolean }) {
  const [view, setView] = useState<View>('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get('reset'));
  const [resetComplete, setResetComplete] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('reset')) {
      url.searchParams.delete('reset');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const login = view === 'login';
      const body = login ? { email: form.email, password: form.password, rememberMe } : form;
      onUser(await api.post<User>(`/api/auth/${view}`, body));
    } catch (err) { setError((err as Error).message); }
  };

  const requestReset = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await api.post('/api/auth/forgot', { email: forgotEmail });
      setForgotSent(true);
    } catch (err) { setError((err as Error).message); }
  };

  const submitReset = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    try {
      await api.post('/api/auth/reset', { token: resetToken, newPassword });
      setNewPassword('');
      setConfirmPassword('');
      setResetToken(null);
      setResetComplete(true);
    } catch (err) { setError((err as Error).message); }
  };

  const login = view === 'login';
  return (
    <main className="auth-layout">
      <section className="auth-brand" aria-label="About StudyPilot">
        <span className="logo-mark logo-mark-large" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M7 6.5h18v19H7z" /><path d="M11 11h10M11 15h10M11 19h7" /></svg></span>
        <p className="auth-brand-name">StudyPilot</p>
        <h2>Plan your semester. Never miss a deadline or a class.</h2>
        <ul><li>Keep classes and deadlines together</li><li>Stay on top of your weekly timetable</li><li>Track grades and attendance</li></ul>
      </section>
      <section className="auth auth-card">
      <h1>StudyPilot</h1>
      {!online && <p className="offline-banner" role="status">You are offline. Log in and account changes need a connection.</p>}
      {resetToken ? <>
        <h2>Choose a new password</h2>
        <fieldset className="app-content" disabled={!online}><form className="stack" onSubmit={submitReset}>
          <label>New password<input type="password" required minLength={8} maxLength={72} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label>Confirm new password<input type="password" required minLength={8} maxLength={72} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
          {error && <p className="bad" role="alert">{error}</p>}
          <button className="btn">Reset password</button>
        </form></fieldset>
      </> : resetComplete ? <>
        <p role="status">Password updated.</p>
        <button className="link" onClick={() => { setResetComplete(false); setView('login'); }}>Log in</button>
      </> : view === 'forgot' ? <>
        <p className="hint">Enter the email address for your account.</p>
        {forgotSent ? <p role="status">If an account exists for that email, we sent a reset link.</p> : <fieldset className="app-content" disabled={!online}><form className="stack" onSubmit={requestReset}>
          <label>Email<input type="email" required autoComplete="email" value={forgotEmail} onChange={(event) => setForgotEmail(event.target.value)} /></label>
          {error && <p className="bad" role="alert">{error}</p>}
          <button className="btn">Send reset link</button>
        </form></fieldset>}
        <button className="link" onClick={() => { setView('login'); setError(''); setForgotSent(false); }}>Back to log in</button>
      </> : <>
        <p className="hint">{login ? 'Log in to see your classes and deadlines.' : 'Create an account to start planning.'}</p>
        <fieldset className="app-content" disabled={!online}><form className="stack" onSubmit={submit}>
          {!login && <label>Name<input value={form.name} onChange={set('name')} maxLength={40} /></label>}
          <label>Email<input type="email" required value={form.email} onChange={set('email')} autoComplete="email" /></label>
          <label>Password
            <input type="password" required minLength={8} value={form.password} onChange={set('password')} autoComplete={login ? 'current-password' : 'new-password'} />
          </label>
          {login && <label className="remember-me"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />Remember me</label>}
          {error && <p className="bad" role="alert">{error}</p>}
          <button className="btn">{login ? 'Log in' : 'Create account'}</button>
        </form></fieldset>
        {login && <p><button className="link" disabled={!online} onClick={() => { setForgotEmail(form.email); setView('forgot'); setError(''); }}>Forgot password?</button></p>}
        <p className="mut">
          {login ? 'New here? ' : 'Already have an account? '}
          <button className="link" disabled={!online} onClick={() => { setView(login ? 'register' : 'login'); setRememberMe(false); setError(''); }}>
            {login ? 'Create an account' : 'Log in'}
          </button>
        </p>
      </>}
      </section>
    </main>
  );
}
