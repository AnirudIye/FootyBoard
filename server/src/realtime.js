import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { accessFor } from './access.js'
import { userForToken, readCookie, COOKIE_NAME } from './auth.js'
import { isAllowedOrigin } from './env.js'

/**
 * Collaborative rooms across several API instances.
 *
 * A socket is only ever connected to one instance, so a broadcast has to reach
 * the others somehow. Postgres LISTEN/NOTIFY is the bus: an instance relays an
 * op to its own sockets, then NOTIFYs, and every other instance relays it to
 * theirs. That means no Redis, no sticky sessions, and no shared memory — the
 * database we already depend on is the coordination point.
 *
 * Each instance tags its messages with its own id and ignores its own echo,
 * which is what stops an op being applied twice.
 */

const CHANNEL = 'board_ops'
const INSTANCE_ID = randomUUID()

// NOTIFY payloads are capped at 8000 bytes. Ops are small (a token moving), so
// anything larger is a bug or an abuse and is dropped rather than truncated.
const MAX_PAYLOAD = 6000

/** How long to wait before trying the notification bus again after it drops. */
const LISTENER_RETRY_MS = 2000

/**
 * Messages a client is never allowed to send.
 *
 * `lock` and `evict` originate on the server. Without this a member could
 * broadcast `lock: false` and every peer's UI would unlock — the server would
 * still drop their edits, so nothing would actually be written, but the
 * interface would be lying about who is allowed to do what. The presence
 * messages are here for the same reason: only the server decides who is in a
 * room.
 */
const SERVER_ONLY = new Set([
  'lock',
  'evict',
  'welcome',
  'peer-joined',
  'peer-left',
  'peer-present',
])

/**
 * Messages a locked-out member may still send. Editing is what the lock
 * withholds; being present is not. Resync has to stay open too, or a member
 * who is locked mid-edit has no way to get back to the truth.
 */
const ALLOWED_WHEN_LOCKED = new Set(['cursor', 'sel', 'need-state', 'replaced', 'here'])

/** boardId -> set of sockets on THIS instance. */
const rooms = new Map()

/**
 * boardId -> whether members may currently edit.
 *
 * Cached so that authorizing an op — which happens on every frame of a drag —
 * is a map lookup rather than a database round trip. The `lock` control message
 * rides the same NOTIFY bus as everything else, so every instance's copy is
 * corrected by the same broadcast that updates every client.
 */
const membersCanEdit = new Map()

/** Set by attachRealtime, so HTTP routes can push control messages onto the bus. */
let publishFn = null

/**
 * Fan out a server-originated message to a room, on every instance.
 *
 * Used by the share routes: flipping the lock and removing a member both have
 * to reach sockets this process does not hold.
 */
export function publish(boardId, message) {
  publishFn?.(boardId, message)
}

function deliverLocally(boardId, message, exceptSocket) {
  const room = rooms.get(boardId)
  if (!room) return
  const text = JSON.stringify(message)
  for (const socket of room) {
    if (socket !== exceptSocket && socket.readyState === socket.OPEN) socket.send(text)
  }
}

/** Everyone currently in the room, as far as this instance can see locally. */
const localPresence = (boardId) =>
  [...(rooms.get(boardId) ?? [])].map((s) => ({ id: s.peerId, email: s.userEmail }))

/**
 * Server-originated messages that change this instance's own state, applied
 * wherever the message arrives — locally on publish, or off the bus from
 * another instance. Both paths run this, so the two never drift.
 */
function applyControl(boardId, message) {
  if (message?.type === 'lock') {
    // Only worth caching where the room actually exists. An instance holding no
    // sockets for this board has nothing to enforce, and the next socket to
    // arrive seeds itself from the row the route has already written.
    if (rooms.has(boardId)) membersCanEdit.set(boardId, !message.locked)
    return
  }
  if (message?.type === 'evict') {
    for (const socket of rooms.get(boardId) ?? []) {
      if (socket.userId === message.userId) socket.close(4403, 'That board is no longer shared with you.')
    }
  }
}

