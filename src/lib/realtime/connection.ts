import type { Op, ServerMessage } from './protocol'
import { isEphemeral, withinSizeLimit } from './protocol'

/**
 * The socket, and the rules about what goes down it.
 *
 * Two things this deliberately is not: it does not know what a board is, and it
 * does not decide what an op means. It connects, keeps itself connected, throttles
 * what would otherwise be a flood, and hands messages to a callback.
 *
 * Realtime is an enhancement here, never a dependency. Every failure below ends
 * with the board still fully usable and still saving over REST — a room that
 * cannot be reached must never take the board down with it.
 */

/** A drag emits on every pointer move; the wire does not need 120 of those a second. */
const THROTTLE_MS = 50

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30_000

/**
 * How much work is held while the socket is away.
 *
 * The backoff reaches half a minute, which is long enough to draw a whole
 * training move, so ops written while disconnected are kept and replayed rather
 * than dropped on the floor.
 *
 * 32 is not arbitrary: the server buffers messages that arrive before a socket
 * has finished authenticating, and its buffer is 32 deep. A flush longer than
 * that would have the tail silently discarded at the other end, which is the
 * failure this queue exists to stop. The byte cap is the second half of the
 * same guard, because thirty-two text annotations are not the same size as
 * thirty-two chip positions.
 */
const QUEUE_MAX_OPS = 32
const QUEUE_MAX_BYTES = 64_000

export type Status = 'connecting' | 'live' | 'reconnecting' | 'offline'

export interface ConnectionHandlers {
  onMessage: (message: ServerMessage) => void
  onStatus: (status: Status, detail?: string) => void
}

/**
 * Close codes the server uses deliberately. These are not transport failures
 * and retrying cannot fix them, so they stop the loop rather than spinning.
 */
const FATAL: Record<number, string> = {
  4400: 'No board was specified for this room.',
  // The room is only opened for somebody who is signed in, so this is almost
  // always a session that has ended underneath an open tab rather than one that
  // never existed: a password reset elsewhere, a sign-out, or the thirty days
  // running out. Saying "sign in" alone read as though nothing had changed.
  4401: 'Your session has ended. Sign in again to collaborate on this board.',
  4403: 'This board is no longer shared with you.',
  // The row is gone, so a retry cannot succeed: it re-authorizes against a
  // board that does not exist and comes back as a 4403 saying the wrong thing,
  // one backoff later. This code has always been on the wire from
  // `reconcileRooms`; it became the ordinary close for a deletion when the
  // route started publishing one.
  4404: 'This board has been deleted.',
}

export class RoomConnection {
  private socket: WebSocket | null = null
  private attempts = 0
  private timer: number | null = null
  private closed = false

  /** Last time each throttle key was sent, so a drag coalesces per token. */
  private lastSent = new Map<string, number>()
  private pending = new Map<string, Op>()
  private flushTimer: number | null = null

  /** Ops written with no socket to write them to, oldest first. */
  private offline: { json: string; bytes: number }[] = []
  private offlineBytes = 0

  private readonly boardId: string
  private readonly handlers: ConnectionHandlers

  constructor(boardId: string, handlers: ConnectionHandlers) {
    this.boardId = boardId
    this.handlers = handlers
  }

