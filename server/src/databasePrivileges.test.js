import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { pool, closePool } from './db.js'
import { withoutPassword } from '../scripts/pg.js'
import { askAssistant } from './assistant.js'

/**
 * What the connection string is allowed to be worth if somebody steals it.
 *
 * Until now the answer was "everything". The API connects as `soccerboard`,
 * which is SUPERUSER — and CREATEROLE, CREATEDB, BYPASSRLS and REPLICATION on
 * top — and owns every table in the schema. So a `DATABASE_URL` that leaked out
 * of a log line, a screenshot, a bug report or a mis-scoped environment variable
 * did not merely expose the rows: it handed over the Postgres host. `DROP TABLE
 * boards` was available to exactly the credential the API uses for `SELECT`, and
 * there is no backup behind board data, so that is not a recoverable event.
 *
 * `sql/runtime-role.sql` provisions the role production should actually connect
 * as, and this file is the proof that it is worth having. Two halves, and both
 * matter: the app's own queries must keep working, or the role is undeployable
 * theatre; and the destructive verbs must be refused, or it is decoration.
 *
 * These tests talk to the real development Postgres rather than to a mock,
 * because the thing under test is not our code. It is Postgres' own privilege
 * checker, and a mock of it would only ever assert what we already believed.
 * That is also why the provisioning file is executed verbatim rather than
 * paraphrased here: a test that grants its own privileges proves the grants in
 * the test, not the grants that ship.
 *
 * One test here binds a port, :8824, and it is the one that starts a real
 * instance as the restricted role. Everything else talks to Postgres directly.
 */

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url))
const serverDir = here('..')

/** Claimed by the one test that spawns an instance. :8825 is the next free one. */
const SKIPPED_MIGRATION_PORT = 8824

/**
 * The superuser URL the rest of the suite already runs on, taken from the pool
 * rather than typed out again. There is one hardcoded copy of this string in
 * the tree, in `env.js`, where the boot refusal that goes with it lives; a
 * second living in a test would be the one that rots silently, because a test
 * that connects somewhere nobody else does still passes.
 */
const ADMIN_URL = pool.options.connectionString

// Generated per run and never written down. The shipped file carries an
// obviously-fake placeholder, so provisioning has to be told a real one; doing
// that here also exercises the parameter production has to set.
const RUNTIME_PASSWORD = randomBytes(18).toString('hex')

/** The same connection string, as some other role. */
const urlAs = (role, password) => {
  const u = new URL(ADMIN_URL)
  u.username = role
  u.password = password
  return u.href
}

let admin
let runtime
let ROLE

before(async () => {
  admin = new pg.Client(ADMIN_URL)
  await admin.connect()

  // The file reads its three settings from the session when they are already
  // set and falls back to its own defaults when they are not, so this overrides
  // the placeholder password and leaves the role name and owner at whatever
  // ships. Meaning the defaults are under test too.
  await admin.query(`SELECT set_config('soccerboard.runtime_password', $1, false)`, [
    RUNTIME_PASSWORD,
  ])
  await admin.query(await readFile(here('../sql/runtime-role.sql'), 'utf8'))

  // Asked back rather than parsed out of the file, so renaming the role in one
  // place cannot leave this suite testing a role nobody provisions.
  ROLE = (await admin.query(`SELECT current_setting('soccerboard.runtime_role') AS r`)).rows[0].r

  runtime = new pg.Client(urlAs(ROLE, RUNTIME_PASSWORD))
  await runtime.connect()
})

after(async () => {
  await runtime?.end().catch(() => {})
  await admin?.query('DROP TABLE IF EXISTS privilege_drift_probe').catch(() => {})
  await admin?.end().catch(() => {})
  await closePool()
})

/** Runs `sql` as the runtime role and reports what Postgres said. */
const asRuntime = async (sql) => {
  try {
    await runtime.query(sql)
    return { refused: false }
  } catch (err) {
    return { refused: true, code: err.code, message: err.message }
  }
}

/**
 * Every read the API performs is a plain SELECT against a table in `public`, so
 * "can it still read" is answered by asking for all of them rather than a
 * chosen few — a new table nobody added to a list here would otherwise be
 * exactly the one that fails in production.
 */
