import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  publicDir: path.resolve(__dirname, '..', 'assets'),
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '..', 'dist', 'renderer'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.split(path.sep).join('/')
          if (!normalizedId.includes('/node_modules/')) return undefined

          const modulePath = normalizedId.split('/node_modules/').pop()
          const segments = modulePath?.split('/') ?? []
          const packageName = segments[0]?.startsWith('@')
            ? `${segments[0]}/${segments[1]}`
            : segments[0]

          if (!packageName) return undefined
          if (packageName.startsWith('@tauri-apps/')) return 'tauri'
          if (
            packageName === 'react-markdown' ||
            packageName.startsWith('remark-') ||
            packageName.startsWith('rehype-')
          ) return 'markdown'
          if (packageName === 'highlight.js') return 'highlight'
          if (packageName === 'lucide-react') return 'icons'
          if (
            packageName === 'react' ||
            packageName === 'react-dom' ||
            packageName === 'scheduler' ||
            packageName === 'use-sync-external-store'
          ) return 'react-vendor'
          if (packageName === 'i18next' || packageName === 'react-i18next') return 'i18n'
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: 5173,
    // Tauri expects a fixed port, ensure it doesn't change
    strictPort: true,
  },
  // Make envPrefix include TAURI_ for Tauri-specific env vars
  envPrefix: ['VITE_', 'TAURI_'],
})
