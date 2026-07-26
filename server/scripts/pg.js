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

const DATA_DIR = './data/pg'
const PORT = Number(process.env.PG_PORT ?? 55432)
const USER = 'soccerboard'
const PASSWORD = 'soccerboard'
const DATABASE = 'soccerboard'

const instance = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
})

const command = process.argv[2] ?? 'start'

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
      `  DATABASE_URL=postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}\n` +
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
} else {
  console.error(`Unknown command "${command}". Use start or stop.`)
  process.exit(1)
}
