import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import Notes from './Notes'
import Assistant from './Assistant'
import { useNotesStore } from '../../store/notesStore'
import { useAssistantStore } from '../../store/assistantStore'
import { useBoardStore } from '../../store/boardStore'
import { useRealtimeStore } from '../../store/realtimeStore'
import { MAX_NOTES } from '../../lib/persistence'

/**
 * The pad as somebody meets it.
 *
 * The store tests hold what a note *is*; these hold the four things about the
 * panel that would be wrong in ways nobody notices until it matters: that what
 * is typed reaches the board rather than a local `useState`, that the cap is
 * announced before it is hit, that a locked-out member can read the team talk
 * and not rewrite it, and that closing the pad ends the undo step it opened.
 */

// The assistant asks the server whether an AI key is configured the first time
// it is opened. Stubbed so the pair test does not reach for the network.
vi.mock('../../lib/api', () => ({
  api: { assistantStatus: vi.fn().mockResolvedValue({ enabled: false }) },
}))

// jsdom implements no scrolling of any kind, and the assistant scrolls its
// transcript to the bottom whenever it opens.
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}

const field = () => screen.getByRole('textbox', { name: /board notes/i })
const launcher = () => screen.getByRole('button', { name: /notes/i })

beforeEach(() => {
  // jsdom has no `matchMedia` at all, and `Assistant` asks it about reduced
  // motion on its first render.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  useBoardStore.getState().initDefaultBoard()
  useNotesStore.setState({ open: false, expanded: false })
  useAssistantStore.setState({ open: false })
  useRealtimeStore.setState({ locked: false })
})

afterEach(cleanup)

describe('Notes', () => {
  it('opens from its launcher and puts what is typed on the board', () => {
    render(<Notes />)
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.click(launcher())
    fireEvent.change(field(), { target: { value: 'Press high in the first fifteen' } })

    expect(useBoardStore.getState().notes).toBe('Press high in the first fifteen')
    // And it is the board's, not the panel's: the pad reads back from the store.
    expect(field()).toHaveValue('Press high in the first fifteen')
  })

  it('shows what the board already carries when it is reopened', () => {
    useBoardStore.getState().setNotes('Set piece: near post')
    render(<Notes />)
    fireEvent.click(launcher())
    expect(field()).toHaveValue('Set piece: near post')
  })

  it('counts down to the cap and stops the field at it', () => {
    render(<Notes />)
    fireEvent.click(launcher())

    fireEvent.change(field(), { target: { value: 'x'.repeat(1900) } })
    expect(screen.getByText(`1900/${MAX_NOTES}`)).toBeInTheDocument()

    // `maxLength` is what a browser enforces while typing; the store is what
    // enforces it for a paste, and the two have to agree on the number.
    expect(field()).toHaveAttribute('maxLength', String(MAX_NOTES))
    fireEvent.change(field(), { target: { value: 'x'.repeat(MAX_NOTES + 50) } })
    expect(useBoardStore.getState().notes).toHaveLength(MAX_NOTES)
    expect(screen.getByText('Full')).toBeInTheDocument()
  })

  it('expands and shrinks, and says which it is', () => {
    render(<Notes />)
    fireEvent.click(launcher())

    const expand = screen.getByRole('button', { name: 'Expand' })
    expect(expand).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(expand)

    const shrink = screen.getByRole('button', { name: 'Shrink' })
    expect(shrink).toHaveAttribute('aria-pressed', 'true')
    expect(useNotesStore.getState().expanded).toBe(true)
  })

  /**
   * Instructor mode. Notes are board content, so the lock reaches them exactly
   * as it reaches a chip — and read-only rather than hidden, because locking
   * editing is not a reason to take the team talk off somebody's screen.
   */
  it('is readable and not writable while the board is locked', () => {
    useBoardStore.getState().setNotes('Do not move')
    useRealtimeStore.setState({ locked: true })
    render(<Notes />)
    fireEvent.click(launcher())

    expect(field()).toHaveValue('Do not move')
    expect(field()).toHaveAttribute('readOnly')
    expect(screen.getByText('VIEW ONLY')).toBeInTheDocument()
  })

  it('closes the undo step when the pad is put away', () => {
    render(<Notes />)
    fireEvent.click(launcher())

    const before = useBoardStore.getState().history.past.length
    fireEvent.change(field(), { target: { value: 'Half time' } })
    // Deferred: the run is still open, so nothing is on the stack yet.
    expect(useBoardStore.getState().history.past.length).toBe(before)

    fireEvent.click(screen.getByRole('button', { name: /collapse notes/i }))
    expect(useNotesStore.getState().open).toBe(false)
    expect(useBoardStore.getState().history.past.length).toBe(before + 1)
    expect(useBoardStore.getState()._pending).toBe(null)
  })

  /**
   * Two 300px panels cannot share the corner of a 375px phone, so opening one
   * puts the other away. Both directions, because the rule is only worth
   * anything if it holds whichever pill gets pressed — and the two are
   * implemented in two files, which is exactly how one of them gets missed.
   */
  it('puts the assistant away when it opens', () => {
    useAssistantStore.setState({ open: true })
    render(<Notes />)
    fireEvent.click(launcher())

    expect(useNotesStore.getState().open).toBe(true)
    expect(useAssistantStore.getState().open).toBe(false)
  })

  it('is put away by the assistant opening', () => {
    render(
      <>
        <Notes />
        <Assistant />
      </>,
    )
    fireEvent.click(launcher())
    expect(useNotesStore.getState().open).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /^assistant$/i }))
    expect(useAssistantStore.getState().open).toBe(true)
    expect(useNotesStore.getState().open).toBe(false)
  })

  it('leaves the pad alone when the assistant is only being collapsed', () => {
    // The collapse button uses the plain toggle. If it went through the opening
    // path, closing the assistant would close a pad somebody had just opened —
    // which cannot happen while they are exclusive, and would the day they are
    // not, in a file nobody would think to look in.
    useAssistantStore.setState({ open: true })
    render(
      <>
        <Notes />
        <Assistant />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: /collapse assistant/i }))

    expect(useAssistantStore.getState().open).toBe(false)
    expect(useNotesStore.getState().open).toBe(false)
  })
})
