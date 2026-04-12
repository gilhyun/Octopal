import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'renderer', 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'renderer/src/**/*.test.{ts,tsx}'],
    setupFiles: ['renderer/src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/security.ts', 'src/skills/registry.ts', 'renderer/src/components/TaskBoard/**/*.{ts,tsx}'],
    },
  },
})
