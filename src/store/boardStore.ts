import { create } from 'zustand'
import type {
  Team,
  Token,
  Drawing,
  Frame,
  ViewSettings,
  CustomFormation,
  Side,
} from '../lib/types'
import type { PersistedBoard } from '../lib/persistence'
import { SCHEMA_VERSION } from '../lib/persistence'
import type { Pos, Slot, BlockHeight } from '../lib/formations'
import { getFormation, applyBlock, mirror, formationCode, FORMATION_NAMES } from '../lib/formations'
import type { PitchKind } from '../lib/types'
import { clampNorm } from '../lib/geometry'
import type { DrawStyle } from '../lib/drawings'
import { shiftAttached } from '../lib/drawings'
import { captureFrame } from '../lib/frames'
import type { History } from '../lib/history'
import { createHistory, push, undo, redo } from '../lib/history'
import { id } from '../lib/id'
import { emit, emitFinal, emitReplaced, runAsRemote } from '../lib/realtime/bridge'
import { applyOp } from '../lib/realtime/apply'
import type { EntityOp } from '../lib/realtime/protocol'

export type ToolMode =
  | 'select'
  | 'pen'
  | 'arrow'
  | 'dashedArrow'
  | 'curveArrow'
  | 'curvePass'
  | 'line'
  | 'zoneRect'
  | 'zoneEllipse'
  | 'zonePoly'
  | 'text'

// Muted, colour-blind-safe team pair. Deliberately not neon.
export const HOME_COLOR = '#B4432E'
export const AWAY_COLOR = '#2C5B8A'

const defaultView: ViewSettings = {
  view: 'fullH',
  kind: '11',
  grass: true,
  lineColor: '#F2F6F1',
  overlayGrid: false,
  pitchTheme: 'dark',
  snap: false,
}

interface BoardData {
  teams: Team[]
  tokens: Token[]
  bench: Token[]
  drawings: Drawing[]
  frames: Frame[]
  view: ViewSettings
  customFormations: CustomFormation[]
}

export interface InspectorTarget {
  tokenId: string
  x: number
  y: number
}

export interface Playback {
  /** Fractional playhead in [0, frames.length-1]; -1 means "off, show live". */
  position: number
  playing: boolean
  speed: number
  loop: boolean
  eased: boolean
}

interface BoardState extends BoardData {
  selection: string[]
  tool: ToolMode
  history: History<PersistedBoard>
  _pending: PersistedBoard | null
  /** Ephemeral: which token the inspector is editing, and where to anchor it. */
  inspector: InspectorTarget | null
  /** Bumped whenever chips are repositioned as a set, so the renderer can
   *  animate them into place. Dragging deliberately does not bump it. */
  formationEpoch: number
  /** Ephemeral viewport/readout state for the HUD. */
  zoom: number
  setZoom: (zoom: number) => void
  lastFormation: string | null
  /** The team new formations, saved shapes, and assistant commands act on. */
  activeTeam: Side
  setActiveTeam: (side: Side) => void
  openInspector: (tokenId: string, x: number, y: number) => void
  closeInspector: () => void

  // lifecycle
  initDefaultBoard: () => void
  resetBoardAction: () => void
  loadPersisted: (data: PersistedBoard) => void
  getPersistable: () => PersistedBoard

  // history
  commit: () => void
  undoAction: () => void
  redoAction: () => void

  // tokens
  moveToken: (tokenId: string, x: number, y: number) => void
  moveTokens: (ids: string[], dx: number, dy: number) => void
  updateToken: (tokenId: string, patch: Partial<Token>) => void
  addToken: (token: Omit<Token, 'id'>) => string
  duplicateSelection: () => void
  deleteSelection: () => void
  // frames & playback
  playback: Playback
  addFrame: () => void
  deleteFrame: (frameId: string) => void
  recaptureFrame: (frameId: string) => void
  renameFrame: (frameId: string, label: string) => void
  setPlayback: (patch: Partial<Playback>) => void

  // drawings
  drawStyle: DrawStyle
  setDrawStyle: (patch: Partial<DrawStyle>) => void
  addDrawing: (drawing: Omit<Drawing, 'id'>) => string
  updateDrawing: (drawingId: string, patch: Partial<Drawing>) => void
  deleteDrawings: (ids: string[]) => void

