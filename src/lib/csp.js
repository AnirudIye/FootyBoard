/**
 * The document's Content-Security-Policy, defined once.
 *
 * **Three things deliver this policy and none of them may spell it out.** The
 * `footyboard-csp` plugin in `vite.config.ts` injects it as a `<meta>` tag so the
 * built output is never unprotected; `vercel.json` sends it as a real header,
 * because a `<meta>` CSP silently ignores `frame-ancestors` and that is the
 * directive clickjacking protection rests on; and `server/src/index.js` sends it
 * when `SERVE_STATIC=true` makes that process the thing serving the page.
 *
 * **It lives here because the third delivery arrived without it and shipped a
 * blank page.** `6a4ce0b` taught the API to serve `dist/`, and the API's own
 * policy — `default-src 'none'`, correct for JSON and wrong for a document —
 * was already being set for every response by a middleware written before
 * anything here served a document. The page went out forbidding its own scripts.
 * Measured 2026-07-31: `#root` had zero children and the bundle sat in the DOM
 * having never executed. The `<meta>` tag does not rescue that, because a browser
 * enforces every policy it is handed and the intersection is what applies, which
 * is the same property the tag relies on in the other direction.
 *
 * Plain JavaScript rather than TypeScript, for the same reason
 * `src/lib/boardSchema.js` is: Node cannot import a `.ts` file without a loader,
 * `server/` has to read this, and that is not worth a build step. `allowJs` is
 * already on in `tsconfig.app.json`. It also means **the API cannot be deployed
 * without `src/lib/` beside it**, which was already true of `boardSchema.js` and
 * is now true of two files.
 *
 * `vercel.json` is JSON and can import nothing, so it is the one copy that has to
 * be kept in step by hand. `src/lib/csp.test.ts` is what does the keeping, and it
 * asserts against this module rather than against a regex over a config file.
 */
export const DOCUMENT_CSP_DIRECTIVES = [
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
]

/** The policy as a header or `<meta>` value. */
export const DOCUMENT_CSP = DOCUMENT_CSP_DIRECTIVES.join('; ')
