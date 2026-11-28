import type { RequestHandler } from 'express';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const localDevOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']);

export const checkRequestOrigin: RequestHandler = (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('Origin');
  if (origin !== undefined) {
    try {
      const source = new URL(origin);
      const host = req.get('Host');
      if (!host || !['http:', 'https:'].includes(source.protocol) || source.username || source.password
        || source.pathname !== '/' || source.search || source.hash) throw new Error();
      // Use Host, never an untrusted X-Forwarded-Host or APP_URL. Normalize default ports.
      const target = new URL(`${source.protocol}//${host}`);
      const development = process.env.NODE_ENV === undefined || process.env.NODE_ENV === 'development';
      if (source.host === target.host || (development && localHosts.has(target.hostname) && localDevOrigins.has(source.origin))) return next();
    } catch { /* Invalid and opaque origins are rejected with the same response. */ }
  } else if (!['cross-site', 'same-site'].includes(req.get('Sec-Fetch-Site')?.toLowerCase() ?? '')) {
    return next();
  }
  res.status(403).json({ error: 'Request not allowed' });
};
