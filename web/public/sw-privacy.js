// Also clean caches created by previously installed versions of StudyPilot.
// Workbox does not route OPTIONS or custom methods. They go directly to fetch.
self.addEventListener('fetch', (event) => {
  if (/^\/api(?:\/|$)/i.test(new URL(event.request.url).pathname)
    && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(event.request.method)) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
  }
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name === 'api-network-first') {
        await caches.delete(name);
        continue;
      }
      const cache = await caches.open(name);
      const requests = await cache.keys();
      let containsApi = requests.some((request) => /^\/api(?:\/|$)/i.test(new URL(request.url).pathname));
      // A redirected API response may have been stored under a different key.
      for (const request of containsApi ? [] : requests) {
        const response = await cache.match(request);
        if (response?.url && /^\/api(?:\/|$)/i.test(new URL(response.url).pathname)) { containsApi = true; break; }
      }
      if (containsApi) {
        await caches.delete(name);
      }
    }
  })());
});
