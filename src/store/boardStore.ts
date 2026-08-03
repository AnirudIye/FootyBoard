import { create } from 'zustand'
import type {
  Team,
  Token,
  Drawing,
  DrawingType,
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
import { clamp } from '../lib/math'
import type { DrawStyle } from '../lib/drawings'
import { shiftAttached } from '../lib/drawings'
import { captureFrame, MAX_FRAMES } from '../lib/frames'
import type { History } from '../lib/history'
import { createHistory, push, undo, redo } from '../lib/history'
import { id } from '../lib/id'
import { HOME_COLOR, AWAY_COLOR } from '../theme/teamColors'
import { emit, emitFinal, emitReplaced, runAsRemote } from '../lib/realtime/bridge'
import { applyOp } from '../lib/realtime/apply'
import type { EntityOp } from '../lib/realtime/protocol'

/**
 * What the pointer is armed to do: draw one kind of thing, or select.
 *
 * Derived from `DrawingType` rather than restating it, which it did until a
 * triangle needed adding to both. The two lists had been identical since the
 * board was written, and being identical was doing real work: `DrawingToolbar`
 * hands a narrowed `ToolMode` to `isZone`, and `useDrawGesture` puts one
 * straight into a draft's `type`, so both call sites only compile while every
 * tool that is not `select` is a drawing kind. A copy that the compiler holds
 * flush against its original is still a copy — it drifts the moment somebody
 * adds to one and the type error lands in a file they were not editing, which
 * reads as an unrelated breakage rather than as the omission it is.
 *
 * A tool that genuinely is not a drawing kind belongs in this union beside
 * `'select'`. That is the extension point, and it is why this is a union rather
 * than the bare alias.
 *
 * `'eraser'` is the first tool to use it, and using it cost exactly what the
 * paragraph above promised it would: the two call sites that hand a narrowed
 * `ToolMode` to `isZone` and `isCurve` stopped compiling, in the file that owns
 * them, on the commit that added it. Both now ask `armedDrawing` for the tool as
 * a drawing kind and get null for the two tools that are not one. Anything added
 * here in future should expect the same three-file conversation and should not
 * try to avoid it — the compiler pointing at every place that assumed "not
 * select means a shape" is the whole value of the union.
 */
export type ToolMode = DrawingType | 'select' | 'eraser'

/**
 * The armed tool as a kind of drawing, or null when it is not one of those.
 *
 * `select` and `eraser` both act on marks that already exist rather than making
 * one, so neither has a `DrawingType` to offer. Callers that used to write
 * `tool !== 'select' && isZone(tool)` cannot simply add a second inequality —
 * that is the copy this union exists to prevent, and it would need finding again
 * in every file the next time a tool joins them.
 */
export const armedDrawing = (tool: ToolMode): DrawingType | null =>
  tool === 'select' || tool === 'eraser' ? null : tool

/**
 * The muted, colour-blind-safe team pair. Defined in `src/theme/teamColors.ts`
 * and re-exported here so the store's callers did not have to move, the way
 * `persistence.ts` re-exports the shared board schema.
 *
 * The same two values reach CSS as `--home` and `--away`. They are not written
 * in this file, and must not be: the module is the only place either colour is
 * spelled, and a test fails on a second copy anywhere under `src/`.
 */
export { HOME_COLOR, AWAY_COLOR }

const defaultView: ViewSettings = {
  view: 'fullH',
  kind: '11',
  grass: true,
  lineColor: '#F2F6F1',
  overlayGrid: false,
  pitchTheme: 'dark',
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
  /**
   * Which saved board the contents in this store belong to, or null when they
   * belong to no board at all: a guest's board, the blank one that stands in
   * when a saved board cannot be read, and the moment before a newly created
   * board has an id.
   *
   * The save path asserts against this, so a write can never be attributed to
   * a board the store is no longer showing. That was not a hypothetical: a
   * debounced save is scheduled against whatever board was open when the edit
   * happened, and anything that swaps the contents underneath it without
   * changing that id turns the next write into a `PUT` of the wrong board's
   * data over the right board's row. There is no version history behind that
   * row, so it is not recoverable.
   */
  boardId: string | null
  /**
   * Which state of that board these contents were derived from.
   *
   * Sent as the base of every write, and refused by the server when the board
   * has been replaced since. It moves only when the board's *lineage* does —
   * undo, redo, reset, a format change — rather than on every save, so it says
   * "these contents come from that board's current lineage" rather than "these
   * contents are byte-for-byte that row".
   *
   * Null means the same as a null `boardId` does: not known, so refuse to write.
   * The two are one fact and are always set together, because a generation that
   * outlived the board it describes would be a base attached to the wrong row,
   * which is the exact failure `boardId` exists to prevent.
   */
  boardGeneration: number | null
  /** Records which saved board these contents came from, and which state of it. */
  setBoardId: (boardId: string | null, generation?: number | null) => void
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
  /**
   * The last preset shape applied to each side, kept per side rather than once
   * for the board.
   *
   * It reads like a HUD readout, and it was one until the assistant's "drop them
   * deeper" started re-applying it: a single string means the last shape applied
   * to *anybody*, so asking for the away team to sit deeper handed them whichever
   * formation home was last put in. A depth change has to keep the team in the
   * shape it is already playing, and the only way to do that from a preset is to
   * know which preset that side is on.
   *
   * Not part of `PersistedBoard`, so this shape is free to change: nothing is
   * stored, and there is no schema version to carry.
   */
  lastFormation: Record<Side, string | null>
  /** The team new formations, saved shapes, and assistant commands act on. */
  activeTeam: Side
  setActiveTeam: (side: Side) => void
  openInspector: (tokenId: string, x: number, y: number) => void
  closeInspector: () => void

  // lifecycle
  /**
   * Throw the open board away and start from the default setup.
   *
   * The id defaults to null rather than being left as it was, because the
   * contents really do stop being that board's the moment this runs, and the
   * safe direction for the save guard is "belongs to nothing". Pass an id only
   * when these contents have genuinely just been written to that board.
   */
  initDefaultBoard: (boardId?: string | null) => void
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
  /**
   * Patch one token.
   *
   * `defer` holds the undo step open in `_pending` instead of pushing one, for
   * edits that arrive a character at a time. The caller ends the run with
   * `commit()`, exactly as a drag does. It changes nothing about what is
   * broadcast or saved.
   */
  updateToken: (tokenId: string, patch: Partial<Token>, defer?: boolean) => void
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
  /** `defer` holds the undo step open the way `updateToken`'s does; see there. */
  updateDrawing: (drawingId: string, patch: Partial<Drawing>, defer?: boolean) => void
  /** `defer` holds the undo step open the way `updateDrawing`'s does; see there. */
  deleteDrawings: (ids: string[], defer?: boolean) => void

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

/**
 * A fresh board's contents, built without touching the open one.
 *
 * Creating a board needs a snapshot to send, and the obvious way to get one was
 * to reset the store and read it back. That is a mutation of the board the user
 * is still looking at, made before the new board exists, and if the create then
 * failed the open board had already been replaced by a blank one that autosave
 * duly wrote over the real thing. Build the payload here instead and leave the
 * store alone until there is somewhere for it to go.
 */
export function defaultPersistedBoard(): PersistedBoard {
  return { version: SCHEMA_VERSION, ...buildDefaultData() }
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
 * Settle a team's substitutes onto numbers nobody on the pitch is wearing.
 *
 * The pitch is the fixed half of this. Shirt numbers are positional and travel
 * with the slot, so a squad that has just been fitted to a formation is already
 * wearing that formation's numbers and cannot be asked to wear anything else.
 * The bench is therefore what gives way, and it gives way as little as it can:
 * a substitute keeps their own number unless the pitch has claimed it, and only
 * then takes the lowest number nobody on that team holds.
 *
 * Without this, resizing a squad collided the two sets. Going from 11-a-side to
 * 7-a-side puts the 7-a-side numbers (1, 2, 3, 7, 8, 9, 11) on the seven who
 * stay while the four sent off carry 7, 9, 10 and 11 to the bench, so three
 * numbers existed twice and 4, 5 and 6 existed nowhere. The count still came to
 * sixteen, which is why nothing counting players noticed, and "bring on number
 * 9" then put two number 9s on the pitch.
 */
function renumberBench(tokens: Token[], bench: Token[], side: Side): Token[] {
  const taken = new Set<number>()
  for (const t of tokens) {
    if (t.type === 'player' && t.teamId === side && t.number !== undefined) taken.add(t.number)
  }
  return bench.map((t) => {
    if (t.teamId !== side) return t
    if (t.number !== undefined && !taken.has(t.number)) {
      taken.add(t.number)
      return t
    }
    let n = 1
    while (taken.has(n)) n++
    taken.add(n)
    return { ...t, number: n }
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
  boardId: null,
  boardGeneration: null,
  setBoardId: (boardId, generation = null) => set({ boardId, boardGeneration: generation }),
  selection: [],
  tool: 'select',
  history: createHistory<PersistedBoard>(),
  _pending: null,
  _touched: new Set<string>(),
  inspector: null,
  formationEpoch: 0,
  zoom: 1,
  lastFormation: { home: null, away: null },
  activeTeam: 'home',
  drawStyle: { color: '#2ae07a', thickness: 2.4, fillOpacity: 0.18, curve: 'right' },
  playback: { position: -1, playing: false, speed: 1, loop: true, eased: true },

  addFrame: () => {
    // Refused rather than trimmed at the ceiling: dropping the oldest pose to
    // make room would silently rewrite a sequence somebody built deliberately,
    // and the caller has no way to know it happened. `FrameStrip` disables the
    // control at the same count and says why, so this is the floor under that
    // rather than the thing anybody meets. See `MAX_FRAMES`.
    if (get().frames.length >= MAX_FRAMES) return
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

  updateDrawing: (drawingId, patch, defer = false) => {
    const before = defer ? null : get()._snapshot()
    // `defer` is `updateToken`'s, for the same reason and with the same rule:
    // a drag is one gesture and should be one undo step, so the snapshot is
    // parked in `_pending` at the first move and `commit()` at the end turns
    // the whole run into a single step. Without it, dragging a label spends one
    // of the fifty history slots and one `structuredClone` of the entire board
    // per pointer move, and undo walks the label back a few pixels at a time.
    //
    // **Only the history push is deferred.** The `set` and the `emit` run on
    // every call either way, which is what keeps this invisible to everything
    // else: peers see the label move continuously, and autosave still fires for
    // the originator because it watches the drawings array's identity rather
    // than the history. Anything else that starts deferring has to leave those
    // two where they are.
    //
    // The emit is deliberately not throttled, so the last op of a drag *is* the
    // resting position and there is nothing left to correct afterwards. That is
    // why this needs no `emitFinal` counterpart the way the token drag does,
    // and it is the same choice the curve control point already makes.
    if (defer && !get()._pending) set({ _pending: get()._snapshot() })
    set((s) => ({
      drawings: s.drawings.map((d) => (d.id === drawingId ? { ...d, ...patch } : d)),
    }))
    if (before) get()._pushPast(before)
    emit({ type: 'patch', entity: 'drawing', id: drawingId, patch })
  },

  deleteDrawings: (ids, defer = false) => {
    if (ids.length === 0) return
    const before = defer ? null : get()._snapshot()
    // `defer` is `updateDrawing`'s, to the letter, because a sweep of the eraser
    // is one gesture the way a drag is: the disc passes over one mark, then
    // another, then a third, and undo has to put the sweep back rather than the
    // marks back one at a time in the order they happened to be met. The first
    // delete parks a snapshot in `_pending` and the `commit()` at the release
    // turns the whole run into a single step.
    //
    // **Only the history push is deferred.** The `set` and the `emit` run on
    // every call either way, which is what lets a peer watch the marks vanish
    // under the sweep instead of all at once when the finger lifts, and what
    // keeps autosave — which watches the drawings array's identity, not the
    // history — firing for the person doing it.
    //
    // The empty-ids return above sits deliberately in front of all of this: a
    // sweep across bare grass calls this on every pointer move, and it must not
    // park a snapshot that the release would then commit as an undo step in
    // which nothing changed.
    if (defer && !get()._pending) set({ _pending: get()._snapshot() })
    const idset = new Set(ids)
    set((s) => ({
      drawings: s.drawings.filter((d) => !idset.has(d.id)),
      selection: s.selection.filter((i) => !idset.has(i)),
    }))
    if (before) get()._pushPast(before)
    emit({ type: 'remove', entity: 'drawing', ids })
  },

  openInspector: (tokenId, x, y) => set({ inspector: { tokenId, x, y } }),
  closeInspector: () => set({ inspector: null }),

  initDefaultBoard: (boardId = null) =>
    set((s) => ({
      ...buildDefaultData(),
      boardId,
      // Never carried over. These contents are not the previous board's, and a
      // brand new board's generation is learned from the read that follows,
      // never assumed here.
      boardGeneration: null,
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
    // Clamp the delta once, against the selection's own bounding box, rather
    // than clamping each chip as it arrives at the touchline. Clamping them
    // individually meant the leading edge of a selection stopped while the rest
    // kept coming, so dragging a back four into the byline squashed it flat and
    // dragging back out did not restore the spacing. The set moves as a set.
    const { dx: cdx, dy: cdy } = clampGroupDelta(get().tokens, idset, dx, dy)
    set((s) => ({
      tokens: s.tokens.map((t) => (idset.has(t.id) ? { ...t, x: t.x + cdx, y: t.y + cdy } : t)),
      // Pinned annotations take the same clamped delta, or they would drift off
      // the chips they are pinned to as soon as the set hit an edge.
      drawings: shiftAttached(s.drawings, idset, cdx, cdy),
    }))
    for (const i of ids) get()._touched.add(i)
    emit({ type: 'bulk', tokens: bulkFor(get().tokens, idset) }, 'group')
  },

  updateToken: (tokenId, patch, defer = false) => {
    const before = defer ? null : get()._snapshot()
    // Typing is a gesture, so it is held the way a drag is held: one snapshot
    // parked in `_pending` at the first keystroke, and `commit()` on blur
    // turning the whole run into a single undo step. Pushing per keystroke
    // spent one of the 50 history slots and one `structuredClone` of the entire
    // board per character, and made undo walk a rename back letter by letter.
    //
    // Only the *history* push is deferred. The `set` and the `emit` below run
    // on every call either way, which is what keeps this invisible to the rest
    // of the system: peers still receive a patch per keystroke, and autosave
    // still fires for the originator, because it watches the token array's
    // identity and not the history.
    if (defer && !get()._pending) set({ _pending: get()._snapshot() })
    set((s) => ({
      tokens: s.tokens.map((t) => (t.id === tokenId ? { ...t, ...patch } : t)),
    }))
    if (before) get()._pushPast(before)
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

        // The pitch has just taken this format's positional numbers, so anyone
        // on the bench still wearing one of them is now a duplicate. Settle
        // them before the next side is considered.
        bench = renumberBench(tokens, bench, side)
      }

      return {
        tokens,
        bench,
        view: { ...s.view, kind },
        selection: [],
        inspector: null,
        formationEpoch: s.formationEpoch + 1,
        // Both sides are rebuilt from this format's first preset, so both are
        // on it. Recording one and leaving the other stale would make the next
        // depth change put a team back into an 11-a-side shape on a futsal court.
        lastFormation: { home: formationCode(FORMATION_NAMES[kind][0]), away: formationCode(FORMATION_NAMES[kind][0]) },
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
      lastFormation: { ...s.lastFormation, [side]: formationCode(name) },
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
      // A saved shape is not one of the presets, so this side is no longer on
      // one. Leaving the old code here would let the next depth change throw the
      // custom shape away and put the team back into the preset it replaced.
      lastFormation: { ...s.lastFormation, [side]: null },
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

/**
 * The largest part of a group drag that keeps every named token on the pitch.
 *
 * Taken from the bounding box of the set, so the answer is one delta for
 * everybody and the arrangement is preserved exactly.
 */
function clampGroupDelta(
  tokens: Token[],
  ids: Set<string>,
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const t of tokens) {
    if (!ids.has(t.id)) continue
    minX = Math.min(minX, t.x)
    maxX = Math.max(maxX, t.x)
    minY = Math.min(minY, t.y)
    maxY = Math.max(maxY, t.y)
  }
  if (!Number.isFinite(minX)) return { dx, dy }
  return {
    dx: clamp(dx, -minX, 100 - maxX),
    dy: clamp(dy, -minY, 100 - maxY),
  }
}

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
