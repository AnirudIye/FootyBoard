import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DATABASE_URL } from './env.js'

/**
 * The perimeter, asserted against a real instance rather than against a mock.
 *
 * Every property here is a property of the middleware *chain* — what order
 * things run in, what a response carries before any route sees it, and what
 * happens to a request that never reaches a route at all. None of that survives
 * being tested against a hand-built `app`: the defects these cover were all
 * "the real chain does something the code reads as if it did not", and a second
 * app assembled in a test file would have reproduced the reading rather than
 * the behaviour. So this spawns `index.js` exactly as `npm start` does, which is
 * the same thing `sharing.integration.test.js` decided for the same reason.
 *
 * Two instances, because two of these controls are the ones that follow
 * `APP_ENV` and there is no way to see both branches from one process. The
 * production instance is given real key material rather than being allowed to
 * fall back, since production refuses to boot without it, which is itself the
 * behaviour `env.js` exists to have.
 *
 * Nothing here writes a row. Every request is either a GET, a logout with no
 * session behind it (`destroySession` returns 0 on a null token without
 * touching the database), or a request refused before it reaches a handler, so
 * this file has nothing to clean up and cannot collide with a concurrent one.
 */

const DEV_PORT = 8822
const PROD_PORT = 8823
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

/** The origin the production instance is configured to allow. */
const PROD_ORIGIN = 'https://footyboard.test'

/** Somewhere a page could be served from that is not us. */
const FOREIGN_ORIGIN = 'https://evil.example'

const children = []

/** Everything each instance has said on stderr, so a test can assert on it. */
const stderrFor = new Map()

