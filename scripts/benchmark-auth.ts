import { performance } from 'node:perf_hooks';

// This benchmark always uses synthetic accounts and in-memory SQLite.
process.env.DATABASE_URL = '';
process.env.DB_PATH = ':memory:';
process.env.STUDYPILOT_TEST_POSTGRES = '';
const { securityHarness } = await import('../test/support/securityHarness.ts');
const { legacyHash } = await import('../test/support/legacyPassword.ts');
const h = await securityHarness(true, false);
const summarize = (values: number[]) => ({ medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)], minMs: Math.min(...values), maxMs: Math.max(...values) });
try {
  const a = await h.register();
  const current = String((await h.db.get('SELECT password_hash FROM users WHERE id = ?', [a.user.id]))!.password_hash);
  const legacy = legacyHash('synthetic-password-123');
  for (const mode of ['normal-login', 'legacy-upgrade', 'current-failure', 'legacy-failure', 'unknown-failure']) {
    const values: number[] = [];
    for (let i = 0; i < 4; i++) {
      const stored = mode.startsWith('legacy') ? legacy : current;
      await h.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [stored, a.user.id]);
      const failure = mode.endsWith('failure');
      const started = performance.now();
      const result = await h.send('POST', '/api/auth/login', { email: mode === 'unknown-failure' ? 'missing-benchmark@example.test' : a.email, password: failure ? 'incorrect-synthetic' : 'synthetic-password-123' }, undefined, { 'X-Forwarded-For': `192.0.2.${100 + ['normal-login', 'legacy-upgrade', 'current-failure', 'legacy-failure', 'unknown-failure'].indexOf(mode)}` });
      if (result.status !== (failure ? 401 : 200)) throw new Error('Synthetic authentication benchmark failed');
      if (i) values.push(performance.now() - started);
    }
    console.log(JSON.stringify({ mode, ...summarize(values) }));
  }
} finally { await h.close(); }
