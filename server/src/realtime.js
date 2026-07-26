import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { accessFor } from './access.js'
import { userForToken, readCookie, COOKIE_NAME } from './auth.js'

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

const roomFor = (boardId) => {
  let room = rooms.get(boardId)
  if (!room) {
    room = new Set()
    rooms.set(boardId, room)
  }
  return room
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
  const listener = new pg.Client({
    connectionString:
      process.env.DATABASE_URL ??
      'postgres://soccerboard:soccerboard@127.0.0.1:55432/soccerboard',
  })
  await listener.connect()
  await listener.query(`LISTEN ${CHANNEL}`)

  listener.on('notification', (msg) => {
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
  })

  listener.on('error', (err) => console.error('LISTEN connection error:', err.message))

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', async (socket, req) => {
    /**
     * The handshake finishes before the authorization below does, so anything
     * the client sends the instant it connects arrives while this handler is
     * still awaiting. Without a listener attached those messages are emitted
     * into nothing and silently lost — which in practice means a client's first
     * op after connecting sometimes vanishes, depending on how quickly the
     * database answers.
     *
     * So the listener goes on synchronously and queues until the socket is
     * authorized. The cap matters: it bounds what an unauthenticated caller can
     * make this process hold while it is being turned away.
     */
    let onMessage = null
    const queued = []
    socket.on('message', (raw) => {
      if (onMessage) onMessage(raw)
      else if (queued.length < 32) queued.push(raw)
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

      socket.peerId = randomUUID()
      socket.userId = user.id
      socket.userEmail = user.email
      socket.boardId = boardId
      socket.role = access.role
      roomFor(boardId).add(socket)

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

      socket.on('close', () => {
        const room = rooms.get(boardId)
        room?.delete(socket)
        if (room && room.size === 0) {
          rooms.delete(boardId)
          // Drop the cached flag with the room, so a board whose lock changed
          // while nobody was connected is read fresh next time.
          membersCanEdit.delete(boardId)
        }
        broadcast(boardId, { type: 'peer-left', peerId: socket.peerId }, socket)
      })

      socket.on('error', () => socket.close())
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
    deliverLocally(boardId, message, exceptSocket)
    const payload = JSON.stringify({ from: INSTANCE_ID, boardId, message })
    if (payload.length > MAX_PAYLOAD) return
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
      clearInterval(heartbeat)
      publishFn = null
      wss.close()
      await listener.end()
    },
  }
}

export const instanceId = INSTANCE_ID
