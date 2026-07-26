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
        // One instance is enough to run the periodic cleanup.
        RUN_MAINTENANCE: i === 0 ? 'true' : 'false',
      },
      stdio: 'inherit',
    }),
  )
}

let next = 0
const nextPort = () => {
  const port = ports[next % ports.length]
  next++
  return port
}

const proxy = createServer((clientReq, clientRes) => {
  const port = nextPort()
  const upstream = httpRequest(
    { host: '127.0.0.1', port, path: clientReq.url, method: clientReq.method, headers: clientReq.headers },
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
        Object.entries(req.headers)
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
