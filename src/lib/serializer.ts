import type { Token, ViewSettings, Side } from './types'

/**
 * A semantic, coordinate-free description of the board for the assistant. The
 * point is that "flat back four holding a mid block" is far more useful, and
 * far cheaper in tokens, than eleven raw x/y pairs.
 */

const FORMAT_NAME: Record<ViewSettings['kind'], string> = {
  '11': '11-a-side',
  '7aside': '7-a-side',
  futsal: 'futsal',
}

interface Line {
  count: number
  x: number // average distance from own goal, 0..100
  flat: boolean // defenders roughly level across the width
}

/** Distance of a point from a team's own goal line, 0 (own goal) to 100. */
const fromOwnGoal = (x: number, side: Side) => (side === 'home' ? x : 100 - x)

/** Group a team's outfield players into lines running from defence to attack. */
function toLines(players: Token[], side: Side): Line[] {
  const sorted = [...players]
    .map((p) => ({ d: fromOwnGoal(p.x, side), y: p.y }))
    .sort((a, b) => a.d - b.d)

  const lines: Line[] = []
  let group: { d: number; y: number }[] = []
  const flush = () => {
    if (group.length === 0) return
    const avg = group.reduce((s, g) => s + g.d, 0) / group.length
    const spread = Math.max(...group.map((g) => g.d)) - Math.min(...group.map((g) => g.d))
    lines.push({ count: group.length, x: avg, flat: spread < 4 })
    group = []
  }
  for (const p of sorted) {
    if (group.length > 0 && p.d - group[group.length - 1].d > 9) flush()
    group.push(p)
  }
  flush()
  return lines
}

function blockHeight(backLineDist: number): string {
  if (backLineDist < 22) return 'a deep block'
  if (backLineDist < 34) return 'a mid block'
  return 'a high line'
}

const numberWord = (n: number): string =>
  (['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][n] ?? String(n))

export function describeTeam(tokens: Token[], side: Side): string {
  const players = tokens.filter((t) => t.type === 'player' && t.teamId === side)
  if (players.length === 0) return `${cap(side)} has no players on the pitch.`

  const keeper =
    players.find((p) => p.shape === 'keeper') ??
    [...players].sort((a, b) => fromOwnGoal(a.x, side) - fromOwnGoal(b.x, side))[0]
  const outfield = players.filter((p) => p !== keeper)
  const lines = toLines(outfield, side)
  if (lines.length === 0) return `${cap(side)} has only a goalkeeper on the pitch.`

  const shape = lines.map((l) => l.count).join('-')
  const back = lines[0]
  const forwards = lines[lines.length - 1]

  const backPhrase = `${back.flat ? 'a flat ' : 'a '}back ${numberWord(back.count)}`
  const heightPhrase = blockHeight(back.x)
  const forwardPhrase =
    forwards.count === 1 ? 'a lone striker' : `${numberWord(forwards.count)} forward${forwards.count > 1 ? 's' : ''}`

  return `${cap(side)} are in a ${shape} with ${backPhrase} holding ${heightPhrase}, ${forwardPhrase} up top.`
}

export function describeBoard(tokens: Token[], view: ViewSettings): string {
  const parts = [`This is an ${FORMAT_NAME[view.kind]} board.`]
  parts.push(describeTeam(tokens, 'home'))
  parts.push(describeTeam(tokens, 'away'))
  const props = tokens.filter((t) => !['player', 'ball'].includes(t.type))
  if (props.length > 0) parts.push(`There are ${props.length} training props on the pitch.`)
  return parts.join(' ')
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
