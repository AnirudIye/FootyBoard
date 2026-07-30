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

    -- One row per destroyed session, so that an eviction survives the bus that
    -- was supposed to carry it. The evict-session NOTIFY is the only thing that
    -- closes an already-open socket, and an instance whose LISTEN connection is
    -- down when it is published never hears it; this table is what that
    -- instance reads when its listener comes back. Written in the same
    -- transaction as the DELETE FROM sessions, in sessions.js, and read in
    -- realtime.js.
    --
    -- Neither column is a foreign key, and both omissions are deliberate.
    -- session_id names a row that is gone by construction -- that is the event
    -- being recorded. user_id must not cascade from users, because DELETE
    -- /api/auth/me destroys the sessions and then the account, and a cascade
    -- would take the revocations with it: the one case where somebody has asked
    -- for every trace of themselves to stop working is the last case that
    -- should lose its evictions. It is not what the sweep matches on either; it
    -- is here so a row still says whose session this was once the session row
    -- it names no longer exists.
    CREATE TABLE IF NOT EXISTS session_revocations (
      session_id TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      revoked_at BIGINT NOT NULL
    );

    -- Ten ways back into an account whose authenticator is gone, hashed exactly
    -- the way every other machine-generated credential here is.
    --
    -- SHA-256 rather than scrypt, and that is the line this file already draws
    -- consistently rather than a shortcut: human-chosen secrets go through
    -- hashPassword (the password, and the security answer, which reuses the same
    -- function), and high-entropy tokens drawn from randomInt are stored as
    -- SHA-256, like sessions, resets and share links. scrypt exists to make
    -- grinding a *guessable* secret expensive, and sixteen characters over 24
    -- letters is about 2^72.7, which is not guessable in that sense. It is also
    -- what lets the check be one indexed read, which is in turn what lets
    -- UPDATE ... WHERE used_at IS NULL be the whole single-use mechanism instead
    -- of ten scrypt derivations per submitted code.
    --
    -- used_at rather than a delete, so a spent code stays a row: the count the
    -- account page shows is "unused", and a deleted row could not tell the
    -- difference between a code that was spent and one that was never issued.
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash  TEXT NOT NULL,
      used_at    BIGINT,
      created_at TEXT NOT NULL
    );

    -- What exists between "password accepted" and "code accepted", and nothing
    -- more than that.
    --
    -- A row rather than a signed token, because npm run cluster forks N
    -- instances behind a round-robin balancer: the instance that checks the code
    -- is almost never the one that checked the password, so nothing about this
    -- can live in process memory. A signed token would also be one this server
    -- could not revoke, and turning 2FA off has to be able to void a pending one.
    --
    -- purpose is 'login' or 'reset' and is compared in the same statement that
    -- claims the row. A challenge earned by answering the security question must
    -- not be spendable at the sign-in form and the reverse, or the second factor
    -- would be proved once and reused to buy a different privilege.
    --
    -- used_at and expires_at are both here because both failures are real: a
    -- challenge is single use, and one left in a closed tab has to stop working
    -- on its own. Neither is checked by reading the row first; see the UPDATE in
    -- twoFactor.js.
    CREATE TABLE IF NOT EXISTS auth_challenges (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      purpose    TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at    BIGINT,
      created_at TEXT NOT NULL
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

  /**
   * An account somebody was given rather than made.
   *
   * Somebody handed a join code and told to type it wanted the board, not a
   * signup form. The standing argument for making them register first was that
   * "membership attaches to a person rather than a browser", and it does not
   * survive reading `POST /api/auth/signup`, which verifies no address at all:
   * anyone who wanted through that gate was through it in fifteen seconds with a
   * throwaway. It was a constraint on this table, not a barrier.
   *
   * So a guest gets a row here with no address and no password, and a real
   * `board_members` row like anybody else. Three consequences, all deliberate.
   *
   * `email`, `password_hash` and `password_salt` become nullable. The unique
   * index on `email` still holds, because Postgres does not consider two NULLs
   * equal, so guests do not collide with each other or with anybody. **Every
   * credential path must miss these rows rather than match loosely**, which
   * `WHERE email = $1` does for free since `NULL = anything` is NULL and never
   * true. That is structural rather than filtered, and it is asserted in
   * `guestJoin.test.js` because getting it wrong is an authentication bypass
   * rather than a bug.
   *
   * `accepted_terms_at` stays NOT NULL. A guest is asked on the way through, at
   * the door, and the timestamp is when they went through it. Loosening it would
   * have been the easy way and would have left the column lying.
   *
   * `is_guest` is stored rather than derived from `password_hash IS NULL`. The
   * two would agree today, and a stored flag is a fact about how the account
   * came to exist rather than an inference from what it currently lacks, which
   * is what `POST /api/auth/claim` needs to be able to refuse a second time.
   */
  await client.query(`
    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    ALTER TABLE users ALTER COLUMN password_salt DROP NOT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT false;
  `)

  /**
   * The name a person chooses for the room to call them.
   *
   * Presence named a member by their address, and the only escape was the
   * owner's per-board "Anonymous guests" switch, which is off by default because
   * a coaching staff who know each other are better served by real names. So a
   * signed-up member showed their local part to everybody in the room unless
   * somebody else had thought about it. This column is what they get to decide
   * for themselves, and `identity()` in `realtime.js` is the only thing that
   * reads it — the substitution has to happen in the payload, since sending an
   * address and asking the browser to hide it still sends it.
   *
   * Nullable, and required at signup and at `/claim`. Those are the two places
   * an account comes into existence with credentials, so requiring it there is
   * what makes every *new* account safe by construction. **The consequence is
   * deliberate and is written down in `handoff.md`: accounts that existed before
   * this column have a null here and go on disclosing their address until they
   * set one.** Backfilling would mean inventing a name on somebody's behalf, and
   * defaulting everyone to a generated animal would turn a working roster into a
   * zoo without being asked — the same argument that keeps anonymity off by
   * default. It is the same shape as the security-question backfill above it.
   *
   * No unique index. Two people may be called Sam, and a name is a label rather
   * than an identity: nothing authenticates on it, nothing looks an account up
   * by it, and refusing the second Sam would be a puzzle at signup in exchange
   * for nothing.
   */
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
  `)

  // Which lineage the board's contents are on, so a write from a superseded one
  // can be refused rather than winning by arriving last.
  //
  // **It bumps only on a write that also broadcasts `replaced`** — undo, redo,
  // reset, a format change, or answering a joiner — and that restraint is the
  // whole design rather than an optimisation. A counter incremented by every
  // write would be correct and unusable: an ordinary autosave announces itself to
  // nobody, so in a two-person room every alternating save leaves the other
  // client's base stale, and each refusal costs a full board read and that
  // client's undo history, in the case where both already hold identical contents
  // because the ops flowed between them.
  //
  // Bumping only on replacement makes a refusal mean one specific thing: your
  // contents come from a lineage this board is no longer on. That is exactly the
  // case that used to diverge a room for good, and it is what makes the client's
  // response to a refusal — re-read and adopt, discarding local work — correct
  // rather than merely tolerable.
  //
  // No index. It is only ever read and compared by primary key, so one would be
  // write amplification, which is the reasoning that dropped `idx_attempts_locked`.
  await client.query(`
    ALTER TABLE boards ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1;
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

  /**
   * The second factor, as three columns rather than a table.
   *
   * Columns on `users` because every other credential on this account is already
   * one (`password_hash`, `password_salt`, `security_question_id`,
   * `security_answer_hash`, `security_answer_salt`), the relationship is
   * one-to-one, the row is already read on every authenticated request by
   * `sessionForToken`, and `ON DELETE` needs no thought.
   *
   * **`totp_secret` is sealed, not hashed, and the difference is forced rather
   * than chosen.** A TOTP secret is a bearer credential: the server has to
   * recompute the same HMAC the phone computes, so it must be recoverable in
   * plaintext and `hashPassword` is structurally unavailable, unlike for the
   * password and the security answer above. What is available is `crypto.js`,
   * which already seals board contents, so a stolen database or a leaked backup
   * yields no working factors without a key that lives in the environment. Two
   * costs, said here rather than left to be found: in development and test the
   * key is derived from `SESSION_SECRET`, so this is worth about as much as it
   * is for boards in a dev database, which is very little; and a stolen database
   * *plus* a stolen `ENCRYPTION_KEY` does yield working factors, which is
   * inherent to TOTP and is why the recovery codes are hashed instead.
   *
   * **`totp_confirmed_at` is the switch, not `totp_secret`.** A secret with a
   * NULL timestamp is an enrollment somebody started and did not finish, and
   * every login path must ignore it completely. Deriving "is 2FA on" from
   * `totp_secret IS NOT NULL` would turn an abandoned enrollment into a lockout.
   * It is the same distinction `is_guest` draws above: a stored fact about how
   * the account got here beats an inference from what it currently holds.
   *
   * **`totp_last_step` is the replay defence**, claimed in one UPDATE guarded on
   * the step being newer. A code is live for ninety seconds, so somebody who
   * reads one over a shoulder or lifts one off a phished form has a real window;
   * banking the step is what closes it, and doing it as a claim rather than a
   * read is what stops two requests carrying the same code both passing.
   *
   * All three nullable, because an account with no factor is the normal case and
   * 2FA here is opt-in. No index on any of them: they are only ever read and
   * written by primary key, so one would be write amplification, which is the
   * reasoning that dropped `idx_attempts_locked`.
   */
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret       TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_confirmed_at TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step    BIGINT;
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

    -- Both readers of session_revocations filter on this and nothing else: an
    -- instance catching up asks for rows newer than its watermark, and the
    -- hourly sweep asks for rows older than the retention. Nothing ever looks a
    -- revocation up by session or by user, which is why neither has an index.
    CREATE INDEX        IF NOT EXISTS idx_revocations_at ON session_revocations(revoked_at);

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

    -- The lookup is always (this user, this code), never a code on its own, so
    -- the composite serves both the check and the per-user delete on disable.
    -- Unique, because one code is one row, and it is what keeps a submitted code
    -- to a single indexed read rather than a scan of everybody's.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_user_code
      ON recovery_codes(user_id, code_hash);

    -- Read by token on every second-factor attempt, so it must not be a scan.
    -- Unique for the reason the reset and share token indexes are: a token
    -- identifies at most one challenge.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_challenges_token  ON auth_challenges(token_hash);
    -- Turning 2FA off voids this account's pending challenges, which filters on
    -- the user and nothing else.
    CREATE INDEX        IF NOT EXISTS idx_challenges_user   ON auth_challenges(user_id);
    -- And the hourly sweep asks for everything already expired.
    CREATE INDEX        IF NOT EXISTS idx_challenges_expiry ON auth_challenges(expires_at);
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

/**
 * The database's own clock, in the milliseconds every timestamp column here
 * counts in.
 *
 * Written down once because two things compare against it across processes: a
 * revocation is stamped with it in `sessions.js`, and an instance catching up
 * in `realtime.js` decides what it has already applied by it. Taking both from
 * the database rather than from `Date.now()` in each process means there is one
 * clock rather than one per instance — otherwise an instance running a minute
 * fast would quietly hold a watermark past revocations a slower instance had
 * just written, and skip them. That is a silent failure of a security control,
 * which is not the kind of thing to leave resting on NTP.
 *
 * `clock_timestamp()` rather than `now()`: `now()` is the transaction's start
 * time, and the interesting moment is as close to the commit as it can be got.
 */
export const DB_NOW_MS = '(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT'

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
