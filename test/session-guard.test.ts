import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceSession, listenForSessionFailure, reportSessionFailure, sessionStamp } from '../web/src/sessionGuard.js';
import { api, ApiError } from '../web/src/api.js';

test('only current-session protected 401s request authoritative verification', () => {
  let checks = 0;
  const stop = listenForSessionFailure(() => { checks++; });
  try {
    const old = sessionStamp();
    for (const path of ['/api/config', '/api/health', '/api/auth/login', '/api/auth/register', '/api/auth/forgot', '/api/auth/reset', '/api/auth/verify-email', '/api/auth/confirm-email-change']) reportSessionFailure(old, 'POST', path);
    reportSessionFailure(old, 'GET', '/api/auth/me');
    assert.equal(checks, 0, 'public auth errors and verification reads cannot trigger recursive checks');
    reportSessionFailure(old, 'POST', '/api/classes');
    reportSessionFailure(old, 'PATCH', '/api/auth/email');
    reportSessionFailure(old, 'PATCH', '/api/auth/me');
    assert.equal(checks, 3, 'a protected password-confirmation error is verified, not assumed to mean logout');
    advanceSession();
    reportSessionFailure(old, 'POST', '/api/classes');
    assert.equal(checks, 3, 'a response from an obsolete session cannot invalidate a new account');
    reportSessionFailure(sessionStamp(), 'GET', '/api/tasks');
    assert.equal(checks, 4);
  } finally { stop(); }
  reportSessionFailure(sessionStamp(), 'GET', '/api/tasks');
  assert.equal(checks, 4, 'unmounted listeners are removed');
});

test('API reports protected 401 headers before awaiting the body; other failures retain their meanings', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const fetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'http://127.0.0.1/' } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  let checks = 0;
  const stop = listenForSessionFailure(() => { checks++; });
  let release!: (value: { error: string }) => void;
  const body = new Promise<{ error: string }>(resolve => { release = resolve; });
  let arrived!: () => void;
  const reading = new Promise<void>(resolve => { arrived = resolve; });
  try {
    globalThis.fetch = async () => ({ status: 401, ok: false, json: () => { arrived(); return body; } }) as Response;
    const request = api.get('/api/classes').catch(error => error);
    await reading;
    assert.equal(checks, 1, 'session validity is doubtful as soon as the headers arrive');
    release({ error: 'Please log in' });
    const error = await request;
    assert.ok(error instanceof ApiError); assert.equal(error.status, 401); assert.equal(error.message, 'Please log in');
    for (const status of [429, 503]) {
      globalThis.fetch = async () => ({ status, ok: false, json: async () => ({ error: 'Synthetic retryable failure' }) }) as Response;
      await assert.rejects(api.get('/api/classes'), (error: unknown) => error instanceof ApiError && error.status === status);
    }
    globalThis.fetch = async () => { throw new Error('Synthetic network failure'); };
    await assert.rejects(api.get('/api/classes'), /Synthetic network failure/);
    assert.equal(checks, 1);
  } finally {
    release({ error: 'Synthetic cleanup' }); stop(); globalThis.fetch = fetch;
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor); else Reflect.deleteProperty(globalThis, 'window');
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