export async function attachRealtime(httpServer) {
  // LISTEN needs its own dedicated connection: a pooled client would be handed
  // back to the pool and stop receiving notifications.
  let listener = null
  let listenerTimer = null
  let closing = false

  const onNotification = (msg) => {
    if (!msg.payload) return
    let parsed
    try {
      parsed = JSON.parse(msg.payload)
    } catch {
      return
    }
    // Our own broadcast coming back around; we already sent it locally.
    if (parsed.from === INSTANCE_ID) return
    applyControl(parsed.boardId, parsed.message)
    deliverLocally(parsed.boardId, parsed.message, null)
  }

  /**
   * Open the bus, and keep it open.
   *
   * Losing this connection is invisible from outside: the instance carries on
   * serving HTTP and its own sockets perfectly well, and simply stops hearing
   * every other instance. Rooms then diverge with nothing obviously wrong, so
   * logging the error and carrying on is not an option — a Postgres restart
   * would silently split the cluster until somebody noticed and redeployed.
   */
  async function openListener() {
    const client = new pg.Client({
      connectionString:
        process.env.DATABASE_URL ??
        'postgres://soccerboard:soccerboard@127.0.0.1:55432/soccerboard',
    })
    client.on('notification', onNotification)
    client.on('error', (err) => {
      console.error('LISTEN connection error:', err.message)
      if (listener !== client) return
      listener = null
      client.end().catch(() => {})
      reopenListener()
    })
    await client.connect()
    await client.query(`LISTEN ${CHANNEL}`)
    listener = client
  }

  function reopenListener() {
    if (closing || listenerTimer) return
    listenerTimer = setTimeout(() => {
      listenerTimer = null
      openListener().catch((err) => {
        console.error('Could not reopen the LISTEN connection:', err.message)
        reopenListener()
      })
    }, LISTENER_RETRY_MS)
    listenerTimer.unref?.()
  }

  await openListener()

  /**
   * `maxPayload` is the real bound on what an unauthenticated caller can make
   * this process hold. `ws` defaults it to 100 MiB, so the queue below capping
   * at 32 frames was capping at 3.2 GB — the count was never the constraint,
   * the size was. Set here, an oversized frame never reaches JavaScript at all.
   *
   * The origin check is the socket's half of what CORS does for REST. A
   * handshake is not a fetch and never asks a browser's permission, so without
   * it the only thing standing between a page on another origin and a
   * cookie-carrying connection into someone's room is `SameSite=Lax`. What
   * counts as allowed lives in `env.js`, next to the value the REST check uses,
   * so the two cannot answer differently.
   */
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: MAX_PAYLOAD,
    verifyClient: ({ origin }) => isAllowedOrigin(origin),
  })

  wss.on('connection', async (socket, req) => {
    /**
     * Everything a socket needs before it is anybody goes on synchronously,
     * because authorization below is two database round trips and a client can
     * connect, send, and disconnect inside them.
     *
     * `error`: `ws` rethrows an `error` event that has no listener, so a client
     * that opens the socket and immediately resets the connection used to take
     * the whole instance down with an uncaught exception.
     *
     * `close`: attaching this after the room was joined looked like it was
     * enough, and was not. A client that disconnects mid-authorization has
     * already emitted `close` by then, so the handler never ran: the dead
     * socket stayed in `rooms` for the life of the process, was announced to
     * every later joiner as present, and held the room's size above zero so its
     * cached lock was never dropped. It reads `socket.boardId`, which is only
     * set once the socket is actually in a room, so a socket turned away before
     * that does nothing here.
     *
     * `message`: queued until there is somewhere to put it, or a client's first
     * op after connecting vanishes whenever the database is a little slow. The
     * queue is bounded by size as well as by count, because a count alone
     * bounds nothing without `maxPayload`.
     */
    socket.on('error', () => socket.close())

    socket.on('close', () => {
      const boardId = socket.boardId
      if (!boardId) return
      const room = rooms.get(boardId)
      // `delete` reports whether it was there, which makes a second `close`
      // event a no-op rather than a second `peer-left`.
      if (!room?.delete(socket)) return
      if (room.size === 0) {
        rooms.delete(boardId)
        // Drop the cached flag with the room, so a board whose lock changed
        // while nobody was connected is read fresh next time.
        membersCanEdit.delete(boardId)
      }
      broadcast(boardId, { type: 'peer-left', peerId: socket.peerId }, socket)
    })

    let onMessage = null
    const queued = []
    socket.on('message', (raw) => {
      if (onMessage) onMessage(raw)
      else if (queued.length < 32 && raw.length <= MAX_PAYLOAD) queued.push(raw)
    })

    try {
      // Same cookie as the REST API — a socket is not a way around auth.
      const user = await userForToken(readCookie(req.headers.cookie, COOKIE_NAME))
      if (!user) return socket.close(4401, 'Sign in to collaborate.')

      const boardId = new URL(req.url, 'http://localhost').searchParams.get('board')
      if (!boardId) return socket.close(4400, 'No board specified.')

      // Access is checked here, not trusted from the client. A board you do not
      // own but have been shared into is reachable; anything else is not.
      const access = await accessFor(boardId, user.id)
      if (!access.role) return socket.close(4403, 'That board is not shared with you.')

      // Nobody who has already gone joins a room. The `close` handler above
      // cannot take this socket back out if it goes in after that event has
      // fired, so the check is here rather than left to be tidied up later.
      if (socket.readyState !== socket.OPEN) return

      socket.peerId = randomUUID()
      socket.userId = user.id
      socket.userEmail = user.email
      socket.boardId = boardId
      socket.role = access.role

      let room = rooms.get(boardId)
      if (!room) {
        room = new Set()
        rooms.set(boardId, room)
      }
      room.add(socket)

      // Seed the cache from the row we just read, so the first op does not have
      // to go back to the database for something we already know.
      if (!membersCanEdit.has(boardId)) membersCanEdit.set(boardId, access.membersCanEdit)

      socket.send(
        JSON.stringify({
          type: 'welcome',
          peerId: socket.peerId,
          role: access.role,
          locked: !membersCanEdit.get(boardId),
          peers: localPresence(boardId),
        }),
      )
      broadcast(boardId, { type: 'peer-joined', peerId: socket.peerId, email: user.email }, socket)

      onMessage = (raw) => {
        if (raw.length > MAX_PAYLOAD) return
        let op
        try {
          op = JSON.parse(raw)
        } catch {
          return
        }
        if (typeof op?.type !== 'string') return
        if (SERVER_ONLY.has(op.type)) return

        // The lock is enforced here rather than only in the interface, so a
        // client that ignores it achieves nothing. Presence and resync stay
        // open — editing is the only thing the lock withholds.
        if (
          socket.role !== 'owner' &&
          !membersCanEdit.get(boardId) &&
          !ALLOWED_WHEN_LOCKED.has(op.type)
        ) {
          return
        }

        /**
         * "I am also here."
         *
         * The `welcome` roster can only list sockets on this instance, and the
         * cluster spreads a room across all of them — so a joiner would
         * otherwise see only the subset that happened to land on the same
         * process. Existing peers answer a join with this, and the reply is
         * relayed as `peer-present` rather than `peer-joined` precisely so it
         * does not itself look like a join and trigger another round.
         *
         * Identity is stamped here rather than taken from the message, so a
         * client cannot introduce itself as somebody else.
         */
        if (op.type === 'here') {
          broadcast(
            boardId,
            { type: 'peer-present', peerId: socket.peerId, email: socket.userEmail },
            socket,
          )
          return
        }

        // The sender is stamped server-side so a client cannot impersonate a peer.
        broadcast(boardId, { ...op, peerId: socket.peerId }, socket)
      }

      // Anything that arrived while we were authorizing, in the order it was
      // sent, before any new message can overtake it.
      for (const raw of queued) onMessage(raw)
      queued.length = 0
    } catch (err) {
      console.error('WebSocket setup failed:', err.message)
      socket.close(1011, 'Could not open the room.')
    }
  })

  // Server-originated messages take the same path as a client op, minus the
  // sender to exclude — there isn't one.
  publishFn = (boardId, message) => {
    applyControl(boardId, message)
    broadcast(boardId, message, null)
  }

  /** Local sockets first, then every other instance via NOTIFY. */
  function broadcast(boardId, message, exceptSocket) {
    const payload = JSON.stringify({ from: INSTANCE_ID, boardId, message })
    /**
     * Measured, and refused, before anyone is given it.
     *
     * The cap used to be checked after the local room had already received the
     * message, so an op that fits the inbound limit but not the wrapped payload
     * reached this instance's peers and no others — leaving the room divided
     * with no error anywhere. Bytes rather than characters, because NOTIFY's
     * limit is bytes and a board full of accented names is not ASCII.
     */
    if (Buffer.byteLength(payload) > MAX_PAYLOAD) return
    deliverLocally(boardId, message, exceptSocket)

    /**
     * A missing listener is said out loud rather than optional-chained past.
     *
     * `listener?.query(...)` short-circuited the whole chain, `.catch` and all,
     * so during the two-second reconnect window every op reached this
     * instance's sockets and no other instance ever heard about it, silently.
     * That is precisely the split room the comment above says must never
     * happen, arrived at from the other direction. Buffering these until the
     * bus returns is a bigger design than this; knowing it happened is not
     * optional either way.
     */
    if (!listener) {
      console.error(
        `Op not published: the notification bus is down, so only this instance saw it (board ${boardId}, ${message?.type}).`,
      )
      return
    }
    // pg_notify is the function form, so the payload can be a bound parameter
    // instead of being concatenated into a NOTIFY statement.
    listener.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]).catch((err) => {
      console.error('Could not publish op:', err.message)
    })
  }

  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const socket of room) {
        if (socket.readyState === socket.OPEN) socket.ping()
      }
    }
  }, 30_000)
  heartbeat.unref?.()

  return {
    instanceId: INSTANCE_ID,
    close: async () => {
      closing = true
      if (listenerTimer) clearTimeout(listenerTimer)
      listenerTimer = null
      clearInterval(heartbeat)
      publishFn = null
      wss.close()
      await listener?.end()
      listener = null
    },
  }
}
