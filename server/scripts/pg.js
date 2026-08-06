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
import { execFile } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import { argv } from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)

/**
 * The cluster, at an absolute path derived from this file rather than from
 * wherever it was invoked.
 *
 * **It was `./data/pg`, and that is a directory somewhere else every time the
 * caller's shell is somewhere else.** `npm run db` sets the cwd to `server/`
 * and worked; `node server/scripts/pg.js start` from the repository root, which
 * is the obvious way to run it from the root and reads as the same command,
 * silently built a second 49MB cluster at the repository root instead. Nothing
 * failed. Two clusters answered to the same script, `db:stop` could not stop the
 * one that was running because it was looking in `server/data/pg`, and the
 * stray copy sat outside `server/.gitignore` — which ignores `data/` relative to
 * itself — where the next `git add -A` swept all 1348 files of it into a commit.
 *
 * That is a lot of consequence for a leading dot, and none of it announced
 * itself. The data directory is a property of this checkout, not of the
 * terminal, so it is now written down as one.
 */
const DATA_DIR = fileURLToPath(new URL('../data/pg', import.meta.url))
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

/**
 * Is anything actually listening on the port?
 *
 * Ground truth, and the only claim this file is entitled to make. The pid file
 * is not it: `data/pg/postmaster.pid` outlives an unclean shutdown, and
 * `pg_ctl status` reads that file and asks whether *a* process holds that id,
 * which after id reuse is a different question from whether Postgres is up.
 * A socket either connects or it does not.
 */
const isListening = () =>
  new Promise((resolve) => {
    const socket = net.connect({ port: PORT, host: '127.0.0.1' })
    const settle = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.setTimeout(2000, () => settle(false))
  })

/**
 * Where `pg_ctl` is for this platform.
 *
 * The same mapping `embedded-postgres` does internally, redone here because it
 * keeps `dist/binary.js` out of its `exports` map and there is no supported way
 * to ask it. Every platform package exports the three binary paths as absolute
 * strings; only the package name changes, and only `win32` needs renaming.
 */
async function pgCtl() {
  const platform = os.platform() === 'win32' ? 'windows' : os.platform()
  const { pg_ctl: path } = await import(`@embedded-postgres/${platform}-${os.arch()}`)
  return path
}

/**
 * Stop a server this process did not start.
 *
 * **This is the whole reason the file changed.** `instance.stop()` is a method
 * on an object that holds a handle to a child process it spawned, and its first
 * line is `if (!this.process) return`. Run from `npm run db:stop`, which is a
 * fresh Node process with a fresh instance and no handle, it therefore returns
 * immediately having done nothing — and this script then printed "Postgres
 * stopped." because the call had not thrown. A stop command that reports
 * success without stopping is worse than one that fails: the port stays held,
 * the next `npm run db` fails for a reason that looks unrelated, and the only
 * evidence is a line of output that says the opposite.
 *
 * `pg_ctl` talks to the running postmaster through the data directory rather
 * than through a handle, so it can stop a server started by anybody. `-m fast`
 * rolls back open transactions and shuts down cleanly, which is also a repair:
 * the library's own Windows path is `taskkill /f`, and a force-killed Postgres
 * leaves a cluster that has to run crash recovery on the next boot.
 *
 * Nothing here trusts its own exit code. It asks the port.
 */
async function stopServer() {
  if (!(await isListening())) {
    console.log(`Nothing is listening on 127.0.0.1:${PORT}. Already stopped.`)
    return
  }

  try {
    await run(await pgCtl(), ['-D', DATA_DIR, '-m', 'fast', 'stop'])
  } catch (err) {
    // Reported, not swallowed, and then verified anyway: pg_ctl exits non-zero
    // for a stale pid file it cleaned up on the way past, which is a failure
    // that leaves the port correctly closed.
    console.error(`pg_ctl exited non-zero: ${err.stderr?.trim() || err.message}`)
  }

  if (await isListening()) {
    console.error(
      `FAIL  something is still listening on 127.0.0.1:${PORT}.\n` +
        '      If a `node scripts/pg.js start` is still holding it, stop that process too:\n' +
        '      it owns the postmaster and will not let go because pg_ctl asked nicely.',
    )
    process.exit(1)
  }

  console.log('Postgres stopped.')
}

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

  // Hold the process open so the server stays up. Ctrl-C goes through the same
  // `pg_ctl` path as `db:stop` rather than through `instance.stop()`, which on
  // Windows is `taskkill /f` and leaves a cluster needing crash recovery.
  process.on('SIGINT', async () => {
    await stopServer()
    process.exit(0)
  })

  /**
   * And go away when the server does.
   *
   * Without this, `npm run db:stop` leaves this process alive holding a handle
   * to a postmaster that no longer exists — it has nothing left to do and no
   * way to notice. They accumulate one per stop, and the next person to run
   * `netstat` while debugging a port finds a list of `node scripts/pg.js start`
   * that are all lying about what they are doing. One of them cost an hour
   * already.
   *
   * `instance.process` is the library's own field for the spawned server; its
   * `stop()` reads the same one, so this is the documented shape of the object
   * rather than a reach behind it. Guarded anyway: a version that stops setting
   * it should make this do nothing, not throw on boot.
   */
  instance.process?.once('exit', () => {
    console.log('The Postgres server exited, so this is done holding it.')
    process.exit(0)
  })
} else if (command === 'stop') {
  await stopServer()
} else if (command !== null) {
  console.error(`Unknown command "${command}". Use start or stop.`)
  process.exit(1)
}
