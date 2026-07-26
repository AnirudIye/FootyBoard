/**
 * Small marks drawn in the board's own annotation language — a run arrow, a
 * keyframe strip, a formation cluster — rather than generic UI icons. Each one
 * is monochrome (currentColor) so it inherits the accent ink from its row.
 */
export type GlyphName =
  | 'formation'
  | 'assistant'
  | 'collab'
  | 'frames'
  | 'canvas'
  | 'share'

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export function TacticalGlyph({ name, className = '' }: { name: GlyphName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none">
      {name === 'formation' && (
        <g fill="currentColor">
          {/* A 4-3-3 read as dots, defence at the base. */}
          {[
            [4, 20], [10, 20], [14, 20], [20, 20],
            [6, 12.5], [12, 12.5], [18, 12.5],
            [6, 5], [12, 5], [18, 5],
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={1.5} />
          ))}
        </g>
      )}

      {name === 'assistant' && (
        <g {...stroke}>
          {/* A command prompt: a caret and a typed line. */}
          <rect x={2.5} y={4} width={19} height={16} rx={2.5} />
          <path d="M6.5 10 L9.5 12.5 L6.5 15" />
          <path d="M12.5 15 H17.5" />
        </g>
      )}

      {name === 'collab' && (
        <g {...stroke}>
          {/* Two cursors on one board. */}
          <path d="M4 4 L4 14.5 L6.6 12 L8.4 16 L10 15.3 L8.2 11.4 L11.5 11.4 Z" />
          <path d="M13 9 L13 18 L15.2 15.9 L16.7 19.2 L18 18.6 L16.5 15.3 L19.3 15.3 Z" opacity={0.55} />
        </g>
      )}

      {name === 'frames' && (
        <g {...stroke}>
          {/* Keyframes with a playhead. */}
          <rect x={3} y={6} width={4.4} height={12} rx={1} />
          <rect x={9.8} y={6} width={4.4} height={12} rx={1} />
          <rect x={16.6} y={6} width={4.4} height={12} rx={1} />
          <path d="M12 3.5 V20.5" strokeWidth={1.9} />
        </g>
      )}

      {name === 'canvas' && (
        <g {...stroke}>
          {/* A bounded pitch on an endless surface. */}
          <path d="M2 6 H22 M2 18 H22" strokeDasharray="2 2.4" opacity={0.7} />
          <rect x={7.5} y={8.5} width={9} height={7} rx={1} />
          <path d="M12 8.5 V15.5" opacity={0.7} />
        </g>
      )}

      {name === 'share' && (
        <g {...stroke}>
          {/* The address bar as the share link. */}
          <rect x={2.5} y={7} width={19} height={10} rx={2} />
          <circle cx={5.6} cy={12} r={0.5} fill="currentColor" />
          <path d="M8.5 12 H14.5" />
          <path d="M15.5 9.5 L18 12 L15.5 14.5" />
        </g>
      )}
    </svg>
  )
}
