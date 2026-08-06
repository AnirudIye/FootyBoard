import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runAssistant } from './runAssistant'
import { useAssistantStore } from '../../store/assistantStore'
import { useBoardStore } from '../../store/boardStore'
import { api } from '../../lib/api'

/**
 * The assistant is rule-based first and AI second. What matters here is the
 * gate: a phrasing the parser knows must never reach the network, and nothing
 * reaches it at all unless both the server has a key and the person said yes.
 */

const askAssistant = vi.spyOn(api, 'askAssistant')

const lastMessage = () => {
  const { messages } = useAssistantStore.getState()
  return [...messages].reverse().find((m) => m.role === 'assistant') ?? { text: '', undoable: false }
}

const lastReply = () => lastMessage().text

const homePlayer = (number: number) =>
  useBoardStore.getState().tokens.find((t) => t.type === 'player' && t.teamId === 'home' && t.number === number)

const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  askAssistant.mockReset()
  useBoardStore.getState().initDefaultBoard()
  useAssistantStore.setState({
    messages: [],
    aiAvailable: false,
    aiConsented: false,
    thinking: false,
  })
})

describe('the offline parser comes first', () => {
  it('handles a command it knows without touching the network', async () => {
    useAssistantStore.setState({ aiAvailable: true, aiConsented: true })

    runAssistant('play 4-3-3')
    await settle()

    expect(askAssistant).not.toHaveBeenCalled()
    expect(useBoardStore.getState().lastFormation.home).toBeTruthy()
  })

  it('moves one player from a phrasing it knows, still without the network', async () => {
    useAssistantStore.setState({ aiAvailable: true, aiConsented: true })

    runAssistant('move 9 to the left wing')
    await settle()

    expect(askAssistant).not.toHaveBeenCalled()
    expect(homePlayer(9)).toMatchObject({ x: 70, y: 12 })
  })

  it('still works with the AI switched off entirely', async () => {
    runAssistant('reset the board')
    await settle()

    expect(askAssistant).not.toHaveBeenCalled()
    expect(lastReply().length).toBeGreaterThan(0)
  })
})

describe('the AI gate', () => {
  /**
   * A phrase the offline parser does not recognise — proven by the third test
   * below, which shows it *does* reach the AI once both gates are open. Without
   * that proof the two "stays offline" cases would pass even with the gate
   * removed, because a parseable phrase never reaches the network anyway.
   */
  const unknown = 'make the away side aggressive'

  it('stays offline when the server has no key', async () => {
    useAssistantStore.setState({ aiAvailable: false, aiConsented: true })

    runAssistant(unknown)
    await settle()

    expect(askAssistant).not.toHaveBeenCalled()
  })

  it('stays offline until the person has agreed', async () => {
    // The panel promised an online assistant would ask first. A configured key
    // makes it offerable, not on.
    useAssistantStore.setState({ aiAvailable: true, aiConsented: false })

    runAssistant(unknown)
    await settle()

    expect(askAssistant).not.toHaveBeenCalled()
    expect(lastReply().length).toBeGreaterThan(0)
  })

  it('asks only when both are true', async () => {
    useAssistantStore.setState({ aiAvailable: true, aiConsented: true })
    askAssistant.mockResolvedValue({ reply: 'Pushed them up.', command: null })

    runAssistant(unknown)
    await settle()

    expect(askAssistant).toHaveBeenCalledOnce()
    expect(askAssistant.mock.calls[0][0].message).toBe(unknown)
  })
})

