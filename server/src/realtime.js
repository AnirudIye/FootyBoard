import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { accessFor } from './access.js'
import { get, all, DB_NOW_MS } from './db.js'
import { sessionForToken, readCookie, COOKIE_NAME } from './auth.js'
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

/**
 * How long to wait before trying the notification bus again after it drops.
 *
 * Exported because it is also the window a missed eviction survives in, so
 * `durableEviction.test.js` budgets against this rather than against a second
 * copy of the number that would drift the day this one is tuned.
 */
export const LISTENER_RETRY_MS = 2000

/**
 * How far back a catch-up looks behind its own watermark.
 *
 * A revocation is stamped as its statement runs, not as its transaction
 * commits, so two revocations can become visible in the opposite order to their
 * timestamps. A catch-up that landed between them would advance past the later
 * stamp and never see the earlier row appear behind it — a revocation silently
 * skipped, which is the one outcome this whole mechanism exists to prevent.
 * Re-applying a revocation costs nothing, because the socket it names is
 * already gone, so the watermark is deliberately held this far back rather than
 * made exact. It only has to exceed how long a revocation can sit between its
 * own statement and its commit, and a minute is orders of magnitude more.
 */
const RECONCILE_OVERLAP_MS = 60_000

/**
 * Messages a client is never allowed to send.
 *
 * `lock`, `evict` and `evict-session` originate on the server. Without this a
 * member could broadcast `lock: false` and every peer's UI would unlock — the
 * server would still drop their edits, so nothing would actually be written,
 * but the interface would be lying about who is allowed to do what. The
 * presence messages are here for the same reason: only the server decides who
 * is in a room.
 */