test('the runtime role can read every application table', async () => {
  const { rows } = await admin.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  )
  assert.ok(rows.length >= 11, 'expected the application schema to be present in the dev database')

  for (const { tablename } of rows) {
    const result = await asRuntime(`SELECT * FROM ${tablename} LIMIT 1`)
    assert.equal(result.refused, false, `SELECT on ${tablename} was refused: ${result.message}`)
  }
})

/**
 * `login_attempts` is the one table the suite can write to freely: it is keyed
 * on a string the caller chooses, has no foreign keys into anything, and the
 * hourly sweep already treats stray rows as garbage to collect.
 */
test('the runtime role can insert, update and delete', async () => {
  const key = `privilege-test:${randomBytes(6).toString('hex')}`

  for (const sql of [
    `INSERT INTO login_attempts (key, count) VALUES ('${key}', 1)`,
    `UPDATE login_attempts SET count = 2 WHERE key = '${key}'`,
    `DELETE FROM login_attempts WHERE key = '${key}'`,
  ]) {
    const result = await asRuntime(sql)
    assert.equal(result.refused, false, `${sql} was refused: ${result.message}`)
  }
})

/**
 * Not obvious, and load-bearing. `migrate()` takes an advisory lock and
 * `realtime.js` runs LISTEN/NOTIFY, and neither is a table privilege — a role
 * that could read every row but not take a lock would still fail to boot.
 */
test('the runtime role can take advisory locks and use the notification bus', async () => {
  for (const sql of [
    'SELECT pg_advisory_lock(8170251)',
    'SELECT pg_advisory_unlock(8170251)',
    `SELECT pg_notify('board', 'ping')`,
    `SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT`,
  ]) {
    const result = await asRuntime(sql)
    assert.equal(result.refused, false, `${sql} was refused: ${result.message}`)
  }
})

/**
 * The whole point. Every one of these is available today to the credential the
 * API uses for ordinary reads, and every one of them is unrecoverable against a
 * database with nothing behind it.
 *
 * 42501 is `insufficient_privilege`, asserted alongside the refusal because a
 * statement that failed for some unrelated reason — a typo, a missing table —
 * would otherwise read as a privilege that is being enforced when it is not.
 */
test('the runtime role cannot destroy or reshape the schema', async () => {
  const forbidden = [
    'DROP TABLE boards',
    'TRUNCATE boards',
    'CREATE TABLE privilege_escalation (id TEXT)',
    'ALTER TABLE boards ADD COLUMN IF NOT EXISTS injected TEXT',
    'CREATE INDEX IF NOT EXISTS idx_injected ON boards(id)',
    'DROP INDEX IF EXISTS idx_boards_user_updated',
  ]

  for (const sql of forbidden) {
    const result = await asRuntime(sql)
    assert.equal(result.refused, true, `${sql} was ALLOWED and must not be`)
    assert.equal(result.code, '42501', `${sql} failed with ${result.code}, not insufficient_privilege`)
  }
})

/**
 * The residual, asserted rather than left to be discovered.
 *
 * `DELETE FROM boards` with no WHERE clause still works, and no arrangement of
 * grants can stop it while the application remains able to delete a board. The
 * API issues unqualified-in-effect deletes of its own — the hourly sweeps, and
 * the cascade when an account is destroyed — so DELETE is not severable from
 * what the app does. What the role buys is therefore narrower than "the data is
 * safe": it is that the damage is confined to rows, inside a schema that stays
 * intact, by a role that cannot then rewrite the tables or reach the host. That
 * is a real reduction and it is not the same as protection, and this test exists
 * so nobody reads the list above and concludes otherwise.
 *
 * The thing that would actually close this is a backup, which the deployment
 * does not have. That is a gap in the deployment rather than in the grant.
 */
test('DELETE is deliberately not withheld, because the application needs it', async () => {
  const result = await asRuntime('DELETE FROM boards WHERE id = $$no-such-board$$')
  assert.equal(
    result.refused,
    false,
    'DELETE was refused, which breaks board deletion and the hourly sweeps',
  )
})

