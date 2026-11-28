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
      importScripts: ['/sw-privacy.js'],
      globIgnores: ['**/pdf-*.js', '**/pdf.worker*'],
      navigateFallback: '/index.html',
      navigateFallbackDenylist: [/^\/api(?:\/|\?|$)/i],
      runtimeCaching: (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const).map((method) => ({
        urlPattern: ({ url }: { url: URL }) => /^\/api(?:\/|$)/i.test(url.pathname),
        handler: 'NetworkOnly' as const,
        method,
      })),
    },
  })],
  // Preserve the browser's Host so Origin checks also work if Vite chooses another port.
  server: { proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } } },
});
