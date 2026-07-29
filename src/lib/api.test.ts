import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { api } from './api'
import { AppError, ConflictError } from './errors'

/**
 * What actually goes on the wire, asserted as the wire sees it.
 *
 * Every other test in this repo mocks `api`, which is right for what those tests
 * are about and leaves one thing uncovered: the field names themselves. Rename
 * `baseGeneration` to `base` here and all 388 of them still pass, while every
 * save in the running product answers 400 and no board is ever written again.
 *
 * That is the exact shape of defect this repo keeps finding — a claim about a
 * second file that nobody checked against the second file — and the server side
 * of this contract is pinned by `server/src/boardConcurrency.test.js`, which
 * posts these same three body shapes to a real Postgres-backed instance. The two
 * files meet at a literal, not at somebody's reading of one.
 */

const fetchMock = vi.fn()

/** The parsed body of the last request made. */
const sentBody = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body)
const sentTo = () => fetchMock.mock.calls.at(-1)![0]
const sentMethod = () => fetchMock.mock.calls.at(-1)![1].method

const answers = (status: number, payload: unknown) =>
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  answers(200, { board: { id: 'b1', name: 'B', generation: 4 } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('saving a board', () => {
  const DATA = { version: 9, tokens: [] }

  it('names the base generation and the replacing flag exactly as the server reads them', async () => {
    await api.saveBoard('b1', 'Board', DATA, 3, true)

    expect(sentMethod()).toBe('PUT')
    expect(sentTo()).toBe('/api/boards/b1')
    expect(sentBody()).toEqual({
      name: 'Board',
      data: DATA,
      baseGeneration: 3,
      replacing: true,
    })
  })

  it('sends no name at all when the caller does not know one', async () => {
    // Not `name: null`. The server treats an absent name as "leave the title
    // alone", and a client that guessed used to write its guess over the
    // owner's title on the next autosave.
    await api.saveBoard('b1', null, DATA, 3, false)

    expect(sentBody()).toEqual({ data: DATA, baseGeneration: 3, replacing: false })
    expect('name' in sentBody()).toBe(false)
  })

  it('hands back the generation the write landed on', async () => {
    const { board } = await api.saveBoard('b1', null, DATA, 3, false)

    expect(board.generation).toBe(4)
  })

  it('turns a refusal into a ConflictError carrying where the board actually is', async () => {
    // The one 4xx here that is answered by re-reading rather than by showing
    // somebody a message, so the save path has to be able to tell it apart
    // without reading prose.
    answers(409, { error: 'This board was changed somewhere else.', generation: 11 })

    await expect(api.saveBoard('b1', null, DATA, 3, false)).rejects.toBeInstanceOf(ConflictError)
    await expect(api.saveBoard('b1', null, DATA, 3, false)).rejects.toMatchObject({
      generation: 11,
    })
  })

  it('leaves every other failure an ordinary AppError', async () => {
    answers(400, { error: 'That board is not in a format this version can save.' })

    const failure = await api.saveBoard('b1', null, DATA, 3, false).catch((e) => e)
    expect(failure).toBeInstanceOf(AppError)
    expect(failure).not.toBeInstanceOf(ConflictError)
  })
})

describe('reading a board', () => {
  it('carries the generation back beside the contents', async () => {
    // Read from the same response as the data, because "these contents" and
    // "which lineage they are on" are one fact: fetched apart they could
    // disagree, and the base of every later write comes from this.
    answers(200, { board: { id: 'b1', name: 'B', data: { version: 9 }, generation: 6 } })

    const { board } = await api.getBoard<{ version: number }>('b1')

    expect(board.generation).toBe(6)
  })
})
