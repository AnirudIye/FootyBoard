/**
 * The looping background play. Five stations, four passes and a ball that runs
 * the move, then the whole thing clears and starts again. It is the product's
 * own subject matter used as ambience — a move being worked through — rather
 * than a decorative particle field.
 *
 * Every animation here is pure CSS, so reduced motion is handled entirely in
 * the stylesheet: tokens.css stops the animations and index.css says what the
 * pass lines and the ball should look like once they are stopped, which is not
 * the same as what they look like before they start.
 */

const NODES: [number, number][] = [
  [180, 430],
  [430, 300],
  [720, 170],
  [910, 380],
  [1060, 268],
]

// Each pass, with its path length (for the draw-on) and its slot in the loop.
const PASSES = NODES.slice(0, -1).map(([x1, y1], i) => {
  const [x2, y2] = NODES[i + 1]
  return { x1, y1, x2, y2, len: Math.hypot(x2 - x1, y2 - y1), delay: i * 2.6 }
})

const LOOP = '13s'

export default function TacticalLoop({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1240 600"
      preserveAspectRatio="xMidYMid slice"
      className={className}
      aria-hidden
      fill="none"
    >
      {/* Halfway line and centre circle, just enough to read as a pitch. */}
      <g stroke="rgb(42 224 122)" strokeWidth={1.5} opacity={0.1}>
        <line x1={620} y1={40} x2={620} y2={560} />
        <circle cx={620} cy={300} r={86} />
        <rect x={40} y={150} width={130} height={300} />
        <rect x={1070} y={150} width={130} height={300} />
      </g>

      {/* Stations */}
      {NODES.map(([cx, cy], i) => (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={7}
          fill="rgb(42 224 122)"
          opacity={0.28}
          style={{ animation: `nodePulse 4s ease-in-out ${i * 0.5}s infinite` }}
        />
      ))}

      {/* Passes, drawn in sequence */}
      {PASSES.map((p, i) => (
        <line
          key={i}
          className="tactical-pass"
          x1={p.x1}
          y1={p.y1}
          x2={p.x2}
          y2={p.y2}
          stroke="rgb(42 224 122)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={p.len}
          strokeDashoffset={p.len}
          opacity={0}
          style={
            {
              '--len': `${p.len}`,
              animation: `passDraw ${LOOP} linear ${p.delay}s infinite`,
            } as React.CSSProperties
          }
        />
      ))}

      {/* The ball running the move */}
      <circle
        className="tactical-ball"
        r={6}
        fill="rgb(240 244 241)"
        style={{ animation: `ballRun ${LOOP} ease-in-out infinite` }}
      />
    </svg>
  )
}