/**
 * `CREATE TABLE IF NOT EXISTS` deserves its own case, because the intuition is
 * wrong. It looks like it should be a harmless no-op against a table that is
 * already there, and if Postgres checked existence before privilege it would be.
 * It does not: the schema privilege is checked first, so this is refused even
 * though it would have changed nothing. That ordering is the single fact the
 * migration-role decision rests on, so it is pinned here rather than left as
 * something someone reasoned about once.
 */
test('CREATE TABLE IF NOT EXISTS is refused even where the table already exists', async () => {
  const result = await asRuntime('CREATE TABLE IF NOT EXISTS users (id TEXT)')
  assert.equal(result.refused, true)
  assert.match(result.message, /permission denied for schema public/)
})

/** The escalation half: a stolen URL must not become a foothold on the host. */
test('the runtime role cannot escalate itself or reach the host', async () => {
  for (const sql of [
    `ALTER ROLE ${ROLE} SUPERUSER`,
    'CREATE ROLE another_way_in LOGIN',
    'SELECT rolname, rolpassword FROM pg_authid',
    `SELECT pg_read_file('postgresql.conf')`,
    `COPY (SELECT 1) TO PROGRAM 'whoami'`,
  ]) {
    const result = await asRuntime(sql)
    assert.equal(result.refused, true, `${sql} was ALLOWED and must not be`)
  }
})

/** And the attributes themselves, since a future edit could hand any of them back. */
test('the runtime role holds none of the dangerous role attributes', async () => {
  const { rows } = await admin.query(
    `SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication
       FROM pg_roles WHERE rolname = $1`,
    [ROLE],
  )
  assert.equal(rows.length, 1, `${ROLE} was not provisioned`)
  for (const [attribute, value] of Object.entries(rows[0])) {
    assert.equal(value, false, `${ROLE} has ${attribute}`)
  }
})

/**
 * A grant enumerating today's tables is a grant that breaks on the next one, and
 * "the next one" is not hypothetical: a table is being added to `db.js` in this
 * same branch. `ALTER DEFAULT PRIVILEGES` is what makes the provisioning survive
 * that, and this is the assertion that it is actually in the file — a table
 * created after provisioning ran, readable and writable with no second visit to
 * the SQL.
 */
test('a table created after provisioning is reachable without re-granting', async () => {
  await admin.query('DROP TABLE IF EXISTS privilege_drift_probe')
  await admin.query('CREATE TABLE privilege_drift_probe (id TEXT PRIMARY KEY, note TEXT)')

  try {
    for (const sql of [
      `INSERT INTO privilege_drift_probe (id, note) VALUES ('a', 'added later')`,
      'SELECT * FROM privilege_drift_probe',
      `UPDATE privilege_drift_probe SET note = 'edited' WHERE id = 'a'`,
      'DELETE FROM privilege_drift_probe',
    ]) {
      const result = await asRuntime(sql)
      assert.equal(
        result.refused,
        false,
        `${sql} was refused on a table added after provisioning (${result.message}). ` +
          'The grant has probably been narrowed to a fixed list of table names.',
      )
    }
  } finally {
    await admin.query('DROP TABLE IF EXISTS privilege_drift_probe')
  }
})

/**
 * "Another role's data" is the tenancy question, and the honest version of it
 * for a database rather than for the app: a second role with its own table. The
 * app's own per-user separation is a `WHERE user_id = $1` in the query and is
 * not what this proves, deliberately — row-level security was considered and
 * rejected, because this app connects as one role for every user, so an RLS
 * policy has no identity to key on and would break sharing outright.
 */
