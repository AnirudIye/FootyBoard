import { useEffect } from 'react'
import { RoomConnection } from '../lib/realtime/connection'
import { registerSinks, clearSinks, emit } from '../lib/realtime/bridge'
import type { EntityOp, Op, ServerMessage } from '../lib/realtime/protocol'
import { loadBoard, flushSave } from '../lib/boardSync'
import { useBoardStore } from '../store/boardStore'
import { useBoardsStore } from '../store/boardsStore'
import { useAuthStore } from '../store/authStore'
import { useRealtimeStore } from '../store/realtimeStore'
import { toast } from '../store/toastStore'

/**
 * Joins the room for the open board and keeps it in step.
 *
 * The board works with none of this running. If the socket never connects, or
 * drops and never comes back, every edit still lands over REST and the only
 * thing lost is seeing other people — which is why nothing here throws into the
 * board's own code paths.
 */
export function useRealtime() {
  const email = useAuthStore((s) => s.email)
  const currentId = useBoardsStore((s) => s.currentId)

  useEffect(() => {
    // A guest has no account, so no board on a server, so nobody to share with.
    if (!email || !currentId) return

    let disposed = false

    /**
     * Messages are handled strictly in arrival order.
     *
     * `handle` awaits a REST round trip in the `need-state` and `replaced`
     * branches, so letting two run at once means the slower one finishes last:
     * two `replaced` messages in flight would leave whichever load happened to
     * be slower as the winner, which is not the newer of the two. An op
     * arriving during a pending `replaced` had the same problem from the other
     * side — it applied to the pre-load board and was then read straight over.
     * Chaining costs nothing at this message rate and removes both races.
     */
    let inOrder: Promise<void> = Promise.resolve()

    const connection = new RoomConnection(currentId, {
      onStatus: (status, detail) => {
        useRealtimeStore.getState().setStatus(status, detail)
        if (status === 'offline' && detail) toast(detail)
      },
      onMessage: (message) => {
        // Errors are swallowed rather than allowed to poison the chain: one
        // message failing must not stop every later message from being handled.
        inOrder = inOrder.then(() => handle(message)).catch(() => {})
      },
    })

    /**
     * Answer a joiner's request for the current state.
     *
     * Whoever has the lowest peer id answers, which needs no coordination: every
     * client already knows every peer id, so they all reach the same conclusion
     * independently and exactly one of them writes.
     */
    const shouldAnswer = (askerId: string): boolean => {
      const { peerId, peers } = useRealtimeStore.getState()
      if (!peerId) return false
      // The asker is excluded from its own election. The server announces a
      // joiner before relaying their request, so by now everyone already counts
      // them as a peer — and whenever their id happened to sort first, every
      // responder concluded somebody else would answer and nobody did.
      const candidates = [peerId, ...Object.keys(peers)].filter((id) => id !== askerId)
      return candidates.sort()[0] === peerId
    }

    async function handle(message: ServerMessage) {
      if (disposed) return
      const store = useRealtimeStore.getState()

      switch (message.type) {
        case 'welcome': {
          store.welcome(message.peerId, message.role, message.locked, message.peers)
          // Asked unconditionally rather than only when the roster looks
          // populated: that roster covers one instance, so "nobody here" is not
          // something this message can actually tell us. If we really are alone
          // nobody answers, and the REST load already in flight stands.
          connection.send({ type: 'need-state' })
          return
        }

        case 'peer-joined':
          store.peerJoined(message.peerId, message.email, message.displayName)
          // Introduce ourselves back. Their `welcome` could only see the
          // instance that answered their connection, so this is how a room
          // spread across processes learns it is one room.
          connection.send({ type: 'here' })
          return

        case 'peer-present':
          // An answer to someone else's join. Never replied to, or every join
          // would set off an endless round of introductions.
          store.peerJoined(message.peerId, message.email, message.displayName)
          return

        case 'peer-left':
          store.peerLeft(message.peerId)
          return

        case 'need-state': {
          if (!shouldAnswer(message.peerId)) return
          try {
            await flushSave(currentId!)
            connection.send({ type: 'replaced' })
          } catch {
            // The joiner keeps whatever it loaded; it is at worst slightly
            // stale, and the next op will correct the part that matters.
          }
          return
        }

        case 'replaced': {
          try {
            await loadBoard(currentId!, 'adopt')
          } catch {
            toast('Could not catch up with the latest changes on this board.')
          }
          return
        }

        case 'lock':
          store.setLocked(message.locked)
          if (message.locked && store.role !== 'owner') {
            toast('The owner has locked editing on this board.')
            // Anything edited in the moments before the lock arrived was dropped
            // by the server, so it exists only here. Go back to the truth.
            void loadBoard(currentId!, 'adopt').catch(() => {})
          }
          return

        case 'cursor':
          store.setCursor(message.peerId, message.x, message.y)
          return

        case 'sel':
          store.setPeerSelection(message.peerId, message.ids)
          return

        default:
          // Everything else changes the board itself.
          useBoardStore.getState().applyRemote(message as EntityOp)
      }
    }

    registerSinks({
      send: (op: Op, throttleKey?: string) => connection.send(op, throttleKey),
      sendFinal: (op: Op, throttleKey: string) => connection.sendFinal(op, throttleKey),
      sendReplaced: () => {
        // Save first, then tell peers to read — announcing before the write
        // lands would have them re-read the state we are replacing.
        void flushSave(currentId)
          .then(() => connection.send({ type: 'replaced' }))
          .catch(() => {})
      },
    })

    connection.connect()

    return () => {
      disposed = true
      clearSinks()
      connection.close()
      useRealtimeStore.getState().reset()
    }
  }, [email, currentId])
}

/**
 * Broadcast this client's pointer, in normalized pitch coordinates.
 *
 * Separate from the hook above because only the canvas knows where the pointer
 * is on the pitch, as opposed to on the screen. Throttled like a drag, and a
 * no-op when nothing is connected.
 */
export function sendCursor(x: number, y: number): void {
  emit({ type: 'cursor', x, y }, 'cursor')
}
