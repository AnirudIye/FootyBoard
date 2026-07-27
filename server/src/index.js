import express from 'express'
import { createServer } from 'node:http'
import {
  migrate,
  purgeExpiredSessions,
  purgeStaleAllowances,
  closePool,
} from './db.js'
import { initEncryption } from './crypto.js'
import { userForToken, readCookie, COOKIE_NAME } from './auth.js'
import { attachRealtime } from './realtime.js'
import { purgeExpiredResets } from './passwordReset.js'
import { authRouter } from './routes/auth.js'
import { boardsRouter } from './routes/boards.js'
import { sharesRouter, redeemRouter } from './routes/shares.js'
import { assistantRouter } from './routes/assistant.js'
import { TooManyRequests } from './rateLimit.js'
import { ORIGIN, APP_ENV } from './env.js'

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

// Safe to run in every instance: migrate() takes an advisory lock, so
// simultaneous boots serialise rather than racing on the catalogue.
await migrate()

const app = express()

if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY)
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

app.use((req, res, next) => {
  if (req.headers.origin === ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ORIGIN)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

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

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  // Only on a connection that is already secure. Sent over plain HTTP it is
  // ignored by browsers and actively wrong in development, where it would pin
  // localhost to HTTPS in the developer's browser for a year. `req.secure`
  // follows `trust proxy`, so a TLS-terminating proxy has to be declared for
  // this to fire behind one, which is the same variable the rate limiters need.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
})

// Resolve the caller once per request. Now async, since the session lookup is
// a database round trip rather than an in-process read. Express 5 forwards a
// rejected promise to the error handler on its own.
app.use(async (req, _res, next) => {
  req.clientIp = req.ip ?? 'unknown'
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
 * Anything carrying a status has already said what it is: BadRequest sets 400
 * and TooManyRequests 429, so one branch answers both. The header is the only
 * thing that is particular to being rate limited, and `field` is dropped from
 * the body by JSON.stringify wherever there isn't one.
 */
app.use((err, _req, res, _next) => {
  if (err instanceof TooManyRequests) res.setHeader('Retry-After', String(err.retryAfter))
  if (err?.status) return res.status(err.status).json({ error: err.message, field: err.field })
  console.error('Unhandled:', err)
  res.status(500).json({ error: 'Something went wrong on our end.' })
})

const server = createServer(app)
const realtime = await attachRealtime(server)

/**
 * Only one instance needs to sweep; the rest would run the same DELETEs against
 * the same rows.
 *
 * Three things accumulate. Sessions and reset links expire on a timestamp the
 * row carries. Rate-limit allowances do not expire at all on their own, and
 * several of them are keyed on values a stranger chooses, so without this the
 * table grows by one row per distinct address anyone has ever typed into
 * "forgot password".
 */
if (process.env.RUN_MAINTENANCE !== 'false') {
  const sweep = async () => {
    for (const [what, purge] of [
      ['Session', purgeExpiredSessions],
      ['Reset link', purgeExpiredResets],
      ['Rate limit', purgeStaleAllowances],
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
