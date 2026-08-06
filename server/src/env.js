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
 * What `server/.env.example` ships, so that shipping it to production is caught.
 *
 * Written here as well as there, which is a duplication and is the deliberate
 * kind: this file has to know the string in order to refuse it.
 * `envExample.test.js` reads the file and asserts the two are the same, so they
 * cannot drift into a check that quietly matches nothing.
 */
const PLACEHOLDER_SECRET = 'dev-only-secret-change-me'

/**
 * Short enough that any honest secret clears it, long enough that a memorable
 * one does not. `.env.example` tells you to generate 32 bytes of hex, which is
 * 64 characters, so this is half of what the instructions have always said.
 */
const MIN_SECRET_LENGTH = 32

const HOW_TO_GENERATE =
  'Generate one with:\n' +
  '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'

/**
 * The secret, and the floor that production has to clear before it may boot.
 *
 * **The name undersells it, which is why this had no check for so long.** It
 * signs nothing: sessions are opaque random tokens stored as SHA-256. What it
 * actually keys is the HMAC in `securityQuestions.js` that decides which
 * question an address with *no account* is shown. That mapping has to be stable,
 * or probing an address twice shows two questions and gives the game away, and
 * it has to be uncomputable offline, or an attacker derives the decoy for any
 * address and flags every account whose real question differs from the one their
 * own arithmetic predicts. Left at the placeholder, that key is public: it is in
 * this repository and in the published mirror. Recovery step one then becomes
 * the account-enumeration oracle that its deliberately generic replies exist to
 * prevent. It is also the seed for the derived encryption key, though production
 * never reaches that branch, since `allowsDerivedKey` is false there.
 *
 * So production stops at boot rather than running with it, in the same voice and
 * for the same reason an unrecognised `APP_ENV` does: this is a security setting
 * whose failure is silent, and a silent failure is the one worth refusing to
 * start over.
 *
 * **Development and test are deliberately untouched.** Requiring key material
 * before anybody can run the app or its suite buys nothing and would break every
 * laptop in the project at once, which is the far worse direction and is the
 * argument `allowsDerivedKey` already makes about `ENCRYPTION_KEY`. The `'dev'`
 * fallback is the one both consumers used to spell out for themselves.
 */
const secret = process.env.SESSION_SECRET?.trim()

