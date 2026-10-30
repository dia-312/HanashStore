import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // The new version waits until the app is reloaded; the update prompt comes in M3 (SPEC section 8).
      registerType: 'autoUpdate',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        globIgnores: ['media/**'],
      },
      manifest: {
        // Placeholder branding until the client sends the business name and logo (SPEC section 16).
        name: 'تطبيق مندوب المبيعات',
        short_name: 'المندوب',
        lang: 'ar',
        dir: 'rtl',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        background_color: '#14213D',
        theme_color: '#14213D',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
    }),
  ],
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:8000' },
  },
  preview: { host: true, allowedHosts: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
