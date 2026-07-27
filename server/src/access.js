import { get } from './db.js'

/**
 * The one place "may this person touch this board?" is answered.
 *
 * Two roles, not three. The owner holds the board and manages who else is in
 * it; everybody else is a member. Whether members may edit is a property of the
 * *board* rather than of the person, which is what lets a coach lock the room
 * to demonstrate and unlock it again without touching anyone's access.
 *
 * Every route and the WebSocket relay authorize through here, so there is a
 * single function to audit rather than an ownership check copied into each
 * handler.
 */

const NO_ACCESS = { role: null, membersCanEdit: false, canEdit: false }

/**
 * Role and edit rights in one indexed round trip.
 *
 * A LEFT JOIN rather than two queries: the common case is a board you own, and
 * asking separately would double the latency of every authorized request. The
 * join also means a missing board and an inaccessible one come back the same
 * way, so callers cannot accidentally leak which it was.
 */
export async function accessFor(boardId, userId) {
  if (!boardId || !userId) return NO_ACCESS

  const row = await get(
    `SELECT b.user_id = $2        AS is_owner,
            m.user_id IS NOT NULL AS is_member,
            b.members_can_edit
       FROM boards b
       LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = $2
      WHERE b.id = $1`,
    boardId,
    userId,
  )
  if (!row) return NO_ACCESS

  const role = row.is_owner ? 'owner' : row.is_member ? 'member' : null
  if (!role) return NO_ACCESS

  return {
    role,
    membersCanEdit: row.members_can_edit,
    // The owner is never locked out by their own lock.
    canEdit: role === 'owner' || row.members_can_edit,
  }
}
