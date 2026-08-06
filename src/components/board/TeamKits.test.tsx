import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import TeamKits from './TeamKits'
import { useBoardStore, AWAY_COLOR } from '../../store/boardStore'
import { SWATCHES } from './Inspector'

/**
 * The control that answers the recolouring bug.
 *
 * The store tests hold what a kit change does; these hold the two things about
 * the panel that would quietly stop being true: that it acts on the squad rather
 * than on a selection, and that what it shows as the current kit is what the
 * board says rather than what the constants say.
 */

const KIT = SWATCHES[2]
const home = (side: 'home' | 'away' = 'home') => [
  ...useBoardStore.getState().tokens.filter((t) => t.type === 'player' && t.teamId === side),
  ...useBoardStore.getState().bench.filter((t) => t.teamId === side),
]

beforeEach(() => {
  useBoardStore.getState().initDefaultBoard()
  render(<TeamKits />)
  fireEvent.click(screen.getByRole('button', { name: 'Team kits' }))
})

afterEach(cleanup)

describe('Team kits', () => {
  it('restrips the whole squad from one swatch, bench included', () => {
    fireEvent.click(screen.getByRole('button', { name: `Home kit ${KIT}` }))

    expect(home().every((t) => t.color === KIT)).toBe(true)
    expect(useBoardStore.getState().bench.some((t) => t.teamId === 'home')).toBe(true)
    // One side at a time: this is a kit, not a theme.
    expect(home('away').every((t) => t.color === AWAY_COLOR)).toBe(true)
  })

  it('takes a colour that is not in the palette', () => {
    fireEvent.change(screen.getByLabelText('Away custom kit colour'), {
      target: { value: '#123456' },
    })
    expect(home('away').every((t) => t.color === '#123456')).toBe(true)
  })

  it('shows the kit the board is in rather than the one it started in', () => {
    // The pressed state is read off `teams`, so a board loaded already
    // restripped opens with the right swatch marked — which a component holding
    // its own copy of the colour would get wrong on exactly that board.
    fireEvent.click(screen.getByRole('button', { name: `Home kit ${KIT}` }))
    expect(screen.getByRole('button', { name: `Home kit ${KIT}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('is one undo step for a whole squad', () => {
    const steps = useBoardStore.getState().history.past.length
    fireEvent.click(screen.getByRole('button', { name: `Home kit ${KIT}` }))
    expect(useBoardStore.getState().history.past.length).toBe(steps + 1)
  })
})
