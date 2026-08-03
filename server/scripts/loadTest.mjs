/**
 * Plan 010, Phase 0: find out where this breaks before inviting a crowd.
 *
 *     npm --prefix server run load-test
 *
 * 008 put the origin on a desktop in a room behind a home upload link. That is a
 * fine host for a quiet tool and an unusual one to point a front-page thread at.
 * Cloudflare caches `dist/` at its edge, so the static bundle is not the worry:
 * the worry is the API and the WebSocket, one Node process, where **every open
 * board is a held connection rather than a request that finishes**. This ramps
 * held connections until something gives and writes down what gave.
 *
 * It lives in `server/scripts/` rather than the root `scripts/` for one reason:
 * it needs a WebSocket client that can set headers, Node's global `WebSocket`
 * cannot (the WHATWG constructor takes url and protocols and nothing else), and
 * `ws` is already a dependency here and nowhere else. No new dependency.
 *
 * **It was called `load-test.mjs` and that name broke the suite.** `npm --prefix
 * server test` is a bare `node --test`, whose default patterns include
 * `**\/*-test.?(c|m)js` — so the runner discovered this file, ran it, and it
 * exited non-zero asking for credentials it is never given in a test run. One
 * failure among three hundred passes, at a path that is obviously not a test.
 * The npm script keeps the name `load-test`, because that is not what the runner
 * reads. `src/testDiscovery.test.js` now fails on any file with a name in that
 * set, so the next one is caught by a message that names the glob.
 *
 * ## It aims at staging, and argues if you aim it elsewhere
 *
 * `tunnel.footyboard.me` is still routed precisely so this can be done without
 * touching `www`. Pointing a few hundred sockets at the origin your users are on
 * is not a load test, it is an outage with a spreadsheet, so `www` needs
 * `--yes-really-production` and a reason you are happy to write in the log.
 *
 * ## Why the target and the declared origin are two different things
 *
 * **A board cannot open a room on `tunnel.footyboard.me` at all.** Measured
 * 2026-08-02:
 *
 *     Origin: https://tunnel.footyboard.me  ->  upgrade refused, HTTP 401
 *     Origin: https://www.footyboard.me     ->  accepted, then 4401 with no cookie
 *
 * The socket's `verifyClient` is `isAllowedOrigin(origin)` against `CORS_ORIGIN`,
 * which is the single value `https://www.footyboard.me`. So the staging hostname
 * serves the page and answers REST, and the realtime half of the product is dead
 * on it — which is awkward, because held sockets are the exact thing Phase 0
 * exists to measure. Plan 010's "the staging hostname is still routed so this can
 * be measured without touching www" is true of HTTP and false of the socket.
 *
 * `--declaredOrigin` is the way through: send the Origin header the server will
 * accept while pointing the packets at staging. The header is a claim, the
 * server only compares it to a string, and both hostnames are the same tunnel to
 * the same process — so this measures the real thing and touches no user. It is
 * spoofing an origin against infrastructure you own, said plainly rather than
 * left for somebody to notice in the arguments.
 *
 * The honest alternative is to widen `CORS_ORIGIN` to a list including the
 * staging host, which would make staging a real environment rather than a
 * half one. That is a deployment decision and this script is not the place for
 * it; `--probe` reports the state so it can be made deliberately.
 *
 * ## What it can and cannot simulate, stated up front
 *
 * **It holds N sockets on one account, not N distinct guests.** That is
 * deliberate and it is the honest shape of the thing:
 *
 *   - `MAX_GUESTS_PER_SHARE` is 200 per share. That is a constant, not a
 *     measurement. Knowing it is the whole of Phase 0's second bullet.
 *   - `POST /api/shares/join` is rate limited to **10 per ten minutes per IP**.
 *     A load generator is one IP, so the guest path cannot mint more than ten
 *     sessions in a window however hard it tries, and a test that fought that
 *     limit would be measuring the limiter.
 *   - Which is itself a finding rather than an obstacle, and `--probe` prints
 *     it: a school or a club behind one NAT is also one IP. Thirty pupils
 *     following a code get ten joins and twenty refusals, and the twenty are
 *     told to try later. That is a product decision waiting to be made, not a
 *     capacity problem.
 *
 * So this measures the thing that actually falls over under a crowd — held
 * sockets, the relay's fan-out, and REST latency while they are held — and
 * leaves the admission limits to be read off rather than hammered.
 *
 * ## Credentials
 *
 * `LOADTEST_EMAIL` and `LOADTEST_PASSWORD` from the environment, never from
 * argv: a password on a command line is in the shell history and in every
 * process listing on the box. Use an account with no second factor; one with a
 * factor gets a challenge instead of a session and this says so and stops.
 */

