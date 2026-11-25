const channelName = 'studypilot-session';
export const SESSION_EVENT_KEY = 'studypilot-session-event';
type Signal = { type: 'logout' | 'changed'; nonce: string };
const outgoing = new Set<string>();

export function publishSessionEvent(type: Signal['type']) {
  const signal: Signal = { type, nonce: crypto.randomUUID() };
  outgoing.add(signal.nonce);
  if (outgoing.size > 32) outgoing.delete(outgoing.values().next().value!);
  if (type === 'logout') window.dispatchEvent(new Event('studypilot-local-logout'));
  try {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage(signal);
    channel.close();
  } catch { /* Storage events support browsers without BroadcastChannel. */ }
  try {
    localStorage.setItem(SESSION_EVENT_KEY, JSON.stringify(signal));
    localStorage.removeItem(SESSION_EVENT_KEY);
  } catch { /* Focus checks still protect tabs when browser storage is blocked. */ }
}

export function listenForSessionEvents(listener: (type: Signal['type']) => void) {
  const seen = new Set<string>();
  const receive = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const signal = value as Partial<Signal>;
    if ((signal.type !== 'logout' && signal.type !== 'changed') || typeof signal.nonce !== 'string' || seen.has(signal.nonce) || outgoing.has(signal.nonce)) return;
    seen.add(signal.nonce);
    if (seen.size > 32) seen.delete(seen.values().next().value!);
    listener(signal.type);
  };
  let channel: BroadcastChannel | undefined;
  try { channel = new BroadcastChannel(channelName); channel.onmessage = (event) => receive(event.data); } catch { /* Storage fallback. */ }
  const storage = (event: StorageEvent) => {
    if (event.key !== SESSION_EVENT_KEY || !event.newValue) return;
    try { receive(JSON.parse(event.newValue)); } catch { /* Ignore malformed events. */ }
  };
  const local = () => listener('logout');
  window.addEventListener('storage', storage);
  window.addEventListener('studypilot-local-logout', local);
  return () => {
    channel?.close();
    window.removeEventListener('storage', storage);
    window.removeEventListener('studypilot-local-logout', local);
  };
}
