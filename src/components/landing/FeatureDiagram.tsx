/**
 * The six marks in the "What it does" section.
 *
 * These are diagrams, not icons. Each one is drawn in the vocabulary the board
 * itself uses — chalk markings on a dark ground, accent chips, a dashed
 * selection marquee, a run arrow with a head — so the section reads as six
 * views of one product rather than six picks from an icon set. That is what
 * the section's whole budget went on: the pictures now carry the grouping that
 * six mono labels used to announce.
 *
 * **Every stroke is `non-scaling-stroke`, and that is the load-bearing detail.**
 * Formations renders at 440px and the two notes beside it at 124px, so a stroke
 * width in user units would come out at 5px on one and 1.4px on the other, and
 * the set would stop looking like one hand drew it. Taking the strokes out of
 * the scale makes the weight a constant of the drawing system rather than a
 * function of how much room the cell had. Fills still scale, which is right:
 * a chip is a thing in the drawing, a line is the pen.
 *
 * Colour comes from Tailwind's token classes rather than literals: chalk is
 * `currentColor` inherited from the root `<svg>`, anything the diagram is
 * actually about is wrapped in `text-accent`, and the second person in "Rooms"
 * is `text-away`.
 *
 * **That last claim used to end "the same blue the away team wears two sections
 * down", and it was false the whole time it was written down.** `text-away`
 * resolved to a bright sky blue while the away team was painted a dark navy,
 * because the token and the board's own constant were two separate
 * declarations that had never been compared. It is true now, and true by
 * construction rather than by inspection: both ends read
 * `src/theme/teamColors.ts`, and a test fails on a second spelling of either
 * colour anywhere under `src/`, which is why this paragraph describes them and
 * does not name them. The cursor here is therefore the navy the away side has
 * always actually worn.
 *
 * Static on purpose. `.mini-line`'s draw-on fires on mount, and these mount
 * with the page rather than when they are scrolled to, so a draw-on would have
 * finished long before anyone reached the section. The entrance these get is
 * the one <Reveal> already gives them.
 */

export type DiagramName = 'formations' | 'assistant' | 'canvas' | 'frames' | 'rooms' | 'sharing'

/** One pen, used by every stroke in all six. */
const pen = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  vectorEffect: 'non-scaling-stroke' as const,
}

/** Dashes are in the same unscaled space as the stroke, so these are px. */
const DASH = '2 4'

const CHIP = 3.2

/** A live cursor with its name pill, tip at (x, y). */
function PeerCursor({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path
        d="M0 0 L0 11 L2.9 8.3 L4.8 12.6 L6.6 11.8 L4.7 7.6 L8.2 7.6 Z"
        fill="currentColor"
        stroke="rgb(var(--paper))"
        strokeWidth={1}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <rect x={8.5} y={5.5} width={11} height={4} rx={2} fill="currentColor" opacity={0.7} />
    </g>
  )
}

function Chips({ at }: { at: [number, number][] }) {
  return (
    <g fill="currentColor">
      {at.map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={CHIP} />
      ))}
    </g>
  )
}