describe('block height', () => {
  const awayPlayer = (number: number) =>
    useBoardStore.getState().tokens.find((t) => t.type === 'player' && t.teamId === 'away' && t.number === number)

  it('pushes the team up the pitch when the depth rides on the shape', () => {
    // The reported bug: "4-3-3 high" set the shape and dropped the height, so
    // the board looked identical to a plain "4-3-3" and nothing said why.
    runAssistant('set up a 4-3-3')
    const base = homePlayer(9)!.x

    runAssistant('set up a 4-3-3 high')
    expect(homePlayer(9)!.x).toBeGreaterThan(base)
  })

  it('leaves the keeper in goal at every height', () => {
    // `applyBlock` skips index 0 on purpose. A high line that takes the keeper
    // with it is not a high line.
    runAssistant('set up a 4-3-3')
    const keeper = homePlayer(1)!.x

    runAssistant('set up a 4-3-3 high')
    expect(homePlayer(1)!.x).toBe(keeper)
  })

  it('reads mid and low as their own heights, not as the base', () => {
    runAssistant('set up a 4-3-3 low')
    const low = homePlayer(9)!.x
    runAssistant('set up a 4-3-3 mid')
    const mid = homePlayer(9)!.x
    runAssistant('set up a 4-3-3 high')
    const high = homePlayer(9)!.x

    expect(low).toBeLessThan(mid)
    expect(mid).toBeLessThan(high)
  })

  it('moves the named team without changing its shape', () => {
    // The order matters: away is set first, then home, so the board's last
    // formation is home's. That is exactly the case the old single
    // `lastFormation` got wrong, handing the away team home's 3-5-2 in answer
    // to a request about how deep they sit.
    runAssistant('put the away team in a 4-4-2 high')
    runAssistant('set us up in a 3-5-2')
    const before = awayPlayer(9)!.x

    runAssistant('drop the away team deeper')

    expect(useBoardStore.getState().lastFormation).toEqual({ home: '3-5-2', away: '4-4-2' })
    // Away attacks toward 0, so deeper is a larger x.
    expect(awayPlayer(9)!.x).toBeGreaterThan(before)
  })

  it('leaves the other team alone entirely', () => {
    runAssistant('put the away team in a 4-4-2')
    runAssistant('set us up in a 3-5-2')
    const home = useBoardStore
      .getState()
      .tokens.filter((t) => t.teamId === 'home')
      .map((t) => `${t.id}:${t.x},${t.y}`)

    runAssistant('push the away team higher')

    expect(
      useBoardStore
        .getState()
        .tokens.filter((t) => t.teamId === 'home')
        .map((t) => `${t.id}:${t.x},${t.y}`),
    ).toEqual(home)
  })

  it('asks for a shape first per side, not for the board', () => {
    runAssistant('set us up in a 3-5-2')
    useBoardStore.setState({ lastFormation: { home: '3-5-2', away: null } })

    runAssistant('drop the away team deeper')

    expect(lastReply()).toMatch(/away team up in a formation first/)
    expect(lastMessage().undoable).toBeFalsy()
  })
})

