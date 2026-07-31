import { useEffect } from 'react'
import { RoomConnection } from '../lib/realtime/connection'
import { registerSinks, clearSinks, emit } from '../lib/realtime/bridge'
import type { EntityOp, Op, ServerMessage } from '../lib/realtime/protocol'
import { loadBoard, flushSave, rereadFailed } from '../lib/boardSync'
import { useBoardStore } from '../store/boardStore'
import { useBoardsStore } from '../store/boardsStore'
import { useAuthStore, selectSignedIn } from '../store/authStore'
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
  // A guest admitted by a join code is a real member of a real room, so the
  // gate is "is there an account" and not "is there an address".
  const signedIn = useAuthStore(selectSignedIn)
  const currentId = useBoardsStore((s) => s.currentId)

  useEffect(() => {
    // Nobody signed in means no board on a server and so nobody to share with.
    // This used to say "a guest", and a guest is now exactly the case that does
    // belong in a room: admitted by a code, a real member, a real board.
    if (!signedIn || !currentId) return

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
        /**
         * A detail means the room refused this client for a reason retrying
         * cannot fix, and every one of those reasons refuses a write too.
         *
         * The session was destroyed, or the board stopped being shared. REST
         * answers 401 or 404 to the very next save either way, so the indicator
         * has no business resting on "Saved" until somebody happens to move a
         * chip. That is exactly the standing condition `blocked` exists for:
         * not a write that failed, but no write being possible at all, lasting
         * until a board opens successfully rather than until the next attempt.
         * The toast says which of the two it was and then fades; this keeps
         * saying that it happened.
         *
         * A dropped connection is deliberately not this. Saving goes over REST
         * and works perfectly well without a room.
         */
        if (status === 'offline' && detail) {
          toast(detail)
          useBoardsStore.getState().setSaveState('blocked')
        }
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

    /**
     * Whether the board store is still holding the board this room is for.
     *
     * The same question `flushSave` asks before every write, asked the same way,
     * because it is the same question: contents that are not this board's must
     * not be written to it, and must not be described to the room either.
     */
    const holdsThisBoard = (): boolean => useBoardStore.getState().boardId === currentId

    // `rereadFailed` used to be written out here. It lives in `boardSync.ts`
    // now, because a refused write's catch-up read is a third way into the same
    // dead end and three copies of one rule is how this repo keeps shipping a
    // fix that only landed in two of the places it belonged.

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
          // An answer to someone else's join, or a peer who has just changed
          // their name. Never replied to, or every join would set off an
          // endless round of introductions — which is also why a rename is
          // announced with this type rather than as a fresh `peer-joined`.
          store.peerJoined(message.peerId, message.email, message.displayName)
          return

        case 'peer-left':
          store.peerLeft(message.peerId)
          return

        case 'need-state': {
          if (!shouldAnswer(message.peerId)) return
          try {
            // Only claim to have written when the write happened. `flushSave`
            // refuses when the store is not holding this board, or when the
            // board has been replaced since these contents were read, and
            // telling peers to re-read on the back of a refusal points them at
            // whatever the server already had, which is not what we were
            // elected to give them.
            //
            // `replacing`, because this write is announced as `replaced` and
            // every peer re-reads on it. The flag and the broadcast are one
            // decision: the generation has to move for the peers whose base this
            // supersedes, and it must not move for a write nobody is told about.
            if (await flushSave(currentId!, { replacing: true }))
              connection.send({ type: 'replaced' })
          } catch {
            // The joiner keeps whatever it loaded; it is at worst slightly
            // stale, and the next op will correct the part that matters.
          }
          return
        }

        case 'replaced': {
          try {
            // A throw and a false are deliberately not the same answer here.
            // A throw is a request that did not land, which the next op or the
            // next `replaced` repairs and which leaves this board perfectly
            // writable in the meantime, so it is said once and left. False is a
            // row that will not parse until somebody writes a readable board
            // over it, which is a standing condition rather than an attempt
            // that failed, and that distinction is the whole of `offline`
            // against `blocked`.
            if (!(await loadBoard(currentId!, 'adopt'))) rereadFailed()
          } catch {
            toast('Could not catch up with the latest changes on this board.')
          }
          return
        }

        case 'lock': {
          store.setLocked(message.locked)

          /**
           * **The owner hands over their board, not just the permission.**
           *
           * This is the half that was missing, and it is why toggling instructor
           * mode on and off left two people looking at different boards. A lock
           * changes who may edit; it says nothing about *contents*. But a member
           * answers one by re-reading over REST, and REST serves the stored row
           * — which holds whatever the owner's debounced autosave last wrote,
           * not the ops they have broadcast since. So the member snapped back to
           * the last save while the owner kept their live board, and nothing
           * afterwards corrected it: ordinary ops announce nothing, and
           * unlocking re-read nothing at all.
           *
           * The owner is the one client whose edits the relay never drops, so
           * the owner's board is the only authoritative one and the owner is who
           * must publish. `replacing` is what moves the generation, which is
           * what supersedes the base every member is holding; without it their
           * next write would be refused for a base that quietly stopped being
           * current. It is the same save-and-announce every other whole-board
           * change already uses rather than a second mechanism beside it.
           *
           * **On both transitions.** Unlocking hands editing back, and handing
           * editing back to people whose board is behind is how the two diverge
           * for good rather than for a moment.
           *
           * Deliberately no re-read here: the owner already has the truth, and
           * reading would replace it with the stored row, which is the same
           * divergence reached from the other side.
           */
          if (store.role === 'owner') {
            try {
              if (await flushSave(currentId!, { replacing: true })) {
                connection.send({ type: 'replaced' })
              }
            } catch {
              // A write that did not land leaves the board writable and the
              // room on its previous contents, which the next op or the next
              // toggle repairs. Nothing standing to report.
            }
            return
          }

          if (message.locked) {
            toast('The owner has locked editing on this board.')
            // Anything edited in the moments before the lock arrived was dropped
            // by the server, so it exists only here. Go back to the truth. If
            // the truth will not parse, this client is left holding edits the
            // server refused, on a board it can no longer read, which is the
            // same dead end the branch above reaches by a different route.
            //
            // Awaited, not fired off to one side. This is the third branch that
            // pulls the whole board back over REST, so it belongs on the same
            // chain as the other two for the same reason they do: two reads in
            // flight settle in whichever order the network hands them over, and
            // that is not the order the messages arrived in. Left outside the
            // chain, a `lock` re-read could be overtaken by a `replaced` that
            // came after it and then land on top of it, leaving this client on
            // the older of the two boards with nothing due to correct it. The
            // lock itself is applied above, before the await, so the read
            // blocking costs nothing anybody is looking at.
            try {
              if (!(await loadBoard(currentId!, 'adopt'))) rereadFailed()
            } catch {
              // A read that did not land, exactly as in `replaced` above: the
              // next op or the next `replaced` repairs it and the board stays
              // writable meanwhile, so there is no standing condition to report.
            }
          }
          return
        }

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

    /**
     * Ops describe this board, so a client not holding it has nothing to say.
     *
     * Ops carry outcomes rather than intents: "token t7 is now here", applied by
     * peers without re-deriving anything. That is what makes last-write-wins
     * correct, and it is also why a client working from contents nobody else has
     * is worse than a quiet one. Its positions come from a board the room
     * replaced, and every peer would apply them to the board that actually
     * exists. The client already knows it is stale, so sending anyway is the
     * same silence the returned false was, one file over.
     *
     * Guarded on the store rather than latched in a flag, for two reasons. It is
     * the condition `flushSave` already refuses on, so "cannot be written" and
     * "cannot be broadcast" cannot drift apart. And it heals: a later `replaced`
     * that does parse puts the id back and this client speaks again, where a
     * latch or a `clearSinks()` would leave it mute for the life of the page
     * with its contents perfectly correct.
     */
    registerSinks({
      send: (op: Op, throttleKey?: string) => {
        if (holdsThisBoard()) connection.send(op, throttleKey)
      },
      sendFinal: (op: Op, throttleKey: string) => {
        if (holdsThisBoard()) connection.sendFinal(op, throttleKey)
      },
      sendReplaced: () => {
        // Save first, then tell peers to read: announcing before the write
        // lands would have them re-read the state we are replacing. A refused
        // write is the same case, so it announces nothing either — and a
        // refusal here means somebody else replaced the board first, so this
        // client has already taken theirs on and has nothing left to announce.
        //
        // `replacing`, which is what moves the board's generation and so
        // supersedes every peer's base. It is true here for exactly the reason
        // the branch exists: this is undo, redo, reset or a format change,
        // rewriting everything at once.
        void flushSave(currentId, { replacing: true })
          .then((saved) => {
            if (saved) connection.send({ type: 'replaced' })
          })
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
  }, [signedIn, currentId])
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
