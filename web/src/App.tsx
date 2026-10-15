import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import { listenForToasts } from './toast';

type TabIconName = 'dashboard' | 'classes' | 'tasks' | 'timetable' | 'progress' | 'profile';

const TABS: [Tab, string, TabIconName][] = [
  ['dash', 'Dashboard', 'dashboard'],
  ['classes', 'Classes', 'classes'],
  ['tasks', 'Tasks', 'tasks'],
  ['timetable', 'Timetable', 'timetable'],
  ['progress', 'Progress', 'progress'],
  ['profile', 'Profile', 'profile'],
];

function TabIcon({ name }: { name: TabIconName }) {
  const paths: Record<TabIconName, ReactNode> = {
    dashboard: <><rect x="3.5" y="3.5" width="7" height="7" rx="1" /><rect x="13.5" y="3.5" width="7" height="7" rx="1" /><rect x="3.5" y="13.5" width="7" height="7" rx="1" /><rect x="13.5" y="13.5" width="7" height="7" rx="1" /></>,
    classes: <><path d="M5 4.5h14a1 1 0 0 1 1 1v14H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z" /><path d="M7 8h9M7 12h9M7 16h6" /></>,
    tasks: <><rect x="4" y="3.5" width="16" height="17" rx="2" /><path d="m7.5 10 2 2 4-4M7.5 16h9" /></>,
    timetable: <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M7.5 3v4M16.5 3v4M3.5 9.5h17M8 13h2M14 13h2M8 16.5h2M14 16.5h2" /></>,
    progress: <><path d="M4 19.5h16" /><path d="M6.5 16V11M12 16V7M17.5 16V4" /></>,
    profile: <><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

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
  if (user === undefined) return <main><LoadingState /></main>;
  return user ? <Shell user={user} setUser={setUser} online={online} /> : <Auth onUser={setUser} online={online} />;
}

function LoadingState() {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWaiting(true), 4000);
    return () => window.clearTimeout(timer);
  }, []);
  return <div className="loading-screen" role="status" aria-busy="true">
    <div className="skeleton skeleton-title" />
    <div className="skeleton skeleton-line" />
    <div className="skeleton-grid">{Array.from({ length: 4 }, (_, index) => <div className="skeleton skeleton-card" key={index} />)}</div>
    <p className="mut">{waiting ? 'Waking up the free server. This can take up to a minute.' : 'Loading...'}</p>
  </div>;
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
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const toastId = useRef(0);
  const store = useStore();
  const notifications = useDeadlineNotifications(store.tasks, user.reminderDays);
  const attentionCount = store.tasks.filter((task) => task.status !== 'Complete' && (daysLeft(task.due) < 0 || daysLeft(task.due) <= user.reminderDays)).length;
  useEffect(() => listenForToasts((message) => setToast({ id: ++toastId.current, message })), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const changeUser = (nextUser: User | null) => {
    setUser(nextUser);
    if (nextUser) store.refreshSummary();
    else void caches.delete('api-network-first');
  };
  return <><header><div className="brand-lockup"><span className="logo-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M7 6.5h18v19H7z" /><path d="M11 11h10M11 15h10M11 19h7" /></svg></span><h1>StudyPilot</h1></div><nav aria-label="Main navigation">{TABS.map(([key, label, icon]) => <button key={key} data-tab={key} aria-current={key === tab ? 'page' : undefined} onClick={() => setTab(key)}><span className="nav-icon" aria-hidden="true"><TabIcon name={icon} /></span><span>{label}{key === 'dash' && attentionCount > 0 ? ` (${attentionCount})` : ''}</span></button>)}</nav><span className="user-avatar" aria-hidden="true">{user.name.trim().charAt(0).toUpperCase() || user.email.charAt(0).toUpperCase()}</span></header>
    <main>
      {!online && <p className="offline-banner" role="status">You are offline. Saved app screens are available, but changes are read-only until you reconnect.</p>}
      {store.error && <p className="banner" role="alert">{store.error} <button className="link" onClick={store.clearError}>Dismiss</button></p>}
      <fieldset className="app-content" disabled={!online} aria-label={online ? undefined : 'Read-only while offline'}>
        {store.loading ? <LoadingState />
          : tab === 'dash' ? <Dashboard name={user.name} reminderDays={user.reminderDays} emailVerified={user.emailVerified} {...store} go={setTab} />
          : tab === 'classes' ? <Classes {...store} />
          : tab === 'tasks' ? <Tasks {...store} />
          : tab === 'timetable' ? <Timetable {...store} />
          : tab === 'progress' ? <Progress {...store} user={user} onUser={changeUser} go={setTab} />
          : <Profile user={user} setUser={changeUser} permission={notifications.permission} requestNotifications={notifications.requestPermission} />}
      </fieldset>
    </main>{toast && <p key={toast.id} className="toast" role="status">{toast.message}</p>}</>;
}
