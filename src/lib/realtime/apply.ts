import type { Team, Token, Drawing, Frame, ViewSettings, CustomFormation } from '../types'
import { shiftAttached } from '../drawings'
import type { EntityOp } from './protocol'

/**
 * Turning a peer's op into a state change.
 *
 * A pure function over the persisted slice of the board, deliberately separate
 * from the store: what an op *means* is the part worth testing exhaustively,
 * and it should be possible to do that without a React tree or a socket.
 *
 * The rule throughout is last-write-wins per entity. An op naming something
 * that is no longer here — a token a peer deleted while another was dragging it
 * — is dropped rather than resurrecting it. The delete was the later decision;
 * honouring the move instead would bring back something someone removed on
 * purpose, which is the worse of the two failures.
 */

export interface BoardSlice {
  teams: Team[]
  tokens: Token[]
  bench: Token[]
  drawings: Drawing[]
  frames: Frame[]
  view: ViewSettings
  customFormations: CustomFormation[]
}

/** Annotations pinned to a player travel with them, exactly as they do locally. */
function withAttachments(
  state: BoardSlice,
  moves: { id: string; x: number; y: number }[],
): Drawing[] {
  let drawings = state.drawings
  for (const move of moves) {
    const prev = state.tokens.find((t) => t.id === move.id)
    if (!prev) continue
    drawings = shiftAttached(drawings, new Set([move.id]), move.x - prev.x, move.y - prev.y)
  }
  return drawings
}

export function applyOp(state: BoardSlice, op: EntityOp): Partial<BoardSlice> {
  switch (op.type) {
    case 'patch': {
      if (op.entity === 'token') {
        const prev = state.tokens.find((t) => t.id === op.id)
        if (!prev) return {}
        const next = { ...prev, ...op.patch }
        return {
          tokens: state.tokens.map((t) => (t.id === op.id ? next : t)),
          drawings: withAttachments(state, [{ id: op.id, x: next.x, y: next.y }]),
        }
      }
      if (op.entity === 'drawing') {
        if (!state.drawings.some((d) => d.id === op.id)) return {}
        return {
          drawings: state.drawings.map((d) => (d.id === op.id ? { ...d, ...op.patch } : d)),
        }
      }
      return { frames: state.frames.map((f) => (f.id === op.id ? { ...f, ...op.patch } : f)) }
    }

    case 'add': {
      // Adds are idempotent by id. A reconnect can replay an op that already
      // landed, and duplicating a chip is both visible and annoying to undo.
      switch (op.entity) {
        case 'token':
          return state.tokens.some((t) => t.id === op.item.id)
            ? {}
            : { tokens: [...state.tokens, op.item] }
        case 'drawing':
          return state.drawings.some((d) => d.id === op.item.id)
            ? {}
            : { drawings: [...state.drawings, op.item] }
        case 'frame':
          return state.frames.some((f) => f.id === op.item.id)
            ? {}
            : { frames: [...state.frames, op.item] }
        case 'customFormation':
          return state.customFormations.some((c) => c.id === op.item.id)
            ? {}
            : { customFormations: [...state.customFormations, op.item] }
      }
      return {}
    }

    case 'remove': {
      const ids = new Set(op.ids)
      if (op.entity === 'frame') return { frames: state.frames.filter((f) => !ids.has(f.id)) }
      if (op.entity === 'drawing')
        return { drawings: state.drawings.filter((d) => !ids.has(d.id)) }
      // op.entity === 'selection'

      // A selection can mix chips and annotations, so both are removed — and an
      // annotation left pinned to a chip that no longer exists is detached
      // rather than left pointing at nothing.
      return {
        tokens: state.tokens.filter((t) => !ids.has(t.id)),
        bench: state.bench.filter((t) => !ids.has(t.id)),
        drawings: state.drawings
          .filter((d) => !ids.has(d.id))
          .map((d) =>
            d.attachedTokenId && ids.has(d.attachedTokenId)
              ? { ...d, attachedTokenId: undefined }
              : d,
          ),
      }
    }

    case 'bulk': {
      const byId = new Map(op.tokens.map((t) => [t.id, t]))
      const tokens = state.tokens.map((t) => {
        const next = byId.get(t.id)
        if (!next) return t
        return {
          ...t,
          x: next.x,
          y: next.y,
          ...(next.number !== undefined ? { number: next.number } : {}),
          ...(next.shape !== undefined ? { shape: next.shape } : {}),
        }
      })
      return { tokens, drawings: withAttachments(state, op.tokens) }
    }

    case 'bench': {
      const token = state.tokens.find((t) => t.id === op.id)
      if (!token) return {}
      return {
        tokens: state.tokens.filter((t) => t.id !== op.id),
        bench: [...state.bench, token],
      }
    }

    case 'unbench': {
      const sub = state.bench.find((t) => t.id === op.id)
      if (!sub) return {}
      return {
        bench: state.bench.filter((t) => t.id !== op.id),
        tokens: [...state.tokens, { ...sub, x: op.x, y: op.y }],
      }
    }

    case 'view':
      return { view: { ...state.view, ...op.patch } }
  }
}
