import express from 'express'
import { createServer } from 'node:http'
import { migrate, purgeExpiredSessions, closePool } from './db.js'
import { initEncryption } from './crypto.js'
import { userForToken, readCookie, COOKIE_NAME } from './auth.js'
import { attachRealtime } from './realtime.js'
import { authRouter } from './routes/auth.js'
import { boardsRouter } from './routes/boards.js'
import { sharesRouter, redeemRouter } from './routes/shares.js'
import { assistantRouter } from './routes/assistant.js'
import { BadRequest } from './validate.js'
import { TooManyRequests } from './rateLimit.js'

const PORT = Number(process.env.PORT ?? 8787)
const ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173'

// Fail fast: a misconfigured key should stop startup, not surface later as a
// board that cannot be opened.
initEncryption()

// Safe to run in every instance: migrate() takes an advisory lock, so
// simultaneous boots serialise rather than racing on the catalogue.
await migrate()

const app = express()

app.set('trust proxy', 1)
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

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  next()
})

// Resolve the caller once per request. Now async, since the session lookup is
// a database round trip rather than an in-process read.
app.use(async (req, _res, next) => {
  try {
    req.clientIp = req.ip ?? 'unknown'
    req.user = await userForToken(readCookie(req.headers.cookie, COOKIE_NAME))
    next()
  } catch (err) {
    next(err)
  }
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

app.use((err, _req, res, _next) => {
  if (err instanceof BadRequest) return res.status(400).json({ error: err.message, field: err.field })
  if (err instanceof TooManyRequests) {
    res.setHeader('Retry-After', String(err.retryAfter))
    return res.status(429).json({ error: err.message })
  }
  if (err?.status) return res.status(err.status).json({ error: err.message })
  console.error('Unhandled:', err)
  res.status(500).json({ error: 'Something went wrong on our end.' })
})

const INSTANCE_LABEL = process.env.INSTANCE_LABEL ?? `pid-${process.pid}`

const server = createServer(app)
const realtime = await attachRealtime(server)

// Only one instance needs to sweep expired sessions; the rest would just be
// running the same DELETE against the same rows.
if (process.env.RUN_MAINTENANCE !== 'false') {
  const purge = setInterval(() => {
    purgeExpiredSessions().catch((err) => console.error('Session purge failed:', err.message))
  }, 60 * 60 * 1000)
  purge.unref?.()
}

server.listen(PORT, () => {
  console.log(`API instance ${INSTANCE_LABEL} on :${PORT} (ws /ws, allowing ${ORIGIN})`)
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
