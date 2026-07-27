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
      className={`absolute top-1/2 -translate-y-1/2 z-10 ${isHome ? 'left-3' : 'right-3'}
        flex w-[52px] flex-col items-center gap-1.5 rounded-lg border border-rule
        bg-surface/95 px-1.5 py-2 shadow-2`}
    >
      <span className="font-mono text-[10px] tracking-[0.1em] text-ink-3">
        {isHome ? 'H' : 'A'}
      </span>

      <AnimatePresence initial={false}>
        {bench.map((t) => (
          <motion.button
            key={t.id}
            layout
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            whileHover={{ scale: 1.12 }}
            whileTap={{ scale: 0.92 }}
            transition={spring}
            title={`Bring on number ${t.number}`}
            onClick={() => unbenchToken(t.id, isHome ? 22 : 78, 92)}
            style={{ background: t.color }}
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
