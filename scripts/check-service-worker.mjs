import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const output = new URL('../web/dist/', import.meta.url);
const source = readFileSync(new URL('sw.js', output), 'utf8');
function inspect(code) {
  const routes = [], listeners = [], fetchListeners = [], networkCalls = [], manifest = [];
  const fixtures = new Map([
    ['api-network-first', []],
    ['old-user-data', ['https://synthetic.test/api/auth/me']],
    ['mixed-runtime', ['https://synthetic.test/icon.svg', 'https://synthetic.test/API/classes?synthetic=1']],
    ['redirected-private-data', ['https://synthetic.test/legacy-view']],
    ['static-assets', ['https://synthetic.test/icon.svg']],
  ]);
  class NavigationRoute { constructor(handler, options) { this.options = options; } }
  const workbox = new Proxy({
    clientsClaim() {}, cleanupOutdatedCaches() {},
    precacheAndRoute(entries) { manifest.push(...entries); },
    createHandlerBoundToURL() { return {}; }, NavigationRoute,
    registerRoute(match, handler, method = 'GET') { routes.push({ match, handler, method }); },
  }, { get(target, key) { return target[key] ?? class { strategy = key; }; } });
  const define = (_, factory) => factory(workbox);
  const sandbox = {
    URL, define,
    self: { define, skipWaiting() {}, addEventListener(type, handler) { if (type === 'activate') listeners.push(handler); if (type === 'fetch') fetchListeners.push(handler); } },
    fetch(request, options) { networkCalls.push({ request, options }); return Promise.resolve({ synthetic: true }); },
    caches: {
      async keys() { return [...fixtures.keys()]; },
      async open(name) { return {
        async keys() { return (fixtures.get(name) ?? []).map((url) => ({ url })); },
        async match(request) { return { url: name === 'redirected-private-data' ? 'https://synthetic.test/api/tasks' : request.url }; },
      }; },
      async delete(name) { return fixtures.delete(name); },
    },
    importScripts(...paths) {
      for (const path of paths) {
        assert.equal(path, '/sw-privacy.js', 'Review additional worker scripts for privacy');
        runInNewContext(readFileSync(new URL(path.slice(1), output), 'utf8'), sandbox);
      }
    },
  };
  runInNewContext(code, sandbox);
  // Fail closed for future runtime routes, even if their matchers target paths
  // outside the sample URLs below. Static caching belongs in the precache.
  for (const route of routes) if (!(route.match instanceof NavigationRoute)) {
    assert.equal(route.handler?.strategy, 'NetworkOnly', 'Runtime caching strategies require privacy review; keep runtime routes NetworkOnly');
  }
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    for (const path of ['/api', '/api/', '/api/config', '/api/auth/me', '/api/classes?synthetic=1', '/api/future-private-route', '/API/tasks']) {
      const url = new URL(path, 'https://synthetic.test');
      const matches = routes.filter((r) => r.method === method && typeof r.match === 'function' && r.match({ url, request: { method }, sameOrigin: true }));
      assert.ok(matches.length, `${method} ${path} needs an explicit network-only route`);
      for (const route of matches) assert.equal(route.handler.strategy, 'NetworkOnly', `${method} ${path} must never use a cache strategy`);
    }
  }
  for (const method of ['OPTIONS', 'SYNTHETIC']) {
    let responded = false;
    for (const listener of fetchListeners) listener({ request: { method, url: 'https://synthetic.test/api/auth/me' }, respondWith() { responded = true; } });
    assert.ok(responded, 'Methods unsupported by Workbox must go directly to network');
    assert.equal(networkCalls.at(-1)?.request.method, method);
    assert.equal(networkCalls.at(-1)?.options.cache, 'no-store');
  }
  const navigation = routes.find((r) => r.match instanceof NavigationRoute)?.match;
  assert.ok(navigation);
  for (const path of ['/api', '/api?synthetic=1', '/api/auth/me', '/API/classes']) assert.ok(navigation.options.denylist.some((pattern) => pattern.test(path)), 'API navigation must bypass the app shell');
  assert.ok(!navigation.options.denylist.some((pattern) => pattern.test('/')), 'Static offline navigation must remain available');
  assert.ok(manifest.some((entry) => entry.url === 'index.html'));
  assert.ok(manifest.some((entry) => entry.url.endsWith('.css')));
  for (const entry of manifest) assert.ok(!/(^|\/)api(?:\/|$)|\/pdf(?:-|\.worker)/i.test(entry.url), 'API responses and PDF assets must not be precached');
  assert.ok(listeners.length, 'Activation must clean old API caches');
  return { listeners, fixtures };
}
const { listeners, fixtures } = inspect(source);
const pending = [];
for (const listener of listeners) listener({ waitUntil(promise) { pending.push(promise); } });
await Promise.all(pending);
assert.deepEqual([...fixtures.keys()], ['static-assets'], 'Remove API caches while retaining static caches');
assert.throws(() => inspect(source.replaceAll('NetworkOnly', 'NetworkFirst')), 'The guard must detect caching strategies in generated code');
console.log('Generated service worker: API network-only routes, navigation exclusion, activation cleanup and PDF exclusions verified.');