function startInstance(port, env) {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      RUN_MAINTENANCE: 'false',
      INSTANCE_LABEL: `security-${port}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  stderrFor.set(port, '')
  child.stderr.on('data', (d) => stderrFor.set(port, stderrFor.get(port) + String(d)))
  children.push(child)
  return child
}

async function waitForHealth(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(
    `instance on :${port} never became healthy. Its stderr was:\n${stderrFor.get(port)}`,
  )
}

const call = (port, path, init = {}) => fetch(`http://127.0.0.1:${port}/api${path}`, init)

/**
 * A logout with nothing to log out of.
 *
 * The cheapest state-changing POST in the API that needs no body, no session
 * and no row: exactly the shape the Origin check exists for, and exactly the
 * shape that made `express.json()` no protection at all. It also sets the
 * session cookie on the way out, which is how the `Secure` flag is observed
 * without minting a session first.
 */
const logout = (port, headers = {}) => call(port, '/auth/logout', { method: 'POST', headers })

before(async () => {
  startInstance(DEV_PORT, {})
  startInstance(PROD_PORT, {
    APP_ENV: 'production',
    // Production refuses to boot without each of these, which is the point of
    // env.js. Supplying them here is not weakening the test; it is the only way
    // to have a production instance to test at all.
    SESSION_SECRET: 'f'.repeat(64),
    ENCRYPTION_KEY: 'a'.repeat(64),
    CORS_ORIGIN: PROD_ORIGIN,
    // Imported rather than typed out: this instance has to reach the same local
    // database every other suite does, and a fourth spelling of that string is
    // exactly what env.js was changed to stop. Without it the child refuses to
    // boot and the only symptom is a twenty-second health-check timeout.
    DATABASE_URL,
  })
  await Promise.all([waitForHealth(DEV_PORT), waitForHealth(PROD_PORT)])
})

after(() => {
  for (const child of children) child.kill()
})

/* -------------------------------------------------------------------------- */
/* A malformed cookie from a stranger                                          */
/* -------------------------------------------------------------------------- */

/**
 * `sb_session=%` is not a percent-escape, so decoding it throws.
 *
 * That throw came out of the middleware that resolves `req.user`, which every
 * request goes through, so it reached the error handler with no `status` on it
 * and was answered 500 with a stack printed beside it. Both halves are wrong: a
 * cookie a client sent is the client's mistake, and a stranger who can pick how
 * much goes into the log stream can fill it.
 *
 * The fix is a tolerant parse rather than a 400, and the reason is two lines
 * down: the endpoint that clears the cookie reads it too.
 */
test('a cookie that cannot be decoded is not a server error', async () => {
  const before = stderrFor.get(DEV_PORT).length

  const res = await call(DEV_PORT, '/auth/me', { headers: { Cookie: 'sb_session=%' } })
  const body = await res.json()

  assert.equal(res.status, 401, 'a malformed cookie answered as though the server had broken')
  assert.deepEqual(body, { error: 'Not signed in.' }, 'the reply says only what it should')

  // Give the child a moment to have written anything it was going to write.
  await new Promise((r) => setTimeout(r, 200))
  const logged = stderrFor.get(DEV_PORT).slice(before)
  assert.ok(!logged.includes('Unhandled:'), `a stranger's cookie reached the error log:\n${logged}`)
  assert.ok(!logged.includes('URIError'), `a stack trace was printed:\n${logged}`)
})

/**
 * The reason this is not answered 400.
 *
 * A browser cannot delete an httpOnly cookie from JavaScript, and the only
 * endpoint that clears this one reads it first. Answering 400 on a cookie we
 * cannot parse would therefore make a mangled cookie permanent: every request
 * refused, and the one call that would fix it refused along with them.
 */
test('a cookie that cannot be decoded can still be cleared', async () => {
  const res = await logout(DEV_PORT, { Cookie: 'sb_session=%' })
  assert.equal(res.status, 204)
  assert.match(String(res.headers.get('set-cookie')), /sb_session=;/)
})

test('the rest of the API is reachable with a malformed cookie on the request', async () => {
  const res = await call(DEV_PORT, '/health', { headers: { Cookie: 'sb_session=%20%zz' } })
  assert.equal(res.status, 200)
})

/* -------------------------------------------------------------------------- */
/* Origin                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The trap that has already been fallen into once, on the socket side.
 *
 * Nothing that is not a browser sends `Origin`, including every request this
 * suite makes and every `curl` anybody will ever debug with. Refusing those
 * would break the entire test run, and would protect nobody: a page cannot
 * suppress the header, so absence is not a state an attacker can reach.
 */
test('a state-changing request with no Origin header at all is allowed', async () => {
  assert.equal((await logout(DEV_PORT)).status, 204)
})

test('a state-changing request from another origin is refused', async () => {
  const res = await logout(DEV_PORT, { Origin: FOREIGN_ORIGIN })
  assert.equal(res.status, 403, 'a cross-origin POST was let through')
  const body = await res.json()
  assert.match(body.error, /origin/i)
})

/**
 * The check has to sit in front of the routes rather than inside them.
 *
 * If it ran per route it would be a thing each route has to remember, and the
 * four that need no body are exactly the four somebody would forget. Asserting
 * on methods whose handlers answer 401 without a session proves the refusal
 * happens first: a 403 here means the request never reached the handler.
 */
test('every state-changing method is covered, and the refusal comes before the route', async () => {
  const cases = [
    ['POST', '/auth/logout'],
    ['DELETE', '/auth/me'],
    ['PATCH', '/auth/display-name'],
    ['PUT', '/boards/00000000-0000-0000-0000-000000000000'],
  ]
  for (const [method, path] of cases) {
    const res = await call(DEV_PORT, path, { method, headers: { Origin: FOREIGN_ORIGIN } })
    assert.equal(res.status, 403, `${method} ${path} was not refused`)
  }
})

test('a safe method is never refused on its Origin', async () => {
  // GET carries no state change, and CORS already stops the reply being read
  // cross-origin. Refusing it here would break linking to the API and prove
  // nothing.
  const res = await call(DEV_PORT, '/health', { headers: { Origin: FOREIGN_ORIGIN } })
  assert.equal(res.status, 200)
})

/**
 * The second trap, and the reason this reuses `isAllowedOrigin` rather than
 * comparing against `CORS_ORIGIN`.
 *
 * Vite's port is assigned by the harness, so the frontend is on 5173 until the
 * day it is on 5174, and a check pinned to the exact configured origin starts
 * refusing every save with no error a developer can act on.
 */
test('development allows any loopback origin, because the dev port is not fixed', async () => {
  for (const origin of ['http://localhost:5199', 'http://127.0.0.1:4173', 'http://localhost:5173']) {
    assert.equal((await logout(DEV_PORT, { Origin: origin })).status, 204, `refused ${origin}`)
  }
})

test('production does not widen to loopback, and allows only the configured origin', async () => {
  assert.equal((await logout(PROD_PORT, { Origin: 'http://localhost:5173' })).status, 403)
  assert.equal((await logout(PROD_PORT, { Origin: FOREIGN_ORIGIN })).status, 403)
  assert.equal((await logout(PROD_PORT, { Origin: PROD_ORIGIN })).status, 204)
})

/* -------------------------------------------------------------------------- */
/* Headers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The preflight is a response too.
 *
 * It used to be answered by a `return` sitting above the middleware that sets
 * every security header, so an `OPTIONS` reply carried none of them. Nothing is
 * known to be exploitable through a 204 with an empty body, and that is not the
 * argument: a header set "on every response" that is missing from a whole class
 * of them is a claim that has stopped being true, and the next person to read
 * it will believe it.
 */
test('a CORS preflight carries the same security headers as everything else', async () => {
  const res = await call(DEV_PORT, '/auth/login', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
  })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.match(String(res.headers.get('content-security-policy')), /frame-ancestors 'none'/)
  // And it is still a working preflight.
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true')
})

