/**
 * Apply the schema once, against a privileged connection, and exit.
 *
 * The other half of `RUN_MIGRATIONS=false` in `src/index.js`. The role in
 * `sql/runtime-role.sql` has no DDL rights at all, so the two-role deploy runs
 * this first, under the URL that owns the tables, and only then rolls the
 * instances with the restricted one:
 *
 *   DATABASE_URL="$ADMIN_DATABASE_URL" npm --prefix server run migrate
 *
 * `env.js` reads `DATABASE_URL` when it is imported, and there is deliberately
 * no second variable for it: one connection string pointed somewhere else for
 * one command, rather than a third spelling of a credential in a repo that has
 * just finished removing the second. A value already in the environment beats
 * `.env`, so the line above works unchanged on a host that has one.
 *
 * **It does not consult `RUN_MIGRATIONS`, and must not.** Whoever runs this is
 * precisely the person with `RUN_MIGRATIONS=false` set on that host, so
 * honouring it here would turn the migration step into a no-op that reports
 * success. That single failure would make the arrangement worse than not having
 * it at all: every instance would come up healthy on a schema nobody applied.
 *
 * Nothing is caught. A deploy step that fails has to fail loudly and non-zero,
 * and a rejected top-level await already exits 1 with the error on stderr.
 */
import { migrate, closePool } from '../src/db.js'

await migrate()
console.log('Schema is up to date.')
await closePool()