import { WebSocket } from 'ws'

const DEFAULTS = {
  /** Where the packets go. */
  origin: 'https://tunnel.footyboard.me',
  /**
   * What the `Origin` header claims, for REST and for the socket upgrade.
   * Defaults to the deployment's `CORS_ORIGIN`, not to `--origin`, because the
   * socket refuses anything else outright. See the header.
   */
  declaredOrigin: 'https://www.footyboard.me',
  sockets: 200,
  batch: 25,
  interval: 1000,
  hold: 30,
  board: '',
  ops: 0,
  // Give up once this share of a batch fails to reach `welcome`. The point is
  // to find the edge, not to sit on the far side of it hammering.
  tolerate: 0.1,
}

function parseArgs(argv) {
  const out = { ...DEFAULTS, probe: false, production: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--probe') out.probe = true
    else if (arg === '--yes-really-production') out.production = true
    else if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[++i]
      if (!(key in DEFAULTS)) throw new Error(`Unknown option --${key}`)
      out[key] = typeof DEFAULTS[key] === 'number' ? Number(value) : value
    } else throw new Error(`Unexpected argument ${arg}`)
  }
  return out
}

const pct = (sorted, p) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

const summarise = (values) => {
  const s = [...values].sort((a, b) => a - b)
  return s.length === 0
    ? 'no samples'
    : `n=${s.length} p50=${pct(s, 50)}ms p95=${pct(s, 95)}ms max=${s.at(-1)}ms`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** REST, with the Origin the CORS check wants and the cookie the session is. */
async function api(cfg, path, { method = 'GET', body, cookie } = {}) {
  const started = Date.now()
  const res = await fetch(new URL(path, cfg.origin), {
    method,
    headers: {
      Origin: cfg.declaredOrigin,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { res, ms: Date.now() - started }
}

async function signIn(cfg) {
  const email = process.env.LOADTEST_EMAIL
  const password = process.env.LOADTEST_PASSWORD
  if (!email || !password) {
    throw new Error(
      'Set LOADTEST_EMAIL and LOADTEST_PASSWORD in the environment. They are not accepted as arguments, because a password on a command line lands in the shell history and in every process listing.',
    )
  }

  const { res } = await api(cfg, '/api/auth/login', {
    method: 'POST',
    body: { email, password },
  })
  if (!res.ok) throw new Error(`Sign-in failed: ${res.status} ${(await res.text()).slice(0, 200)}`)

  const payload = await res.json()
  if (payload.challenge) {
    throw new Error(
      'That account has two-factor enabled, so signing in returns a challenge rather than a session. Use an account without a second factor for load testing.',
    )
  }

  const setCookie = res.headers.getSetCookie?.() ?? []
  const session = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('sb_session='))
  if (!session) throw new Error('Signed in but no sb_session cookie came back.')
  return session
}

/**
 * One socket, resolved when the room actually admits it.
 *
 * `open` is the wrong signal and getting it wrong would flatter every number
 * here: the server accepts the upgrade, then reads the cookie, then authorizes
 * the board, and only then sends `welcome`. A socket rejected for an ended
 * session opens perfectly and closes 4401 a moment later. Waiting for `welcome`
 * is waiting for the thing a person would call being in the room.
 */
function openSocket(cfg, cookie, boardId, record) {
  return new Promise((resolve) => {
    const started = Date.now()
    const url = new URL('/ws', cfg.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('board', boardId)

    let settled = false
    const socket = new WebSocket(url, {
      headers: { Cookie: cookie, Origin: cfg.declaredOrigin },
    })

    const done = (ok, why) => {
      if (settled) return
      settled = true
      resolve({ ok, why, socket })
    }

    const timer = setTimeout(() => {
      done(false, 'timeout waiting for welcome')
      socket.terminate()
    }, 20_000)

    socket.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type === 'welcome') {
        clearTimeout(timer)
        record.welcomeMs.push(Date.now() - started)
        done(true)
      }
    })

    socket.on('close', (code, reason) => {
      clearTimeout(timer)
      record.closes.set(code, (record.closes.get(code) ?? 0) + 1)
      done(false, `closed ${code} ${reason?.toString().slice(0, 80) ?? ''}`.trim())
    })

    // The upgrade itself being refused, which is a different failure from a
    // socket that opened and was then closed. `verifyClient` answers 401 here
    // for a disallowed Origin, and reading that as "the server is full" is how
    // a capacity number becomes fiction.
    socket.on('unexpected-response', (_req, res) => {
      clearTimeout(timer)
      record.upgradeRefusals.set(
        res.statusCode,
        (record.upgradeRefusals.get(res.statusCode) ?? 0) + 1,
      )
      socket.terminate()
      done(false, `upgrade refused, http ${res.statusCode}`)
    })

    socket.on('error', (err) => {
      clearTimeout(timer)
      record.errors.push(err.message.slice(0, 120))
      done(false, err.message.slice(0, 80))
    })
  })
}

/** What the limits are, read off the code and confirmed against the target. */
async function probe(cfg) {
  console.log(`\nProbing ${cfg.origin}\n`)

  const checks = [
    ['/', 'the document'],
    ['/robots.txt', 'robots.txt'],
    // Real, and it names the instance: `{"ok":true,"instance":"pid-9044"}`.
    // Under the cluster that is how you tell which of the three answered.
    ['/api/health', 'the API, which also names the instance'],
  ]
  for (const [path, what] of checks) {
    try {
      const { res, ms } = await api(cfg, path)
      console.log(`  ${res.status}  ${ms}ms  ${path}  (${what})`)
    } catch (err) {
      console.log(`  ERR        ${path}  ${err.message}`)
    }
  }

  // The socket's origin check, which decides whether this host can hold a room
  // at all. Answered without a session: a refused upgrade and a 4401 are
  // different answers and only the first is about the origin.
  console.log('\n  Socket upgrade, by declared origin:\n')
  for (const origin of [cfg.origin, cfg.declaredOrigin]) {
    const verdict = await new Promise((resolve) => {
      const url = new URL('/ws', cfg.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('board', 'probe')
      const ws = new WebSocket(url, { headers: { Origin: origin } })
      const t = setTimeout(() => {
        ws.terminate()
        resolve('timeout')
      }, 15_000)
      const say = (v) => {
        clearTimeout(t)
        ws.terminate()
        resolve(v)
      }
      ws.on('unexpected-response', (_q, res) => say(`REFUSED at upgrade, http ${res.statusCode}`))
      ws.on('close', (c) => say(c === 4401 ? 'accepted (4401, no session, as expected)' : `closed ${c}`))
      ws.on('error', () => {})
    })
    console.log(`    ${origin.padEnd(32)} ${verdict}`)
  }
  console.log(`
  A refusal at the upgrade is CORS_ORIGIN, not capacity. If the target host
  refuses its own hostname, that host cannot open a room: the page loads, REST
  answers, and realtime is dead on it. Use --declaredOrigin to send the value
  CORS_ORIGIN is set to, or widen CORS_ORIGIN so staging is a whole environment.

  Admission limits, from the source rather than by hammering them:

    MAX_GUESTS_PER_SHARE   200 per share, over the code's lifetime
    POST /api/shares/join   10 per 10 minutes per IP
    POST /api/shares        20 per 10 minutes per IP
    socket max payload    6000 bytes, and the relay drops anything over

  The per-IP join limit is the one worth thinking about before promoting
  anything. It is per address, so a school, a club or an office behind one NAT
  is a single bucket: the eleventh person to follow a code in ten minutes is
  refused, and told to try later. That is correct against someone guessing codes
  and wrong for a squad in one building, and nothing in the product currently
  tells those two apart.
`)
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2))

  if (/(^|\.)footyboard\.me$/.test(new URL(cfg.origin).hostname) &&
      new URL(cfg.origin).hostname.startsWith('www.') && !cfg.production) {
    throw new Error(
      'Refusing to load test www. tunnel.footyboard.me is routed for exactly this. Pass --yes-really-production if you genuinely mean the origin your users are on.',
    )
  }

  if (cfg.probe) return probe(cfg)

  console.log(`\nTarget      ${cfg.origin}`)
  const cookie = await signIn(cfg)
  console.log('Signed in   yes')

  let boardId = cfg.board
  if (!boardId) {
    const { res } = await api(cfg, '/api/boards', { cookie })
    if (!res.ok) throw new Error(`Could not list boards: ${res.status}`)
    const { boards } = await res.json()
    if (!boards?.length) throw new Error('That account has no boards. Make one, or pass --board.')
    boardId = boards[0].id
  }
  console.log(`Board       ${boardId}`)
  console.log(`Ramp        ${cfg.batch} sockets every ${cfg.interval}ms, up to ${cfg.sockets}`)
  console.log(`Hold        ${cfg.hold}s\n`)

  const record = {
    welcomeMs: [],
    closes: new Map(),
    upgradeRefusals: new Map(),
    errors: [],
  }

  // One socket before two hundred. A declared origin the server will not accept
  // fails every single connection at the upgrade, and without this the run
  // reports "0 sockets accepted" and reads exactly like a machine at capacity.
  const canary = await openSocket(cfg, cookie, boardId, record)
  if (canary.ok) canary.socket.close()
  if (record.upgradeRefusals.size > 0) {
    throw new Error(
      `The socket upgrade was refused (http ${[...record.upgradeRefusals.keys()].join(', ')}) with Origin: ${cfg.declaredOrigin}.\n` +
        "That is `verifyClient` comparing it to CORS_ORIGIN, not a capacity limit. Pass --declaredOrigin with the value CORS_ORIGIN is set to on the target.",
    )
  }
  if (!canary.ok) {
    throw new Error(`A single socket could not join the room: ${canary.why}`)
  }
  console.log(`Canary      joined in ${record.welcomeMs[0]}ms\n`)
  const live = []
  const restIdle = []
  const restLoaded = []

  // A baseline before any load, or "slow under load" has nothing to be slow
  // against.
  for (let i = 0; i < 5; i++) {
    const { ms } = await api(cfg, `/api/boards/${boardId}`, { cookie })
    restIdle.push(ms)
    await sleep(200)
  }
  console.log(`REST idle   ${summarise(restIdle)}\n`)

  let brokeAt = null
  ramp: while (live.length < cfg.sockets) {
    const want = Math.min(cfg.batch, cfg.sockets - live.length)
    const results = await Promise.all(
      Array.from({ length: want }, () => openSocket(cfg, cookie, boardId, record)),
    )

    let failed = 0
    for (const r of results) {
      if (r.ok) live.push(r.socket)
      else failed++
    }

    const { ms } = await api(cfg, `/api/boards/${boardId}`, { cookie })
    restLoaded.push(ms)
    console.log(
      `  ${String(live.length).padStart(4)} live   ${failed}/${want} failed   REST ${ms}ms`,
    )

    if (failed / want > cfg.tolerate) {
      brokeAt = live.length
      console.log(`\n  Stopping: ${failed} of ${want} failed, over the ${cfg.tolerate * 100}% tolerance.`)
      break ramp
    }
    await sleep(cfg.interval)
  }

  // Hold, because a socket that connects and a socket that survives are
  // different claims, and the second is the one a room depends on.
  console.log(`\nHolding ${live.length} sockets for ${cfg.hold}s`)
  let opTimer = null
  if (cfg.ops > 0) {
    opTimer = setInterval(() => {
      for (const s of live) {
        if (s.readyState !== WebSocket.OPEN) continue
        // A cursor is ephemeral: never persisted, dropped when its peer leaves.
        // The least destructive traffic that still exercises the relay's fan-out.
        s.send(JSON.stringify({ type: 'cursor', x: Math.random() * 100, y: Math.random() * 100 }))
      }
    }, Math.max(50, 1000 / cfg.ops))
  }

  const holdStart = Date.now()
  while (Date.now() - holdStart < cfg.hold * 1000) {
    await sleep(2000)
    const { ms } = await api(cfg, `/api/boards/${boardId}`, { cookie })
    restLoaded.push(ms)
  }
  if (opTimer) clearInterval(opTimer)

  const survived = live.filter((s) => s.readyState === WebSocket.OPEN).length
  for (const s of live) s.close()
  await sleep(500)

  console.log(`
==============================================================
  Write this down. Plan 010 Phase 0 asks for where it breaks.

  Target            ${cfg.origin}
  Peak accepted     ${live.length} concurrent sockets
  Survived the hold ${survived} of ${live.length}
  Broke at          ${brokeAt ?? 'did not break inside ' + cfg.sockets}
  Welcome latency   ${summarise(record.welcomeMs)}
  REST idle         ${summarise(restIdle)}
  REST under load   ${summarise(restLoaded)}
  Close codes       ${[...record.closes].map(([c, n]) => `${c}x${n}`).join(' ') || 'none'}
  Upgrade refusals  ${[...record.upgradeRefusals].map(([c, n]) => `http ${c} x${n}`).join(' ') || 'none'}
  Socket errors     ${record.errors.length ? record.errors.slice(0, 3).join(' | ') : 'none'}
==============================================================

  Read REST-under-load against REST-idle rather than against a number you
  remember. A home upload link degrades latency long before it refuses a
  connection, so the first thing a crowd notices is the board feeling slow, not
  the board being down.
`)
}

main().catch((err) => {
  console.error(`\n${err.message}\n`)
  process.exitCode = 1
})
