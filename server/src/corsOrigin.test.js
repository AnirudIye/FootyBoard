import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * The one variable in `env.js` that had no floor under it.
 *
 * `APP_ENV` stops the boot on a value nobody recognises and `SESSION_SECRET`
 * stops it on the placeholder, both for the same reason: a security setting
 * whose failure is silent is worth refusing to start over. `CORS_ORIGIN` had
 * neither, and it defaults to `http://localhost:5173`.
 *
 * So an unset variable in production does not fail, it *succeeds* at something
 * nobody asked for: it hands credentialed cross-origin access to a cleartext
 * origin, and to one on the machine of whoever is reading the page. Everything
 * downstream then behaves correctly, which is the problem — the socket
 * handshake, the CORS echo and the REST Origin check all faithfully allow the
 * wrong thing, and the only symptom is that they do.
 *
 * The scheme is the part that cannot be argued with in production. The rest of
 * the value is checked too, because an origin that will never match anything is
 * a misconfiguration in either direction: it locks the real frontend out rather
 * than letting a stranger in, and it does it with no error either.
 */

/**
 * Load `env.js` fresh under a given environment.
 *
 * Same mechanism `env.test.js` uses, and for the same reason: a specifier that
 * has been imported once is never re-evaluated, and every check here is about
 * what happens *during* evaluation. The environment is restored key by key
 * rather than by replacing `process.env`, which would detach the object every
 * other module in this process is holding.
 */
let sequence = 0
async function loadEnv(vars) {
  const keys = ['APP_ENV', 'NODE_ENV', 'SESSION_SECRET', 'CORS_ORIGIN', 'DATABASE_URL']
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))

  for (const key of keys) delete process.env[key]
  for (const [key, value] of Object.entries(vars)) process.env[key] = value

  try {
    return await import(`./env.js?cors=${++sequence}`)
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/** Enough to clear the production floors that are not what is under test here. */
const PRODUCTION = {
  APP_ENV: 'production',
  SESSION_SECRET: 'f'.repeat(64),
  DATABASE_URL: 'postgres://app:secret@db.example.com:5432/app?sslmode=verify-full',
}

test('production refuses to boot with CORS_ORIGIN unset', async () => {
  await assert.rejects(
    () => loadEnv(PRODUCTION),
    (err) => {
      assert.match(err.message, /CORS_ORIGIN/)
      // The message has to say that the value it is refusing is a default it
      // chose, or the person reading it goes looking for where they set it.
      assert.match(err.message, /localhost:5173/)
      return true
    },
    'an unset CORS_ORIGIN booted a production process onto its http default',
  )
})

test('production refuses a cleartext origin that was set on purpose', async () => {
  await assert.rejects(
    () => loadEnv({ ...PRODUCTION, CORS_ORIGIN: 'http://app.example.com' }),
    /CORS_ORIGIN/,
    'production allowed credentialed access from an http origin',
  )
})

test('production boots on https, and exports it unchanged', async () => {
  const env = await loadEnv({ ...PRODUCTION, CORS_ORIGIN: 'https://app.example.com' })
  assert.equal(env.ORIGIN, 'https://app.example.com')
  assert.equal(env.isAllowedOrigin('https://app.example.com'), true)
  assert.equal(env.isAllowedOrigin('http://app.example.com'), false)
})

/**
 * The direction that would be far worse than the defect, and the same argument
 * `allowsDerivedKey` and the `SESSION_SECRET` floor both already make.
 *
 * Requiring TLS on a laptop would stop the suite and every developer at once.
 * The http default is right for development; it is only production where it is
 * a hole.
 */
test('development and test keep the http default they exist for', async () => {
  for (const APP_ENV of ['development', 'test']) {
    const env = await loadEnv({ APP_ENV })
    assert.equal(env.ORIGIN, 'http://localhost:5173')
  }
})

/**
 * A value that can never match anything is a misconfiguration too.
 *
 * A browser sends `Origin: https://app.example.com` with no trailing slash and
 * no path, so a configured value carrying either compares equal to nothing that
 * will ever arrive. The frontend then cannot reach its own API, in production,
 * with no error anywhere — which is the same class of silent failure as the
 * scheme, pointing the other way. Cheaper to refuse at boot than to debug from
 * a browser console.
 */
test('a value that is not bare scheme-host-port is refused, in every environment', async () => {
  for (const bad of [
    'https://app.example.com/',
    'https://app.example.com/app',
    'https://app.example.com?x=1',
    'app.example.com',
    'not a url at all',
    'ftp://app.example.com',
  ]) {
    await assert.rejects(
      () => loadEnv({ APP_ENV: 'development', CORS_ORIGIN: bad }),
      /CORS_ORIGIN/,
      `"${bad}" was accepted as an origin`,
    )
  }
})

/**
 * `isAllowedOrigin` is the one origin policy, and the REST check has to be the
 * same one the socket uses.
 *
 * Asserted here rather than trusted, because "the two cannot answer
 * differently" is a claim about there being one function, and the way that
 * claim stops being true is somebody adding a second.
 */
test('the development widening is loopback only, and never reaches production', async () => {
  const dev = await loadEnv({ APP_ENV: 'development' })
  assert.equal(dev.isAllowedOrigin(undefined), true, 'a non-browser client must pass')
  assert.equal(dev.isAllowedOrigin('http://localhost:5174'), true)
  assert.equal(dev.isAllowedOrigin('http://127.0.0.1:4173'), true)
  assert.equal(dev.isAllowedOrigin('https://evil.example'), false)

  const prod = await loadEnv({ ...PRODUCTION, CORS_ORIGIN: 'https://app.example.com' })
  assert.equal(prod.isAllowedOrigin(undefined), true)
  assert.equal(prod.isAllowedOrigin('http://localhost:5174'), false)
})
