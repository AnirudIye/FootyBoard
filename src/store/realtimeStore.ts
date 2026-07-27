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
  email: string
  /** Normalized pitch coordinates, or null before they have moved. */
  cursor: { x: number; y: number } | null
  selection: string[]
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
  welcome: (peerId: string, role: 'owner' | 'member', locked: boolean, peers: { id: string; email: string }[]) => void
  peerJoined: (peerId: string, email: string) => void
  peerLeft: (peerId: string) => void
  setCursor: (peerId: string, x: number, y: number) => void
  setPeerSelection: (peerId: string, ids: string[]) => void
  setLocked: (locked: boolean) => void
  reset: () => void
}

const blankPeer = (id: string, email: string): RemotePeer => ({
  id,
  email,
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
      peers: Object.fromEntries(peers.filter((p) => p.id !== peerId).map((p) => [p.id, blankPeer(p.id, p.email)])),
    }),

  peerJoined: (peerId, email) =>
    set((s) => ({ peers: { ...s.peers, [peerId]: blankPeer(peerId, email) } })),

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

/** Peer count including this client, for the HUD readout. */
export const useRoomSize = () =>
  useRealtimeStore((s) => (s.peerId ? Object.keys(s.peers).length + 1 : 0))

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __realtimeStore?: unknown }).__realtimeStore = useRealtimeStore
}
