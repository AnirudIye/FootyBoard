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
  // `challenges.cloudflare.com` is Turnstile, on the signup, contact and join
  // forms. The host and not the path: `/turnstile/v0/api.js` 302s to a
  // build-hashed path that rotates, so a path-scoped source breaks on
  // Cloudflare's next deploy. No `'unsafe-inline'` is needed here and none is
  // added — the snippets circulating that include it are cargo cult.
  "script-src 'self' https://challenges.cloudflare.com",
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
  /**
   * The Turnstile widget is an iframe, and this directive did not exist.
   *
   * **Adding the host to `script-src` alone is the silent outage.** With only
   * that, `api.js` loads, `window.turnstile` exists, and the hidden
   * `cf-turnstile-response` input is even created — and then stays empty
   * forever, because framing falls through to `default-src 'self'` and is
   * refused. Nothing throws for about thirty-eight seconds, after which the
   * error callback fires `300030`, a code Cloudflare documents under
   * "bot behaviour detected". So a policy mistake here does not look like a
   * policy mistake; it looks like an attack, in a form that hangs the button
   * rather than failing it.
   *
   * `frame-src` rather than `child-src`: the deprecated fallback happens to
   * work through the CSP3 chain and would pass a smoke test, which is exactly
   * what makes it the wrong one to write down.
   */
  'frame-src https://challenges.cloudflare.com',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
]

/** The policy as a header or `<meta>` value. */
export const DOCUMENT_CSP = DOCUMENT_CSP_DIRECTIVES.join('; ')