  /** Flip a player to the other team: recolours and renumbers to fit. */
  switchPlayerTeam: (tokenId: string) => void
  /** Move an on-pitch player to the bench. */
  benchToken: (tokenId: string) => void
  /** Bring a substitute onto the pitch at a normalized position. */
  unbenchToken: (tokenId: string, x: number, y: number) => void

  // selection
  setSelection: (ids: string[]) => void
  toggleSelection: (tokenId: string) => void
  clearSelection: () => void
  setTool: (tool: ToolMode) => void

  // view
  setView: (patch: Partial<ViewSettings>) => void
  /** Switch format and resize both squads to match (11-a-side, 7-a-side, futsal). */
  setPitchKind: (kind: PitchKind) => void

  // formations
  applyFormation: (side: Side, name: string, block: BlockHeight) => Pos[]
  saveCustomFormation: (name: string) => void
  applyCustomFormation: (formationId: string, side: Side) => Pos[]

  // realtime
  /**
   * Apply a peer's op.
   *
   * Deliberately not routed through the ordinary actions: a remote change must
   * not enter this client's undo history. Undo means "take back what I did",
   * and a stack containing someone else's edits makes it mean something no one
   * wants.
   */
  applyRemote: (op: EntityOp) => void
  /**
   * Take on a whole board a peer replaced (undo, redo, reset, format change).
   *
   * Unlike `loadPersisted` this leaves the tool, zoom and playhead alone — a
   * peer pressing undo should not put your pen down or move your camera.
   *
   * It does clear the undo history, which is the honest thing to do: those
   * snapshots describe a lineage the board is no longer on, and offering to
   * "undo" back into it would restore state that has since been overwritten.
   */
  adoptRemote: (data: PersistedBoard) => void
  /**
   * Tokens moved since the gesture began.
   *
   * Movement is broadcast throttled, so the last position a peer sees is
   * whatever happened to fall on a throttle boundary — a few pixels off where
   * the chip was actually let go, and nothing ever corrects it. `commit` uses
   * this to send the exact resting positions once the gesture ends.
   */
  _touched: Set<string>

  // internal helpers
  _snapshot: () => PersistedBoard
  _pushPast: (snap: PersistedBoard) => void
  _applySnapshot: (snap: PersistedBoard) => void
}

const makeTeams = (): Team[] => [
  { id: 'home', side: 'home', name: 'Home', color: HOME_COLOR },
  { id: 'away', side: 'away', name: 'Away', color: AWAY_COLOR },
]

function buildTeamTokens(side: Side, color: string, positions: Slot[]): Token[] {
  return positions.map((p) => ({
    id: id(),
    type: 'player',
    teamId: side,
    number: p.n,
    color,
    shape: p.n === 1 ? 'keeper' : 'outfield',
    x: p.x,
    y: p.y,
    rotation: 0,
  }))
}

function buildSubs(side: Side, color: string, count: number): Token[] {
  return Array.from({ length: count }, (_, i) => ({
    id: id(),
    type: 'player' as const,
    teamId: side,
    number: 12 + i,
    color,
    shape: 'outfield' as const,
    x: 50,
    y: 50,
    rotation: 0,
  }))
}

function buildDefaultData(): BoardData {
  const home = buildTeamTokens('home', HOME_COLOR, getFormation('4-3-3', '11'))
  const away = buildTeamTokens('away', AWAY_COLOR, mirror(getFormation('4-3-3', '11')))
  const ball: Token = { id: id(), type: 'ball', color: '#ffffff', x: 50, y: 50, rotation: 0 }
  return {
    teams: makeTeams(),
    tokens: [...home, ...away, ball],
    bench: [...buildSubs('home', HOME_COLOR, 5), ...buildSubs('away', AWAY_COLOR, 5)],
    drawings: [],
    frames: [],
    view: { ...defaultView },
    customFormations: [],
  }
}