const SERVER_ONLY = new Set([
  'lock',
  'evict',
  'evict-session',
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

/**
 * Control messages that stop here rather than reaching a browser.
 *
 * `deliverLocally` is the one funnel every server-originated message goes
 * through, so this is the only place the distinction can be made. A client's
 * message handler has a `default` arm that treats anything it does not
 * recognise as a board operation, which means shipping it internal bookkeeping
 * is not merely wasteful — it is handed to code that will try to apply it to
 * the board. None of these has anything a client could do with it: `evict` and
 * `evict-session` are acted on here by closing the socket, and `anon` only
 * corrects this instance's cache.
 */
const INTERNAL_ONLY = new Set(['evict', 'evict-session', 'anon'])

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

/**
 * boardId -> whether presence hides addresses, cached exactly like the lock.
 *
 * Read once when a room opens and corrected by the same NOTIFY bus, so every
 * instance answers the same way without asking the database on each join.
 */
const anonymousPresence = new Map()

/**
 * Names to hand out when a board hides addresses, the way Google Docs does it.
 *
 * A fixed list in code rather than a table: nothing here is worth a migration,
 * the set never needs to differ per install, and having it in one array is what
 * lets every instance derive the same name for the same person without
 * coordinating. Thirty is comfortably more than any room this product expects,
 * which keeps collisions rare enough that probing almost never runs.
 */
const ANONYMOUS_ANIMALS = [
  'Aardvark', 'Badger', 'Capybara', 'Dingo', 'Echidna', 'Fennec', 'Gecko',
  'Heron', 'Ibex', 'Jackal', 'Kudu', 'Lemur', 'Marmot', 'Narwhal', 'Ocelot',
  'Pangolin', 'Quokka', 'Raccoon', 'Serval', 'Tapir', 'Uakari', 'Vicuna',
  'Wombat', 'Xerus', 'Yak', 'Zebu', 'Bonobo', 'Coati', 'Dhole', 'Eland',
]

/**
 * FNV-1a, 32-bit. Not a security hash and not asked to be one.
 *
 * All it has to do is scatter two ids across thirty buckets identically on
 * every instance and on every reconnect, which is the whole reason the name is
 * derived rather than assigned: no instance has to remember anything, and two
 * processes seeing the same person reach the same animal on their own.
 */
function hash32(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * The animal this person keeps for as long as this room lives.
 *
 * Stable by derivation: the same user on the same board hashes to the same
 * starting index, so leaving and coming back gets the same name rather than
 * reading as a new arrival. Their own other sockets are excluded from the taken
 * set for the same reason — one person in two tabs is one person.
 *
 * Collisions are resolved by walking the list, which can only see the sockets
 * this instance holds. Across a cluster two different people can therefore end
 * up sharing an animal. That is a cosmetic duplicate rather than a leak, and
 * the alternative is a room-wide allocation table with a consensus problem
 * attached, which is a great deal of machinery for "two people are both called
 * Anonymous Badger".
 *
 * Exported for the owner's member list, which has the same problem from the REST
 * side: a guest has no address, so a list selecting one drew a blank row. It asks
 * this rather than inventing a second stand-in, because the owner matching a row
 * in the list against a cursor on the pitch depends on the two agreeing, and two
 * spellings of "what do we call somebody with no address" is exactly how they
 * would stop agreeing.
 */
export function anonymousNameFor(boardId, userId) {
  const taken = new Set()
  for (const socket of rooms.get(boardId) ?? []) {
    if (socket.userId !== userId && socket.anonName) taken.add(socket.anonName)
  }

  const start = hash32(`${userId}:${boardId}`) % ANONYMOUS_ANIMALS.length
  for (let step = 0; step < ANONYMOUS_ANIMALS.length; step++) {
    const name = `Anonymous ${ANONYMOUS_ANIMALS[(start + step) % ANONYMOUS_ANIMALS.length]}`
    if (!taken.has(name)) return name
  }
  // More people in this room than there are animals. Duplicating is the only
  // option left, and is better than refusing the connection.
  return `Anonymous ${ANONYMOUS_ANIMALS[start]}`
}

/**
 * What the room is told to call somebody, and the point of the whole feature.
 *
 * The substitution happens here, in the payload, rather than anywhere near a
 * client. Sending the address and asking the browser to hide it would leave it
 * on the wire and in every peer's memory, which is exactly the gap this closes:
 * on an anonymous board nobody's client ever receives another guest's address,
 * the owner's included. The owner still sees real addresses in the members
 * list, which is REST, owner-scoped, and a different question — "who has access
 * to my board" is theirs to know; "who is that cursor" is not the room's.
 *
 * `email` carries the same generated name rather than being dropped, because it
 * is the field every existing reader labels a peer from. Leaving it out would
 * mean an unlabelled cursor rather than an anonymous one, and the guarantee
 * that matters is that no address travels — not that a field goes missing.
 *
 * Evaluated per message rather than frozen at join, so flipping the setting
 * takes effect on the next introduction without anyone reconnecting.
 *
 * **There are now two reasons to substitute, and they are one rule.** The owner
 * asked, or there is no address to show in the first place: a guest admitted by a
 * join code has a null one, by construction. Keying on the absent address rather
 * than on the account being a guest is deliberate — the question here is "what
 * may this room be told", and the honest answer follows from what there is to
 * tell rather than from how the account came to exist. Without it a guest reaches
 * the room as `{ email: null }`, which is not a leak but is an unlabelled cursor,
 * and the whole point of carrying `email` at all is that a peer has something to
 * put beside a pointer.
 *
 * **Four candidates now, and the order is the feature.**
 *
 *   1. The board hides addresses, so the generated name, whatever else is true.
 *      The owner is deciding what their room discloses and that outranks anybody's
 *      preference about themselves — a coach who has just turned the switch on
 *      before reading a code to a hall must not be quietly overridden by somebody
 *      who set their own name to something identifying.
 *   2. A chosen display name. This is the new one, and it is why a member no
 *      longer has to be either an address or an animal.
 *   3. No address at all, so the generated name. A guest, as before.
 *   4. The address, exactly as it always was.
 *
 * **Case 4 is a residual gap rather than a design.** An account created before
 * this column existed carries a null name and keeps disclosing its local part
 * until somebody sets one. There is no name to invent on their behalf, and
 * defaulting everyone to an animal would turn a working roster into a zoo without
 * being asked, which is the same argument that keeps anonymity off by default. It
 * is written down in `handoff.md` beside the security-question backfill, which
 * has the identical shape.
 *
 * The chosen name is read off the socket rather than the row, so it is fixed at
 * the handshake exactly as the address is. A rename therefore reaches the room on
 * the next connection rather than immediately, which is a real cost and a small
 * one: what has to be live is the *owner's* switch, because that is thrown mid
 * session in front of a room, and that stays live because the flag is read here
 * per message rather than baked into a payload at join.
 */
function identity(socket) {
  const name = anonymousPresence.get(socket.boardId)
    ? socket.anonName
    : socket.userDisplayName || socket.userEmail || socket.anonName
  return { email: name, displayName: name }
}

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

/**
 * How many session ids ride in one eviction message.
 *
 * `broadcast` refuses a payload over `MAX_PAYLOAD` and returns, because an op
 * that will not fit is a bug rather than something to truncate. An *eviction*
 * that will not fit is a different thing entirely: it would be a revoked
 * session quietly keeping its socket. So the list is cut into pieces that
 * cannot reach the cap rather than handed over and hoped for. A hundred uuids
 * is under 4 kB, wrapper included.
 */
const EVICT_CHUNK = 100

/**
 * Close every socket authenticated by one of these sessions, on every instance.
 *
 * This is the socket half of destroying a session, and it exists because the
 * REST half is not enough on its own. A socket is authorized once, during the
 * handshake, and never re-checked: deleting the row stops the next request and
 * does nothing at all to a connection that is already open. Password recovery
 * destroys every session precisely so that somebody who believes another person
 * is in their account can throw them out, and without this the one thing that
 * survived it was the live room, still relaying that person's edits in both
 * directions.
 *
 * Not board-scoped, unlike `evict`. A session is an account-wide credential and
 * the process holding its socket almost certainly is not the one that served
 * the request, so the message is published with no board and every instance
 * sweeps every room it holds. `deliverLocally` finds no room for a null board
 * and `INTERNAL_ONLY` lists the type, so no client is ever handed it.
 */
export function closeSessionSockets(sessionIds) {
  const ids = [...new Set(sessionIds)].filter(Boolean)
  for (let at = 0; at < ids.length; at += EVICT_CHUNK) {
    publishFn?.(null, { type: 'evict-session', sessionIds: ids.slice(at, at + EVICT_CHUNK) })
  }
}

function deliverLocally(boardId, message, exceptSocket) {
  const room = rooms.get(boardId)
  if (!room) return
  if (INTERNAL_ONLY.has(message?.type)) return
  const text = JSON.stringify(message)
  for (const socket of room) {
    if (socket !== exceptSocket && socket.readyState === socket.OPEN) socket.send(text)
  }
}

/** Everyone currently in the room, as far as this instance can see locally. */
const localPresence = (boardId) =>
  [...(rooms.get(boardId) ?? [])].map((s) => ({ id: s.peerId, ...identity(s) }))

/**
 * Server-originated messages that change this instance's own state, applied
 * wherever the message arrives — locally on publish, or off the bus from
 * another instance. Both paths run this, so the two never drift.
 *
 * Both cached flags are recorded only where the room actually exists, and that
 * is safe **only because the join path reads them after `room.add`**. An
 * instance holding no sockets for this board has nothing to enforce, and the
 * next socket to arrive opens the room first and then reads the row this route
 * has already written. Move that read back in front of the join and this
 * refusal silently becomes a lost update: the change lands nowhere, and the
 * joiner seeds the value it saw before the change was made.
 */
function applyControl(boardId, message) {
  if (message?.type === 'lock') {
    if (rooms.has(boardId)) membersCanEdit.set(boardId, !message.locked)
    return
  }
  if (message?.type === 'anon') {
    if (rooms.has(boardId)) anonymousPresence.set(boardId, message.anonymous === true)
    return
  }
  if (message?.type === 'evict') {
    for (const socket of rooms.get(boardId) ?? []) {
      if (socket.userId === message.userId) socket.close(4403, 'That board is no longer shared with you.')
    }
    return
  }
  /**
   * A session was destroyed, so everything it authenticated goes with it.
   *
   * Every room on this instance rather than one, because the message carries no
   * board: a session is not scoped to one, and the person being thrown out may
   * be sitting in several. Matched on the session rather than on the user, so
   * that the one path which destroys every session and immediately mints a
   * replacement — changing a password while signed in — does not throw out the
   * browser it just handed a live cookie to.
   */
  if (message?.type === 'evict-session') {
    const revoked = new Set(message.sessionIds ?? [])
    if (revoked.size === 0) return
    for (const room of rooms.values()) {
      for (const socket of room) {
        if (revoked.has(socket.sessionId)) socket.close(4401, 'That session has ended.')
      }
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
   * The moment up to which every revocation has been applied to this instance.
   *
   * In memory and deliberately not durable. A restart re-authorizes every
   * socket from scratch, because sockets do not survive a restart, so there is
   * nothing for a remembered watermark to protect: at the moment this is
   * assigned the process holds no rooms at all, and the only thing this value
   * bounds is a query that consequently has nothing to do.
   */
  let appliedThrough = Date.now()

  /**
   * Catch up on evictions that were published while this instance was deaf.
   *
   * The NOTIFY is the only thing that closes a socket, and an instance whose
   * LISTEN connection was down when one was published never heard it. Its
   * sockets are then authorized by sessions that no longer exist anywhere, and
   * nothing re-checks a socket after the handshake, so they would keep relaying
   * that person's edits until they happened to disconnect. `sessions.js` writes
   * every revocation down for exactly this read.
   *
   * The clock is read *before* the rows rather than after, so this can only
   * ever claim to have applied things that were already committed when it
   * looked. And it is applied through `applyControl` — the same arm the bus
   * message lands in — rather than through `closeSessionSockets`, for two
   * reasons: what an eviction does to a room is written down once, and this
   * instance is catching *itself* up. Publishing would tell every other
   * instance something it has either already done or is about to do for itself,
   * and turn one instance reconnecting into a broadcast to all of them.
   */
  async function catchUpOnRevocations() {
    const [{ at }] = await all(`SELECT ${DB_NOW_MS} AS at`)
    const revoked = await all(
      'SELECT session_id FROM session_revocations WHERE revoked_at > $1',
      appliedThrough - RECONCILE_OVERLAP_MS,
    )
    if (revoked.length > 0) {
      applyControl(null, {
        type: 'evict-session',
        sessionIds: revoked.map((row) => row.session_id),
      })
    }
    // Advanced whether or not anything was found, or an instance that has been
    // up for a month would rescan a month of revocations the first time its
    // listener blinked. `Math.max` because the watermark is only ever allowed
    // to move forward.
    appliedThrough = Math.max(appliedThrough, Number(at))
  }

  /**
   * Open the bus, and keep it open.
   *
   * Losing this connection is invisible from outside: the instance carries on
   * serving HTTP and its own sockets perfectly well, and simply stops hearing
   * every other instance. Rooms then diverge with nothing obviously wrong, so
   * logging the error and carrying on is not an option — a Postgres restart
   * would silently split the cluster until somebody noticed and redeployed.
   *
   * **`LISTEN` first, then catch up, and only then is the client the listener.**
   * A revocation committing between the two is delivered by both, which costs a
   * closed socket being closed a second time; the other order leaves a gap that
   * neither covers, which costs the guarantee. Publishing the client last means
   * a failed catch-up is a failed open: the connection is ended and the retry
   * comes round again, rather than this instance sitting on a live bus
   * believing it is up to date when it is not.
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
    try {
      await client.query(`LISTEN ${CHANNEL}`)
      await catchUpOnRevocations()
    } catch (err) {
      await client.end().catch(() => {})
      throw err
    }
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
        // Drop the cached flags with the room, so a board whose lock or
        // anonymity changed while nobody was connected is read fresh next time.
        membersCanEdit.delete(boardId)
        anonymousPresence.delete(boardId)
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
      // Same cookie as the REST API — a socket is not a way around auth. The
      // session, not just the user: this connection is only as alive as the row
      // that let it in, and `closeSessionSockets` above needs to be able to
      // find it by that row when the row is deleted.
      const session = await sessionForToken(readCookie(req.headers.cookie, COOKIE_NAME))
      if (!session) return socket.close(4401, 'Sign in to collaborate.')
      const user = session.user

      const boardId = new URL(req.url, 'http://localhost').searchParams.get('board')
      if (!boardId) return socket.close(4400, 'No board specified.')

      // Access is checked here, not trusted from the client. A board you do not
      // own but have been shared into is reachable; anything else is not.
      const access = await accessFor(boardId, user.id)
      if (!access.role) return socket.close(4403, 'That board is not shared with you.')

      // Nobody who has already gone joins a room. The `close` handler above
      // cannot take this socket back out if it goes in after that event has
      // fired, so the check is here rather than left to be tidied up later —
      // and **nothing may `await` between this line and `room.add` below**, or
      // the socket can die in the gap and be added to a room it can never
      // leave. That requirement is why the flags are read after the join
      // rather than before it.
      if (socket.readyState !== socket.OPEN) return

      socket.peerId = randomUUID()
      socket.userId = user.id
      socket.sessionId = session.id
      socket.userEmail = user.email
      // Beside the address rather than instead of it, because `identity()` needs
      // both: the name is what the room hears and the address is the fallback
      // for an account that has never chosen one.
      socket.userDisplayName = user.displayName ?? null
      socket.boardId = boardId
      socket.role = access.role

      let room = rooms.get(boardId)
      if (!room) {
        room = new Set()
        rooms.set(boardId, room)
      }
      room.add(socket)

      // Assigned unconditionally, even on a board that names people normally,
      // so that switching the setting on mid-session has a name ready rather
      // than having to invent one at broadcast time. It is derived, so this
      // costs a hash.
      socket.anonName = anonymousNameFor(boardId, user.id)

      /**
       * Both cached flags, read once per room, and only once the room exists.
       *
       * Three things about the position of this read are load-bearing.
       *
       * **It is after `room.add`.** A read taken before the room existed can
       * only ever seed a stale value, because `applyControl` records a `lock`
       * or `anon` broadcast only where `rooms.has(boardId)` — so a change made
       * in the window between reading and joining is refused by this instance
       * and then overwritten by the older value the joiner carried in. That is
       * how a lock the owner had just thrown ended up cached as unlocked for
       * the life of the room: every member served here was told `locked: false`
       * in `welcome`, their ops passed the relay's check below, and `PUT`
       * correctly refused to save any of it.
       *
       * **It is after the `readyState` check, not before it.** Nothing writes
       * to either cache for a socket that never joined. Writing first and
       * checking afterwards left a permanent entry for a board with no room on
       * this instance, which `applyControl` then refused to correct and every
       * later joiner trusted instead of reading the row — an anonymous board
       * quietly serving real addresses again.
       *
       * **Neither value is overwritten if something already knows better.** A
       * `lock` or `anon` that arrived while this read was in flight is newer
       * than the row it returns, and the room existed by then, so it was
       * recorded. Seeding only what is missing is what stops this read putting
       * the older answer back.
       *
       * `accessFor` cannot supply either: it is the one place every access
       * decision is made, its answer predates the room, and adding a display
       * concern to it would put a column nothing authorizes on into the query
       * every request already runs.
       */
      if (!membersCanEdit.has(boardId) || !anonymousPresence.has(boardId)) {
        const row = await get(
          'SELECT members_can_edit, anonymous_presence FROM boards WHERE id = $1',
          boardId,
        )
        // Reading is an `await`, and this socket may have gone during it. The
        // `close` handler has already taken it out and dropped the room's
        // cached flags with it, so seeding them now would recreate exactly the
        // orphan this ordering exists to prevent.
        if (rooms.get(boardId)?.has(socket) !== true) return
        if (!membersCanEdit.has(boardId)) {
          membersCanEdit.set(boardId, row?.members_can_edit === true)
        }
        if (!anonymousPresence.has(boardId)) {
          anonymousPresence.set(boardId, row?.anonymous_presence === true)
        }
      }

      socket.send(
        JSON.stringify({
          type: 'welcome',
          peerId: socket.peerId,
          role: access.role,
          locked: !membersCanEdit.get(boardId),
          peers: localPresence(boardId),
        }),
      )
      broadcast(boardId, { type: 'peer-joined', peerId: socket.peerId, ...identity(socket) }, socket)

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
         * client cannot introduce itself as somebody else — and on an anonymous
         * board it cannot introduce itself as *itself*, either, because the name
         * the room hears is the one the server substitutes.
         */
        if (op.type === 'here') {
          broadcast(
            boardId,
            { type: 'peer-present', peerId: socket.peerId, ...identity(socket) },
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
     *
     * `evict-session` is the one message here where losing it costs more than
     * convergence: the instance that handled the request has already closed its
     * own sockets, and every other instance keeps serving a session that no
     * longer exists until it happens to disconnect. It carries no board, hence
     * the `n/a`, and it is worth grepping for on its own.
     */
    if (!listener) {
      console.error(
        `Not published: the notification bus is down, so only this instance saw it (${message?.type}, board ${boardId ?? 'n/a'}).`,
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
