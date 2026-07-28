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
    expect(useBoardStore.getState().lastFormation).toBeTruthy()
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

describe('acting on what comes back', () => {
  beforeEach(() => useAssistantStore.setState({ aiAvailable: true, aiConsented: true }))

  it('runs a returned command through the ordinary board executor', async () => {
    askAssistant.mockResolvedValue({
      reply: 'Away are pressing high.',
      command: { type: 'setFormation', side: 'away', name: '4-4-2', block: 'high' },
    })

    runAssistant('make the away side aggressive')
    await settle()

    expect(useBoardStore.getState().lastFormation).toBe('4-4-2')
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
