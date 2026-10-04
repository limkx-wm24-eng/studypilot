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

const TABS: [Tab, string][] = [
  ['dash', 'Dashboard'], ['classes', 'Classes'], ['tasks', 'Tasks'], ['timetable', 'Timetable'], ['progress', 'Progress'], ['profile', 'Profile'],
];

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    api.get<User>('/api/auth/me').then(setUser).catch(() => setUser(null));
  }, []);
  if (user === undefined) return <p className="center mut">Loading…</p>;
  return user ? <Shell user={user} setUser={setUser} /> : <Auth onUser={setUser} />;
}

function Shell({ user, setUser }: { user: User; setUser: (u: User | null) => void }) {
  const [tab, setTab] = useState<Tab>('dash');
  const store = useStore();
  const notifications = useDeadlineNotifications(store.tasks, user.reminderDays);
  const attentionCount = store.tasks.filter((task) => task.status !== 'Complete' && (daysLeft(task.due) < 0 || daysLeft(task.due) <= user.reminderDays)).length;
  // The attendance allowance depends on the course type and teaching weeks, so refresh it when they change.
  const changeUser = (u: User | null) => { setUser(u); if (u) store.refreshSummary(); };
  return (
    <>
      <header>
        <h1>StudyPilot</h1>
        <nav>
          {TABS.map(([key, label]) => (
            <button key={key} aria-current={key === tab ? 'page' : undefined} onClick={() => setTab(key)}>{label}{key === 'dash' && attentionCount > 0 ? ` (${attentionCount})` : ''}</button>
          ))}
        </nav>
      </header>
      <main>
        {store.error && (
          <p className="banner" role="alert">
            {store.error} <button className="link" onClick={store.clearError}>Dismiss</button>
          </p>
        )}
        {store.loading ? <p className="mut">Loading…</p>
          : tab === 'dash' ? <Dashboard name={user.name} reminderDays={user.reminderDays} {...store} go={setTab} />
          : tab === 'classes' ? <Classes {...store} />
          : tab === 'tasks' ? <Tasks {...store} />
          : tab === 'timetable' ? <Timetable {...store} />
          : tab === 'progress' ? <Progress {...store} user={user} onUser={changeUser} go={setTab} />
          : <Profile user={user} setUser={changeUser} permission={notifications.permission} requestNotifications={notifications.requestPermission} />}
      </main>
    </>
  );
}
