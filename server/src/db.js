import pg from 'pg'
import { codeExpiryFrom, withFreshCode } from './joinCode.js'

/**
 * Postgres, reached through a connection pool.
 *
 * This is where pooling actually matters: unlike an embedded database, every
 * connection here is a TCP socket plus a backend process on the server, and
 * both are expensive to create. The pool keeps a small set of them warm and
 * hands them out per query, so a burst of requests reuses sockets instead of
 * opening one each. `max` is per API instance — with N instances behind the
 * balancer the server sees up to N * max, which is why it is deliberately
 * modest rather than "as many as possible".
 */

const { Pool } = pg

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://soccerboard:soccerboard@127.0.0.1:55432/soccerboard',
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000, // release sockets that nobody is using
  connectionTimeoutMillis: 5_000, // fail fast rather than hanging a request
})

// A pooled client can die with the server behind it; without a handler this
// surfaces as an unhandled rejection and takes the process down.
pool.on('error', (err) => {
  console.error('Idle Postgres client error:', err.message)
})

// Any constant works; it just has to be the same in every instance.
const MIGRATION_LOCK = 8_170_251

/**
 * Runs the schema once, even when several instances boot together.
 *
 * `CREATE TABLE IF NOT EXISTS` is not atomic against concurrent DDL: two
 * instances can both find the table missing and then collide inserting into
 * the system catalogue (`duplicate key ... pg_type_typname_nsp_index`). An
 * advisory lock serialises them — the first migrates, the rest wait and then
 * find everything already in place.
 */
export async function migrate() {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK])
    await applySchema(client)
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {})
    client.release()
  }
}

