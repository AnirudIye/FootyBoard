/**
 * The two team colours, said once for the canvas and for the stylesheet.
 *
 * They used to be said twice. `tokens.css` declared `--home: 232 92 66` and
 * `--away: 82 154 224`, commented "still separable on a dark ground, still
 * colour-blind safe"; the board store declared `#B4432E` and `#2C5B8A`,
 * commented "muted, colour-blind-safe team pair, deliberately not neon". Both
 * comments were written in good faith and neither author knew the other pair
 * existed, which is exactly why it survived: two independent arguments for
 * colour-blind safety read like agreement. A third copy sat in `MiniPitch.tsx`.
 * On the landing page the divergence rendered sixty pixels apart, a bright
 * legend dot directly above the muted chip it was labelling.
 *
 * **The muted pair won.** Three reasons, in the order they matter.
 *
 * 1. **Every saved board already contains it.** A board stores a colour per
 *    token, so the constants describe new boards and nothing else. Moving them
 *    to the bright pair would not have recoloured one existing board; it would
 *    have split the estate in two, and worse, `switchPlayerTeam` would then
 *    paint a bright chip into a muted board, putting the divergence *inside* a
 *    single team where no reconciliation could reach it. The muted pair agrees
 *    with the data that exists, so there is nothing to migrate.
 * 2. **It is what the product already looks like.** The board, the toolbar's
 *    team dots, the inspector's team switch and swatches, and the landing
 *    page's own live board all paint it. The bright pair reached two 8px legend
 *    dots and one cursor in a feature diagram.
 * 3. **The bright pair was never reasoned about as a chip.** It was chosen as a
 *    swatch on a near-black ground, which it is good at. A chip is a ground in
 *    its own right, carrying a shirt number: `MiniPitch` writes that number in
 *    hard-coded near-white, which reads 5.28:1 and 6.72:1 on the muted pair and
 *    3.31:1 and 2.83:1 on the bright one, and `PlayerChip.pickText` would have
 *    flipped every number on the real board from near-white to near-black,
 *    since both bright colours sit above its 0.18 luminance threshold.
 *
 * What the muted pair costs, stated plainly rather than left to be discovered:
 * against `--paper` the legend dots drop from 5.71:1 to 3.58:1 (home) and from
 * 6.67:1 to 2.81:1 (away), so the away dot lands just under the 3:1 that
 * WCAG 1.4.11 asks of meaningful non-text. Both marks are echoes rather than
 * carriers: the dot sits beside a mono label that already names the formation,
 * and the diagram's meaning is carried by its accent-coloured half. Chips are
 * read on turf, not on paper, and turf is what the pair was chosen for.
 *
 * The alarm the save indicator used to borrow from `--home` is `--alert` now,
 * and it kept the bright value. That split had to land first, or reconciling
 * the teams would have darkened "Not saved" and "Not saving" by proxy.
 */

/**
 * Space separated RGB channels, the way every colour in `tokens.css` is stored
 * so that Tailwind's opacity modifiers resolve (`bg-home/60`).
 *
 * **This is the definition.** Everything below is derived from it, and nothing
 * anywhere else may spell either value. `teamColors.test.ts` walks the source
 * tree and fails on a second copy, because a second copy is the whole of the
 * defect this file exists to close.
 */
const CHANNELS = {
  home: '180 67 46',
  away: '44 91 138',
} as const

const toHex = (channels: string) =>
  '#' +
  channels
    .trim()
    .split(/\s+/)
    .map((c) => Number(c).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()

/** What Konva fills a chip with, and what a saved board records. */
export const HOME_COLOR = toHex(CHANNELS.home)
export const AWAY_COLOR = toHex(CHANNELS.away)

/**
 * Hand the same two values to CSS.
 *
 * The direction is forced rather than chosen. `handoff.md` says colour lives in
 * `tokens.css` and should be consumed rather than added, which argues for the
 * stylesheet being canonical, but Konva paints to a canvas and cannot read a
 * custom property. Resolving one at runtime with `getComputedStyle` would make
 * the store's constants depend on a stylesheet having loaded, which is not true
 * in jsdom, is not true before first paint, and would need a hard-coded
 * fallback: a second definition, wearing the word "fallback".
 *
 * So the module holds the pair and publishes it. An inline property on `:root`
 * outranks any stylesheet rule, `main.tsx` calls this before the first render,
 * and there is no server-rendered markup to be caught mid-flight.
 */
export function applyTeamTokens(root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--home', CHANNELS.home)
  root.style.setProperty('--away', CHANNELS.away)
}
