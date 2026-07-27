import { Router } from 'express'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { get, all, run, transaction } from '../db.js'
import { accessFor } from '../access.js'
import { publish } from '../realtime.js'
import { consume } from '../rateLimit.js'
import { generateCode, normalizeCode } from '../joinCode.js'
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
sharesRouter.post('/:id/share', async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return

    const token = randomBytes(32).toString('base64url')
    const id = randomUUID()

    // The code has to be unique among live shares, and six readable characters
    // is a small enough space that a collision is worth planning for rather
    // than assuming away. The unique index is the arbiter; this just retries.
    let code = null
    for (let attempt = 0; attempt < 5 && code === null; attempt++) {
      const candidate = generateCode()
      try {
        await transaction(async (client) => {
          await client.query(
            'UPDATE board_shares SET revoked_at = $1 WHERE board_id = $2 AND revoked_at IS NULL',
            [Date.now(), req.params.id],
          )
          await client.query(
            `INSERT INTO board_shares (id, board_id, token_hash, code, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, req.params.id, digest(token), candidate, req.user.id, new Date().toISOString()],
          )
        })
        code = candidate
      } catch (err) {
        // 23505 is unique_violation: that code is already in use by a live
        // share. Anything else is a real failure and should surface.
        if (err.code !== '23505') throw err
      }
    }
    if (code === null) throw new Error('could not allocate a unique join code')

    // The only time the plaintext token exists outside the owner's browser. The
    // code, unlike the token, can be read again — being readable is its job.
    res.status(201).json({ share: { id, token, code, createdAt: new Date().toISOString() } })
  } catch (err) {
    next(err)
  }
})

/**
 * Whether a link is live, and what the join code is.
 *
 * The token is never returned — it is not recoverable, by design. The code is,
 * because the owner has to be able to put it back on screen at the start of
 * every session without invalidating everyone's existing access.
 */
sharesRouter.get('/:id/share', async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return
    const row = await get(
      `SELECT id, code, created_at FROM board_shares
        WHERE board_id = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      req.params.id,
    )
    res.json({ share: row ? { id: row.id, code: row.code, createdAt: row.created_at } : null })
  } catch (err) {
    next(err)
  }
})

sharesRouter.delete('/:id/share', async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return
    await run(
      'UPDATE board_shares SET revoked_at = $1 WHERE board_id = $2 AND revoked_at IS NULL',
      Date.now(),
      req.params.id,
    )
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

sharesRouter.get('/:id/members', async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return
    const rows = await all(
      `SELECT u.id, u.email, m.joined_at
         FROM board_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.board_id = $1
        ORDER BY m.joined_at ASC`,
      req.params.id,
    )
    res.json({
      members: rows.map((r) => ({ id: r.id, email: r.email, joinedAt: r.joined_at })),
    })
  } catch (err) {
    next(err)
  }
})

/** Removing a member also throws them out of the room, on every instance. */
sharesRouter.delete('/:id/members/:userId', async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return
    const { changes } = await run(
      'DELETE FROM board_members WHERE board_id = $1 AND user_id = $2',
      req.params.id,
      req.params.userId,
    )
    if (changes === 0) return res.status(404).json({ error: 'That person is not on this board.' })
    publish(req.params.id, { type: 'evict', userId: req.params.userId })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

/**
 * The editing lock.
 *
 * Broadcast as well as written, so every peer's interface flips within a round
 * trip rather than waiting to discover it by having an edit silently ignored.
 * The relay enforces it independently — this message updates the display, it is
 * not what makes the lock real.
 */
sharesRouter.patch('/:id/lock', async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return
    if (typeof req.body?.locked !== 'boolean')
      throw new BadRequest('Say whether editing is locked.', 'locked')

    const locked = req.body.locked
    await run('UPDATE boards SET members_can_edit = $1 WHERE id = $2', !locked, req.params.id)
    publish(req.params.id, { type: 'lock', locked })
    res.json({ locked })
  } catch (err) {
    next(err)
  }
})

/**
 * Redeem a link.
 *
 * Rate-limited per IP, because guessing a share token is credential-guessing
 * and deserves the same treatment as guessing a password. Every failure mode
 * returns one message, so the endpoint cannot be used to tell an unknown token
 * from a revoked one.
 */
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

redeemRouter.post('/:token/redeem', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Sign in to open a shared board.' })

    await consume(`share:${req.clientIp}`, {
      max: 20,
      windowMs: 10 * 60 * 1000,
      message: 'Too many attempts from this network. Try again shortly.',
    })

    const share = await get(
      `SELECT s.id, s.board_id, b.name
         FROM board_shares s
         JOIN boards b ON b.id = s.board_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
      digest(String(req.params.token)),
    )
    if (!share) return res.status(404).json({ error: 'That link is not valid any more.' })

    res.json({ board: await admit(share, req.user) })
  } catch (err) {
    next(err)
  }
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
 * A malformed code is rejected before the database is touched, but *after* the
 * limiter has counted it, so mashing the keyboard is not a free way to probe.
 */
redeemRouter.post('/join', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Sign in to join a board.' })

    await consume(`join:${req.clientIp}`, {
      max: 10,
      windowMs: 10 * 60 * 1000,
      message: 'Too many attempts from this network. Try again shortly.',
    })

    const code = normalizeCode(req.body?.code)
    // One message for every failure, so this cannot be used to tell a wrong
    // code from a well-formed code for a board that does not exist.
    const wrong = () => res.status(404).json({ error: 'That code is not valid. Check it and try again.' })
    if (!code) return wrong()

    const share = await get(
      `SELECT s.id, s.board_id, b.name
         FROM board_shares s
         JOIN boards b ON b.id = s.board_id
        WHERE s.code = $1 AND s.revoked_at IS NULL`,
      code,
    )
    if (!share) return wrong()

    res.json({ board: await admit(share, req.user) })
  } catch (err) {
    next(err)
  }
})
