import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DATABASE_URL } from './env.js'
import { DOCUMENT_CSP } from '../../src/lib/csp.js'

/**
 * `SERVE_STATIC=true`, which is the whole of the single-origin deployment.
 *
 * **This file exists because nothing asserted any of it, and the feature was
 * broken from the day it landed.** `6a4ce0b` taught this process to serve
 * `dist/`, and the security-header middleware — written when every response here
 * was JSON — kept setting `default-src 'none'` on all of them. So the page went
 * out forbidding its own scripts: `#root` with zero children, the bundle in the
 * DOM having never executed, nothing logged anywhere.
 *
 * **The reason it survived review is worth more than the bug.** The verification
 * written down at the time checked that `/` returned 200 `text/html` and that the
 * hashed bundle returned `text/javascript`. Both are true of the broken build.
 * A CSP defect is invisible to anything that does not execute the page, so the
 * assertion has to be on the policy itself, which is what this does.
 *
 * Two instances, because the flag's whole point is that it changes behaviour and
 * the off case has to keep working: an API with no `dist/` behind it must still
 * answer `No such endpoint.` rather than reaching for a file.
 *
 * **Nothing here depends on `dist/` having been built.** The header is set by
 * middleware that runs long before anything looks for a file, so the policy is
 * observable whether the build exists or not, and asserting the body would make
 * this suite fail on a clean checkout for a reason that is not about security.
 * The status code is deliberately not asserted on document paths for the same
 * reason.
 *
 * Nothing here writes a row, so this file has nothing to clean up and cannot
 * collide with a concurrent one.
 */

const STATIC_PORT = 8825
const API_ONLY_PORT = 8826
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

const children = []
const stderrFor = new Map()

function startInstance(port, env) {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      RUN_MAINTENANCE: 'false',
      INSTANCE_LABEL: `static-${port}`,
      DATABASE_URL,
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

const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`)
const cspOf = (res) => res.headers.get('content-security-policy')

before(async () => {
  startInstance(STATIC_PORT, { SERVE_STATIC: 'true' })
  startInstance(API_ONLY_PORT, {})
  await Promise.all([waitForHealth(STATIC_PORT), waitForHealth(API_ONLY_PORT)])
})

after(() => {
  for (const child of children) child.kill()
})

/* -------------------------------------------------------------------------- */
/* The document gets a policy a document can live under                        */
/* -------------------------------------------------------------------------- */

test('the document carries the document policy, not the API one', async () => {
  const res = await get(STATIC_PORT, '/')
  assert.equal(cspOf(res), DOCUMENT_CSP)
})

test('a client route carries it too, since the fallback serves the same page', async () => {
  // `/board` is served by the SPA fallback rather than by a file on disk, and it
  // goes through a different branch than `/` does. Both are documents.
  const res = await get(STATIC_PORT, '/board')
  assert.equal(cspOf(res), DOCUMENT_CSP)
})

test('the document policy permits the page to load its own scripts', async () => {
  // The property the bug violated, asserted as itself rather than as a string
  // comparison. `default-src 'none'` with no script-src is a page that cannot
  // boot, and that is precisely what was being sent.
  const csp = cspOf(await get(STATIC_PORT, '/'))
  assert.match(csp, /script-src 'self'/)
  assert.doesNotMatch(csp, /default-src 'none'/)
})

test('the bundle is not served under a policy stricter than the page', async () => {
  const res = await get(STATIC_PORT, '/assets/anything.js')
  assert.equal(cspOf(res), DOCUMENT_CSP)
})

/* -------------------------------------------------------------------------- */
/* The API keeps the policy the API needs                                      */
/* -------------------------------------------------------------------------- */

test('an API reply on the same instance keeps default-src none', async () => {
  // The other half, and the one a careless fix breaks. Relaxing the API's policy
  // to make the page work would be a real regression that no page-level check
  // would notice.
  const res = await get(STATIC_PORT, '/api/health')
  assert.equal(res.status, 200)
  assert.match(cspOf(res), /default-src 'none'/)
})

test('a missing API endpoint is still JSON, and still under the API policy', async () => {
  const res = await get(STATIC_PORT, '/api/nope')
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'No such endpoint.')
  assert.match(cspOf(res), /default-src 'none'/)
})

/* -------------------------------------------------------------------------- */
/* With the flag off, nothing about a local run changes                        */
/* -------------------------------------------------------------------------- */

test('without the flag every response is an API response', async () => {
  const res = await get(API_ONLY_PORT, '/board')
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'No such endpoint.')
  assert.match(cspOf(res), /default-src 'none'/)
})

test('the flag is the literal string true and nothing else', async () => {
  // `SERVE_STATIC=1` reads as off. It is worth an assertion because the failure
  // is quiet — the server 404s the whole site — and because an earlier draft of
  // the deployment plan told people to write exactly that.
  const port = 8827
  startInstance(port, { SERVE_STATIC: '1' })
  await waitForHealth(port)
  const res = await get(port, '/board')
  assert.equal(res.status, 404)
})