export function FeatureDiagram({ name, className = '' }: { name: DiagramName; className?: string }) {
  return (
    <svg viewBox="0 0 120 68" className={`text-ink/50 ${className}`} aria-hidden fill="none">
      {name === 'formations' && (
        <>
          {/* An attacking-half view: goal at the left, the halfway arc at the right. */}
          <rect {...pen} x={4} y={4} width={112} height={60} rx={1.5} />
          <rect {...pen} x={4} y={16} width={20} height={36} />
          <rect {...pen} x={4} y={26} width={7} height={16} />
          <path {...pen} d="M116 24 A 10 10 0 0 0 116 44" />

          <g className="text-accent">
            {/* Two banks of four is what makes a 4-4-2 a 4-4-2, so they are drawn. */}
            <path {...pen} strokeDasharray={DASH} opacity={0.5} d="M36 12 V56" />
            <path {...pen} strokeDasharray={DASH} opacity={0.5} d="M68 12 V56" />
            <circle {...pen} cx={13} cy={34} r={5.4} opacity={0.5} />
            <Chips
              at={[
                [13, 34],
                [36, 12],
                [36, 26],
                [36, 42],
                [36, 56],
                [68, 12],
                [68, 26],
                [68, 42],
                [68, 56],
                [98, 24],
                [98, 44],
              ]}
            />
          </g>
        </>
      )}

      {name === 'assistant' && (
        <>
          {/* What you typed is chalk, what the board did is accent. Drawing
              both in the accent made the sentence and the arrow read as one
              dashed line, which is the opposite of the point. */}
          <path {...pen} d="M5 27 L10.5 34 L5 41" />
          <path {...pen} d="M16 34 H28" />
          <path {...pen} d="M31.5 34 H40" />
          <path {...pen} d="M43.5 34 H50" />

          <g className="text-accent">
            {/* A run arrow, because that is how this board says "becomes". */}
            <path {...pen} d="M56 34 H68" />
            <path {...pen} d="M63.5 30 L68 34 L63.5 38" />
            {/* Two banks and a tip: the same grammar the formations mark uses,
                so the thing the sentence turned into is legibly a shape. */}
            <path {...pen} strokeDasharray={DASH} opacity={0.45} d="M78 16 V52" />
            <path {...pen} strokeDasharray={DASH} opacity={0.45} d="M95 25 V43" />
            <Chips
              at={[
                [78, 16],
                [78, 34],
                [78, 52],
                [95, 25],
                [95, 43],
                [111, 34],
              ]}
            />
          </g>
        </>
      )}

      {name === 'canvas' && (
        <>
          <rect {...pen} x={4} y={6} width={72} height={56} rx={1.5} />
          <path {...pen} d="M40 6 V62" />
          <circle {...pen} cx={40} cy={34} r={8} />
          <rect {...pen} x={4} y={20} width={11} height={28} />

          {/* Off the touchline entirely, still selected, still waiting. */}
          <g className="text-accent">
            <rect {...pen} strokeDasharray={DASH} opacity={0.55} x={84} y={12} width={32} height={44} rx={2} />
            <Chips
              at={[
                [93, 23],
                [107, 23],
                [100, 45],
              ]}
            />
            <path {...pen} opacity={0.6} d="M94 28 L99 39" />
            <path {...pen} opacity={0.6} d="M95.5 34.5 L99.5 40 L103 36.5" />
          </g>
        </>
      )}

      {name === 'frames' && (
        <>
          <rect {...pen} x={5} y={14} width={33} height={40} rx={2} />
          <rect {...pen} x={43.5} y={14} width={33} height={40} rx={2} />
          <rect {...pen} x={82} y={14} width={33} height={40} rx={2} />

          {/* The trail runs straight through the cuts, which is what the
              tweening between two captured frames actually looks like. */}
          <g className="text-accent">
            <path {...pen} strokeDasharray={DASH} opacity={0.5} d="M15 44 L59.5 33 L104 22" />
            <g fill="currentColor">
              <circle cx={15} cy={44} r={CHIP} opacity={0.28} />
              <circle cx={59.5} cy={33} r={CHIP} opacity={0.55} />
              <circle cx={104} cy={22} r={CHIP} />
            </g>
          </g>
        </>
      )}

      {name === 'rooms' && (
        <>
          <rect {...pen} x={10} y={8} width={100} height={52} rx={1.5} />
          <path {...pen} d="M60 8 V60" />
          <circle {...pen} cx={60} cy={34} r={8} />

          {/* Two people, one pitch: a selection ring belongs to whoever drew it.
              The cursors clear their own rings on purpose, because a pointer
              sitting on top of the thing it has hold of reads as a smudge. */}
          <g className="text-accent">
            <circle cx={32} cy={21} r={CHIP} fill="currentColor" />
            <circle {...pen} cx={32} cy={21} r={6.4} opacity={0.6} />
            <PeerCursor x={41} y={27} />
          </g>
          <g className="text-away">
            <circle cx={84} cy={41} r={CHIP} fill="currentColor" />
            <PeerCursor x={88} y={45} />
          </g>
        </>
      )}

      {name === 'sharing' && (
        <>
          <rect {...pen} x={6} y={21} width={108} height={26} rx={13} />
          <path {...pen} opacity={0.7} d="M28 34 H50" />
          <path {...pen} opacity={0.7} d="M54 34 H62" />
          <circle cx={19} cy={34} r={2.2} fill="currentColor" opacity={0.7} />

          {/* The board's own id is the only part of the address that is yours. */}
          <g className="text-accent">
            <path {...pen} d="M66 34 H88" />
            <path {...pen} opacity={0.75} d="M94 34 H104" />
            <path {...pen} opacity={0.75} d="M100 30 L104.5 34 L100 38" />
          </g>
        </>
      )}
    </svg>
  )
}
