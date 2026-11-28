import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, ApiError, type User } from './api';
import { MutationQueue } from './mutationQueue';
import { closeDeadlineNotifications, clearLegacyNotificationHistory } from './notifications';
import { listenForSessionEvents } from './sessionEvents';
import { advanceSession, listenForSessionFailure } from './sessionGuard';

export type UserPatch = Partial<Pick<User, 'name' | 'courseType' | 'programme' | 'reminderDays' | 'semesterStart' | 'semesterWeeks'>>;
export type UserUpdateSource = 'profile' | 'semester' | 'import';
export type UpdateUser = (patch: UserPatch, source: UserUpdateSource) => Promise<User>;

export function useUserSession() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const currentUser = useRef<User | null>(null);
  const accountView = useRef<HTMLDivElement>(null);
  const [checking, setChecking] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [sessionKey, setSessionKey] = useState(0);
  const generation = useRef(0);
  const verificationPending = useRef(true);
  const requestVersion = useRef(0);
  const verification = useRef<{ version: number; promise: Promise<void> } | null>(null);
  const queue = useRef(new MutationQueue());
  const pending = useRef(new Set<UserUpdateSource>());
  const [pendingUpdates, setPendingUpdates] = useState<ReadonlySet<UserUpdateSource>>(new Set());
  const [online, setOnline] = useState(() => navigator.onLine);

  const resetWork = () => {
    advanceSession();
    queue.current = new MutationQueue();
    pending.current.clear();
    setPendingUpdates(new Set());
    setSessionKey(++generation.current);
  };

  const hideAccount = () => {
    verificationPending.current = true;
    if (accountView.current) accountView.current.hidden = true;
    document.documentElement.classList.add('session-checking');
    setChecking(true);
  };
  const changeUser = (next: User | null, forceReset = false) => {
    requestVersion.current++;
    verification.current = null;
    advanceSession();
    if (forceReset || currentUser.current?.id !== next?.id) {
      closeDeadlineNotifications();
      clearLegacyNotificationHistory();
      resetWork();
    }
    currentUser.current = next;
    verificationPending.current = false;
    setSessionError('');
    setUser(next);
    setChecking(false);
  };
  const recheckSession = () => {
    hideAccount();
    if (verification.current?.version === requestVersion.current) return verification.current.promise;
    setSessionError('');
    const version = ++requestVersion.current;
    const check = { version, promise: Promise.resolve() };
    verification.current = check;
    // Reads share the user-write queue: a snapshot taken before a pending PATCH
    // must not replace that PATCH's eventual authoritative result.
    check.promise = queue.current.run('user', () => api.get<User>('/api/auth/me')).then((next) => {
      if (version === requestVersion.current) flushSync(() => changeUser(next));
    }).catch((failure: unknown) => {
      if (version !== requestVersion.current) return;
      if (failure instanceof ApiError && failure.status === 401) {
        flushSync(() => changeUser(null, true));
      } else {
        // Transport errors cannot prove logout. Keep an existing account hidden
        // and paused, with explicit retry; a cold shell has no private data.
        setSessionError('Could not verify your session. Check your connection and retry.');
        if (!currentUser.current) { setUser(null); setChecking(false); }
      }
    }).finally(() => { if (verification.current === check) verification.current = null; });
    return check.promise;
  };
  const updateUser: UpdateUser = (patch, source) => {
    const account = currentUser.current;
    const stamp = generation.current;
    const current = () => stamp === generation.current && currentUser.current?.id === account?.id;
    if (generation.current !== sessionKey || !account || verificationPending.current) return Promise.reject(new Error('Verify your session before saving.'));
    if (pending.current.has(source)) return Promise.reject(new Error('This save is already pending.'));
    pending.current.add(source);
    setPendingUpdates(new Set(pending.current));
    return queue.current.run('user', async () => {
      if (!current()) throw new Error('The account changed before saving.');
      // A queued write has not acquired a server session yet. A focus/401 check
      // may have discovered a cookie change while an earlier write was pending;
      // do not send the old account's draft under that unverified cookie.
      if (verificationPending.current) throw new Error('Verify your session before saving.');
      const next = await api.patch<User>('/api/auth/me', patch);
      if (!current()) throw new Error('The account changed while saving.');
      currentUser.current = next;
      setUser(next);
      return next;
    }).finally(() => {
      if (current()) { pending.current.delete(source); setPendingUpdates(new Set(pending.current)); }
    });
  };
  useLayoutEffect(() => {
    if (accountView.current) accountView.current.hidden = checking;
    document.documentElement.classList.toggle('session-checking', checking);
  });
  useEffect(() => {
    setSessionKey(generation.current);
    clearLegacyNotificationHistory();
    void recheckSession();
    const stopFailures = listenForSessionFailure(() => { void recheckSession(); });
    const stopEvents = listenForSessionEvents((type) => {
      if (type === 'logout') flushSync(() => changeUser(null, true));
      else { requestVersion.current++; verification.current = null; resetWork(); void recheckSession(); }
    });
    const focus = () => { void recheckSession(); };
    const visibility = () => { if (document.visibilityState === 'visible') focus(); else hideAccount(); };
    const connectivity = () => { setOnline(navigator.onLine); if (navigator.onLine && verificationPending.current) focus(); };
    window.addEventListener('focus', focus);
    window.addEventListener('blur', hideAccount);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    return () => {
      requestVersion.current++;
      generation.current++;
      advanceSession();
      stopFailures(); stopEvents();
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', hideAccount);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', connectivity);
      window.removeEventListener('offline', connectivity);
      document.documentElement.classList.remove('session-checking');
    };
  }, []);
  return {
    user, accountView, checking, sessionError, sessionKey, online, recheckSession, updateUser, pendingUpdates,
    isUserPending: (source: UserUpdateSource) => pending.current.has(source),
    acceptLogin: (next: User) => { if (generation.current === sessionKey) changeUser(next); },
    leaveAccount: () => { if (generation.current === sessionKey) changeUser(null, true); },
  };
}
