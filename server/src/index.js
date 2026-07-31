import express from 'express'
import { createServer } from 'node:http'
import { migrate, purgeStaleAllowances, closePool } from './db.js'
import { purgeExpiredSessions, purgeExpiredRevocations } from './sessions.js'
import { initEncryption } from './crypto.js'
import { userForToken, readCookie, COOKIE_NAME } from './auth.js'
import { attachRealtime } from './realtime.js'
import { purgeExpiredResets } from './passwordReset.js'
import { purgeExpiredChallenges } from './twoFactor.js'
import { authRouter } from './routes/auth.js'
import { boardsRouter } from './routes/boards.js'
import { sharesRouter, redeemRouter } from './routes/shares.js'
import { assistantRouter } from './routes/assistant.js'
import { TooManyRequests } from './rateLimit.js'
import { ORIGIN, APP_ENV, isProduction, isAllowedOrigin } from './env.js'

const PORT = Number(process.env.PORT ?? 8787)
const INSTANCE_LABEL = process.env.INSTANCE_LABEL ?? `pid-${process.pid}`

/**
 * Whether to believe `X-Forwarded-For`, and how many hops of it.
 *
 * Off unless something is actually in front of us. Trusting the header
 * unconditionally lets any caller pick which bucket the per-IP limiters count
 * them in, simply by sending their own — and the join code's entire defence is
 * that limiter, so this is not a hardening detail. Unset, `req.ip` is the
 * socket address, which a client cannot choose.
 *
 * `npm run cluster` sets this for its children, because its balancer overwrites
 * the header with the real peer address before forwarding.
 */
const TRUST_PROXY = process.env.TRUST_PROXY?.trim()

// Fail fast: a misconfigured key should stop startup, not surface later as a
// board that cannot be opened.
initEncryption()

/**
 * Migrations at boot, which is what happens unless an operator has taken the
 * two-role database split and said otherwise.
 *
 * `migrate()` issues DDL, so the restricted role in `sql/runtime-role.sql`
 * cannot get past the first statement: `CREATE TABLE IF NOT EXISTS users` is
 * refused even though `users` is right there, because Postgres checks the
 * schema privilege before it checks existence. There is no grant that permits
 * that and forbids `DROP TABLE` — they are the same privilege — so the role was
 * provisioned, proven and unusable, and this line was the reason. This is the
 * switch that unpicks it.
 *
 * Read the way `RUN_MAINTENANCE` is read further down, on unless it is the
 * literal `false`, so this file has one dialect for a boolean rather than two.
 * An unrecognised value migrates, which is today's behaviour, and as the
 * restricted role that is a refused boot carrying a real 42501 rather than a
 * process that starts and is quietly wrong.
 *
 * **Setting it spends three things, and they are the operator's to spend rather
 * than this file's**: that migrations run at boot, that there is no separate
 * migration step, and that several instances may boot at once with the advisory
 * lock sorting them out. Schema/code atomicity goes with them — skip the step
 * and the instances come up on an old schema and fail at query time, later and
 * further from the cause than a failed boot would be. Unset, none of that is
 * spent and this is the line it always was.
 *
 * Safe to run in every instance while it is on: migrate() takes an advisory
 * lock, so simultaneous boots serialise rather than racing on the catalogue.
 */
if (process.env.RUN_MIGRATIONS !== 'false') {
  await migrate()
} else {
  console.log(
    'RUN_MIGRATIONS=false, so this instance did not migrate. The schema has to have been ' +
      'applied already by `npm run migrate` under a privileged DATABASE_URL; if it was not, ' +
      'this process starts normally and fails at query time instead.',
  )
}

const app = express()

if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY)
app.disable('x-powered-by')

