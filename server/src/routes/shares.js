import { Router } from 'express'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { get, all, run, transaction, DB_NOW_MS } from '../db.js'
import { accessFor } from '../access.js'
import { publish, anonymousNameFor } from '../realtime.js'
import { consume } from '../rateLimit.js'
import { createSession, signIn } from '../auth.js'
import { REVOCATION_RETENTION_MS } from '../sessions.js'
import { normalizeCode, codeExpiryFrom, withFreshCode, CODE_TTL_MS } from '../joinCode.js'
import { BadRequest } from '../validate.js'

/**
 * Sharing a board.
 *
 * A share link is a credential and is treated like one: a random token, only
 * its SHA-256 stored, shown to the owner exactly once and revocable by a single
 * row. Membership is kept separately, because the two answer different
 * questions — revoking the link stops new people joining, and does not eject
 * the ones already inside.
 *
 * Everything except redeeming is owner-only.
 */

export const sharesRouter = Router()
export const redeemRouter = Router()

const digest = (token) => createHash('sha256').update(token).digest('hex')

sharesRouter.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to use your boards.' })
  next()
})

/** Owner-only guard. Says "does not exist" for a board you cannot see. */
async function requireOwner(req, res) {
  const { role } = await accessFor(req.params.id, req.user.id)
  if (role !== 'owner') {
    res.status(role ? 403 : 404).json({
      error: role ? 'Only the board owner can do that.' : 'That board does not exist.',
    })
    return false
  }
  return true
}

/**
 * Create or rotate the link.
 *
 * Rotating revokes the previous one in the same transaction, so there is never
 * a moment when two links are live — "regenerate" means the old one stops
 * working, which is the only useful reading of it.
 */
