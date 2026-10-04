import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const tempDir = await mkdtemp(join(tmpdir(), 'studypilot-e2e-'));
const databasePath = join(tempDir, 'studypilot.sqlite');
const port = process.env.STUDYPILOT_E2E_PORT
  ? Number(process.env.STUDYPILOT_E2E_PORT)
  : await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local test port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Playwright server port');
process.env.STUDYPILOT_E2E_PORT = String(port);

export default defineConfig({
  testDir: './e2e',
  outputDir: join(tempDir, 'test-results'),
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: 'node dist/server.js',
    url: `http://127.0.0.1:${port}/api/health`,
    env: { PORT: String(port), DB_PATH: databasePath, DATABASE_URL: '', NODE_ENV: 'test' },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