  connect(): void {
    if (this.closed) return
    this.handlers.onStatus(this.attempts === 0 ? 'connecting' : 'reconnecting')

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws?board=${encodeURIComponent(this.boardId)}`,
    )
    this.socket = socket

    socket.onopen = () => {
      this.attempts = 0
      // Before anything else, and in particular before `welcome` arrives and
      // useRealtime asks for `need-state`. What was written while offline
      // describes edits nobody else has seen; the resync that follows exists to
      // reconcile whatever the room holds *including* these, so they have to be
      // in flight first. Flushing after the handshake would instead replay them
      // on top of a board that was just adopted wholesale, and they would fight.
      this.flushOffline()
      this.handlers.onStatus('live')
    }

    socket.onmessage = (event) => {
      let message: ServerMessage
      try {
        message = JSON.parse(event.data as string)
      } catch {
        return
      }
      this.handlers.onMessage(message)
    }

    socket.onclose = (event) => {
      this.socket = null
      if (this.closed) return

      const fatal = FATAL[event.code]
      if (fatal) {
        // Retrying an authorization failure just produces the same answer more
        // often, so say what happened and stop.
        this.closed = true
        this.handlers.onStatus('offline', fatal)
        return
      }
      this.scheduleReconnect()
    }
  }

  /**
   * Backoff with jitter.
   *
   * The jitter is the point: when an API instance restarts, every client in
   * every room is disconnected in the same instant, and a fixed delay would
   * bring them all back simultaneously — knocking it over again. Spreading the
   * return over the window turns a thundering herd into a trickle.
   */
  private scheduleReconnect(): void {
    this.attempts += 1
    const base = Math.min(BACKOFF_MIN_MS * 2 ** (this.attempts - 1), BACKOFF_MAX_MS)
    const delay = base / 2 + Math.random() * (base / 2)

    this.handlers.onStatus('reconnecting')
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  /**
   * Send an op, coalescing bursts.
   *
   * `throttleKey` groups ops that supersede one another — successive positions
   * of one token, or successive cursor positions. Only the most recent is worth
   * sending, so the rest are discarded rather than queued. Ops without a key
   * (a delete, a formation, a view change) always go immediately: they do not
   * supersede anything, and dropping one would lose it outright.
   */
  send(op: Op, throttleKey?: string): void {
    if (!throttleKey) {
      this.write(op)
      return
    }

    const now = Date.now()
    const last = this.lastSent.get(throttleKey) ?? 0

    if (now - last >= THROTTLE_MS) {
      this.lastSent.set(throttleKey, now)
      this.write(op)
      return
    }

    // Too soon: keep the newest and let the timer send it.
    this.pending.set(throttleKey, op)
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => this.flush(), THROTTLE_MS)
    }
  }

  /**
   * The exact final value, bypassing the throttle.
   *
   * Called when a drag ends. Without it a gesture could finish inside a
   * throttle window and leave peers looking at a position a few pixels off the
   * one the person actually chose — a small error that never corrects itself.
   */
  sendFinal(op: Op, throttleKey: string): void {
    this.pending.delete(throttleKey)
    this.lastSent.set(throttleKey, Date.now())
    this.write(op)
  }

  private flush(): void {
    this.flushTimer = null
    const now = Date.now()
    for (const [key, op] of this.pending) {
      this.lastSent.set(key, now)
      this.write(op)
    }
    this.pending.clear()
  }

  private write(op: Op): void {
    // The relay drops an oversized message only after delivering it to sockets
    // on its own instance, so sending one would reach some peers and not
    // others. Failing here makes it uniform — and it is checked before the
    // socket is, since there is no point holding something we could never send.
    if (!withinSizeLimit(op)) {
      if (import.meta.env.DEV) console.warn('Realtime op too large to send:', op.type)
      return
    }

    const json = JSON.stringify(op)
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.hold(op, json)
      return
    }

    this.socket.send(json)
  }

  /**
   * Keep an op until there is a socket again.
   *
   * Presence is deliberately not kept: replaying a cursor from thirty seconds
   * ago moves a peer's pointer to somewhere they left long ago, which is worse
   * than the pointer simply not being there.
   *
   * When the queue is full the oldest goes, not the newest. A board is edited
   * forwards, so the tail is the part closest to what the person actually has
   * in front of them, and the resync on reconnect is what repairs the rest.
   */
  private hold(op: Op, json: string): void {
    if (isEphemeral(op)) return

    // Bytes, not UTF-16 units, for the same reason the size limit measures
    // bytes: a text annotation full of emoji is twice the units and four times
    // the bytes, so counting characters would size this cap wrong.
    const bytes = new TextEncoder().encode(json).length
    this.offline.push({ json, bytes })
    this.offlineBytes += bytes

    let dropped = 0
    while (
      this.offline.length > QUEUE_MAX_OPS ||
      (this.offlineBytes > QUEUE_MAX_BYTES && this.offline.length > 1)
    ) {
      this.offlineBytes -= this.offline.shift()!.bytes
      dropped += 1
    }
    if (dropped > 0 && import.meta.env.DEV) {
      console.warn(`Realtime queue full while offline; dropped ${dropped} of the oldest ops.`)
    }
  }

  /**
   * Drain the queue, oldest first.
   *
   * Each op is removed only once it has actually gone down the socket, so a
   * connection that dies part-way through leaves the rest queued for the next
   * attempt rather than throwing away the tail it never sent.
   */
  private flushOffline(): void {
    while (this.offline.length > 0) {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      const next = this.offline[0]
      this.socket.send(next.json)
      this.offline.shift()
      this.offlineBytes -= next.bytes
    }
    this.offlineBytes = 0
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer)
    this.timer = null
    this.flushTimer = null
    this.pending.clear()
    this.offline = []
    this.offlineBytes = 0
    this.socket?.close()
    this.socket = null
  }
}
