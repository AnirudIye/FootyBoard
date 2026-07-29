import { describe, expect, it } from 'vitest'
import { HOME_COLOR, AWAY_COLOR } from '../store/boardStore'

/**
 * One definition of each team colour, enforced rather than described.
 *
 * The defect these hold shut is not a wrong value, it is two values: the
 * stylesheet said one thing about the away side and the board painted another,
 * for long enough that a doc comment on the landing page asserted they matched.
 * Nothing threw, nothing looked broken in either file, and both declarations
 * were commented as colour-blind safe, so two independent arguments for the
 * same property read like agreement. The only test that catches that is one
 * that reads both ends.
 *
 * Deliberately imported from `../store/boardStore` rather than from the module
 * under test. The store is what Konva paints from, it exists in every version
 * of this tree, and going through it is what makes the assertions below
 * meaningful against the code as it was: on the unfixed tree they name
 * `tokens.css`, `boardStore.ts` and `MiniPitch.tsx` as the three places the
 * pair was spelled.
 */

/**
 * Every source file under `src/`, read through Vite rather than through
 * `node:fs`, which the app's tsconfig has no types for and should not gain any
 * for the sake of one test.
 */
const files = import.meta.glob('/src/**/*.{ts,tsx,js,jsx,css}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** A hex also reaches CSS as space separated channels, so both spellings count. */
const spellings = (hex: string) => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return [hex.toLowerCase(), channels.join(' ')]
}

const hexOf = (channels: string) =>
  '#' +
  channels
    .trim()
    .split(/\s+/)
    .map((c) => Number(c).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()

describe('team colours', () => {
  it('gives the canvas and the stylesheet the same two values', async () => {
    // Imported here rather than at the top of the file so a tree without the
    // module still runs the two assertions below it.
    const teamColors = await import('./teamColors')

    // The store re-exports the module. If it ever holds its own copy again,
    // this is the line that says so.
    expect(teamColors.HOME_COLOR).toBe(HOME_COLOR)
    expect(teamColors.AWAY_COLOR).toBe(AWAY_COLOR)

    const root = document.createElement('div')
    teamColors.applyTeamTokens(root)

    // What `bg-home` and `text-away` resolve to, against what Konva fills a
    // chip with. These are the two numbers that were allowed to drift.
    expect(hexOf(root.style.getPropertyValue('--home'))).toBe(HOME_COLOR)
    expect(hexOf(root.style.getPropertyValue('--away'))).toBe(AWAY_COLOR)
  })

  it('leaves --home and --away to the module, so no stylesheet can hold a second value', () => {
    const css = files['/src/theme/tokens.css']
    expect(css, 'tokens.css should be readable').toBeTypeOf('string')
    expect(css).not.toMatch(/--home\s*:/)
    expect(css).not.toMatch(/--away\s*:/)
  })

  it('is spelled in exactly one file', () => {
    // Comments count, which is not overreach: the claim this began from was a
    // doc comment on the landing page asserting that two colours matched, and
    // it had never been true. A colour written down anywhere it is not defined
    // goes stale silently, whether or not a compiler reads it.
    //
    // Test fixtures are exempt. A fixture carrying a team colour is asserting
    // on a stored value, not claiming to define one. Product code gets no such
    // exemption, because product code is where the copies lived.
    const exempt = (path: string) =>
      path === '/src/theme/teamColors.ts' || /\.test\.[jt]sx?$/.test(path)
    const needles = [...spellings(HOME_COLOR), ...spellings(AWAY_COLOR)]

    const copies = Object.entries(files)
      .filter(([path]) => !exempt(path))
      .flatMap(([path, text]) =>
        needles.filter((n) => text.toLowerCase().includes(n)).map((n) => `${path} spells ${n}`),
      )

    expect(copies).toEqual([])
  })
})