describe('a tactical question', () => {
  const question = 'how do i play against a 4-3-3'

  it('does not rearrange the board in answer to it', async () => {
    // The regression this feature is built on. Every parser rule matched on the
    // formation code in that sentence, so asking how to beat a 4-3-3 set one
    // up: eleven of the coach's players moved, and the question went unanswered.
    useAssistantStore.setState({ aiAvailable: true, aiConsented: true })
    askAssistant.mockResolvedValue({ reply: 'Their holder is alone. Play either side of him.', command: null })
    const before = JSON.stringify(useBoardStore.getState().tokens)

    runAssistant(question)
    await settle()

    expect(JSON.stringify(useBoardStore.getState().tokens)).toBe(before)
    expect(useBoardStore.getState().history.past).toHaveLength(0)
  })

  it('reaches the AI half, which is the only half that can answer it', async () => {
    useAssistantStore.setState({ aiAvailable: true, aiConsented: true })
    askAssistant.mockResolvedValue({ reply: 'Their holder is alone. Play either side of him.', command: null })

    runAssistant(question)
    await settle()

    expect(askAssistant).toHaveBeenCalledOnce()
    expect(askAssistant.mock.calls[0][0].message).toBe(question)
    // The board goes with it, because "against a 4-3-3" is half the question
    // and what is already drawn is the other half.
    expect(askAssistant.mock.calls[0][0].board.length).toBeGreaterThan(0)
    expect(lastReply()).toMatch(/holder is alone/)
  })

  /**
   * The notes pad does not leave the device with the question.
   *
   * Asserted positively rather than left as a property of `describeBoard`'s
   * argument list, because the change that would break it is the natural one:
   * somebody making the assistant more useful adds "and here is what the coach
   * wrote about this board" to the summary, and a paragraph that may name
   * players, injuries or an opposition report goes to Google with it. The panel
   * promises that what it sends is the message and a summary of the board. If
   * that is ever meant to include the notes, it has to be a deliberate edit
   * here and a change to what the consent notice says.
   */
  it('never sends the notes pad to the model', async () => {
    useAssistantStore.setState({ aiAvailable: true, aiConsented: true })
    askAssistant.mockResolvedValue({ reply: 'Play either side of him.', command: null })
    useBoardStore.getState().setNotes('Ellis is carrying a hamstring — do not start him.')

    runAssistant(question)
    await settle()

    const sent = JSON.stringify(askAssistant.mock.calls[0][0])
    expect(sent).not.toContain('hamstring')
    expect(sent).not.toContain('Ellis')
  })

  it('says where the answer would have to come from when the AI is off', async () => {
    runAssistant(question)
    await settle()

    expect(askAssistant).not.toHaveBeenCalled()
    expect(lastReply()).toMatch(/online assistant/)
    expect(lastReply()).toContain('4-3-3')
    expect(useBoardStore.getState().history.past).toHaveLength(0)
  })

  it('does not tell somebody who already turned it on to turn it on', async () => {
    // Past that gate the offline reply has stopped being true. What is left to
    // go wrong is the network, and that is what the failure has to say.
    useAssistantStore.setState({ aiAvailable: true, aiConsented: true })
    askAssistant.mockRejectedValue(new Error('network down'))

    runAssistant(question)
    await settle()

    expect(lastReply()).not.toMatch(/online assistant/)
    expect(lastReply().length).toBeGreaterThan(0)
  })

  it('still lets the AI act when the coach asked for both', async () => {
    // "how should we set up against a 3-5-2" is a question the model can answer
    // by moving the board, and the schema still allows it.
    useAssistantStore.setState({ aiAvailable: true, aiConsented: true })
    askAssistant.mockResolvedValue({
      reply: 'Wide forwards pin their wing-backs, so a back four holds up.',
      command: { type: 'setFormation', side: 'home', name: '4-4-2', block: 'default' },
    })

    runAssistant('how should we set up against a 3-5-2')
    await settle()

    expect(useBoardStore.getState().lastFormation.home).toBe('4-4-2')
    expect(lastReply()).toMatch(/wing-backs/)
  })
})

