import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * The deployment signals, and the one that had no floor under it.
 *
 * `APP_ENV` has thrown on an unrecognised value since the day it replaced the
 * bare `NODE_ENV` check, for a reason written out in `env.js`: two security
 * controls follow it, so guessing at an unknown value means guessing at those.
 * `SESSION_SECRET` had no such check at all, and the committed
 * `.env.example` ships a placeholder with instructions to replace it.
 *
 * **Leaving it is not cosmetic, and the reason is not the one the name
 * suggests.** Sessions are opaque random tokens stored as SHA-256, so nothing is
 * signed with it. What it does key is the HMAC in `securityQuestions.js` that
 * decides which question an address with *no account* is shown. That mapping has
 * to be stable, or probing twice gives the game away, and it has to be
 * uncomputable offline, or an attacker derives the decoy for any address and
 * flags every account whose real question differs from their own arithmetic.
 * With the placeholder in place that key is public: it is in this repo, and in
 * the published mirror. Recovery step one becomes an account-enumeration oracle,
 * which is the exact property the generic replies exist to protect.
 *
 * In production it now stops the process at boot, in the same voice and for the
 * same reason `APP_ENV` does. Development and test are deliberately untouched:
 * nobody should have to generate key material to run the suite, and that is the
 * same argument `allowsDerivedKey` already makes.
 */

/**
 * Load `env.js` fresh under a given environment.
 *
 * The query string is what defeats the ES module cache: a specifier that has
 * been imported once is never re-evaluated, and every check here is about what
 * happens *during* evaluation. The environment is restored key by key rather
 * than by replacing `process.env`, which would detach the object every other
 * module in this process is holding.
 */
