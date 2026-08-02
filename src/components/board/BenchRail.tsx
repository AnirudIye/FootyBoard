import { AnimatePresence, motion } from 'framer-motion'
import { useBoardStore } from '../../store/boardStore'
import { SPRING_SNAP } from '../../theme/motion'
import type { Side } from '../../lib/types'

const spring = { type: 'spring' as const, stiffness: 480, damping: 32, mass: 0.6 }

/**
 * Substitutes rail beside the pitch. Clicking a substitute brings them on near
 * their own touchline; the selected player can be sent off from here.
 */
export default function BenchRail({ side }: { side: Side }) {
  // Select the stable array and narrow it during render: returning a fresh
  // array from the selector would make every render look like a state change.
  const allBench = useBoardStore((s) => s.bench)
  const bench = allBench.filter((t) => t.teamId === side)
  const selection = useBoardStore((s) => s.selection)
  const tokens = useBoardStore((s) => s.tokens)
  const unbenchToken = useBoardStore((s) => s.unbenchToken)
  const benchToken = useBoardStore((s) => s.benchToken)

  // Only offer "send off" when exactly one of this team's players is selected.
  const selectedOwn =
    selection.length === 1
      ? tokens.find((t) => t.id === selection[0] && t.type === 'player' && t.teamId === side)
      : undefined

  const isHome = side === 'home'

  return (
    <div
      /* Narrower and closer to the edge on a phone, because these float *over*
         the pitch. At 375px the two rails covered 104px — 28% of the board's
         width — and the pitch is width-constrained at that size, so that is 28%
         of actual playing surface, not of empty canvas. 42px still clears the
         32px chips inside. On `sm` and up the original 52px and `left-3`
         return, where the same rails cost about 8% of a desktop canvas and are
         not worth crowding.

         Under a finger the chips are 44px, so the rail has to be 46 to hold
         one: 44 of content plus the two 1px rules, with the horizontal padding
         given up to pay for it. That takes the pair from 84px over the pitch
         back to 92px — 22% to 24.5% — which is the price of a substitution a
         coach can actually make, and still short of the 104px this started at.
         There is no version of this that keeps both. */
      className={`absolute top-1/2 -translate-y-1/2 z-10 ${isHome ? 'left-1 sm:left-3' : 'right-1 sm:right-3'}
        flex w-[42px] touch:w-[46px] sm:w-[52px] flex-col items-center gap-1.5 rounded-lg border
        border-rule bg-surface/95 px-1 touch:px-0 sm:px-1.5 py-2 shadow-2`}
    >
      <span className="font-mono text-[10px] tracking-[0.1em] text-ink-3">
        {isHome ? 'H' : 'A'}
      </span>

      <AnimatePresence initial={false}>
        {bench.map((t) => (
          <motion.button
            key={t.id}
            layout
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            // 1.04, not 1.12. This is a 32px chip in a rail the coach sweeps to
            // read shirt numbers, so a 12% jump set every chip springing in turn.
            // Enough to say "this is the one under the pointer" and no more.
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.94 }}
            transition={spring}
            title={`Bring on number ${t.number}`}
            onClick={() => unbenchToken(t.id, isHome ? 22 : 78, 92)}
            style={{ background: t.color }}
            /* 32px to a mouse, 44 to a finger — the floor in index.css raises
               it, and the rail above widens to hold it. */
            className="grid h-8 w-8 place-items-center rounded-full border border-black/25
              font-mono text-[12px] text-paper shadow-1"
          >
            {t.number}
          </motion.button>
        ))}
      </AnimatePresence>

      {bench.length === 0 && <span className="py-1 text-[11px] text-ink-3">none</span>}

      {/* Scale and fade rather than an animated height: a spring on `height`
          relaid out the rail on every frame, and reduced-motion cannot see a
          raw height the way it sees a transform. */}
      <AnimatePresence>
        {selectedOwn && (
          <motion.button
            initial={{ opacity: 0, scaleY: 0.7 }}
            animate={{ opacity: 1, scaleY: 1 }}
            exit={{ opacity: 0, scaleY: 0.7 }}
            transition={SPRING_SNAP}
            style={{ transformOrigin: 'top center' }}
            onClick={() => benchToken(selectedOwn.id)}
            className="mt-1 w-full rounded-sm border border-rule px-1 py-1 text-[10px] leading-tight
              text-ink-2 hover:text-ink hover:border-rule-strong transition-colors duration-150"
          >
            Sub off
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
