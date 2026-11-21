import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Single source of truth for the version shown in "关于" (no Node API in the bundle).
const APP_VERSION: string = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version

// LAN sync service. In dev the Vite dev-server proxies API + WS to it.
// In production `npm start` serves both the built `dist/` and the same API
// from a single origin, so the exact same front-end bundle runs everywhere
// (browser / Electron / Capacitor WebView) without any code change.
const SYNC_TARGET = process.env.LUMEN_SYNC_TARGET || 'http://127.0.0.1:18740'

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  // Relative base keeps the bundle portable into file:// shells.
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: SYNC_TARGET, changeOrigin: true },
      '/raw': { target: SYNC_TARGET, changeOrigin: true },
      '/health': { target: SYNC_TARGET, changeOrigin: true },
      '/ws': { target: SYNC_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
})
