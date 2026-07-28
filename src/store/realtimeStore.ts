import { create } from 'zustand'
import type { Status } from '../lib/realtime/connection'

/**
 * Who else is here, and whether we can reach them.
 *
 * Kept apart from the board store on purpose: none of this is the board. It is
 * not saved, not undoable, and not part of what anyone exports — it is the
 * state of a conversation happening around the board.
 */

export interface RemotePeer {
  id: string
  /**
   * Whatever the server disclosed about who this is, which on a board with
   * anonymous guests turned on is not an address at all. Kept because it is
   * what older readers label a peer from; prefer `displayName`.
   */
  email: string
  /**
   * What to show on screen for this peer, and the only field to render.
   *
   * Always populated, and already a name rather than an identity: two things
   * have happened to it by the time it is here. The relay substitutes a
   * generated name server-side when the board hides addresses, so this is
   * "their name in this room" rather than a thing the interface has to decide;
   * and `shownName` below drops the domain from whatever is left.
   */
  displayName: string
  /** Normalized pitch coordinates, or null before they have moved. */
  cursor: { x: number; y: number } | null
  selection: string[]
}

/** A peer as the relay describes them. `displayName` is optional only so that
 *  a caller relaying an older message shape still type-checks. */
interface PeerInfo {
  id: string
  email: string
  displayName?: string
}

interface RealtimeState {
  status: Status
  /** Set when the connection stopped for a reason retrying cannot fix. */
  detail: string | null
  /** This client's id in the room, assigned by the server. */
  peerId: string | null
  role: 'owner' | 'member' | null
  /**
   * Whether editing is locked **on the board**, regardless of who is asking.
   *
   * Kept apart from `locked` because the two are different questions and the
   * owner needs the first one. Collapsing them is what broke the share dialog:
   * with only `locked` — which is always false for the owner — the owner had
   * nowhere to read the board's real state, so the dialog read a stale copy out
   * of the board list and showed the opposite of the truth.
   */
  boardLocked: boolean
  /** Whether *this client* is prevented from editing. Never true for the owner. */
  locked: boolean
  peers: Record<string, RemotePeer>

  setStatus: (status: Status, detail?: string) => void
  welcome: (peerId: string, role: 'owner' | 'member', locked: boolean, peers: PeerInfo[]) => void
  peerJoined: (peerId: string, email: string, displayName?: string) => void
  peerLeft: (peerId: string) => void
  setCursor: (peerId: string, x: number, y: number) => void
  setPeerSelection: (peerId: string, ids: string[]) => void
  setLocked: (locked: boolean) => void
  reset: () => void
}

/**
 * A cursor label wants a name; the relay sends an identity.
 *
 * It discloses one of two things: a generated `Anonymous Quokka` on a board
 * that hides addresses, or the plain address on one that does not. Only the
 * second needs anything doing to it, and cutting the domain off it is
 * presentation rather than privacy — on a board that names people normally the
 * whole address is on the wire either way, which is known gap 2 in the handoff
 * and not something a client can decide.
 *
 * It happens here, once, because this store is where both readers of a peer
 * get one. Doing it in the components is what put `anirud@gmail.com` on every
 * live cursor label the moment PeerLayer preferred `displayName` over splitting
 * the address for itself. A generated name contains no `@`, so it passes
 * through untouched.
 */
const shownName = (disclosed: string): string => disclosed.split('@')[0]

const blankPeer = (id: string, email: string, displayName?: string): RemotePeer => ({
  id,
  email,
  displayName: shownName(displayName ?? email),
  cursor: null,
  selection: [],
})

export const useRealtimeStore = create<RealtimeState>((set) => ({
  status: 'offline',
  detail: null,
  peerId: null,
  role: null,
  boardLocked: false,
  locked: false,
  peers: {},

  setStatus: (status, detail) => set({ status, detail: detail ?? null }),

  welcome: (peerId, role, locked, peers) =>
    set({
      peerId,
      role,
      boardLocked: locked,
      // The owner is never locked out by their own lock, so this is only ever
      // true for someone else's board.
      locked: role !== 'owner' && locked,
      peers: Object.fromEntries(
        peers
          .filter((p) => p.id !== peerId)
          .map((p) => [p.id, blankPeer(p.id, p.email, p.displayName)]),
      ),
    }),

  peerJoined: (peerId, email, displayName) =>
    set((s) => ({ peers: { ...s.peers, [peerId]: blankPeer(peerId, email, displayName) } })),

  peerLeft: (peerId) =>
    set((s) => {
      // Their cursor and selection go with them; a pointer left behind by
      // someone who has gone is worse than no pointer at all.
      const { [peerId]: _gone, ...rest } = s.peers
      return { peers: rest }
    }),

  setCursor: (peerId, x, y) =>
    set((s) => {
      const peer = s.peers[peerId]
      if (!peer) return s
      return { peers: { ...s.peers, [peerId]: { ...peer, cursor: { x, y } } } }
    }),

  setPeerSelection: (peerId, ids) =>
    set((s) => {
      const peer = s.peers[peerId]
      if (!peer) return s
      return { peers: { ...s.peers, [peerId]: { ...peer, selection: ids } } }
    }),

  setLocked: (locked) =>
    set((s) => ({ boardLocked: locked, locked: s.role !== 'owner' && locked })),

  reset: () =>
    set({
      status: 'offline',
      detail: null,
      peerId: null,
      role: null,
      boardLocked: false,
      locked: false,
      peers: {},
    }),
}))

/**
 * A stable colour per peer.
 *
 * Derived from the id rather than assigned, so two clients independently give
 * the same person the same colour without having to agree on anything. The
 * hue is spread across the wheel while saturation and lightness stay put, which
 * keeps every peer legible against the near-black pitch.
 */
export function peerColor(peerId: string): string {
  let hash = 0
  for (let i = 0; i < peerId.length; i++) hash = (hash * 31 + peerId.charCodeAt(i)) | 0
  return `hsl(${Math.abs(hash) % 360} 85% 62%)`
}

/**
 * The letter a peer's avatar carries.
 *
 * Taken from the **last** word rather than the first, which is the whole
 * difference between a stack of distinguishable people and a row of identical
 * 'A's: every generated name is `Anonymous <Animal>`, so the first letter is
 * the one part of it that is the same for everybody, in the single mode the
 * feature exists for. The animal is what varies, and it is what the label under
 * their cursor says too, so the two agree about who is who.
 *
 * `displayName` has no domain left on it by the time it reaches here, so a
 * board that names people normally is unaffected: one word, first letter.
 */
export function peerInitial(peer: Pick<RemotePeer, 'displayName'>): string {
  const last = peer.displayName.trim().split(/\s+/).pop() ?? ''
  return last[0]?.toUpperCase() ?? '?'
}

/** Peer count including this client, for the HUD readout. */
export const useRoomSize = () =>
  useRealtimeStore((s) => (s.peerId ? Object.keys(s.peers).length + 1 : 0))

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __realtimeStore?: unknown }).__realtimeStore = useRealtimeStore
}
