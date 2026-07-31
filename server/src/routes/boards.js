import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { get, all, run } from '../db.js'
import { accessFor } from '../access.js'
import { publish } from '../realtime.js'
import {
  validateBoardName,
  validateBoardData,
  validateBaseGeneration,
  validatePageQuery,
} from '../validate.js'
import { encrypt, decrypt } from '../crypto.js'

export const boardsRouter = Router()

/**
 * `pg` hands `BIGINT` back as a string, to avoid silently losing precision past
 * 2^53. A generation that reached the browser as `"6"` would compare false
 * against every number the client holds, in the one comparison this whole
 * mechanism rests on, and would do it without a word. So it is converted at every
 * point it leaves SQL, and nowhere else.
 */
const asNumber = (generation) => Number(generation)

boardsRouter.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to use your boards.' })
  next()
})

/**
 * Keyset pagination, not OFFSET.
 *
 * OFFSET makes the database walk and discard every skipped row, so page 500
 * costs far more than page 1. Seeking from the last item read is flat: the
 * composite index (user_id, updated_at DESC, id DESC) takes us straight to the
 * next slice no matter how deep the list goes.
 *
 * The list never selects the `data` column — a board's JSON is large and the
 * index only needs names and timestamps. That is also why there is no N+1
 * here: one query returns the page, rather than one query for ids plus one per
 * board to fetch its contents.
 *
 * The list covers boards you own *and* boards shared with you. That is a UNION
 * ALL of two indexed branches rather than one query with `OR EXISTS (...)`,
 * because the OR form cannot use either index and degrades into a sequential
 * scan of every board in the table. The second branch excludes boards you own,
 * so the two halves are disjoint by construction and UNION ALL cannot produce a
 * duplicate.
 *
 * Each branch carries its own ORDER BY and LIMIT, and that is what makes the
 * seek flat rather than merely looking flat. With them only on the outside,
 * "shared with you" was materialised and sorted in full on every page before
 * the outer LIMIT threw nearly all of it away — so a member of a thousand
 * boards paid for a thousand rows to read twenty. Bounding each branch first
 * leaves the outer sort merging two inputs of at most `limit` rows, and the
 * answer is identical because the branches are disjoint: a row that belongs on
 * the page cannot have been cut from its own branch by a row that outranks it.
 */
const PAGE_COLUMNS = `b.id, b.name, b.created_at, b.updated_at, b.members_can_edit`

const ownedAndSharedPage = (userId, limit, cursor) => {
  const where = cursor ? 'AND (b.updated_at, b.id) < ($2, $3)' : ''
  const limitParam = cursor ? '$4' : '$2'
  const params = cursor ? [userId, cursor.updatedAt, cursor.id, limit] : [userId, limit]
  const seek = `ORDER BY b.updated_at DESC, b.id DESC LIMIT ${limitParam}`

  return all(
    `(SELECT ${PAGE_COLUMNS}, 'owner' AS role
        FROM boards b
       WHERE b.user_id = $1 ${where}
       ${seek})
     UNION ALL
     (SELECT ${PAGE_COLUMNS}, 'member' AS role
        FROM boards b
        JOIN board_members m ON m.board_id = b.id AND m.user_id = $1
       WHERE b.user_id <> $1 ${where}
       ${seek})
     ORDER BY updated_at DESC, id DESC
     LIMIT ${limitParam}`,
    ...params,
  )
}

boardsRouter.get('/', async (req, res) => {
  const { limit, cursor } = validatePageQuery(req.query)

  // Cursor is "<updated_at>|<id>" — the sort key of the last row on the page.
  const [updatedAt, id] = cursor?.split('|') ?? []
  const rows = await ownedAndSharedPage(req.user.id, limit + 1, cursor ? { updatedAt, id } : null)

  // One extra row is fetched purely to know whether another page exists.
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)

  res.json({
    boards: page.map((b) => ({
      id: b.id,
      name: b.name,
      createdAt: b.created_at,
      updatedAt: b.updated_at,
      role: b.role,
      // Only meaningful to a member; the owner is never locked out by their own
      // lock, so the client can render the toggle from this either way.
      membersCanEdit: b.members_can_edit,
    })),
    nextCursor: hasMore && last ? `${last.updated_at}|${last.id}` : null,
  })
})

boardsRouter.get('/:id', async (req, res) => {
  // Owners and members both read. A board you have no access to and a board
  // that does not exist answer identically, so this cannot be used to probe
  // which board ids are real.
  const access = await accessFor(req.params.id, req.user.id)
  if (!access.role) return res.status(404).json({ error: 'That board does not exist.' })

  const row = await get(
    'SELECT id, name, data, created_at, updated_at, generation FROM boards WHERE id = $1',
    req.params.id,
  )
  if (!row) return res.status(404).json({ error: 'That board does not exist.' })

  let data
  try {
    data = JSON.parse(decrypt(row.data))
  } catch {
    // Wrong key, or a row that was tampered with: say so rather than serving
    // something that looks like a board but is not.
    return res.status(500).json({ error: 'That board could not be unlocked.' })
  }

  res.json({
    board: {
      id: row.id,
      name: row.name,
      data,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // The base a later write has to carry. Read here rather than from a
      // separate endpoint, because "these contents" and "which lineage they are
      // on" are one fact and must not be fetched separately.
      generation: asNumber(row.generation),
      role: access.role,
      membersCanEdit: access.membersCanEdit,
    },
  })
})

