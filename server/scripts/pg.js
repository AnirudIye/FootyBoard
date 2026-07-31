/**
 * Local Postgres for development, with nothing to install.
 *
 * `embedded-postgres` ships real Postgres binaries per platform, so this gives
 * an actual server on a port — which is what multiple API instances need to
 * share. It is a devDependency and never runs in production: there you point
 * DATABASE_URL at a managed Postgres and delete none of your hair.
 *
 *   node scripts/pg.js start   # start it (and create the database once)
 *   node scripts/pg.js stop
 */
import EmbeddedPostgres from 'embedded-postgres'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

const DATA_DIR = './data/pg'
const PORT = Number(process.env.PG_PORT ?? 55432)
const USER = 'soccerboard'
const PASSWORD = 'soccerboard'
const DATABASE = 'soccerboard'

/**
 * The same connection string with the password struck out.
 *
 * This script used to print `DATABASE_URL` complete, password and all, on every
 * `npm run db`. The password here is a development constant that is also sitting
 * in `.env.example`, so the immediate secret is worth nothing — but the line is
 * the one people copy into bug reports, paste into chat while asking why the
 * database will not start, and leave in CI output. What it teaches is that a
 * `DATABASE_URL` is a thing you print, and the production instance of that habit
 * is a credential that, until `sql/runtime-role.sql`, was superuser on the host.
 * Cheaper to not print it here than to argue about which passwords are the real
 * ones.
 *
 * Parsed rather than pattern-matched, because a managed provider's URL carries
 * percent-encoded passwords and a query string, and a regex over `:.*@` gets
 * both of those wrong in the direction that leaks. Anything unparseable fails
 * closed and says nothing at all, since the whole job of this function is to not
 * emit a string it does not understand.
 */
export const withoutPassword = (url) => {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.href
  } catch {
    return '<unparseable connection string>'
  }
}

const CONNECTION_URL = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`

const instance = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
})

// Only act when run as a command, so that importing this module to test the
// redaction above does not start a database as a side effect — a silly way to
// run a unit test and a worse way to lose a port. `command` is null when we were
// imported, which is the one case that falls through every branch below.
const invokedDirectly = argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1]
const command = invokedDirectly ? (argv[2] ?? 'start') : null

if (command === 'start') {
  // initialise() throws if the cluster already exists, which is the normal
  // case on every run after the first.
  try {
    await instance.initialise()
    console.log('Initialised a new Postgres cluster.')
  } catch {
    console.log('Reusing the existing Postgres cluster.')
  }

  await instance.start()

  try {
    await instance.createDatabase(DATABASE)
    console.log(`Created database "${DATABASE}".`)
  } catch {
    // Already there from a previous run.
  }

  console.log(
    `Postgres listening on 127.0.0.1:${PORT}\n` +
      `  DATABASE_URL=${withoutPassword(CONNECTION_URL)}\n` +
      '  The development password is in .env.example, which is where it belongs.\n' +
      'Leave this running, or stop it with: node scripts/pg.js stop',
  )

  // Hold the process open so the server stays up.
  process.on('SIGINT', async () => {
    await instance.stop()
    process.exit(0)
  })
} else if (command === 'stop') {
  await instance.stop()
  console.log('Postgres stopped.')
} else if (command !== null) {
  console.error(`Unknown command "${command}". Use start or stop.`)
  process.exit(1)
}
