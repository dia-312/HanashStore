import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectManifest: {
        // Thumbnails and variants.json are cached at runtime (see sw.ts), not precached.
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        globIgnores: ['media/**'],
      },
      manifest: {
        name: 'Sales Rep App — M0 Spike',
        short_name: 'Spike M0',
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
  server: { host: true, fs: { allow: ['..'] } },
  preview: { host: true, allowedHosts: true },
})
