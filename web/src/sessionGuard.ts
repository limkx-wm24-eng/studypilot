// Request stamps are local counters, never account data or credentials.
let generation = 0;
const listeners = new Set<() => void>();
export const sessionStamp = () => generation;
export const advanceSession = () => { generation++; };
export function listenForSessionFailure(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function reportSessionFailure(stamp: number, method: string, path: string) {
  // Public auth failures are ordinary form errors. The authoritative read must
  // never recursively revalidate itself. Password-confirmation failures on
  // protected endpoints instead get checked against the actual session.
  const publicPaths = ['/api/config', '/api/health', '/api/auth/login', '/api/auth/register', '/api/auth/forgot', '/api/auth/reset', '/api/auth/verify-email', '/api/auth/confirm-email-change'];
  if (stamp !== generation || publicPaths.includes(path) || (method === 'GET' && path === '/api/auth/me')) return;
  for (const listener of listeners) listener();
}
