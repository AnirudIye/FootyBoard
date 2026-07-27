/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * The app's own Content-Security-Policy.
 *
 * The API sets one too, but that governs nothing a browser renders: it answers
 * JSON, so its policy applies to a document nobody looks at. The policy that
 * matters is the one on the page, and it has to be delivered with the page.
 *
 * Injected at build time rather than written into `index.html`, because a
 * static tag applies in dev as well and Vite's HMR client needs an inline
 * script and a websocket back to the dev server. Rather than loosening the
 * shipped policy to keep dev working, dev simply has no policy and the built
 * output has a strict one.
 *
 * `frame-ancestors` is here for the copy-paste: a `<meta>` CSP silently ignores
 * it, along with `report-uri` and `sandbox`. Clickjacking protection therefore
 * still depends on the host sending this as a real header. Doing that is
 * strictly better than this tag and is what a deploy should do.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Framer Motion and React write inline `style` attributes on nearly every
  // animated element, and an attribute cannot carry a nonce. This is the one
  // relaxation the app genuinely needs.
  "style-src 'self' 'unsafe-inline'",
  // `blob:` covers PNG and GIF export, which draw the stage into a canvas and
  // hand back an object URL; `data:` covers the inline favicon.
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // Same-origin REST plus the `/ws` room socket. `'self'` already covers a
  // same-origin websocket in current browsers; the explicit schemes are for
  // the deploys that put the API on another host.
  "connect-src 'self' ws: wss:",
  // WebM and MP4 sequence export, same object-URL route as the images.
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const contentSecurityPolicy = (): Plugin => ({
  name: 'footyboard-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
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