async function applySchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                TEXT PRIMARY KEY,
      email             TEXT NOT NULL,
      password_hash     TEXT NOT NULL,
      password_salt     TEXT NOT NULL,
      accepted_terms_at TEXT NOT NULL,
      created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS boards (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at    BIGINT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      key          TEXT PRIMARY KEY,
      count        INTEGER NOT NULL DEFAULT 0,
      locked_until BIGINT  NOT NULL DEFAULT 0,
      last_attempt BIGINT  NOT NULL DEFAULT 0
    );

    -- A share link is a credential, so it is stored the way the other
    -- credentials here are: a random token that is never written down, only its
    -- SHA-256, revocable by one row.
    CREATE TABLE IF NOT EXISTS board_shares (
      id         TEXT PRIMARY KEY,
      board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      revoked_at BIGINT
    );

    -- Membership is the durable grant, separate from the link that produced it.
    -- Revoking a link stops new people joining; it does not eject the ones who
    -- already have. Removing a member is the separate, precise action.
    CREATE TABLE IF NOT EXISTS board_members (
      board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      share_id  TEXT REFERENCES board_shares(id) ON DELETE SET NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (board_id, user_id)
    );

    -- One row per person who has agreed to the assistant's online fallback.
    -- The panel asks, but a promise the browser keeps is not a consent basis:
    -- the record of the grant has to survive the person clearing site data,
    -- and the server has to be the thing that refuses without it.
    CREATE TABLE IF NOT EXISTS assistant_consents (
      user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      granted_at TEXT NOT NULL
    );
  `)

  // Whether members may edit is a property of the board, not of the person, so
  // the owner can lock the room to demonstrate and unlock it again without
  // touching anyone's access.
  await client.query(`
    ALTER TABLE boards ADD COLUMN IF NOT EXISTS members_can_edit BOOLEAN NOT NULL DEFAULT true;
  `)

  // Whether room presence names people by their address.
  //
  // Off by default, because a coaching staff who already know each other are
  // better served by real names, and turning a working roster into a zoo
  // without being asked would be a surprise. On, the relay substitutes a
  // generated name in every presence payload and the address never goes on the
  // wire — see the substitution in `realtime.js`, which is where the setting
  // actually means something. Like `members_can_edit` this belongs to the
  // board rather than to a person: the owner is deciding what this room
  // discloses, not what any one guest is called everywhere.
  await client.query(`
    ALTER TABLE boards ADD COLUMN IF NOT EXISTS anonymous_presence BOOLEAN NOT NULL DEFAULT false;
  `)

  // The security question, which is what proves identity when a password is
  // forgotten. There is no reset email any more, so these three columns are the
  // whole authenticator for recovery.
  //
  // The id is not a secret and is stored plain: knowing which question someone
  // picked tells you nothing. The answer is stored exactly the way the password
  // is, as an scrypt digest with its own per-user salt, and is compared in
  // constant time. Nothing reads it back.
  //
  // All three are nullable, because rows predating this have no answer to store
  // and backfilling one would mean inventing a secret on someone's behalf. The
  // consequence is deliberate and is written down in `handoff.md`: those
  // accounts cannot recover until they set a question, and recovery for them
  // fails through exactly the same generic path a wrong answer takes.
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS security_question_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS security_answer_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS security_answer_salt TEXT;
  `)

  // The short join code, alongside the long link token on the same share row.
  //
  // Stored in plain text, which is deliberate and is the one place this file
  // departs from "credentials are only ever stored hashed". The code exists to
  // be read aloud and put on a screen, so it has to be recoverable — and at six
  // characters it carries little enough entropy that hashing would protect
  // almost nothing against anyone holding the table. What actually defends it
  // is the rate limit on redemption, not the storage.
  await client.query(`
    ALTER TABLE board_shares ADD COLUMN IF NOT EXISTS code TEXT;
    ALTER TABLE board_shares ADD COLUMN IF NOT EXISTS code_expires_at BIGINT;
  `)

  await backfillJoinCodes(client)

  // Indexes cover every column a request filters, joins, or sorts on. The one
  // deliberate exception is the hourly allowance sweep below, which scans a
  // table holding roughly one row per address seen in the last hour.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email    ON users(email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
    CREATE INDEX        IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
    CREATE INDEX        IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

    -- Looked up on every reset attempt, so it must not be a sequential scan.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resets_token  ON password_resets(token_hash);
    CREATE INDEX        IF NOT EXISTS idx_resets_user   ON password_resets(user_id);
    CREATE INDEX        IF NOT EXISTS idx_resets_expiry ON password_resets(expires_at);

    -- Composite: the board list filters by owner and sorts by recency, so one
    -- index serves both halves of the keyset pagination query.
    CREATE INDEX IF NOT EXISTS idx_boards_user_updated
      ON boards(user_id, updated_at DESC, id DESC);

    -- Redeeming a link looks the token up on every attempt, so it must not be
    -- a sequential scan. Unique, because a token identifies at most one link.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_token ON board_shares(token_hash);
    CREATE INDEX        IF NOT EXISTS idx_shares_board ON board_shares(board_id);

    -- Partial, so a code is unique only among links that still work. Once a
    -- share is revoked its code is free to be handed out again, which matters
    -- because the space of six readable characters is not large.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_code
      ON board_shares(code) WHERE revoked_at IS NULL;

    -- (user_id, board_id) serves both callers: the board list filters by user,
    -- and the access check looks up the pair.
    CREATE INDEX IF NOT EXISTS idx_members_user ON board_members(user_id, board_id);

    -- The member list filters by board and sorts by join order, which the index
    -- above cannot serve in that direction.
    CREATE INDEX IF NOT EXISTS idx_members_board_joined
      ON board_members(board_id, joined_at);
  `)

  // Every rate-limit query reaches this table by primary key, so an index on
  // locked_until was only ever write amplification. Dropped rather than left
  // behind, since installs that already ran the old migration still have it.
  await client.query('DROP INDEX IF EXISTS idx_attempts_locked;')
}

/**
 * Give a code to every live share issued before codes existed.
 *
 * The alternative — leaving them null — means a share whose link still works
 * reads as "not shared" in the dialog, and the owner turns sharing back on and
 * silently revokes a link people are already using. Backfilling is the
 * non-destructive option: the old link keeps working and gains a code.
 *
 * Runs inside the migration advisory lock, so concurrent boots do not both
 * try to fill the same rows.
 */
async function backfillJoinCodes(client) {
  const { rows } = await client.query(
    `SELECT id FROM board_shares
      WHERE revoked_at IS NULL AND (code IS NULL OR code_expires_at IS NULL)`,
  )

  for (const row of rows) {
    await withFreshCode((code) =>
      client.query('UPDATE board_shares SET code = $1, code_expires_at = $2 WHERE id = $3', [
        code,
        codeExpiryFrom(),
        row.id,
      ]),
    )
  }
}

/**
 * Values are always bound as $1, $2 … and never concatenated into SQL, which
 * is what makes injection structurally impossible rather than filtered.
 */
export const get = async (sql, ...params) => (await pool.query(sql, params)).rows[0] ?? null
export const all = async (sql, ...params) => (await pool.query(sql, params)).rows
export const run = async (sql, ...params) => {
  const result = await pool.query(sql, params)
  return { changes: result.rowCount }
}

/** Runs `fn` on a single pooled client inside a transaction. */
export async function transaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release() // back to the pool, not closed
  }
}

// `purgeExpiredSessions` used to sit here, beside the other two sweeps. It is
// in `sessions.js` now, because deleting a session row is only half of ending a
// session and this file has no business knowing about the other half. See the
// rule at the top of that file.

/** Comfortably longer than the longest window any limiter uses (one hour). */
const ALLOWANCE_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * Sweep allowances nothing can still be counting.
 *
 * Several limiters are keyed on values a stranger chooses — an address typed
 * into "forgot password", an IP, a user id — so without a sweep the table only
 * ever grows, one row per distinct value anyone ever sent. A row this old is
 * already dead: every limiter that reads it treats a window this stale as
 * expired and starts the count again from one, so deleting it changes no
 * decision, it just stops the table carrying the history.
 *
 * `account:` is the exception, and is left alone deliberately. Its counter has
 * no rolling window: it resets by serving a lockout, not by going quiet, so
 * deleting a stale row there would hand back attempts the limiter is still
 * withholding.
 */
export async function purgeStaleAllowances() {
  const { changes } = await run(
    `DELETE FROM login_attempts
      WHERE key NOT LIKE 'account:%' AND last_attempt < $1`,
    Date.now() - ALLOWANCE_RETENTION_MS,
  )
  return changes
}

export const closePool = () => pool.end()
