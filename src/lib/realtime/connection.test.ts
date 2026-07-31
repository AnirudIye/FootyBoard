import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RoomConnection } from './connection'
import type { Status } from './connection'

/**
 * The transport's own behaviour: what it coalesces, what it refuses to send,
 * and what it does when the connection goes away.
 */

class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly OPEN = 1

  readyState = FakeSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null

  url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }

  /** Drive the socket the way the browser would. */
  open() {
    this.onopen?.()
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  serverClosed(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const latest = () => FakeSocket.instances.at(-1)!
const parsed = (socket: FakeSocket) => socket.sent.map((s) => JSON.parse(s))

let statuses: { status: Status; detail?: string }[]
let messages: unknown[]

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
  statuses = []
  messages = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const connect = () => {
  const connection = new RoomConnection('board-1', {
    onStatus: (status, detail) => statuses.push({ status, detail }),
    onMessage: (message) => messages.push(message),
  })
  connection.connect()
  latest().open()
  return connection
}

describe('connecting', () => {
  it('reports live once the socket opens', () => {
    connect()
    expect(statuses.map((s) => s.status)).toEqual(['connecting', 'live'])
  })

  it('passes decoded messages through and ignores malformed ones', () => {
    connect()
    latest().receive({ type: 'welcome', peerId: 'p1' })
    latest().onmessage?.({ data: 'not json' })
    expect(messages).toEqual([{ type: 'welcome', peerId: 'p1' }])
  })
})

describe('throttling', () => {
  it('sends the first op immediately', () => {
    const connection = connect()
    connection.send({ type: 'cursor', x: 1, y: 1 }, 'cursor')
    expect(parsed(latest())).toHaveLength(1)
  })

  it('coalesces a burst into one op per interval, keeping the newest', () => {
    const connection = connect()
    for (let i = 0; i < 20; i++) connection.send({ type: 'cursor', x: i, y: i }, 'cursor')

    // One went straight out; the other nineteen collapse to the most recent,
    // because a superseded cursor position is worth nothing.
    expect(parsed(latest())).toHaveLength(1)
    vi.advanceTimersByTime(50)
    expect(parsed(latest())).toEqual([
      { type: 'cursor', x: 0, y: 0 },
      { type: 'cursor', x: 19, y: 19 },
    ])
  })

  it('keeps separate keys separate, so dragging two chips sends both', () => {
    const connection = connect()
    connection.send({ type: 'cursor', x: 1, y: 1 }, 'token:a')
    connection.send({ type: 'cursor', x: 2, y: 2 }, 'token:b')
    expect(parsed(latest())).toHaveLength(2)
  })

  it('never delays an op that supersedes nothing', () => {
    const connection = connect()
    // A delete or a view change is not a position being refined — dropping one
    // would lose it outright, so unkeyed ops always go straight out.
    for (let i = 0; i < 5; i++) connection.send({ type: 'remove', entity: 'drawing', ids: [`d${i}`] })
    expect(parsed(latest())).toHaveLength(5)
  })

  it('sends the final value past the throttle', () => {
    const connection = connect()
    connection.send({ type: 'cursor', x: 1, y: 1 }, 'token:a')
    connection.send({ type: 'cursor', x: 2, y: 2 }, 'token:a')
    connection.sendFinal({ type: 'cursor', x: 3, y: 3 }, 'token:a')

    // The queued intermediate is discarded rather than arriving after the final
    // one and moving the chip back.
    expect(parsed(latest())).toEqual([
      { type: 'cursor', x: 1, y: 1 },
      { type: 'cursor', x: 3, y: 3 },
    ])
    vi.advanceTimersByTime(100)
    expect(parsed(latest())).toHaveLength(2)
  })
})

describe('refusing to send', () => {
  it('drops an op too large for the relay rather than sending half a room', () => {
    const connection = connect()
    // The relay drops an oversized message only after delivering it locally, so
    // sending one would reach peers on one instance and not another.
    connection.send({ type: 'sel', ids: Array.from({ length: 5000 }, (_, i) => `id-${i}`) })
    expect(latest().sent).toHaveLength(0)
  })

  it('sends nothing over a socket that is not open', () => {
    const connection = connect()
    latest().readyState = 3
    connection.send({ type: 'view', patch: { grass: false } })
    expect(latest().sent).toHaveLength(0)
  })
})

describe('editing while disconnected', () => {
  /** Take the connection down and bring it back on a fresh socket. */
  const cycle = (connection: RoomConnection, write: () => void) => {
    latest().serverClosed(1006)
    write()
    vi.advanceTimersByTime(60_000)
    latest().open()
    return connection
  }

  it('replays edits made while the socket was away', () => {
    const connection = connect()
    cycle(connection, () => {
      connection.send({ type: 'view', patch: { grass: false } })
      connection.send({ type: 'remove', entity: 'drawing', ids: ['d1'] })
    })

    // Half a minute of backoff used to mean half a minute of edits gone, with
    // nothing shown to the person who made them.
    expect(parsed(latest())).toEqual([
      { type: 'view', patch: { grass: false } },
      { type: 'remove', entity: 'drawing', ids: ['d1'] },
    ])
  })

  it('never replays presence, because a stale cursor is worse than none', () => {
    const connection = connect()
    cycle(connection, () => {
      connection.send({ type: 'cursor', x: 10, y: 10 })
      connection.send({ type: 'sel', ids: ['a'] })
      connection.send({ type: 'bench', id: 'a' })
    })

    expect(parsed(latest())).toEqual([{ type: 'bench', id: 'a' }])
  })

  it('drops the oldest when the queue fills rather than the newest', () => {
    const connection = connect()
    cycle(connection, () => {
      for (let i = 0; i < 40; i++) {
        connection.send({ type: 'remove', entity: 'drawing', ids: [`d${i}`] })
      }
    })

    // A board is edited forwards, so the tail is closest to what the person
    // actually has in front of them. The cap matches the server's own buffer
    // for messages that land before a socket has finished authenticating.
    const sent = parsed(latest())
    expect(sent).toHaveLength(32)
    expect(sent[0]).toEqual({ type: 'remove', entity: 'drawing', ids: ['d8'] })
    expect(sent.at(-1)).toEqual({ type: 'remove', entity: 'drawing', ids: ['d39'] })
  })

  it('holds nothing once the room has been left deliberately', () => {
    const connection = connect()
    latest().serverClosed(1006)
    connection.send({ type: 'view', patch: { grass: false } })
    connection.close()

    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})

describe('losing the connection', () => {
  it('reconnects after a transport close', () => {
    connect()
    latest().serverClosed(1006)
    expect(statuses.at(-1)!.status).toBe('reconnecting')

    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('backs off further each time rather than hammering a server that is down', () => {
    connect()
    const delays: number[] = []
    let elapsed = 0

    for (let attempt = 0; attempt < 4; attempt++) {
      const before = FakeSocket.instances.length
      latest().serverClosed(1006)
      // Advance until it actually retries, and record how long that took.
      let waited = 0
      while (FakeSocket.instances.length === before && waited < 60_000) {
        vi.advanceTimersByTime(100)
        waited += 100
      }
      delays.push(waited)
      elapsed += waited
    }

    expect(delays[0]).toBeLessThan(delays[3])
    expect(elapsed).toBeGreaterThan(0)
  })

  it.each([
    [4401, 'Sign in'],
    [4403, 'no longer shared'],
    [4404, 'has been deleted'],
  ])('stops retrying after a %i, which retrying cannot fix', (code, fragment) => {
    connect()
    latest().serverClosed(code)

    const last = statuses.at(-1)!
    expect(last.status).toBe('offline')
    expect(last.detail).toContain(fragment)

    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('does not reconnect after it has been closed deliberately', () => {
    const connection = connect()
    connection.close()
    latest().serverClosed(1006)
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})
