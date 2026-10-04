import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// In development the API runs on :3000, so /api calls are proxied to it.
export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    manifest: {
      name: 'StudyPilot', short_name: 'StudyPilot', description: 'A study planner for classes, deadlines, grades and attendance.',
      theme_color: '#0f766e', background_color: '#f1f4f3', display: 'standalone', start_url: '/',
      icons: [
        { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      navigateFallback: '/index.html',
      runtimeCaching: [{
        urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
        handler: 'NetworkFirst',
        options: { cacheName: 'api-network-first', networkTimeoutSeconds: 3, cacheableResponse: { statuses: [0, 200] } },
      }],
    },
  })],
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