test('the runtime role cannot touch a table belonging to another role', async () => {
  const other = `probe_tenant_${randomBytes(4).toString('hex')}`
  const otherPassword = randomBytes(12).toString('hex')

  await admin.query(`CREATE ROLE ${other} LOGIN PASSWORD '${otherPassword}'`)
  let tenant
  try {
    await admin.query(`GRANT CONNECT ON DATABASE ${new URL(ADMIN_URL).pathname.slice(1)} TO ${other}`)
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${other}`)

    tenant = new pg.Client(urlAs(other, otherPassword))
    await tenant.connect()
    await tenant.query(`CREATE TABLE ${other}_rows (secret TEXT)`)
    await tenant.query(`INSERT INTO ${other}_rows VALUES ('not for the app')`)

    for (const sql of [
      `SELECT * FROM ${other}_rows`,
      `UPDATE ${other}_rows SET secret = 'x'`,
      `DROP TABLE ${other}_rows`,
    ]) {
      const result = await asRuntime(sql)
      assert.equal(result.refused, true, `${sql} was ALLOWED and must not be`)
      assert.equal(result.code, '42501')
    }
  } finally {
    await tenant?.query(`DROP TABLE IF EXISTS ${other}_rows`).catch(() => {})
    await tenant?.end().catch(() => {})
    await admin.query(`DROP TABLE IF EXISTS ${other}_rows`).catch(() => {})
    await admin.query(`REVOKE ALL ON SCHEMA public FROM ${other}`).catch(() => {})
    await admin
      .query(`REVOKE ALL ON DATABASE ${new URL(ADMIN_URL).pathname.slice(1)} FROM ${other}`)
      .catch(() => {})
    await admin.query(`DROP ROLE IF EXISTS ${other}`).catch(() => {})
  }
})

/**
 * The decisive one, and the reason the runtime role is not also the migration
 * role.
 *
 * `migrate()` runs DDL at every boot, so a role with no `CREATE` cannot start
 * the app. That is not a defect in the role, it is the coupling the app was
 * written with, and this test pins it: if it ever starts passing, `migrate()`
 * has become privilege-free and the two-role split documented in the README has
 * an assumption underneath it that is no longer true.
 *
 * Run in a child process because `env.js` reads `DATABASE_URL` once, when it is
 * imported, and this file has already imported it as the superuser.
 */
test('migrate() cannot run as the runtime role, which is why it is not the migration role', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import('./src/db.js').then(async (m) => {
         try { await m.migrate(); console.log('MIGRATED') }
         catch (e) { console.log('REFUSED', e.code, e.message) }
         finally { await m.closePool() }
       })`,
    ],
    { cwd: serverDir, env: { ...process.env, DATABASE_URL: urlAs(ROLE, RUNTIME_PASSWORD) } },
  )

  assert.match(
    stdout,
    /REFUSED 42501 permission denied for schema public/,
    `migrate() as the runtime role reported: ${stdout.trim()}`,
  )
})

/**
 * `npm run db` printed the whole connection string, password included, on every
 * single run. The password is a development constant rather than a secret worth
 * much on its own, but the line is the one people copy into bug reports, paste
 * into chat, and leave sitting in CI output, and the habit it teaches is that a
 * `DATABASE_URL` is a thing you print. In production that same habit is the
 * whole finding above.
 */
test('the local database banner never prints a password', () => {
  assert.equal(
    withoutPassword('postgres://soccerboard:soccerboard@127.0.0.1:55432/soccerboard'),
    'postgres://soccerboard:***@127.0.0.1:55432/soccerboard',
  )

  // Managed providers hand out URLs with encoded passwords and query strings,
  // and the redaction must not quietly pass those through intact.
  const masked = withoutPassword('postgres://app:p%40ss%3Aword@db.example.com:5432/app?sslmode=require')
  assert.ok(!masked.includes('p%40ss'), `password survived redaction: ${masked}`)
  assert.ok(masked.includes('sslmode=require'), 'the rest of the URL should survive')

  // Anything unparseable must fail closed rather than fall through to the input.
  assert.ok(!withoutPassword('not a url at all').includes('not a url'))
})

/**
 * A provider error carried 200 characters of the provider's own response body
 * into the exception, and `routes/assistant.js` logs `err.message`. The request
 * that produced the error carries the board: its formation names and up to 4000
 * characters of board description. Providers routinely quote the offending
 * request back in an error, so this was a path by which a coach's board reached
 * the server log, on a route the coach had to consent to for the board to be
 * sent to Google at all.
 *
 * The fix has to leave a failure diagnosable, so the status code stays and the
 * provider's machine-readable status enum comes with it. An enum cannot carry
 * board content; free text can.
 */
