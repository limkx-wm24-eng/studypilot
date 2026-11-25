import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';

export default function ResetPassword({ token, online, onSuccess, onClose }: { token: string | null; online: boolean; onSuccess: () => void; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || !token) return;
    setError('');
    if (password !== confirmation) { setError('Passwords do not match.'); return; }
    pending.current = true; setBusy(true);
    try {
      await api.post('/api/auth/reset', { token, newPassword: password });
      if (alive.current) { setPassword(''); setConfirmation(''); onSuccess(); }
    } catch (failure) { if (alive.current) setError((failure as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <main className="auth"><h1>StudyPilot</h1>
    {token ? <><h2>Choose a new password</h2>
      <p>This link resets the account it was issued for, regardless of who is signed in.</p>
      {!online && <p role="status">You are offline. Password reset needs a connection.</p>}
      <form className="stack" onSubmit={submit}><fieldset className="app-content stack" disabled={!online || busy} aria-busy={busy}>
        <label>New password<input type="password" required minLength={8} maxLength={72} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label>Confirm new password<input type="password" required minLength={8} maxLength={72} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button className="btn">Reset password</button>
      </fieldset></form>
      {error && <p className="bad" role="alert">{error}</p>}
      <button className="link" disabled={busy} onClick={onClose}>Cancel password reset</button>
    </> : <><p role="status">Password updated.</p><button className="link" onClick={onClose}>Continue to StudyPilot</button></>}
  </main>;
}