// Assign an ordered list of positions to a team's player tokens in order. When
// the slots carry shirt numbers (a preset formation), the number and keeper
// shape travel with the slot, so applying a shape also numbers the roles
// correctly and puts exactly one keeper in goal. Custom shapes have no numbers,
// so those keep each player's existing identity.
function assignPositions(tokens: Token[], side: Side, positions: (Pos & { n?: number })[]): Token[] {
  let i = 0
  return tokens.map((t) => {
    if (t.type === 'player' && t.teamId === side && i < positions.length) {
      const p = positions[i++]
      if (p.n === undefined) return { ...t, x: p.x, y: p.y }
      return { ...t, x: p.x, y: p.y, number: p.n, shape: p.n === 1 ? 'keeper' : 'outfield' }
    }
    return t
  })
}

/**
 * Keep the playhead inside the sequence. Anything that removes frames — a
 * delete, an undo, a reset, loading another board — can otherwise leave it
 * pointing past the end, which reads as a frame that no longer exists.
 */
function clampPlayhead(playback: Playback, frameCount: number): Playback {
  if (playback.position < 0) return playback
  if (frameCount === 0) return { ...playback, position: -1, playing: false }
  const max = frameCount - 1
  if (playback.position > max) return { ...playback, position: max, playing: false }
  return playback
}