let sequence = 0
async function loadEnv(vars) {
  // `CORS_ORIGIN` joined this list when it grew a production floor of its own:
  // it defaults to an `http://` origin, so a production case that does not set
  // it now fails on the origin check before it can reach the assertion it was
  // written for. Clearing it here keeps each case testing the one variable it
  // names. `DATABASE_URL` joined for the same reason and one more: a developer
  // with it exported in their shell would otherwise satisfy the production
  // floor by accident, and the case asserting the refusal would pass on their
  // machine and fail on everybody else's.
  const keys = ['APP_ENV', 'NODE_ENV', 'SESSION_SECRET', 'CORS_ORIGIN', 'DATABASE_URL']
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))

  for (const key of keys) delete process.env[key]
  for (const [key, value] of Object.entries(vars)) process.env[key] = value

  try {
    return await import(`./env.js?case=${++sequence}`)
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/** What `.env.example` ships, verbatim. */
const PLACEHOLDER = 'dev-only-secret-change-me'
const REAL = 'a'.repeat(64)

test('production refuses to boot with no SESSION_SECRET at all', async () => {
  await assert.rejects(
    () => loadEnv({ APP_ENV: 'production' }),
    /SESSION_SECRET/,
    'an unset secret booted a production process',
  )
})

test('production refuses the placeholder that ships in .env.example', async () => {
  await assert.rejects(
    () => loadEnv({ APP_ENV: 'production', SESSION_SECRET: PLACEHOLDER }),
    /SESSION_SECRET/,
    'the committed placeholder booted a production process',
  )
})

/**
 * The message has to say what to do, because the person reading it is midway
 * through a deploy that has just stopped.
 */
test('the refusal names the variable and how to generate one', async () => {
  await assert.rejects(
    () => loadEnv({ APP_ENV: 'production', SESSION_SECRET: PLACEHOLDER }),
    (err) => {
      assert.match(err.message, /SESSION_SECRET/)
      assert.match(err.message, /randomBytes/)
      return true
    },
  )
})

test('production refuses a secret too short to be worth having', async () => {
  await assert.rejects(
    () => loadEnv({ APP_ENV: 'production', SESSION_SECRET: 'short-but-not-the-placeholder' }),
    /SESSION_SECRET/,
  )
})

const REAL_DATABASE_URL = 'postgres://app:secret@db.example.com:5432/app?sslmode=verify-full'

test('production boots on a real secret, and exports it', async () => {
  // A production boot now has to satisfy every floor, not just this one, so the
  // https origin and the connection string ride along. Neither is what this
  // case is asserting; they are what the case needs in order to reach what it
  // is asserting.
  const env = await loadEnv({
    APP_ENV: 'production',
    SESSION_SECRET: REAL,
    CORS_ORIGIN: 'https://app.example.com',
    DATABASE_URL: REAL_DATABASE_URL,
  })
  assert.equal(env.isProduction, true)
  assert.equal(env.SESSION_SECRET, REAL)
  assert.equal(env.DATABASE_URL, REAL_DATABASE_URL)
})

/**
 * The connection string, which had no floor at all while the three above it
 * did, and which is the most powerful secret in the file.
 *
 * Unset, the process falls back to the local development superuser committed to
 * this repository. That does not fail loudly: it dies on a refused connection
 * to an address nobody configured, or — worse — succeeds against whatever is
 * listening on that port on that host.
 */
test('production refuses to boot with no DATABASE_URL at all', async () => {
  await assert.rejects(
    () =>
      loadEnv({
        APP_ENV: 'production',
        SESSION_SECRET: REAL,
        CORS_ORIGIN: 'https://app.example.com',
      }),
    /DATABASE_URL/,
    'an unset connection string booted a production process onto the development superuser',
  )
})

/**
 * A boot refusal goes into CI output, screenshots and bug reports, so it is the
 * highest-visibility place a credential could be printed. `scripts/pg.js` has a
 * whole `withoutPassword` helper because of this; the refusal must not undo it.
 */
test('the refusal does not print the credential it is refusing', async () => {
  await assert.rejects(
    () =>
      loadEnv({
        APP_ENV: 'production',
        SESSION_SECRET: REAL,
        CORS_ORIGIN: 'https://app.example.com',
      }),
    (err) => {
      assert.match(err.message, /DATABASE_URL/)
      assert.ok(
        !err.message.includes('soccerboard:soccerboard'),
        'the refusal printed the development credential it was falling back to',
      )
      return true
    },
  )
})

/**
 * The direction that would be worse than the bug, again: `npm test` runs
 * `node --test` with no env file, so every suite in this directory reaches
 * Postgres through exactly this fallback. A floor here would stop all of them.
 */
test('development and test fall back to the local database, and export it', async () => {
  for (const APP_ENV of ['development', 'test']) {
    const env = await loadEnv({ APP_ENV })
    assert.match(env.DATABASE_URL, /127\.0\.0\.1:55432/)
  }
})

/**
 * The direction that would be far worse than the bug.
 *
 * A check that drifted into development would stop the suite and every laptop
 * in the project, for everybody, immediately. `allowsDerivedKey` already makes
 * this argument about `ENCRYPTION_KEY`; this follows it rather than inventing a
 * second policy.
 */
test('development and test boot on the placeholder, and on nothing at all', async () => {
  for (const APP_ENV of ['development', 'test']) {
    const withPlaceholder = await loadEnv({ APP_ENV, SESSION_SECRET: PLACEHOLDER })
    assert.equal(withPlaceholder.isProduction, false)

    const withNothing = await loadEnv({ APP_ENV })
    assert.equal(withNothing.APP_ENV, APP_ENV)
    // The fallback the two consumers used to spell out for themselves.
    assert.equal(withNothing.SESSION_SECRET, 'dev')
  }
})

/**
 * `NODE_ENV=production` with `APP_ENV` unset is a real deployment, because
 * `env.js` falls back to it for exactly that case. The floor has to apply there
 * too or it is trivially stepped around by not setting the newer variable.
 */
test('the floor applies when production is reached through NODE_ENV', async () => {
  await assert.rejects(
    () => loadEnv({ NODE_ENV: 'production', SESSION_SECRET: PLACEHOLDER }),
    /SESSION_SECRET/,
  )
})

test('an unrecognised APP_ENV still stops the process, and says so first', async () => {
  await assert.rejects(() => loadEnv({ APP_ENV: 'staging' }), /APP_ENV/)
})
