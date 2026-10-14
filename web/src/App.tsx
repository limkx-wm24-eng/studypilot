import { useEffect, useState } from 'react';
import { api, type User } from './api';
import { useStore } from './store';
import { daysLeft, type Tab } from './util';
import { useDeadlineNotifications } from './notifications';
import Auth from './pages/Auth';
import Dashboard from './pages/Dashboard';
import Classes from './pages/Classes';
import Tasks from './pages/Tasks';
import Timetable from './pages/Timetable';
import Progress from './pages/Progress';
import Profile from './pages/Profile';

const TABS: [Tab, string][] = [['dash', 'Dashboard'], ['classes', 'Classes'], ['tasks', 'Tasks'], ['timetable', 'Timetable'], ['progress', 'Progress'], ['profile', 'Profile']];

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [emailAction] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const confirmEmail = params.get('confirm-email');
    const verify = params.get('verify');
    return confirmEmail ? { type: 'confirm-email' as const, token: confirmEmail } : verify ? { type: 'verify' as const, token: verify } : null;
  });
  useEffect(() => {
    if (emailAction) {
      const url = new URL(window.location.href);
      url.searchParams.delete('verify');
      url.searchParams.delete('confirm-email');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
    api.get<User>('/api/auth/me').then(setUser).catch(() => setUser(null));
    const refresh = () => setOnline(navigator.onLine);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => { window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh); };
  }, [emailAction]);
  if (emailAction) return <EmailAction type={emailAction.type} token={emailAction.token} />;
  if (user === undefined) return <p className="center mut">Loading...</p>;
  return user ? <Shell user={user} setUser={setUser} online={online} /> : <Auth onUser={setUser} online={online} />;
}

function EmailAction({ type, token }: { type: 'verify' | 'confirm-email'; token: string }) {
  const [message, setMessage] = useState('Confirming your email...');
  const [error, setError] = useState('');
  useEffect(() => {
    const path = type === 'verify' ? '/api/auth/verify-email' : '/api/auth/confirm-email-change';
    api.post<{ message: string }>(path, { token }).then((result) => setMessage(result.message)).catch((failure: Error) => {
      setError(failure.message);
      setMessage('');
    });
  }, [type, token]);
  return <main className="auth">
    <h1>StudyPilot</h1>
    {error ? <p className="bad" role="alert">{error}</p> : <p role="status">{message}</p>}
    <a className="link" href="/">Continue to StudyPilot</a>
  </main>;
}

function Shell({ user, setUser, online }: { user: User; setUser: (user: User | null) => void; online: boolean }) {
  const [tab, setTab] = useState<Tab>('dash');
  const store = useStore();
  const notifications = useDeadlineNotifications(store.tasks, user.reminderDays);
  const attentionCount = store.tasks.filter((task) => task.status !== 'Complete' && (daysLeft(task.due) < 0 || daysLeft(task.due) <= user.reminderDays)).length;
  const changeUser = (nextUser: User | null) => {
    setUser(nextUser);
    if (nextUser) store.refreshSummary();
    else void caches.delete('api-network-first');
  };
  return <><header><h1>StudyPilot</h1><nav>{TABS.map(([key, label]) => <button key={key} aria-current={key === tab ? 'page' : undefined} onClick={() => setTab(key)}>{label}{key === 'dash' && attentionCount > 0 ? ` (${attentionCount})` : ''}</button>)}</nav></header>
    <main>
      {!online && <p className="offline-banner" role="status">You are offline. Saved app screens are available, but changes are read-only until you reconnect.</p>}
      {store.error && <p className="banner" role="alert">{store.error} <button className="link" onClick={store.clearError}>Dismiss</button></p>}
      <fieldset className="app-content" disabled={!online} aria-label={online ? undefined : 'Read-only while offline'}>
        {store.loading ? <p className="mut">Loading...</p>
          : tab === 'dash' ? <Dashboard name={user.name} reminderDays={user.reminderDays} emailVerified={user.emailVerified} {...store} go={setTab} />
          : tab === 'classes' ? <Classes {...store} />
          : tab === 'tasks' ? <Tasks {...store} />
          : tab === 'timetable' ? <Timetable {...store} />
          : tab === 'progress' ? <Progress {...store} user={user} onUser={changeUser} go={setTab} />
          : <Profile user={user} setUser={changeUser} permission={notifications.permission} requestNotifications={notifications.requestPermission} />}
      </fieldset>
    </main></>;
}