export const useBoardStore = create<BoardState>((set, get) => ({
  ...buildDefaultData(),
  selection: [],
  tool: 'select',
  history: createHistory<PersistedBoard>(),
  _pending: null,
  _touched: new Set<string>(),
  inspector: null,
  formationEpoch: 0,
  zoom: 1,
  lastFormation: null,
  activeTeam: 'home',
  drawStyle: { color: '#2ae07a', thickness: 2.4, fillOpacity: 0.18, curve: 'right' },
  playback: { position: -1, playing: false, speed: 1, loop: true, eased: true },

  addFrame: () => {
    const before = get()._snapshot()
    const frame: Frame = {
      id: id(),
      label: `${get().frames.length + 1}`,
      tokens: captureFrame(get().tokens),
    }
    set((s) => ({ frames: [...s.frames, frame] }))
    get()._pushPast(before)
    emit({ type: 'add', entity: 'frame', item: frame })
  },

  deleteFrame: (frameId) => {
    const before = get()._snapshot()
    set((s) => {
      const frames = s.frames.filter((f) => f.id !== frameId)
      return { frames, playback: clampPlayhead(s.playback, frames.length) }
    })
    get()._pushPast(before)
    emit({ type: 'remove', entity: 'frame', ids: [frameId] })
  },

  recaptureFrame: (frameId) => {
    const before = get()._snapshot()
    const snap = captureFrame(get().tokens)
    set((s) => ({
      frames: s.frames.map((f) => (f.id === frameId ? { ...f, tokens: snap } : f)),
    }))
    get()._pushPast(before)
    emit({ type: 'patch', entity: 'frame', id: frameId, patch: { tokens: snap } })
  },

  renameFrame: (frameId, label) => {
    set((s) => ({ frames: s.frames.map((f) => (f.id === frameId ? { ...f, label } : f)) }))
    emit({ type: 'patch', entity: 'frame', id: frameId, patch: { label } })
  },

  setPlayback: (patch) => set((s) => ({ playback: { ...s.playback, ...patch } })),

  setZoom: (zoom) => set({ zoom }),
  setActiveTeam: (side) => set({ activeTeam: side }),
  setDrawStyle: (patch) => set((s) => ({ drawStyle: { ...s.drawStyle, ...patch } })),

  addDrawing: (drawing) => {
    const before = get()._snapshot()
    const newId = id()
    const item = { ...drawing, id: newId }
    set((s) => ({ drawings: [...s.drawings, item] }))
    get()._pushPast(before)
    emit({ type: 'add', entity: 'drawing', item })
    return newId
  },

  updateDrawing: (drawingId, patch) => {
    const before = get()._snapshot()
    set((s) => ({
      drawings: s.drawings.map((d) => (d.id === drawingId ? { ...d, ...patch } : d)),
    }))
    get()._pushPast(before)
    emit({ type: 'patch', entity: 'drawing', id: drawingId, patch })
  },

  deleteDrawings: (ids) => {
    if (ids.length === 0) return
    const before = get()._snapshot()
    const idset = new Set(ids)
    set((s) => ({
      drawings: s.drawings.filter((d) => !idset.has(d.id)),
      selection: s.selection.filter((i) => !idset.has(i)),
    }))
    get()._pushPast(before)
    emit({ type: 'remove', entity: 'drawing', ids })
  },

  openInspector: (tokenId, x, y) => set({ inspector: { tokenId, x, y } }),
  closeInspector: () => set({ inspector: null }),

  initDefaultBoard: () =>
    set((s) => ({
      ...buildDefaultData(),
      selection: [],
      tool: 'select',
      history: createHistory<PersistedBoard>(),
      _pending: null,
      inspector: null,
      playback: clampPlayhead(s.playback, 0),
    })),

  // Like initDefaultBoard, but preserves the undo history so it can be reverted.
  resetBoardAction: () => {
    const before = get()._snapshot()
    set((s) => ({
      ...buildDefaultData(),
      selection: [],
      inspector: null,
      formationEpoch: s.formationEpoch + 1,
      playback: clampPlayhead(s.playback, 0),
    }))
    get()._pushPast(before)
    emitReplaced()
  },

  loadPersisted: (data) =>
    set((s) => {
      const frames = structuredClone(data.frames)
      return {
        teams: structuredClone(data.teams),
        tokens: structuredClone(data.tokens),
        bench: structuredClone(data.bench ?? []),
        drawings: structuredClone(data.drawings),
        frames,
        view: structuredClone(data.view),
        customFormations: structuredClone(data.customFormations),
        selection: [],
        tool: 'select',
        history: createHistory<PersistedBoard>(),
        _pending: null,
        inspector: null,
        playback: clampPlayhead(s.playback, frames.length),
      }
    }),

  getPersistable: () => get()._snapshot(),

  _snapshot: () => {
    const s = get()
    return structuredClone({
      version: SCHEMA_VERSION,
      teams: s.teams,
      tokens: s.tokens,
      bench: s.bench,
      drawings: s.drawings,
      frames: s.frames,
      view: s.view,
      customFormations: s.customFormations,
    })
  },

  _pushPast: (snap) =>
    set((s) => {
      s._touched.clear()
      return { history: push(s.history, snap), _pending: null }
    }),

  _applySnapshot: (snap) =>
    set((s) => {
      const frames = structuredClone(snap.frames)
      return {
        teams: structuredClone(snap.teams),
        tokens: structuredClone(snap.tokens),
        bench: structuredClone(snap.bench ?? []),
        drawings: structuredClone(snap.drawings),
        frames,
        view: structuredClone(snap.view),
        customFormations: structuredClone(snap.customFormations),
        playback: clampPlayhead(s.playback, frames.length),
      }
    }),

  commit: () => {
    const p = get()._pending
    if (!p) return
    // The gesture is over, so send exactly where things came to rest. Without
    // this, peers keep whichever throttled position happened to be last, which
    // is close but never quite right and never corrects itself.
    const touched = get()._touched
    if (touched.size > 0) {
      emitFinal({ type: 'bulk', tokens: bulkFor(get().tokens, touched) }, 'group')
    }
    get()._pushPast(p)
  },

  undoAction: () => {
    const res = undo(get().history, get()._snapshot())
    if (!res) return
    get()._applySnapshot(res.present)
    set((s) => ({
      history: res.history,
      _pending: null,
      selection: [],
      formationEpoch: s.formationEpoch + 1,
    }))
    // Undo restores a whole snapshot, which is far too large to send as an op.
    // Peers re-read instead — see emitReplaced.
    emitReplaced()
  },

  redoAction: () => {
    const res = redo(get().history, get()._snapshot())
    if (!res) return
    get()._applySnapshot(res.present)
    set((s) => ({
      history: res.history,
      _pending: null,
      selection: [],
      formationEpoch: s.formationEpoch + 1,
    }))
    emitReplaced()
  },

  moveToken: (tokenId, x, y) => {
    if (!get()._pending) set({ _pending: get()._snapshot() })
    const c = clampNorm(x, y)
    set((s) => {
      const prev = s.tokens.find((t) => t.id === tokenId)
      const dx = prev ? c.x - prev.x : 0
      const dy = prev ? c.y - prev.y : 0
      return {
        tokens: s.tokens.map((t) => (t.id === tokenId ? { ...t, x: c.x, y: c.y } : t)),
        // Anything pinned to this player travels with them.
        drawings: shiftAttached(s.drawings, new Set([tokenId]), dx, dy),
      }
    })
    get()._touched.add(tokenId)
    // Keyed on the token, so a drag coalesces into one op per interval per chip
    // rather than one per pointer move — and dragging two chips at once still
    // sends both.
    emit({ type: 'patch', entity: 'token', id: tokenId, patch: { x: c.x, y: c.y } }, `token:${tokenId}`)
  },

  moveTokens: (ids, dx, dy) => {
    if (!get()._pending) set({ _pending: get()._snapshot() })
    const idset = new Set(ids)
    set((s) => ({
      tokens: s.tokens.map((t) => {
        if (!idset.has(t.id)) return t
        const c = clampNorm(t.x + dx, t.y + dy)
        return { ...t, x: c.x, y: c.y }
      }),
      drawings: shiftAttached(s.drawings, idset, dx, dy),
    }))
    for (const i of ids) get()._touched.add(i)
    emit({ type: 'bulk', tokens: bulkFor(get().tokens, idset) }, 'group')
  },

  updateToken: (tokenId, patch) => {
    const before = get()._snapshot()
    set((s) => ({
      tokens: s.tokens.map((t) => (t.id === tokenId ? { ...t, ...patch } : t)),
    }))
    get()._pushPast(before)
    emit({ type: 'patch', entity: 'token', id: tokenId, patch })
  },

  addToken: (token) => {
    const before = get()._snapshot()
    const newId = id()
    const item = { ...token, id: newId }
    set((s) => ({ tokens: [...s.tokens, item] }))
    get()._pushPast(before)
    emit({ type: 'add', entity: 'token', item })
    return newId
  },

  duplicateSelection: () => {
    const { selection, tokens } = get()
    if (selection.length === 0) return
    const before = get()._snapshot()
    const idset = new Set(selection)
    const copies: Token[] = tokens
      .filter((t) => idset.has(t.id))
      .map((t) => {
        const c = clampNorm(t.x + 3, t.y + 3)
        return { ...t, id: id(), x: c.x, y: c.y }
      })
    set((s) => ({ tokens: [...s.tokens, ...copies], selection: copies.map((c) => c.id) }))
    get()._pushPast(before)
    // One op per copy rather than a batch: a duplicated selection is a handful
    // of chips, and reusing `add` means there is one path for a token arriving.
    for (const item of copies) emit({ type: 'add', entity: 'token', item })
  },

  deleteSelection: () => {
    const { selection } = get()
    if (selection.length === 0) return
    const before = get()._snapshot()
    const idset = new Set(selection)
    set((s) => ({
      tokens: s.tokens.filter((t) => !idset.has(t.id)),
      // A selection can mix chips and annotations; remove both, and drop any
      // annotation left pinned to a chip that no longer exists.
      drawings: s.drawings
        .filter((d) => !idset.has(d.id))
        .map((d) => (d.attachedTokenId && idset.has(d.attachedTokenId) ? { ...d, attachedTokenId: undefined } : d)),
      selection: [],
      inspector: null,
    }))
    get()._pushPast(before)
    emit({ type: 'remove', entity: 'selection', ids: selection })
  },

  switchPlayerTeam: (tokenId) => {
    const token = get().tokens.find((t) => t.id === tokenId)
    if (!token || token.type !== 'player') return
    const to: Side = token.teamId === 'home' ? 'away' : 'home'
    const color = to === 'home' ? HOME_COLOR : AWAY_COLOR
    // Keep the shirt number if it is free on the new team, otherwise take the
    // lowest number that isn't taken, so two players never share one.
    const taken = new Set(
      get()
        .tokens.filter((t) => t.type === 'player' && t.teamId === to && t.id !== tokenId)
        .map((t) => t.number),
    )
    let number = token.number
    if (number === undefined || taken.has(number)) {
      number = 1
      while (taken.has(number)) number++
    }
    const before = get()._snapshot()
    set((s) => ({
      tokens: s.tokens.map((t) => (t.id === tokenId ? { ...t, teamId: to, color, number } : t)),
    }))
    get()._pushPast(before)
    // The resolved values, not "switch this player" — the receiving peer must
    // not re-run the renumbering and reach a different free number.
    emit({ type: 'patch', entity: 'token', id: tokenId, patch: { teamId: to, color, number } })
  },

  benchToken: (tokenId) => {
    const token = get().tokens.find((t) => t.id === tokenId)
    if (!token || token.type !== 'player') return
    const before = get()._snapshot()
    set((s) => ({
      tokens: s.tokens.filter((t) => t.id !== tokenId),
      bench: [...s.bench, { ...token }],
      selection: s.selection.filter((i) => i !== tokenId),
      inspector: null,
    }))
    get()._pushPast(before)
    emit({ type: 'bench', id: tokenId })
  },

  unbenchToken: (tokenId, x, y) => {
    const sub = get().bench.find((t) => t.id === tokenId)
    if (!sub) return
    const before = get()._snapshot()
    const c = clampNorm(x, y)
    set((s) => ({
      bench: s.bench.filter((t) => t.id !== tokenId),
      tokens: [...s.tokens, { ...sub, x: c.x, y: c.y }],
      selection: [tokenId],
    }))
    get()._pushPast(before)
    emit({ type: 'unbench', id: tokenId, x: c.x, y: c.y })
  },

  // Selection is one person's pointer state, not part of the board. It is
  // broadcast so peers can see what someone is working on, and it is never
  // saved and never undoable.
  setSelection: (ids) => {
    set({ selection: ids })
    emit({ type: 'sel', ids }, 'sel')
  },
  toggleSelection: (tokenId) => {
    set((s) => ({
      selection: s.selection.includes(tokenId)
        ? s.selection.filter((i) => i !== tokenId)
        : [...s.selection, tokenId],
    }))
    emit({ type: 'sel', ids: get().selection }, 'sel')
  },
  clearSelection: () => {
    set({ selection: [] })
    emit({ type: 'sel', ids: [] }, 'sel')
  },
  setTool: (tool) => set({ tool }),

  setView: (patch) => {
    set((s) => ({ view: { ...s.view, ...patch } }))
    emit({ type: 'view', patch })
  },

  setPitchKind: (kind) => {
    if (get().view.kind === kind) return
    const before = get()._snapshot()
    const slots = getFormation(FORMATION_NAMES[kind][0], kind)
    const size = slots.length

    set((s) => {
      let tokens = [...s.tokens]
      let bench = [...s.bench]

      for (const side of ['home', 'away'] as Side[]) {
        const color = side === 'home' ? HOME_COLOR : AWAY_COLOR
        // Keepers first, so a shrinking squad keeps its goalkeeper on the pitch.
        let squad = tokens
          .filter((t) => t.type === 'player' && t.teamId === side)
          .sort((a, b) => Number(b.shape === 'keeper') - Number(a.shape === 'keeper'))

        if (squad.length > size) {
          const dropped = squad.slice(size)
          const droppedIds = new Set(dropped.map((t) => t.id))
          tokens = tokens.filter((t) => !droppedIds.has(t.id))
          bench = [...bench, ...dropped]
          squad = squad.slice(0, size)
        }

        // Short of a full team: bring substitutes on, then add players if the
        // bench runs dry, so every format always fields a complete side.
        while (squad.length < size) {
          const i = bench.findIndex((t) => t.teamId === side)
          const player: Token =
            i >= 0
              ? bench.splice(i, 1)[0]
              : {
                  id: id(),
                  type: 'player',
                  teamId: side,
                  number: squad.length + 1,
                  color,
                  shape: 'outfield',
                  x: 50,
                  y: 50,
                  rotation: 0,
                }
          tokens = [...tokens, player]
          squad = [...squad, player]
        }

        // Pair each player with a slot directly, rather than relying on where
        // they happen to sit in the tokens array.
        const positions = side === 'away' ? mirror(slots) : slots
        const bySlot = new Map<string, Slot>()
        squad.forEach((t, i) => {
          if (positions[i]) bySlot.set(t.id, positions[i])
        })
        tokens = tokens.map((t) => {
          const p = bySlot.get(t.id)
          if (!p) return t
          return { ...t, x: p.x, y: p.y, number: p.n, shape: p.n === 1 ? 'keeper' : 'outfield' }
        })
      }

      return {
        tokens,
        bench,
        view: { ...s.view, kind },
        selection: [],
        inspector: null,
        formationEpoch: s.formationEpoch + 1,
        lastFormation: formationCode(FORMATION_NAMES[kind][0]),
      }
    })
    get()._pushPast(before)
    // Changing format resizes both squads: chips move to the bench, others come
    // on, everyone is renumbered. Too much of the board changes at once to
    // describe as ops, so peers re-read.
    emitReplaced()
  },

  applyFormation: (side, name, block) => {
    const { view } = get()
    let positions = applyBlock(getFormation(name, view.kind), block)
    if (side === 'away') positions = mirror(positions)
    const before = get()._snapshot()
    set((s) => ({
      tokens: assignPositions(s.tokens, side, positions),
      formationEpoch: s.formationEpoch + 1,
      lastFormation: formationCode(name),
    }))
    get()._pushPast(before)
    emit({ type: 'bulk', tokens: bulkFor(get().tokens, sideIds(get().tokens, side)) })
    return positions
  },

  saveCustomFormation: (name) => {
    const { tokens, view, activeTeam } = get()
    let positions = tokens
      .filter((t) => t.type === 'player' && t.teamId === activeTeam)
      .map((t) => ({ x: t.x, y: t.y }))
    // Store every shape in home orientation so it can be applied to either team.
    if (activeTeam === 'away') positions = mirror(positions)
    const before = get()._snapshot()
    const cf: CustomFormation = { id: id(), name, positions, kind: view.kind }
    set((s) => ({ customFormations: [...s.customFormations, cf] }))
    get()._pushPast(before)
    emit({ type: 'add', entity: 'customFormation', item: cf })
  },

  applyCustomFormation: (formationId, side) => {
    const cf = get().customFormations.find((c) => c.id === formationId)
    if (!cf) return []
    let positions: Pos[] = cf.positions.map((p) => ({ ...p }))
    if (side === 'away') positions = mirror(positions)
    const before = get()._snapshot()
    set((s) => ({
      tokens: assignPositions(s.tokens, side, positions),
      formationEpoch: s.formationEpoch + 1,
    }))
    get()._pushPast(before)
    emit({ type: 'bulk', tokens: bulkFor(get().tokens, sideIds(get().tokens, side)) })
    return positions
  },

  applyRemote: (op) =>
    runAsRemote(() =>
      set((s) => {
        const patch = applyOp(s, op)
        // A remote op can remove the frame the playhead is sitting on, so the
        // same guard the local actions use has to run here too.
        if (patch.frames) {
          return { ...patch, playback: clampPlayhead(s.playback, patch.frames.length) }
        }
        return patch
      }),
    ),

  adoptRemote: (data) =>
    runAsRemote(() =>
      set((s) => {
        const frames = structuredClone(data.frames)
        const tokens = structuredClone(data.tokens)
        const alive = new Set([...tokens.map((t) => t.id), ...data.drawings.map((d) => d.id)])
        return {
          teams: structuredClone(data.teams),
          tokens,
          bench: structuredClone(data.bench ?? []),
          drawings: structuredClone(data.drawings),
          frames,
          view: structuredClone(data.view),
          customFormations: structuredClone(data.customFormations),
          // Keep whatever of your selection survived, rather than dropping it
          // and interrupting someone mid-edit.
          selection: s.selection.filter((i) => alive.has(i)),
          inspector: s.inspector && alive.has(s.inspector.tokenId) ? s.inspector : null,
          history: createHistory<PersistedBoard>(),
          _pending: null,
          formationEpoch: s.formationEpoch + 1,
          playback: clampPlayhead(s.playback, frames.length),
        }
      }),
    ),
}))

/** The fields a `bulk` op carries, for whichever tokens are named. */
function bulkFor(tokens: Token[], ids: Set<string>) {
  return tokens
    .filter((t) => ids.has(t.id))
    .map((t) => ({ id: t.id, x: t.x, y: t.y, number: t.number, shape: t.shape }))
}

const sideIds = (tokens: Token[], side: Side): Set<string> =>
  new Set(tokens.filter((t) => t.type === 'player' && t.teamId === side).map((t) => t.id))

// Dev-only: expose the store for debugging in the browser console. Stripped
// from production builds.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __boardStore?: unknown }).__boardStore = useBoardStore
}
