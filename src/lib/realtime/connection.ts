import type { Op, ServerMessage } from './protocol'
import { withinSizeLimit } from './protocol'

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
  4401: 'Sign in to collaborate on this board.',
  4403: 'This board is no longer shared with you.',
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

    socket.onerror = () => {
      // Always followed by a close, which is where the retry decision lives.
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
    if (this.socket?.readyState !== WebSocket.OPEN) return

    // The relay drops an oversized message only after delivering it to sockets
    // on its own instance, so sending one would reach some peers and not
    // others. Failing here makes it uniform.
    if (!withinSizeLimit(op)) {
      if (import.meta.env.DEV) console.warn('Realtime op too large to send:', op.type)
      return
    }

    this.socket.send(JSON.stringify(op))
  }

  get isLive(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer)
    this.timer = null
    this.flushTimer = null
    this.pending.clear()
    this.socket?.close()
    this.socket = null
  }
}
