/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Honour the port the harness/preview assigns via PORT; fall back to Vite's default.
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    // Proxying the API makes it same-origin in dev, so the session cookie is
    // sent without any CORS or SameSite special-casing.
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:8787',
        changeOrigin: true,
      },
      // Rooms, same reasoning: same-origin in dev means the session cookie is
      // sent on the upgrade request, which is how the socket authenticates.
      // `ws: true` is what makes Vite forward the upgrade rather than answering
      // it with its own HMR socket.
      '/ws': {
        target: process.env.API_URL ?? 'http://localhost:8787',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    // react-konva pulls in react-reconciler; force every import to resolve to
    // the one project copy of React so hooks share a single dispatcher.
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react-konva'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // The server's tests run on node:test against a real Postgres, not in
    // jsdom. `npm --prefix server test` is their runner.
    exclude: ['**/node_modules/**', '**/dist/**', 'server/**', 'FootyBoard/**'],
  },
})