/**
 * Every response here is JSON. Nothing this process serves is a document, so
 * the policy says exactly that: no scripts, no styles, no images, no
 * connections, nothing. `default-src 'none'` is the strongest statement
 * available and costs nothing, because there is nothing to permit.
 *
 * That is also its limit, and worth being plain about: a CSP only governs the
 * response carrying it, so this one protects the API's own replies and says
 * nothing about the app. The document policy belongs on whatever serves
 * `index.html`, which in development is Vite and in production is the static
 * host, neither of which passes through here.
 *
 * `frame-ancestors` restates `X-Frame-Options` in the form modern browsers
 * actually read; the older header stays for the ones that do not.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * A year, subdomains included, and no `preload`.
 *
 * The year is the figure the preload list requires and the one everything else
 * has settled on; anything shorter is a window an attacker only has to wait out.
 * `includeSubDomains` was already here and stays: this API is the only thing on
 * its host, and the directive is what stops a cookie being set from
 * `anything.the-domain` over plaintext, which is otherwise a way around the
 * whole header.
 *
 * **`preload` is deliberately absent**, and that is a decision rather than an
 * omission. It does nothing on its own — it is a claim that somebody submitted
 * this domain at hstspreload.org — and what it enables when the claim is true is
 * effectively irreversible: baked into browser binaries, removed on a timescale
 * of months, and applying to every subdomain including ones that do not exist
 * yet. That is a commitment for whoever operates the domain to make on purpose,
 * not one for a middleware to make on their behalf. Adding the token is one word
 * on the day they decide to.
 */
const HSTS = 'max-age=31536000; includeSubDomains'

/**
 * Set before anything else can answer, which is the whole reason this moved.
 *
 * It used to sit *below* the CORS middleware, and that middleware ends a
 * preflight with `return res.status(204).end()` — so every `OPTIONS` response
 * this API has ever sent carried no CSP, no `nosniff`, no `X-Frame-Options` and
 * no HSTS. It sat below `express.json()` too, so a body that was malformed or
 * over the cap was answered by the error handler with none of them either.
 * Neither gap is known to be exploitable through an empty 204 or a 400. That is
 * not the argument: "every response carries these" is a claim people build on,
 * and a claim with a whole class of exceptions in it is one that has quietly
 * stopped being true.
 */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  /**
   * HSTS follows the deployment signal, not the connection.
   *
   * This was `if (req.secure)`, which reads as the careful thing to do and is
   * the reason the header was never sent. `req.secure` follows Express's
   * `trust proxy`, which is off unless `TRUST_PROXY` is set — so behind a
   * TLS-terminating proxy that has not declared itself, the exact
   * misconfiguration this file already prints a warning about a hundred lines
   * down, every request looks like plain HTTP and HSTS never appeared once. The
   * deployment where it matters most is the one where it was missing.
   *
   * The asymmetry that makes the fix safe is that **a browser ignores an HSTS
   * header received over plaintext**. Sending it on a connection that is not
   * secure costs nothing and does nothing; not sending it on one that is costs
   * the entire protection. So the signal should be "is this a real deployment",
   * and `APP_ENV` is the variable that exists to be exactly that.
   *
   * What the old guard was really protecting is still protected, by the same
   * change: development sends no HSTS, so nothing pins `localhost` to HTTPS in
   * a developer's browser for a year — a state that survives every project on
   * that machine and has no obvious way back.
   */
  if (isProduction) res.setHeader('Strict-Transport-Security', HSTS)
  next()
})

