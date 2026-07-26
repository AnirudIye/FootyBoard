import type { Token, Drawing, Frame, Team, ViewSettings, CustomFormation } from '../types'

/**
 * What travels between peers in a room.
 *
 * **Ops carry outcomes, not intents.** The client that made a change runs the
 * ordinary store action first — with all its renumbering, clamping and
 * mirroring — and then broadcasts the values it settled on. Peers apply those
 * results rather than re-deriving them from the same inputs.
 *
 * That is the decision the rest of this design rests on. Re-deriving would mean
 * two implementations of every rule, which drift; applying a resolved value
 * means last-write-wins is trivially correct, because the last op to arrive
 * simply *is* the state.
 *
 * The discriminant is `type`, matching the presence messages the relay already
 * sends and the guard it already applies. Payloads must stay small: the
 * cross-instance hop rides a Postgres NOTIFY, which is capped, and an oversized
 * message is dropped there rather than truncated.
 */

/** Ephemeral state, never persisted and dropped when its peer leaves. */
export interface CursorOp {
  type: 'cursor'
  /** Normalized pitch coordinates, 0..100, so peers agree regardless of zoom. */
  x: number
  y: number
}

export interface SelectionOp {
  type: 'sel'
  ids: string[]
}

export type EntityOp =
  | { type: 'patch'; entity: 'token'; id: string; patch: Partial<Token> }
  | { type: 'patch'; entity: 'drawing'; id: string; patch: Partial<Drawing> }
  | { type: 'patch'; entity: 'team'; id: string; patch: Partial<Team> }
  | { type: 'patch'; entity: 'frame'; id: string; patch: Partial<Frame> }
  | { type: 'add'; entity: 'token'; item: Token }
  | { type: 'add'; entity: 'bench'; item: Token }
  | { type: 'add'; entity: 'drawing'; item: Drawing }
  | { type: 'add'; entity: 'frame'; item: Frame }
  | { type: 'add'; entity: 'customFormation'; item: CustomFormation }
  /**
   * `selection` is its own entity rather than a list of token ids, because
   * deleting a selection is not only a token operation: a selection can mix
   * chips and annotations, and it also has to detach anything still pinned to a
   * chip that is going away.
   */
  | { type: 'remove'; entity: 'selection' | 'drawing' | 'frame'; ids: string[] }
  /** A formation applied to a whole team: many tokens, each a handful of fields. */
  | { type: 'bulk'; tokens: BulkToken[] }
  | { type: 'bench'; id: string }
  | { type: 'unbench'; id: string; x: number; y: number }
  | { type: 'view'; patch: Partial<ViewSettings> }

export interface BulkToken {
  id: string
  x: number
  y: number
  number?: number
  shape?: Token['shape']
}

/**
 * Whole-board changes, which cannot be sent as ops.
 *
 * Undo, redo, reset and opening another board all replace everything at once,
 * and a full board is far larger than the payload cap. So they do not travel
 * over the socket at all: the originator writes to the server and then says
 * `replaced`, and peers re-read over REST. A joiner asking `need-state` uses
 * the same answer, which is why there is one message here rather than two — the
 * question "what is the board now?" has one answer however it came to be asked.
 */
export interface ResyncOp {
  type: 'need-state' | 'replaced'
}

/**
 * "I am also here", sent in reply to someone joining.
 *
 * The server's `welcome` roster can only name sockets on the instance that
 * answered the connection, and the cluster spreads one room across all of them.
 * So a joiner announces itself, everyone already present answers, and the
 * answers come back as `peer-present` — a different type from `peer-joined`, so
 * that replying to a join cannot itself look like a join and start another
 * round.
 */
export interface HereOp {
  type: 'here'
}

/** Server-originated. A client that sends one has it dropped by the relay. */
export interface LockOp {
  type: 'lock'
  locked: boolean
}

export type Op = EntityOp | CursorOp | SelectionOp | ResyncOp | LockOp | HereOp

/** As received: the relay stamps the sender so a client cannot impersonate a peer. */
export type IncomingOp = Op & { peerId: string }

export interface Peer {
  id: string
  email: string
}

export type ServerMessage =
  | { type: 'welcome'; peerId: string; role: 'owner' | 'member'; locked: boolean; peers: Peer[] }
  | { type: 'peer-joined'; peerId: string; email: string }
  | { type: 'peer-present'; peerId: string; email: string }
  | { type: 'peer-left'; peerId: string }
  | IncomingOp

/**
 * Ops whose only effect is presence. They are safe to send while the board is
 * locked, cost nothing to drop, and must never reach the undo stack or trigger
 * a save.
 */
export const isEphemeral = (op: { type: string }): boolean =>
  op.type === 'cursor' || op.type === 'sel'

/**
 * Whether an op changes something worth writing to the server.
 *
 * Resync handshakes and presence do not, which is what keeps a room full of
 * idle cursors from generating a save per frame.
 */
export const isPersistent = (op: { type: string }): boolean =>
  !isEphemeral(op) && op.type !== 'need-state' && op.type !== 'replaced' && op.type !== 'lock'

/**
 * A rough size guard, applied before sending.
 *
 * The relay drops anything over its own cap, but it does so *after* delivering
 * to sockets on the same instance — so an oversized op would reach some peers
 * and not others, which is worse than not sending it at all. Catching it here
 * makes the failure uniform.
 */
export const MAX_OP_BYTES = 5000

export const withinSizeLimit = (op: Op): boolean =>
  JSON.stringify(op).length <= MAX_OP_BYTES