test('a provider failure is diagnosable without carrying the request into the log', async () => {
  const realFetch = globalThis.fetch
  process.env.GEMINI_API_KEY = 'test-key'

  // Shaped like a real Google error, quoting the request back at us.
  const leaky = {
    error: {
      code: 400,
      status: 'INVALID_ARGUMENT',
      message:
        'Invalid value at contents[0].parts[0].text: "Home in a 4-3-3, keeper on the six yard box, ' +
        'Sam Whitlock at left wing" is not acceptable',
    },
  }

  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => leaky,
    text: async () => JSON.stringify(leaky),
  })

  try {
    await assert.rejects(
      () =>
        askAssistant('line them up', {
          formationNames: ['4-3-3'],
          kind: '11',
          activeTeam: 'home',
          board: 'Home in a 4-3-3. Sam Whitlock at left wing.',
        }),
      (err) => {
        assert.ok(!/Whitlock/.test(err.message), `board content reached the error: ${err.message}`)
        assert.ok(!/six yard/.test(err.message), `board content reached the error: ${err.message}`)
        assert.match(err.message, /400/, 'the status code should survive, or nothing is debuggable')
        assert.match(err.message, /INVALID_ARGUMENT/, 'the provider status enum should survive')
        return true
      },
    )
  } finally {
    globalThis.fetch = realFetch
    delete process.env.GEMINI_API_KEY
  }
})

/**
 * The other end of that: with the migration skipped, the restricted role boots.
 *
 * This is the test the two-role split was missing, and without it the previous
 * one is only half an argument. `migrate()` being refused explains why the role
 * could not be used; it says nothing about whether the role can run the app
 * once somebody else has applied the schema. So this starts a real instance the
 * way `npm start` does, as the runtime role, with `RUN_MIGRATIONS=false`, and
 * asks it to serve — which is the deployment the README now describes, proved
 * rather than reasoned about.
 *
 * `/health` is the endpoint on purpose: it is the cheapest thing that is
 * nonetheless a real request through the real middleware chain, and an instance
 * that answers it has already got past `initEncryption`, past the pool, and
 * past the line that used to kill it.
 */
test('an instance boots and serves as the runtime role when the migration is skipped', async () => {
  const child = spawn(process.execPath, [here('./index.js')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(SKIPPED_MIGRATION_PORT),
      DATABASE_URL: urlAs(ROLE, RUNTIME_PASSWORD),
      RUN_MIGRATIONS: 'false',
      RUN_MAINTENANCE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))

  try {
    const deadline = Date.now() + 20_000
    let status = null
    while (Date.now() < deadline) {
      try {
        status = (await fetch(`http://127.0.0.1:${SKIPPED_MIGRATION_PORT}/api/health`)).status
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    assert.equal(
      status,
      200,
      `the runtime role could not serve with migrations skipped. It said: ${output.trim()}`,
    )
    // And it says so, rather than skipping silently: an operator reading a boot
    // log has to be able to tell which of the two arrangements this instance is.
    assert.match(output, /RUN_MIGRATIONS=false/)
  } finally {
    child.kill()
  }
})

/**
 * TLS is the other half of "the credential crosses the network". Nothing in this
 * repo configures or mentions `sslmode`, and `pg` does not default to TLS, so
 * against a managed Postgres the password and every board row travel in
 * cleartext. The connection string is the only place this can be set without
 * touching `db.js`, so `.env.example` is where it has to be said.
 */
test('.env.example tells production how to require TLS on the connection', async () => {
  const example = await readFile(here('../.env.example'), 'utf8')
  assert.match(example, /sslmode/, '.env.example never mentions sslmode')
  assert.match(
    example,
    /sslmode=verify-full/,
    'verify-full is the only mode that authenticates the server; the weaker ones should not be the ' +
      'recommendation',
  )
})

/** And the role itself has to be findable by whoever does the next deploy. */
test('the README documents the runtime role and how to provision it', async () => {
  const readme = await readFile(here('../README.md'), 'utf8')
  assert.match(readme, /sql\/runtime-role\.sql/, 'the README never points at the provisioning file')
  assert.match(readme, /sslmode/, 'the README never mentions TLS on the database connection')
  assert.match(readme, /DATABASE_URL/, 'the README never names the variable this all hangs on')
})