sharesRouter.post('/:id/share', async (req, res) => {
  if (!(await requireOwner(req, res))) return

  const token = randomBytes(32).toString('base64url')
  const id = randomUUID()
  const expiresAt = codeExpiryFrom()

  const code = await withFreshCode((candidate) =>
    transaction(async (client) => {
      await client.query(
        'UPDATE board_shares SET revoked_at = $1 WHERE board_id = $2 AND revoked_at IS NULL',
        [Date.now(), req.params.id],
      )
      await client.query(
        `INSERT INTO board_shares
           (id, board_id, token_hash, code, code_expires_at, code_issued_at, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          req.params.id,
          digest(token),
          candidate,
          expiresAt,
          Date.now(),
          req.user.id,
          new Date().toISOString(),
        ],
      )
    }),
  )

  // The only time the plaintext token exists outside the owner's browser. The
  // code, unlike the token, can be read again — being readable is its job.
  res.status(201).json({
    share: { id, token, code, codeExpiresAt: expiresAt, createdAt: new Date().toISOString() },
  })
})

/**
 * Whether a link is live, and what the join code is.
 *
 * The token is never returned — it is not recoverable, by design. The code is,
 * because the owner has to be able to put it back on screen at the start of
 * every session without invalidating everyone's existing access.
 */
sharesRouter.get('/:id/share', async (req, res) => {
  if (!(await requireOwner(req, res))) return
  // `anonymousPresence` rides along rather than getting its own endpoint: the
  // share dialog opens once and needs both, and a second round trip to fill in
  // one boolean would only make the panel paint in two stages. It sits beside
  // `share` rather than inside it because it belongs to the board and outlives
  // any particular link — turning sharing off must not read as turning
  // anonymity off.
  const [row, board] = await Promise.all([
    get(
      `SELECT id, code, code_expires_at, created_at FROM board_shares
        WHERE board_id = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      req.params.id,
    ),
    get('SELECT anonymous_presence FROM boards WHERE id = $1', req.params.id),
  ])
  res.json({
    share: row
      ? {
          id: row.id,
          code: row.code,
          // Returned even when it has passed, so the owner is shown an
          // expired code and a way to refresh it rather than an empty panel
          // that looks like sharing was never turned on.
          codeExpiresAt: Number(row.code_expires_at),
          createdAt: row.created_at,
        }
      : null,
    anonymousPresence: board?.anonymous_presence === true,
  })
})

/**
 * A fresh code on the existing share, leaving the link alone.
 *
 * Separate from rotating the whole share because the two have different
 * blast radii. The code is session-scoped and expected to be refreshed at the
 * start of every session; the link is a credential people may have saved.
 * Making "new code" also break every saved link would mean nobody dares press
 * it, which defeats having an expiry at all.
 *
 * **It is also the owner's undo for a removal**, without a second control to
 * find. A removed member is refused the code that was live when they were
 * removed, and this is what issues one that was not; see `removedSince` below
 * for the whole argument. Nothing here has to know that, which is the point of
 * comparing timestamps rather than keeping a list somebody has to remember to
 * clear.
 */
sharesRouter.post('/:id/share/code', async (req, res) => {
  if (!(await requireOwner(req, res))) return

  const share = await get(
    `SELECT id FROM board_shares
      WHERE board_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    req.params.id,
  )
  if (!share) return res.status(404).json({ error: 'Sharing is not on for this board.' })

  const expiresAt = codeExpiryFrom()
  const code = await withFreshCode((candidate) =>
    run(
      'UPDATE board_shares SET code = $1, code_expires_at = $2, code_issued_at = $3 WHERE id = $4',
      candidate,
      expiresAt,
      Date.now(),
      share.id,
    ),
  )
  res.json({ share: { id: share.id, code, codeExpiresAt: expiresAt } })
})

sharesRouter.delete('/:id/share', async (req, res) => {
  if (!(await requireOwner(req, res))) return
  await run(
    'UPDATE board_shares SET revoked_at = $1 WHERE board_id = $2 AND revoked_at IS NULL',
    Date.now(),
    req.params.id,
  )
  res.status(204).end()
})

/**
 * Who is on this board, for the owner alone.
 *
 * **Two fields, and only one of them is ever drawn**, which is the same division
 * the presence protocol already makes: `email` is what the server chose to
 * disclose and `displayName` is what a client renders. Keeping the convention
 * identical on both wires is the point — one rule to know rather than two.
 *
 * This used to select `u.email` and nothing else, which was fine until a join
 * code could admit somebody without an account. A guest's address is null, so the
 * owner's own "who has access to my board" list drew a blank row with a Remove
 * button beside it, and two guests were indistinguishable from each other and
 * from a rendering bug.
 *
 * The order the stand-in is chosen in differs from `identity()`'s on purpose, and
 * the difference is the whole reason this endpoint exists. **The owner is entitled
 * to a real address for anybody who has one**: "who has access to my board" is
 * theirs to know, which is not the same question as "who is that cursor", and it
 * is why the anonymity switch deliberately does not reach in here. So the address
 * wins when there is one, and a name only stands in where there is nothing else
 * to give. For a guest who has never chosen one, that is the same generated name
 * the room uses, asked of the same function, so a row here and a cursor on the
 * pitch agree about who somebody is.
 */
sharesRouter.get('/:id/members', async (req, res) => {
  if (!(await requireOwner(req, res))) return
  const rows = await all(
    `SELECT u.id, u.email, u.display_name, m.joined_at
       FROM board_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.board_id = $1
      ORDER BY m.joined_at ASC`,
    req.params.id,
  )
  res.json({
    members: rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.email ?? r.display_name ?? anonymousNameFor(req.params.id, r.id),
      joinedAt: r.joined_at,
    })),
  })
})

/**
 * Removing a member, in the one statement that both ends it and writes it down.
 *
 * Deliberately the same shape as `endingSessions` in `sessions.js`, because it
 * is the same problem: **publishing is not the same as arriving.** The `evict`
 * NOTIFY is the only thing that closes an already-open socket, since a socket is
 * authorized once at the handshake and never re-checked, and an instance whose
 * LISTEN connection is down when it is published never hears it. The membership
 * row is gone everywhere, so REST answers 404 on every instance while the
 * removed person keeps a live, authorized socket on that instance — reading
 * every op the room produces and writing their own into it — until they happen
 * to disconnect. Fire-and-forget was the whole defect.
 *
 * One statement rather than a delete followed by an insert, for the reason
 * `sessions.js` gives at length: Postgres runs a data-modifying CTE exactly once
 * and to completion whether or not the outer query reads it, and a statement is
 * its own transaction wherever there is not already one around it. So neither
 * half can commit without the other in either direction — no membership is
 * destroyed without a durable record of the eviction, and no record survives a
 * removal that rolled back and therefore never happened.
 *
 * `ON CONFLICT DO UPDATE` where sessions collide-and-fail, and the difference is
 * real rather than a loosening. A session id is a uuid destroyed once, so a
 * collision there can only be a bug worth failing on. A person can be removed,
 * handed a fresh code, and removed again, and the row records the standing fact
 * "removed at" rather than a history — so a second removal must supersede the
 * first, not fail and leave them a member.
 *
 * **The retention is `sessions.js`'s, imported rather than chosen.** What has to
 * be covered is the window in which a stale socket can still exist, and a socket
 * cannot outlive the session that authorized it: one left alone that long is
 * closed by `purgeExpiredSessions`, which publishes an eviction of its own. Two
 * numbers here would be two answers to one question.
 *
 * Pruning rides along rather than waiting for a sweep, and the exclusion is what
 * makes that safe: a row this statement is about to write must not also be one
 * it deletes, or a removal of somebody last removed a month ago would ask
 * Postgres to delete and update the same row inside one command. Pruning here is
 * sound because this statement is the only thing that ever writes this table --
 * whatever makes it grow is exactly what should make it shrink — and because
 * the reader only ever asks for rows newer than its watermark, so a row left
 * behind by a board nobody removes anyone from again is storage rather than a
 * wrong answer.
 */
const removingMember = `
  WITH gone AS (
    DELETE FROM board_members WHERE board_id = $1 AND user_id = $2
    RETURNING board_id, user_id
  ), recorded AS (
    INSERT INTO board_member_revocations (board_id, user_id, revoked_at)
    SELECT board_id, user_id, ${DB_NOW_MS} FROM gone
    ON CONFLICT (board_id, user_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at
  ), swept AS (
    DELETE FROM board_member_revocations
     WHERE revoked_at < $3 AND NOT (board_id = $1 AND user_id = $2)
  )
  SELECT user_id FROM gone
`

/** Removing a member also throws them out of the room, on every instance. */
sharesRouter.delete('/:id/members/:userId', async (req, res) => {
  if (!(await requireOwner(req, res))) return
  const gone = await all(
    removingMember,
    req.params.id,
    req.params.userId,
    Date.now() - REVOCATION_RETENTION_MS,
  )
  if (gone.length === 0) return res.status(404).json({ error: 'That person is not on this board.' })
  publish(req.params.id, { type: 'evict', userId: req.params.userId })
  res.status(204).end()
})

/**
 * The editing lock.
 *
 * Broadcast as well as written, so every peer's interface flips within a round
 * trip rather than waiting to discover it by having an edit silently ignored.
 * The relay enforces it independently — this message updates the display, it is
 * not what makes the lock real.
 */
sharesRouter.patch('/:id/lock', async (req, res) => {
  if (!(await requireOwner(req, res))) return
  if (typeof req.body?.locked !== 'boolean')
    throw new BadRequest('Say whether editing is locked.', 'locked')

  const locked = req.body.locked
  await run('UPDATE boards SET members_can_edit = $1 WHERE id = $2', !locked, req.params.id)
  publish(req.params.id, { type: 'lock', locked })
  res.json({ locked })
})

/**
 * Anonymous guests.
 *
 * A sibling of the lock rather than another field on it, because the two are
 * different decisions with different blast radii: one withholds editing from
 * people who are already here, the other changes what the room discloses about
 * them. Sharing a route would mean either endpoint could silently carry the
 * other's change, and a client sending a partial body would have to be told
 * apart from one meaning "leave that alone".
 *
 * The broadcast is what makes it take effect on instances this process does not
 * hold sockets for. It is deliberately server-internal: the relay caches it and
 * substitutes names in the payloads it builds from then on, so no client ever
 * has to be trusted to hide anything.
 */
sharesRouter.patch('/:id/anonymous', async (req, res) => {
  if (!(await requireOwner(req, res))) return
  if (typeof req.body?.anonymous !== 'boolean')
    throw new BadRequest('Say whether guests are anonymous.', 'anonymous')

  const anonymous = req.body.anonymous
  await run('UPDATE boards SET anonymous_presence = $1 WHERE id = $2', anonymous, req.params.id)
  publish(req.params.id, { type: 'anon', anonymous })
  res.json({ anonymousPresence: anonymous })
})

/**
 * Make an account for somebody who was handed a code, not a signup form.
 *
 * No address and no password, so it is reachable only by the cookie this returns.
 * `accepted_terms_at` is set because the door they came through says so; the
 * column is still NOT NULL and still means what it says.
 *
 * One transaction, because a user row without the membership it was created for
 * is a stranded account, and a membership row for a user that failed to insert
 * cannot exist at all. Either both or neither.
 */
async function admitAsGuest(share) {
  const id = randomUUID()
  const now = new Date().toISOString()

  return await transaction(async (client) => {
    await client.query(
      `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at, is_guest)
       VALUES ($1, NULL, NULL, NULL, $2, $2, true)`,
      [id, now],
    )
    await client.query(
      `INSERT INTO board_members (board_id, user_id, share_id, joined_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, user_id) DO NOTHING`,
      [share.board_id, id, share.id, now],
    )
    return id
  })
}

/**
 * What one code may mint, and why this allowance is not the guessing one.
 *
 * `POST /join` charged nothing on success, for a reason that is right and stays
 * right: a squad, a staff room or a school shares one address, so counting good
 * codes against a per-IP guessing limit turned the tenth player to type a
 * perfectly good code away for ten minutes. The consequence was that **one valid
 * six-character code minted unlimited accounts** — anybody in the hall could
 * hold the button down and fill `users` and `board_members` for as long as the
 * code lived, at no cost.
 *
 * So this is a second allowance rather than a change to the first, and it is
 * keyed on the share rather than on the address. That is the whole reason it can
 * be strict enough to matter: an attacker with a code has as many addresses as
 * they care to rent, so a per-IP cap on this is bypassed by the one party it is
 * aimed at while still being the cap a school NAT runs into. A cap per code is
 * the opposite — it is indifferent to where the requests come from, and the
 * thing it bounds is exactly the thing being abused.
 *
 * Two hundred, against a room. A squad is twenty-five, a class thirty, a year
 * group in a hall perhaps a hundred and fifty, and every one of those is a
 * number the owner could count. Two hundred is comfortably past the largest of
 * them and nowhere near "unlimited", which is what it replaces. It is only
 * charged where an account is actually created: a member who already has one
 * costs a row in `board_members` at most, and making an account is separately
 * limited by signup's own allowance.
 *
 * The window is the life of a code, because that is the span the number was
 * argued against: a code is read out at the start of a session and dies twelve
 * hours later, so "two hundred people" and "two hundred people per code" are the
 * same sentence. It survives the code being refreshed, since the key is the
 * share — an owner refreshing the code has not gained a fresh two hundred, and
 * should not, because refreshing is a thing they do routinely rather than a
 * decision to admit another roomful.
 *
 * Exported because a suite asserting on this counter has to name the key, and a
 * second spelling of it in a test is how a test ends up passing against a
 * limiter that is writing somewhere else.
 */
export const guestMintingKey = (shareId) => `guests:${shareId}`
export const MAX_GUESTS_PER_SHARE = 200

const chargeGuestMinting = (shareId) =>
  consume(guestMintingKey(shareId), {
    max: MAX_GUESTS_PER_SHARE,
    windowMs: CODE_TTL_MS,
    message: 'This board has admitted as many guests as it can for now. Ask the owner for a link.',
  })

/**
 * Whether this person was removed from this board after the credential they are
 * offering came into existence.
 *
 * **Removing a member used to be undone by re-typing the code**, which made the
 * only precise control an owner has over their room a suggestion: the person
 * still had the six letters they were read out, so they typed them again and
 * were admitted, and the same is true of a link they had saved. That is worse
 * than it sounds because removal is what an owner reaches for mid-session, in
 * front of everybody, when somebody is doing something they should not be.
 *
 * The obvious fix — revoke the code on removal — punishes everybody to exclude
 * one person. The code exists to be read aloud to a room and typed by all of
 * them, so retiring it means the eight people who have not joined yet are turned
 * away, and the owner has to interrupt what they were doing to read out a new
 * one. That is a real cost paid by exactly the people who did nothing.
 *
 * So the removal is compared against the credential instead. **You are refused
 * the credentials that were live when you were removed, and any newer one lets
 * you in.** Concretely: the code the room is currently using, and the link as it
 * stood. The owner's undo is therefore something they already do at the start of
 * every session and already have a button for — refresh the code, or rotate the
 * share — rather than a second control nobody would find, and it costs nobody
 * else anything, because a code was going to be refreshed anyway.
 *
 * Two limits, said out loud rather than left to be discovered.
 *
 * **A guest cannot be held to this**, because a guest is an account with no
 * credentials, created on the spot. Somebody removed can press "continue as a
 * guest" and come back as a row nothing can connect to the one that was removed
 * — and there is nothing to connect it to, short of identifying browsers, which
 * this product does not do. The owner sees a new arrival in the members list,
 * which is honest: it *is* a new account.
 *
 * **The block lapses with the retention** on `board_member_revocations`, about a
 * month. For the code that is irrelevant, since one lives twelve hours. For a
 * link it means a removal stops being enforced eventually, and that is the right
 * direction to fail: a removal from a month ago is not obviously meant to be a
 * permanent ban, and the owner who wants one rotates the link.
 */
async function removedSince(boardId, userId, issuedAtMs) {
  if (!userId) return false
  const row = await get(
    'SELECT revoked_at FROM board_member_revocations WHERE board_id = $1 AND user_id = $2',
    boardId,
    userId,
  )
  // A credential with no issue time we can read is treated as older than every
  // removal rather than newer than any, which is what `-Infinity` says. Refusing
  // somebody who can turn round and ask the owner is the recoverable direction;
  // readmitting somebody the owner threw out is not.
  const issued = Number.isFinite(issuedAtMs) ? issuedAtMs : -Infinity
  return row != null && Number(row.revoked_at) > issued
}

/** The one message both redemption paths give somebody who was removed. */
const REMOVED = {
  error:
    'You were removed from this board, so this invitation no longer works for you. ' +
    'Ask the owner for a new one.',
}

/** Shared by both ways in: whoever is asking becomes a member of `share`. */
async function admit(share, user) {
  // Owners and existing members redeem harmlessly: joining twice is the same
  // as joining once, and the owner needs no membership row at all.
  const { role } = await accessFor(share.board_id, user.id)
  if (!role) {
    await run(
      `INSERT INTO board_members (board_id, user_id, share_id, joined_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, user_id) DO NOTHING`,
      share.board_id,
      user.id,
      share.id,
      new Date().toISOString(),
    )
  }
  return { id: share.board_id, name: share.name }
}

/**
 * Redeem a link.
 *
 * Rate-limited per IP, because guessing a share token is credential-guessing
 * and deserves the same treatment as guessing a password. Every failure mode
 * returns one message, so the endpoint cannot be used to tell an unknown token
 * from a revoked one.
 *
 * **Only wrong tokens are counted**, for the reason `/join` was restructured
 * around: an allowance is per IP, and a squad, a staff room or a school shares
 * one address, so charging successful redeems meant the twenty-first person to
 * open one perfectly good link was refused. Someone guessing a 32-byte token
 * produces nothing but failures, so counting only those leaves the guessing
 * protection exactly as strict and costs a real room nothing.
 */
redeemRouter.post('/:token/redeem', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to open a shared board.' })

  const share = await get(
    `SELECT s.id, s.board_id, s.created_at, b.name
       FROM board_shares s
       JOIN boards b ON b.id = s.board_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
    digest(String(req.params.token)),
  )
  if (!share) {
    await consume(`share:${req.clientIp}`, {
      max: 20,
      windowMs: 10 * 60 * 1000,
      message: 'Too many attempts from this network. Try again shortly.',
    })
    return res.status(404).json({ error: 'That link is not valid any more.' })
  }

  // The link's moment is when it was issued, which is when the share row was
  // made: unlike the code, a link is never reissued in place, so rotating the
  // share is the only thing that produces a newer one. Not charged the
  // allowance, because this is a real credential correctly presented rather than
  // a guess, and the counter above exists to stop guessing.
  if (await removedSince(share.board_id, req.user.id, Date.parse(share.created_at))) {
    return res.status(403).json(REMOVED)
  }

  res.json({ board: await admit(share, req.user) })
})

/**
 * Join by typing the short code.
 *
 * Rate limited harder than the link, and deliberately so: six readable
 * characters is a space you could search, given enough attempts, in a way a
 * 32-byte token is not. The limit — not the length — is what makes the code
 * safe, so it is the part worth being strict about. It is keyed per IP and
 * counted in Postgres, so it holds across API instances rather than being
 * resettable by landing on a different one.
 *
 * **Only wrong codes are counted.** Counting successes too made the limit fire
 * on the exact case it exists to serve: a squad in one room shares one address,
 * so the tenth player to type a perfectly good code was turned away for ten
 * minutes. Someone searching the space only ever produces failures, so counting
 * those alone leaves the guessing protection exactly as strict while a room
 * full of people joining costs nothing.
 *
 * What a success does cost is `chargeGuestMinting`, which is a different
 * allowance answering a different question and is kept separate for that reason:
 * this one asks "is somebody searching for a code?" and that one asks "how many
 * accounts may one code bring into existence?". Merging them would reintroduce
 * exactly the turned-away tenth player above.
 *
 * A malformed code is rejected before the database is touched, but *after* the
 * limiter has counted it, so mashing the keyboard is not a free way to probe.
 */
redeemRouter.post('/join', async (req, res) => {
  /**
   * Joining without an account, and why it is asked for rather than assumed.
   *
   * `asGuest` is an explicit flag and not "there was no cookie". A missing
   * cookie is also exactly what an expired session looks like, and somebody
   * whose thirty days ran out between reading the code and typing it would then
   * be silently handed a brand new empty account, walked away from every board
   * they own, with nothing said. The flag makes the caller state the intent, and
   * only the guest door on the auth page sets it.
   *
   * A guest is created only once the code has been checked, further down. Doing
   * it here would make this endpoint a way to fill the users table by guessing,
   * and the guessing allowance exists precisely because six readable characters
   * is a searchable space.
   */
  const asGuest = req.body?.asGuest === true
  if (!req.user && !asGuest)
    return res.status(401).json({ error: 'Sign in to join a board.' })

  const code = normalizeCode(req.body?.code)

  // Counting happens on the failure paths, and throws once the allowance is
  // spent, so a guesser is cut off and a joiner never is.
  const charge = () =>
    consume(`join:${req.clientIp}`, {
      max: 10,
      windowMs: 10 * 60 * 1000,
      message: 'Too many attempts from this network. Try again shortly.',
    })

  // One message for every failure, so this cannot be used to tell a wrong code
  // from a well-formed code for a board that does not exist.
  const wrong = async () => {
    await charge()
    return res.status(404).json({ error: 'That code is not valid. Check it and try again.' })
  }
  if (!code) return await wrong()

  const share = await get(
    `SELECT s.id, s.board_id, s.code_expires_at, s.code_issued_at, b.name
       FROM board_shares s
       JOIN boards b ON b.id = s.board_id
      WHERE s.code = $1 AND s.revoked_at IS NULL`,
    code,
  )
  if (!share) return await wrong()

  /**
   * An expired code is called expired, unlike a wrong one.
   *
   * This does leak one bit — that a given string was a real code once — but
   * the string is useless by then, and a live code is still never
   * distinguishable from a wrong one. Weighed against telling someone whose
   * session ran over "that code is not valid" when it plainly was, and
   * sending them to check for a typo that is not there, the bit is worth it.
   *
   * It is charged the allowance all the same. That one bit is exactly what a
   * search wants, so landing on a code that was real once has to cost the same
   * as landing on one that never was; otherwise the informative answer is the
   * free one, and expired rows accumulate as a growing set of free hits.
   */
  if (Number(share.code_expires_at) <= Date.now()) {
    await charge()
    return res
      .status(410)
      .json({ error: 'That code has expired. Ask for the new one and try again.' })
  }

  /**
   * A live code, and the person offering it was thrown out after it was issued.
   *
   * Not charged the guessing allowance, deliberately. That counter exists to
   * stop somebody searching 191 million combinations, and this caller did not
   * search: they were given the code, in the room, before they were removed.
   * Charging them would also make "removed" and "wrong" cost the same, which is
   * the reverse of what the allowance is for — it would let a guesser spend
   * somebody else's attempts by presenting a code they already know is real.
   */
  const codeIssuedAt = share.code_issued_at == null ? NaN : Number(share.code_issued_at)
  if (await removedSince(share.board_id, req.user?.id, codeIssuedAt)) {
    return res.status(403).json(REMOVED)
  }

  // Only now, with a live code in hand, is an account made. Every failure above
  // returns having created nobody.
  if (!req.user) {
    await chargeGuestMinting(share.id)
    const guestId = await admitAsGuest(share)
    signIn(res, await createSession(guestId))
    return res.json({ board: { id: share.board_id, name: share.name } })
  }

  res.json({ board: await admit(share, req.user) })
})
