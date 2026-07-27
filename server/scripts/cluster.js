/**
 * Runs several API instances behind one port.
 *
 * Each child is a separate process with its own connection pool and its own
 * WebSocket connections; they share nothing except Postgres. The parent is a
 * plain round-robin proxy, standing in for whatever balancer you would use in
 * production (nginx, ALB, Fly's proxy).
 *
 * WebSocket upgrades are proxied too, and deliberately not sticky: because
 * rooms are synchronised through LISTEN/NOTIFY, any instance can serve any
 * socket. That is the property being demonstrated.
 *
 *   node scripts/cluster.js          # 3 instances behind :8787
 *   INSTANCES=5 node scripts/cluster.js
 */
import { fork } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ENTRY = resolve(here, '../src/index.js')

const COUNT = Number(process.env.INSTANCES ?? 3)
const PUBLIC_PORT = Number(process.env.PORT ?? 8787)
const FIRST_CHILD_PORT = PUBLIC_PORT + 1

const children = []
const ports = []

for (let i = 0; i < COUNT; i++) {
  const port = FIRST_CHILD_PORT + i
  ports.push(port)
  children.push(
    fork(ENTRY, {
      env: {
        ...process.env,
        PORT: String(port),
        INSTANCE_LABEL: `api-${i + 1}`,
        // Safe here and only here: the balancer below overwrites the header
        // with the real peer address, so one hop of it is the truth.
        TRUST_PROXY: '1',
        // One instance is enough to run the periodic cleanup.
        RUN_MAINTENANCE: i === 0 ? 'true' : 'false',
      },
      stdio: 'inherit',
    }),
  )
}

/**
 * Headers to forward, with the caller's real address stamped on.
 *
 * Overwritten rather than appended: whatever the client sent is a claim about
 * its own address, and passing that through is exactly what turns `trust proxy`
 * into a way to choose your own rate-limit bucket. Without setting it at all,
 * every instance sees 127.0.0.1 and the per-IP limits become one global bucket
 * shared by everybody, which is the same bug from the other side.
 */
const forwarded = (req) => ({
  ...req.headers,
  'x-forwarded-for': req.socket.remoteAddress ?? '',
})

let next = 0
const nextPort = () => {
  const port = ports[next % ports.length]
  next++
  return port
}

const proxy = createServer((clientReq, clientRes) => {
  const port = nextPort()
  const upstream = httpRequest(
    { host: '127.0.0.1', port, path: clientReq.url, method: clientReq.method, headers: forwarded(clientReq) },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(clientRes)
    },
  )
  upstream.on('error', () => {
    if (!clientRes.headersSent) clientRes.writeHead(502, { 'Content-Type': 'application/json' })
    clientRes.end(JSON.stringify({ error: 'No API instance answered.' }))
  })
  clientReq.pipe(upstream)
})

// Raw TCP splice for the WebSocket handshake and everything after it.
proxy.on('upgrade', (req, socket, head) => {
  const port = nextPort()
  const upstream = connect(port, '127.0.0.1', () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(forwarded(req))
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\r\n') +
        '\r\n\r\n',
    )
    if (head?.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

proxy.listen(PUBLIC_PORT, () => {
  console.log(
    `Balancer on :${PUBLIC_PORT} → ${COUNT} instances (${ports.join(', ')}), round robin, WS included.`,
  )
})

const shutdown = () => {
  for (const child of children) child.kill('SIGTERM')
  proxy.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