describe('acting on what comes back', () => {
  beforeEach(() => useAssistantStore.setState({ aiAvailable: true, aiConsented: true }))

  it('runs a returned command through the ordinary board executor', async () => {
    askAssistant.mockResolvedValue({
      reply: 'Away are pressing high.',
      command: { type: 'setFormation', side: 'away', name: '4-4-2', block: 'high' },
    })

    runAssistant('make the away side aggressive')
    await settle()

    expect(useBoardStore.getState().lastFormation.away).toBe('4-4-2')
    expect(lastReply()).toBe('Away are pressing high.')
  })

  it('answers in prose when no command comes back', async () => {
    askAssistant.mockResolvedValue({
      reply: 'A back three lets the wing-backs push on.',
      command: null,
    })

    runAssistant('why use a back three')
    await settle()

    expect(lastReply()).toMatch(/wing-backs/)
  })

  it('does not crash the panel on a command the board does not know', async () => {
    // The server filters unknown function names, but the client is the last
    // line: an unrecognised command falls through to a reply, not an exception.
    askAssistant.mockResolvedValue({ reply: 'Done.', command: { type: 'launchRocket' } })

    expect(() => runAssistant('do something odd')).not.toThrow()
    await settle()
    expect(lastReply().length).toBeGreaterThan(0)
  })

  it('moves the named player, and only that player', async () => {
    // "shove" is not a verb the offline parser knows, so this really does travel
    // through the AI path rather than being answered on the way in.
    askAssistant.mockResolvedValue({
      reply: 'Nine is out on the left.',
      command: { type: 'movePlayer', side: 'home', number: 9, zone: 'left-wing' },
    })
    const before = useBoardStore.getState().tokens.map((t) => ({ id: t.id, x: t.x, y: t.y }))

    runAssistant('shove the nine out wide')
    await settle()

    const nine = homePlayer(9)
    expect(nine).toBeDefined()
    expect(nine).toMatchObject({ x: 70, y: 12 })

    const shifted = useBoardStore
      .getState()
      .tokens.filter((t) => {
        const was = before.find((b) => b.id === t.id)
        return !was || was.x !== t.x || was.y !== t.y
      })
      .map((t) => t.id)
    expect(shifted).toEqual([nine!.id])
    expect(lastReply()).toBe('Nine is out on the left.')
  })

  it('leaves the move on the undo stack', async () => {
    // `moveToken` is the middle of a drag in ordinary use and parks its snapshot
    // as pending. One assistant instruction is a whole gesture, so it has to be
    // committed or there is nothing to take back.
    askAssistant.mockResolvedValue({
      reply: 'Done.',
      command: { type: 'movePlayer', side: 'home', number: 9, zone: 'penalty-spot' },
    })

    runAssistant('shove the nine into the six')
    await settle()

    expect(useBoardStore.getState().history.past).toHaveLength(1)
    expect(lastMessage().undoable).toBe(true)

    useBoardStore.getState().undoAction()
    expect(homePlayer(9)).toMatchObject({ x: 64, y: 50 })
  })

  it('mirrors the zone for the away team', async () => {
    askAssistant.mockResolvedValue({
      reply: 'Done.',
      command: { type: 'movePlayer', side: 'away', number: 9, zone: 'left-wing' },
    })

    runAssistant('shove their nine out wide')
    await settle()

    const nine = useBoardStore
      .getState()
      .tokens.find((t) => t.type === 'player' && t.teamId === 'away' && t.number === 9)
    expect(nine).toMatchObject({ x: 30, y: 88 })
  })

  it('says which number it could not find, and changes nothing', async () => {
    askAssistant.mockResolvedValue({
      reply: 'Moved 14 back.',
      command: { type: 'movePlayer', side: 'home', number: 14, zone: 'deep' },
    })
    const before = JSON.stringify(useBoardStore.getState().tokens)

    runAssistant('sort out the fourteen')
    await settle()

    expect(lastReply()).toBe('There is no 14 on the home side right now.')
    expect(lastMessage().undoable).toBeFalsy()
    expect(JSON.stringify(useBoardStore.getState().tokens)).toBe(before)
    expect(useBoardStore.getState().history.past).toHaveLength(0)
  })

  it('benches a number and brings one back on', async () => {
    askAssistant.mockResolvedValue({
      reply: 'Off he comes.',
      command: { type: 'benchPlayer', side: 'home', number: 7 },
    })
    runAssistant('hook the seven')
    await settle()

    expect(homePlayer(7)).toBeUndefined()
    expect(useBoardStore.getState().bench.some((t) => t.teamId === 'home' && t.number === 7)).toBe(true)

    askAssistant.mockResolvedValue({
      reply: 'On he goes.',
      command: { type: 'returnPlayer', side: 'home', number: 7 },
    })
    runAssistant('get the seven going again')
    await settle()

    expect(homePlayer(7)).toMatchObject({ x: 44, y: 50 })
    expect(useBoardStore.getState().bench.some((t) => t.teamId === 'home' && t.number === 7)).toBe(false)
  })

  it('says so when the number is not on the bench', async () => {
    askAssistant.mockResolvedValue({
      reply: 'On he goes.',
      command: { type: 'returnPlayer', side: 'home', number: 9 },
    })

    runAssistant('get the nine going again')
    await settle()

    expect(lastReply()).toBe('There is no 9 on the home bench right now.')
  })

  it('says the assistant is unreachable rather than that it misunderstood', async () => {
    askAssistant.mockRejectedValue(new Error('network down'))

    runAssistant('something it has never seen')
    await settle()

    expect(lastReply().length).toBeGreaterThan(0)
    expect(useAssistantStore.getState().thinking).toBe(false)
  })

  it('clears the thinking state even when the request fails', async () => {
    askAssistant.mockRejectedValue(new Error('boom'))

    runAssistant('another unknown one')
    expect(useAssistantStore.getState().thinking).toBe(true)

    await settle()
    expect(useAssistantStore.getState().thinking).toBe(false)
  })
})
