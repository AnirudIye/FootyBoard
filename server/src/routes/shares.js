import { Router } from 'express'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { get, all, run, transaction } from '../db.js'
import { accessFor } from '../access.js'
import { publish } from '../realtime.js'
import { consume } from '../rateLimit.js'
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

    await transaction(async (client) => {
      await client.query(
        'UPDATE board_shares SET revoked_at = $1 WHERE board_id = $2 AND revoked_at IS NULL',
        [Date.now(), req.params.id],
      )
      await client.query(
        `INSERT INTO board_shares (id, board_id, token_hash, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, req.params.id, digest(token), req.user.id, new Date().toISOString()],
      )
    })

    // The only time the plaintext exists outside the owner's browser.
    res.status(201).json({ share: { id, token, createdAt: new Date().toISOString() } })
  } catch (err) {
    next(err)
  }
})

/** Whether a link is live. Never the token — it is not recoverable, by design. */
sharesRouter.get('/:id/share', async (req, res, next) => {
  try {
    if (!(await requireOwner(req, res))) return
    const row = await get(
      `SELECT id, created_at FROM board_shares
        WHERE board_id = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      req.params.id,
    )
    res.json({ share: row ? { id: row.id, createdAt: row.created_at } : null })
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

    // Owners and existing members redeem harmlessly: joining twice is the same
    // as joining once, and the owner needs no membership row at all.
    const { role } = await accessFor(share.board_id, req.user.id)
    if (!role) {
      await run(
        `INSERT INTO board_members (board_id, user_id, share_id, joined_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (board_id, user_id) DO NOTHING`,
        share.board_id,
        req.user.id,
        share.id,
        new Date().toISOString(),
      )
    }

    res.json({ board: { id: share.board_id, name: share.name } })
  } catch (err) {
    next(err)
  }
})
