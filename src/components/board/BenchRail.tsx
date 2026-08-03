import { AnimatePresence, motion } from 'framer-motion'
import { useBoardStore } from '../../store/boardStore'
import { SPRING_SNAP } from '../../theme/motion'
import type { Side } from '../../lib/types'

const spring = { type: 'spring' as const, stiffness: 480, damping: 32, mass: 0.6 }

/**
 * The substitutes. Clicking one brings them on near their own touchline; the
 * selected player can be sent off from here.
 *
 * Two layouts, one element, chosen by `roomy`: a vertical rail beside the pitch
 * where there is room for it, and a docked row under the canvas where there is
 * not. `BoardPage` builds the column that holds the docked half and explains why
 * it is a column; the class list below is where the two shapes are spelled out.
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
      /* **The pixel widths below belong to the `overlay` half of this and to
         nothing else, and that is the whole of what changed here.**

         At `overlay` this is the rail it has always been: a 52px card floating
         *over* the canvas, pinned to the pitch's own vertical centre — which on
         a horizontal view is precisely where the goals are. On a desktop that is
         affordable, because the pair costs about 8% of a wide canvas and the
         nets are still reachable around it.

         Docked it never was affordable, and re-deriving why is what
         settled this. `computeMapping` fits a 105:68 pitch inside 90% of the
         canvas box on each axis, so on a 375px-wide phone the drawn pitch is
         337.5px across whatever the height is — width-constrained, with hundreds
         of pixels of empty canvas above and below it. Two 46px rails at `left-1`
         and `right-1` therefore covered 31.25px of *drawn pitch* on each side:
         62.5 of 337.5, 18.5% of the playing surface and both goalmouths, in the
         one direction that had nothing to spare.

         So the answer on an upright phone is not a narrower rail. It is not being over
         the pitch at all: this becomes an ordinary row docked under the canvas,
         one half of the row for each side, and the pitch keeps every pixel it
         had. The 42px default and the 46px `touch:` exception have gone with the
         regime that needed them — they were the width of a card that had to lie
         over a 375px board and still hold a 44px chip. Neither ever reached a
         tablet and neither can be missed: both sat below `sm`, `sm:w-[52px]` is
         generated after `touch:w-[46px]`, and so 52 won everywhere the two
         overlapped — which is everywhere the rail still floats, `overlay`
         being a superset of `sm` on every screen that has a rail over the pitch.
         Re-spelling them as `overlay:` would have put 46px on a coarse tablet
         for the first time rather than preserving anything.

         Docked, the width is the row's to hand out: `flex-1` twice, so a long
         bench scrolls inside its own half instead of squeezing the other side. */
      className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-rule
        bg-surface/95 px-2 py-1.5 shadow-2
        overlay:absolute overlay:top-1/2 overlay:z-10 overlay:-translate-y-1/2 overlay:w-[52px]
        overlay:flex-col overlay:px-1.5 overlay:py-2 ${isHome ? 'overlay:left-3' : 'overlay:right-3'}`}
    >
      <span className="font-mono text-[10px] tracking-[0.1em] text-ink-3">
        {isHome ? 'H' : 'A'}
      </span>

      {/* The chips, and the only thing here that is allowed to scroll.
          `Sub off` and the tag sit outside this box on purpose: a bench of ten
          under a finger is 440px of chips in half of a 375px row, so anything
          inside the scroller is reachable only by scrolling to it, and "send
          this player off" is not a control to hide behind a swipe.

          `overlay:contents` for the same reason Toolbar's `More tools` group
          and DrawingToolbar's `More` group use it: at `overlay` the wrapper must not
          exist at all, or the chips would stop being direct children of the
          column above and the rail's layout would change. `display: contents`
          leaves them exactly where they were. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5 overlay:contents">
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
              // The `py-0.5` above is the room that 4% needs: `overflow-x` other
              // than `visible` computes `overflow-y` to `auto`, so a chip that
              // grew past the edge of the scroller would summon a scrollbar in a
              // 44px-tall box rather than simply overhanging it.
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.94 }}
              transition={spring}
              title={`Bring on number ${t.number}`}
              onClick={() => unbenchToken(t.id, isHome ? 22 : 78, 92)}
              style={{ background: t.color }}
              /* 32px to a mouse, 44 to a finger — the floor in index.css raises
                 it, and the rail is sized around whatever comes back.

                 `shrink-0 overlay:shrink` is one regime speaking and the other
                 being left alone. In the docked scroller a chip that may shrink
                 does: a fine pointer puts no `min-width` under it, so ten of
                 them would squeeze to the width of their own digits rather than
                 overflow, and a scroller with nothing overflowing it does not
                 scroll. In the floating column the chips have always been
                 shrinkable, and a rail longer than the band it hangs in still
                 squashes rather than spilling out of it. */
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full border
                border-black/25 font-mono text-[12px] text-paper shadow-1 overlay:shrink"
            >
              {t.number}
            </motion.button>
          ))}
        </AnimatePresence>

        {bench.length === 0 && <span className="py-1 text-[11px] text-ink-3">none</span>}
      </div>

      {/* Scale and fade rather than an animated height: a spring on `height`
          relaid out the rail on every frame, and reduced-motion cannot see a
          raw height the way it sees a transform. `mt-1 w-full` is the column's
          shape — a full-width strip under the chips — so both are `overlay:`; in
          the row it is an ordinary button at the end of the half, sized by its
          own words, and the scroller beside it is what gives up the room. */}
      <AnimatePresence>
        {selectedOwn && (
          <motion.button
            initial={{ opacity: 0, scaleY: 0.7 }}
            animate={{ opacity: 1, scaleY: 1 }}
            exit={{ opacity: 0, scaleY: 0.7 }}
            transition={SPRING_SNAP}
            style={{ transformOrigin: 'top center' }}
            onClick={() => benchToken(selectedOwn.id)}
            className="rounded-sm border border-rule px-1 py-1 text-[10px] leading-tight
              text-ink-2 hover:text-ink hover:border-rule-strong transition-colors duration-150
              overlay:mt-1 overlay:w-full"
          >
            Sub off
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
