import { Router } from 'express'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { get, all, run, transaction } from '../db.js'
import { accessFor } from '../access.js'
import { publish, anonymousNameFor } from '../realtime.js'
import { consume } from '../rateLimit.js'
import { createSession, signIn } from '../auth.js'
import { normalizeCode, codeExpiryFrom, withFreshCode } from '../joinCode.js'
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
           (id, board_id, token_hash, code, code_expires_at, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, req.params.id, digest(token), candidate, expiresAt, req.user.id, new Date().toISOString()],
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
      'UPDATE board_shares SET code = $1, code_expires_at = $2 WHERE id = $3',
      candidate,
      expiresAt,
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

/** Removing a member also throws them out of the room, on every instance. */
sharesRouter.delete('/:id/members/:userId', async (req, res) => {
  if (!(await requireOwner(req, res))) return
  const { changes } = await run(
    'DELETE FROM board_members WHERE board_id = $1 AND user_id = $2',
    req.params.id,
    req.params.userId,
  )
  if (changes === 0) return res.status(404).json({ error: 'That person is not on this board.' })
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
    `SELECT s.id, s.board_id, b.name
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
    `SELECT s.id, s.board_id, s.code_expires_at, b.name
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

  // Only now, with a live code in hand, is an account made. Every failure above
  // returns having created nobody.
  if (!req.user) {
    const guestId = await admitAsGuest(share)
    signIn(res, await createSession(guestId))
    return res.json({ board: { id: share.board_id, name: share.name } })
  }

  res.json({ board: await admit(share, req.user) })
})