if (isProduction) {
  if (!secret) {
    throw new Error(
      `SESSION_SECRET is required when APP_ENV is "${APP_ENV}". It keys the HMAC that hides ` +
        'which addresses have accounts, so without it recovery becomes a way to enumerate them. ' +
        HOW_TO_GENERATE,
    )
  }
  if (secret === PLACEHOLDER_SECRET) {
    throw new Error(
      'SESSION_SECRET is still the placeholder committed to .env.example, so it is public and ' +
        'anybody holding this source can recompute what it protects. ' +
        HOW_TO_GENERATE,
    )
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters when APP_ENV is ` +
        `"${APP_ENV}" (got ${secret.length}). ` +
        HOW_TO_GENERATE,
    )
  }
}

export const SESSION_SECRET = secret || 'dev'

/**
 * The origins allowed to reach the API, over REST and over the socket alike.
 *
 * Read here rather than in each of them so the two cannot drift: a WebSocket
 * handshake bypasses CORS entirely, so the socket has to apply this itself and
 * has to apply the same values.
 *
 * **A list, comma separated, and it was one value until 2026-08-06.** The reason
 * is written in `handoff.md` under "being findable": `tunnel.footyboard.me` is
 * routed so that a load test or a staging check can be aimed somewhere other
 * than `www`, and with a single origin the page loaded there and then connected
 * to nothing — the socket refused the upgrade at the handshake, so staging was
 * an environment where everything worked except the product. One origin is still
 * the ordinary case and the syntax for it is unchanged.
 *
 * Every entry is held to the same rules, which is the property worth stating:
 * the list is not a way to smuggle in a cleartext origin beside a good one.
 */
const DEFAULT_ORIGIN = 'http://localhost:5173'

const configuredOrigin = process.env.CORS_ORIGIN?.trim()

/**
 * Split, trimmed, and emptied entries dropped.
 *
 * `a, b,` is a list of two rather than an error, because a trailing comma in an
 * environment variable is a typo with an obvious intent, and refusing the boot
 * over one would be refusing it over punctuation. A value that is *only*
 * separators has nothing in it at all, and falls through to the default so that
 * the branch below reports it as unset — which is what it effectively is.
 */
const requestedOrigins = (configuredOrigin ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

/**
 * Every origin allowed to call this API with credentials, in the order given.
 *
 * Frozen because it is a policy rather than a collection: `isAllowedOrigin` is
 * the one gate every REST request and every socket handshake passes through, and
 * a module that could push onto this array would be widening that gate from
 * anywhere, at any time, with nothing at the boot to say so.
 */
export const ORIGINS = Object.freeze(
  requestedOrigins.length > 0 ? requestedOrigins : [DEFAULT_ORIGIN],
)

/**
 * The floor under them, which they went without while the two beside them had
 * one.
 *
 * **The scheme is the part that matters, and the default is the reason.** This
 * variable falls back to an `http://` origin, so leaving it unset in production
 * does not fail — it succeeds at something nobody asked for. Everything
 * downstream then works perfectly: the CORS echo, the socket handshake and the
 * REST check below all faithfully grant credentialed access to a cleartext
 * origin, on the machine of whoever is reading the page, and the only symptom is
 * that they do. That is the same shape of silent failure `APP_ENV` and
 * `SESSION_SECRET` already refuse to boot over, so this refuses in the same
 * voice.
 *
 * **The shape is checked in every environment, and points the other way.** A
 * browser sends `Origin: https://app.example.com` — no trailing slash, no path,
 * no credentials — so a configured value carrying any of those compares equal to
 * nothing that will ever arrive. The frontend then cannot reach its own API and
 * no room can connect, with no error anywhere except in a browser console
 * somebody has to think to open. `new URL(...).origin` is exactly "scheme, host
 * and port and nothing else", so comparing the value against its own origin is
 * the whole check.
 *
 * **Checked entry by entry, and the first bad one stops the boot.** A list is
 * exactly where a permissive value would hide: `https://www.example.com,
 * http://staging.example.com` looks like it was written by somebody being
 * careful, and it hands every session cookie on the second host to anybody on
 * the network path. Nothing here is lenient because a good origin was named
 * beside it.
 *
 * Development and test keep the http default deliberately, for the reason
 * `allowsDerivedKey` already gives about `ENCRYPTION_KEY`: requiring TLS on a
 * laptop would stop every developer and the suite at once, to protect a session
 * that is worth nothing.
 */
const howItWasSet = requestedOrigins.length
  ? ''
  : ` CORS_ORIGIN is unset, so it defaulted to ${DEFAULT_ORIGIN}.`

for (const origin of ORIGINS) {
  let parsed = null
  try {
    parsed = new URL(origin)
  } catch {
    // Not a URL at all. Reported by the same branch as a URL of the wrong shape,
    // because to the person reading the message they are one mistake.
  }

  if (
    !parsed ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.origin !== origin
  ) {
    throw new Error(
      `CORS_ORIGIN must be a bare http:// or https:// origin: scheme, host and port, with no ` +
        `trailing slash, path, query or credentials (got "${origin}").${howItWasSet} ` +
        'A browser sends exactly that and nothing else, so any other shape matches no request ' +
        'that will ever arrive and locks the frontend out of its own API. ' +
        'Several may be given, separated by commas.',
    )
  }

  if (isProduction && parsed.protocol !== 'https:') {
    throw new Error(
      `CORS_ORIGIN must be an https:// origin when APP_ENV is "${APP_ENV}" (got "${origin}").` +
        `${howItWasSet} It is the origin allowed to call this API with credentials, so a cleartext ` +
        'one hands every session cookie to anybody on the network path. ' +
        'Every entry in the list is held to this, however good the others are.',
    )
  }
}

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
  if (ORIGINS.includes(origin)) return true
  if (APP_ENV !== 'development') return false
  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * The database, and the credential that reaches it.
 *
 * Written down here for the reason `CORS_ORIGIN` is: two modules needed it and
 * had a copy each. `db.js` pooled one and `realtime.js` handed a second,
 * byte-identical one to its LISTEN client, so the most powerful secret this
 * service holds was the duplication this repo keeps being bitten by, and a
 * deployment that changed one of them would have had half its connections
 * going somewhere else.
 *
 * **Unset in production is the failure this refuses.** The fallback below is
 * the local development role, which `.env.example` and `server/README.md` both
 * say is SUPERUSER and owns every table. Losing the variable on a real host
 * does not stop the boot with anything an operator can read: `migrate()` dies
 * on a refused connection to an address nobody configured, and if anything at
 * all is listening there — a leftover cluster, a sidecar, a connection proxy —
 * the instance comes up serving the wrong database instead. That is the same
 * shape of silent failure `APP_ENV`, `SESSION_SECRET` and `CORS_ORIGIN` already
 * refuse to boot over, so this refuses in the same voice.
 *
 * **The message does not print the string it would have fallen back to.** A
 * connection string is not a thing to put in a log, which is the whole finding
 * behind `withoutPassword` in `scripts/pg.js`, and a boot refusal goes straight
 * into CI output, screenshots and bug reports.
 *
 * Development and test keep the default, and here that is more than the
 * argument `allowsDerivedKey` makes: `npm test` runs `node --test` with no env
 * file, so every suite reaches the local database through exactly this
 * fallback. Requiring it outside production would stop the suite and every
 * laptop at once.
 */
const DEFAULT_DATABASE_URL = 'postgres://soccerboard:soccerboard@127.0.0.1:55432/soccerboard'

const configuredDatabaseUrl = process.env.DATABASE_URL?.trim()

if (isProduction && !configuredDatabaseUrl) {
  throw new Error(
    `DATABASE_URL is required when APP_ENV is "${APP_ENV}". Unset, this process falls back to ` +
      'the local development superuser: a credential published in this repository, pointing at ' +
      "this host's own loopback. So the boot either dies on a refused connection to an address " +
      'nobody configured, or succeeds against whatever happens to be listening on it. It is not ' +
      'printed here because a connection string is not a thing to put in a log. ' +
      'server/README.md has the restricted role production should name, and .env.example has ' +
      'the sslmode it needs.',
  )
}

export const DATABASE_URL = configuredDatabaseUrl || DEFAULT_DATABASE_URL
