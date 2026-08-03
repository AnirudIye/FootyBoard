import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useBoardStore, HOME_COLOR, AWAY_COLOR } from '../../store/boardStore'
import { Button } from '../ui/Button'
import { Slider } from '../ui/Slider'
import { useDismiss } from '../ui/useDismiss'
import { clamp } from '../../lib/math'
import type { Side, TokenShape } from '../../lib/types'

// Shared with the bottom bar's context slot, so the two offer the same palette.
export const SWATCHES = [HOME_COLOR, AWAY_COLOR, '#3F6B4A', '#6B5B95', '#C08A2E', '#4A4E54', '#F2EDE3']
const ROLES: [TokenShape, string][] = [
  ['outfield', 'Outfield'],
  ['keeper', 'Keeper'],
]
const TEAMS: [Side, string, string][] = [
  ['home', 'Home', HOME_COLOR],
  ['away', 'Away', AWAY_COLOR],
]

/** Breathing room between the panel and the viewport edge, or its anchor. */
const MARGIN = 8

export default function Inspector() {
  const inspector = useBoardStore((s) => s.inspector)
  const tokens = useBoardStore((s) => s.tokens)
  const updateToken = useBoardStore((s) => s.updateToken)
  const commit = useBoardStore((s) => s.commit)
  const switchPlayerTeam = useBoardStore((s) => s.switchPlayerTeam)
  const setSelection = useBoardStore((s) => s.setSelection)
  const deleteSelection = useBoardStore((s) => s.deleteSelection)
  const closeInspector = useBoardStore((s) => s.closeInspector)
  const ref = useRef<HTMLDivElement>(null)

  const token = inspector ? tokens.find((t) => t.id === inspector.tokenId) : undefined

  useDismiss(ref, inspector !== null, closeInspector)

  // A run of keystrokes is one undo step, closed by `commit`. Blur closes it in
  // the ordinary case, but Escape and the chip being deleted both take the
  // panel away without the browser blurring anything, and a run left open is a
  // rename the next edit's snapshot swallows. `commit` is a no-op with nothing
  // pending, so closing it here as well costs nothing.
  useEffect(() => () => commit(), [inspector, commit])

  const isPlayer = token?.type === 'player'

  // The panel's own box, measured after it renders. A player's panel is 380px
  // tall and a ball's is 205, so every number here used to be a guess: the
  // launcher passed a top computed from an assumed 320 and the clamp below
  // assumed 300, which is how a panel opened from the bottom bar ended up
  // covering the button that opened it. `offsetHeight`, not a client rect,
  // because the entrance animation scales the panel to 0.97 and a rect taken
  // during it reads 368 for a panel that is really 380.
  const [panel, setPanel] = useState({ w: 236, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setPanel({ w: el.offsetWidth, h: el.offsetHeight })
  }, [inspector, isPlayer])

  // Open below the anchor, flip above it when there is no room below. That one
  // rule serves both callers: a chip right-clicked mid-pitch wants the panel
  // under the pointer, and the bottom bar's Edit button, which is always within
  // a panel's height of the bottom edge, wants it clear of the pill it sits in.
  // The flip leaves the same margin it keeps from a viewport edge, so the panel
  // does not end up flush against whatever opened it.
  const fitsBelow = inspector ? inspector.y + panel.h + MARGIN <= window.innerHeight : true
  const left = inspector
    ? Math.max(MARGIN, Math.min(inspector.x, window.innerWidth - panel.w - MARGIN))
    : 0
  const top = inspector
    ? Math.max(MARGIN, fitsBelow ? inspector.y : inspector.y - panel.h - MARGIN)
    : 0

  return (
    <AnimatePresence>
      {inspector && token && (
        <motion.div
          ref={ref}
          initial={{ opacity: 0, scale: 0.97, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -4 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          style={{ left, top, transformOrigin: 'top left' }}
          className="fixed z-40 w-[236px] rounded-lg border border-rule bg-surface p-3 shadow-2"
        >
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-rule">
            <span className="font-mono text-[11px] tracking-[0.08em] text-ink-3">
              {isPlayer ? 'PLAYER' : token.type.toUpperCase()}
            </span>
            <button
              onClick={closeInspector}
              aria-label="Close inspector"
              className="text-ink-3 hover:text-ink text-[15px] leading-none transition-colors"
            >
              ×
            </button>
          </div>

          {isPlayer && (
            <>
              <div className="flex gap-2 mb-2.5">
                <label className="flex-1">
                  <span className="block text-[11px] text-ink-3 mb-1">Number</span>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={token.number ?? ''}
                    // An empty field is somebody part-way through retyping a
                    // number, not the number nought. `Number('')` is 0, so
                    // clearing it put a 0 on the chip, sent that to the room
                    // and saved it. `min`/`max` are hints to the browser's own
                    // stepper and React enforces neither, so the clamp is here.
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (e.target.value === '' || !Number.isFinite(n)) return
                      updateToken(token.id, { number: clamp(Math.round(n), 1, 99) }, true)
                    }}
                    onBlur={commit}
                    className="w-full rounded border border-rule bg-paper px-2 py-1 font-mono text-[13px]
                      focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </label>
                <label className="flex-[2]">
                  <span className="block text-[11px] text-ink-3 mb-1">Name</span>
                  <input
                    type="text"
                    value={token.label ?? ''}
                    placeholder="optional"
                    onChange={(e) => updateToken(token.id, { label: e.target.value }, true)}
                    onBlur={commit}
                    className="w-full rounded border border-rule bg-paper px-2 py-1 text-[13px]
                      focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </label>
              </div>

              <div className="mb-2.5">
                <span className="block text-[11px] text-ink-3 mb-1">Role</span>
                <div className="flex gap-1.5">
                  {ROLES.map(([shape, label]) => (
                    <Button
                      key={shape}
                      variant={token.shape === shape ? 'primary' : 'secondary'}
                      onClick={() => updateToken(token.id, { shape })}
                      className="flex-1"
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="mb-2.5">
                <span className="block text-[11px] text-ink-3 mb-1">Team</span>
                <div className="flex gap-1.5">
                  {TEAMS.map(([side, label, color]) => (
                    <Button
                      key={side}
                      variant={token.teamId === side ? 'primary' : 'secondary'}
                      onClick={() => token.teamId !== side && switchPlayerTeam(token.id)}
                      className="flex-1"
                    >
                      <span
                        className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle ring-1 ring-black/15"
                        style={{ background: color }}
                      />
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="mb-2.5">
            <span className="block text-[11px] text-ink-3 mb-1">Colour</span>
            {/* The swatch stays 20px because that is the size it reads at; the
                button around it is 28px, because that is the size a finger
                lands on. */}
            <div className="flex flex-wrap items-center">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  aria-label={`Set colour ${c}`}
                  aria-pressed={token.color === c}
                  onClick={() => updateToken(token.id, { color: c })}
                  className="group grid h-7 w-7 place-items-center rounded"
                >
                  <span
                    style={{ background: c }}
                    className={`h-5 w-5 rounded-sm border transition-transform duration-150 ease-out
                      group-hover:scale-110
                      ${token.color === c ? 'border-ink ring-1 ring-ink' : 'border-rule'}`}
                  />
                </button>
              ))}
              <input
                type="color"
                value={token.color}
                onChange={(e) => updateToken(token.id, { color: e.target.value })}
                aria-label="Custom colour"
                className="ml-1 h-7 w-8 cursor-pointer rounded-sm border border-rule bg-transparent p-0"
              />
            </div>
          </div>

          {/* Every whole degree, and up to 359 rather than 350.
              This used to be a ten-degree stepper over 0..350, which was fine
              while the slider was the only way to set a facing. It is not the
              only way now: a prop is turned by the ring on the board, which
              writes any whole degree. A range input snaps its thumb to the
              nearest valid step and clamps it to `max`, but the readout beside
              it prints the value it was handed — so a prop spun to 137 showed a
              thumb at 140 with "137" written next to it, and one spun to 355
              showed the thumb pinned at the end. The control has to be able to
              say what the board already holds. */}
          <div className="mb-3">
            <Slider
              min={0}
              max={359}
              step={1}
              value={token.rotation}
              onChange={(v) => updateToken(token.id, { rotation: v })}
              label="Facing"
            />
          </div>

          <Button
            variant="secondary"
            className="w-full text-accent border-accent/40 hover:border-accent"
            onClick={() => {
              setSelection([token.id])
              deleteSelection()
              closeInspector()
            }}
          >
            Remove
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
