import pg from 'pg'
import { generateCode, codeExpiryFrom } from './joinCode.js'

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
  allowExitOnIdle: false,
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
  `)

  // Whether members may edit is a property of the board, not of the person, so
  // the owner can lock the room to demonstrate and unlock it again without
  // touching anyone's access.
  await client.query(`
    ALTER TABLE boards ADD COLUMN IF NOT EXISTS members_can_edit BOOLEAN NOT NULL DEFAULT true;
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

  // Indexes cover every column we filter, join, or sort on.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email    ON users(email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
    CREATE INDEX        IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
    CREATE INDEX        IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE INDEX        IF NOT EXISTS idx_attempts_locked ON login_attempts(locked_until);

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
  `)
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
    // Retry on the unique index rather than checking first, which would race.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await client.query(
          'UPDATE board_shares SET code = $1, code_expires_at = $2 WHERE id = $3',
          [generateCode(), codeExpiryFrom(), row.id],
        )
        break
      } catch (err) {
        if (err.code !== '23505') throw err
      }
    }
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

export async function purgeExpiredSessions() {
  const { changes } = await run('DELETE FROM sessions WHERE expires_at <= $1', Date.now())
  return changes
}

export const closePool = () => pool.end()
