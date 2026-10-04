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
  useEffect(() => {
    api.get<User>('/api/auth/me').then(setUser).catch(() => setUser(null));
    const refresh = () => setOnline(navigator.onLine);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => { window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh); };
  }, []);
  if (user === undefined) return <p className="center mut">Loading...</p>;
  return user ? <Shell user={user} setUser={setUser} online={online} /> : <Auth onUser={setUser} online={online} />;
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
          : tab === 'dash' ? <Dashboard name={user.name} reminderDays={user.reminderDays} {...store} go={setTab} />
          : tab === 'classes' ? <Classes {...store} />
          : tab === 'tasks' ? <Tasks {...store} />
          : tab === 'timetable' ? <Timetable {...store} />
          : tab === 'progress' ? <Progress {...store} user={user} onUser={changeUser} go={setTab} />
          : <Profile user={user} setUser={changeUser} permission={notifications.permission} requestNotifications={notifications.requestPermission} />}
      </fieldset>
    </main></>;
}