boardsRouter.post('/', async (req, res) => {
  // The one caller that wants a fallback title supplies it. `validateBoardName`
  // used to, which meant every other caller got one too, including the rename
  // endpoint where a missing name can only be a mistake.
  const name = validateBoardName(req.body?.name ?? 'Untitled board')
  const data = validateBoardData(req.body?.data)
  const now = new Date().toISOString()
  const id = randomUUID()
  await run(
    `INSERT INTO boards (id, user_id, name, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    id,
    req.user.id,
    name,
    encrypt(data),
    now,
    now,
  )
  res.status(201).json({ board: { id, name, createdAt: now, updatedAt: now } })
})

boardsRouter.put('/:id', async (req, res) => {
  // The editing lock is enforced here as well as in the relay, so a locked
  // member cannot route around a blocked op by saving the whole board.
  const access = await accessFor(req.params.id, req.user.id)
  if (!access.role) return res.status(404).json({ error: 'That board does not exist.' })
  if (!access.canEdit)
    return res.status(403).json({ error: 'The owner has locked editing on this board.' })

  /**
   * Renaming stays the owner's, matching PATCH.
   *
   * A member's autosave sends whatever name their client resolved, so writing
   * it unconditionally let anyone with edit rights retitle a board they do not
   * own — routing straight around the restriction PATCH enforces. A member's
   * PUT writes the board and leaves its title alone. `RETURNING` gives back
   * the name that actually stands either way.
   *
   * Absent and explicitly null both mean "leave the title alone". A client that
   * does not know the name is the case this exists for, and `null` is how a
   * good many of them say that; answering 400 would refuse to save the board
   * over a field the caller was right not to fill in.
   */
  const renaming = access.role === 'owner' && req.body?.name != null
  const name = renaming ? validateBoardName(req.body.name) : null
  const data = validateBoardData(req.body?.data)

  /**
   * Optimistic concurrency, and the reason this endpoint is no longer
   * last-writer-wins.
   *
   * It was one `UPDATE ... SET data` with nothing behind it, so a debounced
   * autosave carrying contents from before somebody pressed undo could commit
   * *after* the undo and win. The room then diverged for good, because the loser
   * re-read and got its own stale board back, and an ordinary autosave announces
   * itself to nobody so nothing ever corrected it. That is gap 10 in
   * `handoff.md`.
   *
   * The compare and the bump are one statement for the same reason every rate
   * limiter here is: a read, a decision, then a write leaves a gap two requests
   * can both pass through, and this is precisely a mechanism about two requests.
   *
   * `replacing` is the client saying this write is a whole-board replacement and
   * will be announced as `replaced`. It is a coordination signal among
   * cooperating clients rather than an access control: a client that lies about
   * it can only clobber a board it already has write access to, which it can do
   * today with an ordinary write. `access.js` above is what decides who may
   * write at all.
   */
  const baseGeneration = validateBaseGeneration(req.body?.baseGeneration)
  const bump = req.body?.replacing === true ? 1 : 0

  const now = new Date().toISOString()
  const updated = renaming
    ? await get(
        `UPDATE boards SET name = $1, data = $2, updated_at = $3, generation = generation + $4
          WHERE id = $5 AND generation = $6
          RETURNING name, generation`,
        name,
        encrypt(data),
        now,
        bump,
        req.params.id,
        baseGeneration,
      )
    : await get(
        `UPDATE boards SET data = $1, updated_at = $2, generation = generation + $3
          WHERE id = $4 AND generation = $5
          RETURNING name, generation`,
        encrypt(data),
        now,
        bump,
        req.params.id,
        baseGeneration,
      )

  /**
   * No row matched, which is two different answers and they must not be merged.
   *
   * The generation moved is a 409: the caller is holding a board this one has
   * replaced, and telling it so is what lets it re-read instead of retrying.
   * The board is gone is the same 404 every other branch gives, and it has to
   * stay a 404: a status that only ever appears for boards that do exist would
   * hand back exactly the question the shared 404 refuses, which is whether a
   * board id is real.
   */
  if (!updated) {
    const current = await get('SELECT generation FROM boards WHERE id = $1', req.params.id)
    if (!current) return res.status(404).json({ error: 'That board does not exist.' })
    return res.status(409).json({
      error: 'This board was changed somewhere else, so that save was not applied.',
      generation: asNumber(current.generation),
    })
  }

  res.json({
    board: {
      id: req.params.id,
      name: updated.name,
      updatedAt: now,
      generation: asNumber(updated.generation),
    },
  })
})

/** Rename only. Sending a whole board just to change its title would be waste. */
boardsRouter.patch('/:id', async (req, res) => {
  const name = validateBoardName(req.body?.name)
  const now = new Date().toISOString()
  const result = await run(
    'UPDATE boards SET name = $1, updated_at = $2 WHERE id = $3 AND user_id = $4',
    name,
    now,
    req.params.id,
    req.user.id,
  )
  if (result.changes === 0) return res.status(404).json({ error: 'That board does not exist.' })
  res.json({ board: { id: req.params.id, name, updatedAt: now } })
})

boardsRouter.delete('/:id', async (req, res) => {
  const result = await run(
    'DELETE FROM boards WHERE id = $1 AND user_id = $2',
    req.params.id,
    req.user.id,
  )
  if (result.changes === 0) return res.status(404).json({ error: 'That board does not exist.' })
  /**
   * Everybody in the room is now editing something that does not exist.
   *
   * A socket is authorized once, at the handshake, so the delete says nothing
   * to a connection that is already open: a member went on drawing on a board
   * whose row was gone, with every REST call they made answering 404, until
   * they happened to disconnect. `reconcileRooms` already caught it the next
   * time this instance's listener reopened, which is what makes it survive a
   * bus outage; this is the other half, which is that it should not have to
   * wait for one. Published after the row is gone, never before, so a delete
   * that fails throws nobody out.
   */
  publish(req.params.id, { type: 'evict-board' })
  res.status(204).end()
})