app.use((req, res, next) => {
  /**
   * Unconditional, because the answer varies on `Origin` whether or not this
   * particular request carried one. Set only inside the branch, a cache that
   * stored the no-origin reply would replay it to a browser with no
   * `Access-Control-Allow-Origin` on it at all.
   */
  res.setHeader('Vary', 'Origin')

  /**
   * The echo goes through `isAllowedOrigin` rather than comparing to `ORIGIN`,
   * so there is one origin policy in this process and not two.
   *
   * In production the two are the same test: only the configured origin passes,
   * and the value echoed is the value configured. In development it picks up the
   * loopback widening the socket already had, which fixes the REST half of the
   * bug the socket was fixed for — Vite's port is assigned by the harness, so
   * pinning to exactly `CORS_ORIGIN` means every save starts failing CORS the
   * first time the dev server lands on 5174.
   */
  const origin = req.headers.origin
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  }
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

/**
 * The CSRF defence, and why it is a check on `Origin` rather than a token.
 *
 * `SameSite=Lax` on the session cookie is the first line and it is a good one:
 * a page on another site cannot make a browser attach the cookie to a
 * cross-site POST. **But `Lax` is scoped to the registrable domain, not to the
 * origin**, so a sibling subdomain is same-site as far as the cookie is
 * concerned — and four of the state-changing POSTs here read nothing from the
 * body at all (`/api/auth/logout`, `/api/boards/:id/share`,
 * `/api/boards/:id/share/code` and `/api/shares/:token/redeem`), so
 * `express.json()` being the only parser protects those four from nothing. A
 * form post with no body is still a form post, and it rotates a share link.
 *
 * **A double-submit CSRF token would be strictly weaker here, not stronger.**
 * The only attacker `Lax` lets through is one who already controls a sibling
 * subdomain — and a sibling subdomain can *write* a cookie on the parent domain,
 * which is precisely the thing a double-submit scheme reads back and compares.
 * The attacker sets both halves and the check passes. An `Origin` check has no
 * such hole: the header is set by the browser, a page cannot forge or suppress
 * it, and it names the origin rather than the domain. It also costs no state,
 * no rotation, and no coordination with the client.
 *
 * Two things pass deliberately, both of them traps this repo has already fallen
 * into on the socket side, which is why the policy is `isAllowedOrigin` and not
 * a second one written here:
 *
 *   - **No `Origin` header at all.** That is every non-browser client, `curl`
 *     included, and this entire test suite. Browsers have sent `Origin` on
 *     state-changing requests for years and a page cannot suppress it, so
 *     absence is not a state an attacker can reach — refusing it would break
 *     every caller CORS was never protecting anyone from.
 *   - **Any loopback origin, in development only.** Vite's port is assigned by
 *     the harness, so pinning to exactly `CORS_ORIGIN` means saving stops
 *     working the first time the dev server lands on 5174, with no error a
 *     developer can act on.
 *
 * `Referer` is deliberately not consulted as a fallback. Every browser that
 * would send one sends `Origin` too, and `Referer` is the header a referrer
 * policy is allowed to strip — so a second signal here would add a second thing
 * that can be wrong without adding a case the first one misses.
 *
 * Safe methods are not checked. They change nothing, and CORS already stops a
 * cross-origin page reading the reply.
 */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

app.use((req, res, next) => {
  if (!STATE_CHANGING.has(req.method)) return next()
  if (isAllowedOrigin(req.headers.origin)) return next()
  // Ahead of the routers on purpose: this is the whole security property of
  // every state-changing endpoint, and a check each route has to remember is a
  // check the next route added will not make.
  res.status(403).json({ error: 'This request did not come from an allowed origin.' })
})

app.use(express.json({ limit: '1mb' }))

// Resolve the caller once per request. Now async, since the session lookup is
// a database round trip rather than an in-process read. Express 5 forwards a
// rejected promise to the error handler on its own.
/**
 * A proxy is in front of us and has not been declared, which nothing can see at
 * boot.
 *
 * `TRUST_PROXY` unset is the safe default and the right answer whenever this
 * process is reachable directly: `req.ip` is then the socket address, which a
 * caller cannot choose. Behind nginx, an ALB or Fly it is the wrong answer and
 * fails in a way nobody notices, because it does not error. Every request looks
 * like it came from the proxy, so every per-IP allowance collapses into **one
 * global bucket**: the tenth person in the building to mistype a join code locks
 * the code out for everybody, and signup does the same. That is a denial of
 * service the deploy inflicts on itself, and the only evidence is a limiter that
 * seems to fire far too early.
 *
 * The one thing that distinguishes the two cases is a request arriving with
 * `X-Forwarded-For` already on it, so that is what is watched for. Said once and
 * then never again, because it is a deployment fact rather than a per-request
 * event, and a line per request would be its own outage.
 *
 * **It is a warning and not a refusal**, which is the opposite of the
 * `SESSION_SECRET` floor next door, and deliberately. Any caller may send this
 * header, so a refusal would hand a stranger a way to stop the process, and the
 * header is *evidence* of a proxy rather than proof of one. A wrong guess here
 * costs a log line; a wrong guess in the other direction costs the boot.
 */
let warnedAboutProxy = false

app.use(async (req, _res, next) => {
  req.clientIp = req.ip ?? 'unknown'

  if (!TRUST_PROXY && !warnedAboutProxy && req.headers['x-forwarded-for']) {
    warnedAboutProxy = true
    console.warn(
      'X-Forwarded-For is arriving but TRUST_PROXY is unset, so req.ip is the socket address ' +
        'and every per-IP rate limit is counting all traffic in a single bucket. If a proxy you ' +
        'control sits in front of this instance, set TRUST_PROXY. If nothing does, ignore this: ' +
        'a caller can send this header themselves, which is exactly why it is not trusted.',
    )
  }

  req.user = await userForToken(readCookie(req.headers.cookie, COOKIE_NAME))
  next()
})

// Reporting which instance answered makes it visible that requests are really
// spread across processes rather than all landing on one.
app.get('/api/health', (_req, res) => res.json({ ok: true, instance: INSTANCE_LABEL, pid: process.pid }))

app.use('/api/auth', authRouter)
// Sharing sits in front of the board routes: `/:id/share` and `/:id/lock` are
// more specific than anything boardsRouter answers, and reading them in that
// order matches how they resolve.
app.use('/api/boards', sharesRouter)
app.use('/api/boards', boardsRouter)
app.use('/api/shares', redeemRouter)
app.use('/api/assistant', assistantRouter)

app.use((_req, res) => res.status(404).json({ error: 'No such endpoint.' }))

/**
 * How a failure is written down, and the one thing that must not be.
 *
 * `console.error('Unhandled:', err)` passed the error *object*, and console
 * inspects an Error's own enumerable properties as well as its stack. A `pg`
 * error carries several, and one of them is `detail`, which Postgres fills with
 * the **offending column value** — `Key (email)=(someone@example.com) already
 * exists.` So a failed insert wrote a real address into the log beside the
 * trace, in a stream that is shipped somewhere, retained, and read by people who
 * have no business with it.
 *
 * `err.stack` is a plain string: name, message, frames, nothing else. That is
 * everything needed to find the line, and none of what was never ours to keep.
 * `code` is added back because it is a fixed token — a SQLSTATE, an `ECONNRESET`
 * — and losing it makes a pg failure much harder to read.
 *
 * The request's path is deliberately not logged with it. It would help, and it
 * cannot be done safely here: `/api/shares/:token/redeem` carries a live
 * credential in the path, so a handler that logged the URL of anything that
 * threw would be writing share tokens into the same stream.
 */
const forLog = (err) => {
  if (!(err instanceof Error)) return `non-Error value thrown: ${String(err)}`
  const code = typeof err.code === 'string' ? ` [${err.code}]` : ''
  return `${err.stack ?? `${err.name}: ${err.message}`}${code}`
}

/**
 * Anything carrying a status has already said what it is: BadRequest sets 400
 * and TooManyRequests 429, so one branch answers both. The header is the only
 * thing that is particular to being rate limited, and `field` is dropped from
 * the body by JSON.stringify wherever there isn't one.
 *
 * Worth being exact about which branch handles what, because it is easy to
 * misread: `express.json()` sets `status` on its own errors, so a malformed or
 * oversized body is answered *here*, by the first branch, with its own message
 * — which describes the caller's own payload and nothing else. Only errors with
 * no status at all reach the log below, and those are ours: a bug, a database
 * failure, a dropped connection. The client is told nothing about any of them,
 * which is what the fixed body below is for.
 */
app.use((err, _req, res, _next) => {
  if (err instanceof TooManyRequests) res.setHeader('Retry-After', String(err.retryAfter))
  if (err?.status) return res.status(err.status).json({ error: err.message, field: err.field })
  console.error('Unhandled:', forLog(err))
  res.status(500).json({ error: 'Something went wrong on our end.' })
})

const server = createServer(app)
const realtime = await attachRealtime(server)

/**
 * Only one instance needs to sweep; the rest would run the same DELETEs against
 * the same rows.
 *
 * Five things accumulate. Sessions, reset links and auth challenges expire on a
 * timestamp the row carries. Rate-limit allowances do not expire at all on their
 * own, and several of them are keyed on values a stranger chooses, so without
 * this the table grows by one row per distinct address anyone has ever typed
 * into "forgot password". Session revocations are kept deliberately, so that an
 * instance whose bus was down can catch up on them, and stop being worth
 * keeping once the session each one names could no longer have been alive.
 *
 * The `factor:` allowances need no entry of their own: they do not match
 * `account:%`, so `purgeStaleAllowances` already ages them out exactly as it
 * does `answer:`, and the fifteen minute lockout is far inside the twenty-four
 * hour retention, so nothing is handed back that is still being withheld.
 */
if (process.env.RUN_MAINTENANCE !== 'false') {
  const sweep = async () => {
    for (const [what, purge] of [
      ['Session', purgeExpiredSessions],
      ['Reset link', purgeExpiredResets],
      ['Auth challenge', purgeExpiredChallenges],
      ['Rate limit', purgeStaleAllowances],
      ['Session revocation', purgeExpiredRevocations],
    ]) {
      await purge().catch((err) => console.error(`${what} purge failed:`, err.message))
    }
  }
  const purge = setInterval(() => void sweep(), 60 * 60 * 1000)
  purge.unref?.()
}

server.listen(PORT, () => {
  console.log(
    `API instance ${INSTANCE_LABEL} on :${PORT} (ws /ws, ${APP_ENV}, allowing ${ORIGIN})`,
  )
})

const shutdown = async (signal) => {
  console.log(`${INSTANCE_LABEL} shutting down (${signal})`)
  server.close()
  await realtime.close().catch(() => {})
  await closePool().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

/**
 * The two failures that never touch Express, and therefore never touched the
 * handler above.
 *
 * A rejection nobody awaited, or a throw from a timer, a socket callback or the
 * LISTEN/NOTIFY bus, went to Node's default handler — which prints the error
 * **fully inspected**, own properties and all. That is the exact leak `forLog`
 * exists to close, reached by the one path that was not going through it: a `pg`
 * error escaping any of those places printed its `detail`, and its `detail` is
 * the offending column value.
 *
 * **The process still dies, and that is deliberate.** Node's default for both of
 * these is to exit non-zero, and an uncaught exception means the process is in a
 * state nobody has reasoned about — a handler that swallowed one and carried on
 * would be trading a crash a supervisor restarts from for a instance that stays
 * in the pool while quietly not working. So this changes what is written down
 * and nothing else. No graceful drain either: whatever went wrong may be exactly
 * the thing a drain would wait on.
 *
 * Registered here, at the end, rather than at the top of the file, so that a
 * refusal to boot — an unrecognised `APP_ENV`, a missing `SESSION_SECRET`, a
 * cleartext `CORS_ORIGIN`, an absent `DATABASE_URL` — keeps reaching the
 * operator by the route it always
 * has. Those throw during module evaluation, before this line runs, and the
 * message they print is the whole point of them.
 */
for (const event of ['unhandledRejection', 'uncaughtException']) {
  process.on(event, (err) => {
    console.error(`Fatal (${event}):`, forLog(err))
    process.exit(1)
  })
}
