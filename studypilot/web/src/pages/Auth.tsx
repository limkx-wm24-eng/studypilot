import { useState, type ChangeEvent, type FormEvent } from 'react';
import { api, type User } from '../api';

export default function Auth({ onUser }: { onUser: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try { onUser(await api.post<User>(`/api/auth/${mode}`, form)); }
    catch (err) { setError((err as Error).message); }
  };

  const login = mode === 'login';
  return (
    <main className="auth">
      <h1>StudyPilot</h1>
      <p className="hint">{login ? 'Log in to see your classes and deadlines.' : 'Create an account to start planning.'}</p>
      <form className="stack" onSubmit={submit}>
        {!login && <label>Name<input value={form.name} onChange={set('name')} maxLength={40} /></label>}
        <label>Email<input type="email" required value={form.email} onChange={set('email')} autoComplete="email" /></label>
        <label>Password
          <input type="password" required minLength={8} value={form.password} onChange={set('password')} autoComplete={login ? 'current-password' : 'new-password'} />
        </label>
        {error && <p className="bad" role="alert">{error}</p>}
        <button className="btn">{login ? 'Log in' : 'Create account'}</button>
      </form>
      <p className="mut">
        {login ? 'New here? ' : 'Already have an account? '}
        <button className="link" onClick={() => { setMode(login ? 'register' : 'login'); setError(''); }}>
          {login ? 'Create an account' : 'Log in'}
        </button>
      </p>
    </main>
  );
}
