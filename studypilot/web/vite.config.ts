import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :3000, so /api calls are proxied to it.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
