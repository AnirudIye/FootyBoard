/**
 * Which deployment this is, and the security controls that hang off it.
 *
 * `NODE_ENV` used to gate two of them independently — the `Secure` cookie flag
 * and the "you must supply a real ENCRYPTION_KEY" check — and it gated them by
 * equality with 'production'. Deploy with it unset, or set to something
 * reasonable but unrecognised like 'staging', and both quietly took their
 * permissive branch: cookies without `Secure`, and boards encrypted under a key
 * anyone can recompute from the placeholder committed to `.env.example`. Two
 * controls off from one missing variable, with nothing said about it.
 *
 * So there is one signal, it is read in one place, and a value nobody
 * recognises stops the process rather than picking a default. `NODE_ENV` is
 * still honoured as a fallback, because the failure that matters most is an
 * existing production deploy silently downgrading itself to development.
 */

const RECOGNISED = ['development', 'test', 'production']

const configured = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development').trim()

if (!RECOGNISED.includes(configured)) {
  throw new Error(
    `APP_ENV must be one of ${RECOGNISED.join(', ')} (got "${configured}"). ` +
      'Set it explicitly. Cookie security and the encryption-key requirement both follow it, ' +
      'so guessing at an unknown value would mean guessing at those.',
  )
}

export const APP_ENV = configured

/** A real deployment: cookies are marked `Secure`, HSTS is sent, keys are required. */
export const isProduction = APP_ENV === 'production'

/**
 * Whether a key derived from SESSION_SECRET is acceptable.
 *
 * Local and test databases hold no real boards, and making people generate key
 * material before they can run the app or its suite buys nothing. Anything
 * else — production, or a value that reached here by some other route — has to
 * supply its own.
 */
export const allowsDerivedKey = APP_ENV === 'development' || APP_ENV === 'test'

/**
 * The one origin allowed to reach the API, over REST and over the socket alike.
 *
 * Read here rather than in each of them so the two cannot drift: a WebSocket
 * handshake bypasses CORS entirely, so the socket has to apply this itself and
 * has to apply the same value.
 */
export const ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173'

/**
 * Whether a handshake claiming this origin may proceed.
 *
 * Two things are deliberately let through, and neither weakens what the check
 * is for.
 *
 * No `Origin` header at all: that is every non-browser client, including this
 * repo's own test suite. A browser always sends one on a WebSocket handshake
 * and a page cannot suppress it, so absence is not a hole a page can climb
 * through. Refusing it would only lock out the callers CORS was never
 * protecting anyone from.
 *
 * Any loopback origin, in development only. Vite's port is assigned by the
 * harness (`autoPort` in `.claude/launch.json`), so pinning the socket to
 * exactly `CORS_ORIGIN` means the room silently stops connecting the first time
 * the dev server lands on 5174, with no error the developer can act on. There
 * is no session worth stealing from a laptop, and this widening is impossible
 * to reach in production, where APP_ENV says so.
 */
export function isAllowedOrigin(origin) {
  if (!origin) return true
  if (origin === ORIGIN) return true
  if (APP_ENV !== 'development') return false
  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}