/**
 * HSTS follows `APP_ENV`, not `req.secure`, and this is the half that says why
 * that is safe.
 *
 * `req.secure` reads `trust proxy`, which is off unless somebody set
 * `TRUST_PROXY` — so behind a TLS-terminating proxy that has not declared
 * itself, which is the misconfiguration this repo already prints a warning
 * about, the header was never sent at all. A browser ignores HSTS received over
 * plaintext, so sending it on the deployment signal costs nothing when the
 * connection happens not to be secure, and is the only way it gets sent when it
 * is.
 */
test('production sends HSTS even on a connection this process sees as plaintext', async () => {
  const res = await call(PROD_PORT, '/health')
  const hsts = res.headers.get('strict-transport-security')
  assert.ok(hsts, 'production sent no Strict-Transport-Security')
  assert.match(hsts, /max-age=31536000/)
  assert.match(hsts, /includeSubDomains/)
  // Deliberately not submitted to the preload list, so the header does not
  // claim it has been. See the note in index.js.
  assert.ok(!hsts.includes('preload'), 'the header claims a preload submission nobody made')
})

/**
 * The half that keeps the fix from being worse than the defect.
 *
 * A year of `max-age` against `localhost` is a year of a developer's browser
 * refusing to load it over http, across every project on that machine, with no
 * obvious way back. That is what the old `req.secure` guard was protecting, and
 * it still has to be protected — just by the signal that knows what deployment
 * this is rather than by one that does not.
 */
test('development sends no HSTS, so nobody pins localhost to HTTPS for a year', async () => {
  const res = await call(DEV_PORT, '/health')
  assert.equal(res.headers.get('strict-transport-security'), null)
})

/**
 * The cookie flag on the same reasoning, asserted rather than assumed.
 *
 * `SESSION_COOKIE.secure` already followed `APP_ENV` rather than `req.secure`,
 * which is why it needed no change — but it is the same decision as the one
 * above and had no test on it, so a later edit that "made it consistent" with
 * the old HSTS guard would have been a silent downgrade.
 */
test('the session cookie is Secure in production and not in development', async () => {
  const prod = String((await logout(PROD_PORT, { Origin: PROD_ORIGIN })).headers.get('set-cookie'))
  assert.match(prod, /Secure/, 'production cleared the session cookie without Secure')

  const dev = String((await logout(DEV_PORT)).headers.get('set-cookie'))
  assert.ok(!/Secure/.test(dev), 'development marked the cookie Secure, which no dev browser sends')
})

/**
 * Nothing internal reaches the client, on any of these paths.
 *
 * The generic 500 body is the one the error handler already sent; what is being
 * asserted is that none of the new refusals took a shortcut and echoed
 * something back.
 */
test('no refusal leaks a stack, a query or an internal message', async () => {
  const responses = await Promise.all([
    logout(DEV_PORT, { Origin: FOREIGN_ORIGIN }),
    call(DEV_PORT, '/auth/me', { headers: { Cookie: 'sb_session=%' } }),
    call(DEV_PORT, '/nope'),
  ])
  for (const res of responses) {
    const text = await res.text()
    for (const smell of ['at ', 'SELECT', 'node:internal', 'Error:', '.js:']) {
      assert.ok(!text.includes(smell), `a response body contained "${smell}": ${text}`)
    }
  }
})
