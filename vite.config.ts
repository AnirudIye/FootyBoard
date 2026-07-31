/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

import { DOCUMENT_CSP } from './src/lib/csp.js'

/**
 * The app's own Content-Security-Policy, injected as a `<meta>` tag.
 *
 * **The policy itself lives in `src/lib/csp.js`**, which is the only place it is
 * spelled out. Three things deliver it — this tag, `vercel.json`, and the API
 * when `SERVE_STATIC=true` makes it the origin — and the one that arrived last
 * arrived without it, which is the whole story in that file's header.
 *
 * Injected at build time rather than written into `index.html`, because a
 * static tag applies in dev as well and Vite's HMR client needs an inline
 * script and a websocket back to the dev server. Rather than loosening the
 * shipped policy to keep dev working, dev simply has no policy and the built
 * output has a strict one.
 *
 * `frame-ancestors` is in the policy for the copy-paste: a `<meta>` CSP silently
 * ignores it, along with `report-uri` and `sandbox`. Clickjacking protection
 * therefore still depends on the host sending this as a real header. Doing that
 * is strictly better than this tag and is what a deploy should do.
 */
const contentSecurityPolicy = (): Plugin => ({
  name: 'footyboard-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}" />`,
    ),
})

/**
 * Proxying the API makes it same-origin, so the session cookie is sent without
 * any CORS or SameSite special-casing.
 *
 * Shared between `serve` and `preview` rather than written twice: `preview` is
 * where the built output gets exercised against a real API, and a build whose
 * requests all 404 cannot tell you whether it works.
 */
const apiProxy = {
  '/api': {
    target: process.env.API_URL ?? 'http://localhost:8787',
    changeOrigin: true,
  },
  // Rooms, same reasoning: same-origin means the session cookie is sent on the
  // upgrade request, which is how the socket authenticates. `ws: true` is what
  // makes Vite forward the upgrade rather than answering it with its own HMR
  // socket.
  '/ws': {
    target: process.env.API_URL ?? 'http://localhost:8787',
    ws: true,
    changeOrigin: true,
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  server: {
    // Honour the port the harness/preview assigns via PORT; fall back to Vite's default.
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    proxy: apiProxy,
  },
  preview: {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    proxy: apiProxy,
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
