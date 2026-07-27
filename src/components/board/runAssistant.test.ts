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

const lastReply = () => {
  const { messages } = useAssistantStore.getState()
  return [...messages].reverse().find((m) => m.role === 'assistant')?.text ?? ''
}

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
