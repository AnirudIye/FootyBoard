import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useBoardStore } from '../../store/boardStore'
import type { ToolMode } from '../../store/boardStore'
import { isZone, isCurve, curveControl } from '../../lib/drawings'
import type { CurveDirection } from '../../lib/drawings'
import { Slider } from '../ui/Slider'
import { Button } from '../ui/Button'
import { MonoReadout } from '../ui/MonoReadout'
import { SWATCHES } from './Inspector'
import { SPRING_SNAP } from '../../theme/motion'
import { useRealtimeStore } from '../../store/realtimeStore'

const TOOLS: { id: ToolMode; label: string; hint: string }[] = [
  { id: 'select', label: 'Select', hint: 'Select and move (Esc)' },
  { id: 'pen', label: 'Pen', hint: 'Freehand' },
  { id: 'line', label: 'Line', hint: 'Straight line' },
  { id: 'arrow', label: 'Run', hint: 'Run or dribble arrow' },
  { id: 'dashedArrow', label: 'Pass', hint: 'Pass arrow (dashed)' },
  { id: 'curveArrow', label: 'Bend', hint: 'Curved run or shot. Pick which way it bends' },
  { id: 'curvePass', label: 'Bent pass', hint: 'Curved pass (dashed). Pick which way it bends' },
  { id: 'zoneRect', label: 'Box', hint: 'Rectangular zone' },
  { id: 'zoneEllipse', label: 'Oval', hint: 'Elliptical zone' },
  // The hint carries the one thing a triangle does that the two zones above it
  // do not, because it is not guessable from a button that looks like theirs:
  // it is placed a corner at a time rather than dragged out. The comment here
  // described the drag it replaced — an apex that followed the direction of the
  // drag — for as long as the hint beside it said otherwise.
  { id: 'zoneTriangle', label: 'Triangle', hint: 'Triangular zone: click its three corners' },
  // Double-click and Enter both close it, and naming the double-click first is
  // not arbitrary: it is the half that works without a keyboard.
  {
    id: 'zonePoly',
    label: 'Shape',
    hint: 'Free polygon: click points, then double-click or press Enter to close',
  },
  { id: 'text', label: 'Text', hint: 'Text label' },
]

/**
 * What stays on the bar below `sm`. Everything else is a tap away.
 *
 * Raising every target to 44px took this bar from 138px to 262px on a 375x812
 * phone — a third of the screen, floating over the pitch, leaving 295px of
 * clear playing surface and colliding with the bench rails on the way. The
 * targets are not negotiable and neither is the pitch, so what gives is how
 * much of the kit is on screen at once. Plan 009 lists this as the first of its
 * options for the vertical budget, and the top bar already works this way.
 *
 * These four are the ones a coach changes constantly: a way to stop drawing,
 * and the three marks a tactics board is mostly made of. Zones, curves, text
 * and the polygon are chosen once for a diagram and then drawn with. The ink
 * and the weight go behind the toggle for the same reason.
 *
 * The armed tool is always shown even when it is not one of these, because a
 * bar that hides which tool it is in is a bar that draws the wrong thing.
 */
const PRIMARY: ToolMode[] = ['select', 'pen', 'arrow', 'dashedArrow']

// Inks that read on the floodlit pitch; black is kept for the chalk theme.
const INKS = ['#2ae07a', '#f4f2ef', '#e85c42', '#529ae0', '#e0b23c', '#17191d']

const PILL = 'rounded-lg border border-rule bg-surface/95 px-3 py-2 shadow-2 backdrop-blur-[2px]'

/** The gap the side placement leaves between the bar and the pill: `ml-3`. */
const SIDE_GAP = 12

export default function DrawingToolbar() {
  const tool = useBoardStore((s) => s.tool)
  const setTool = useBoardStore((s) => s.setTool)
  const drawStyle = useBoardStore((s) => s.drawStyle)
  const setDrawStyle = useBoardStore((s) => s.setDrawStyle)
  const selection = useBoardStore((s) => s.selection)
  const drawings = useBoardStore((s) => s.drawings)
  const tokens = useBoardStore((s) => s.tokens)
  const updateDrawing = useBoardStore((s) => s.updateDrawing)
  const updateToken = useBoardStore((s) => s.updateToken)
  const deleteDrawings = useBoardStore((s) => s.deleteDrawings)
  const openInspector = useBoardStore((s) => s.openInspector)
  const locked = useRealtimeStore((s) => s.locked)

  const selectedDrawings = drawings.filter((d) => selection.includes(d.id))
  const selectedTokens = tokens.filter((t) => selection.includes(t.id))
  const players = selectedTokens.filter((t) => t.type === 'player')
  const hasZoneSelected = selectedDrawings.some((d) => isZone(d.type))
  const showZoneOpacity = hasZoneSelected || (tool !== 'select' && isZone(tool))

  const selectedCurves = selectedDrawings.filter((d) => isCurve(d.type))
  const showCurveSide = selectedCurves.length > 0 || (tool !== 'select' && isCurve(tool))

  // Sets which way the bend goes: on a selected curve it re-bends it now, and
  // it becomes the default for the next one either way.
  const setCurveSide = (curve: CurveDirection) => {
    for (const d of selectedCurves) updateDrawing(d.id, { control: curveControl(d.points, curve) })
    setDrawStyle({ curve })
  }

  // Applying a style change hits the selection when there is one, otherwise it
  // becomes the default for the next drawing.
  const applyStyle = (patch: { color?: string; thickness?: number; fillOpacity?: number }) => {
    if (selectedDrawings.length > 0) {
      for (const d of selectedDrawings) updateDrawing(d.id, patch)
    }
    setDrawStyle(patch)
  }

  const canAttach = selectedDrawings.length === 1 && selectedTokens.length === 1
  const attached = selectedDrawings.length === 1 && selectedDrawings[0].attachedTokenId

  // Everything conditional lives in the context slot, which is what keeps the
  // tool group a constant width and stops Select sliding under the pointer.
  const hasContext =
    showCurveSide || showZoneOpacity || selectedDrawings.length > 0 || players.length > 0

  // Where the context pill goes: beside the bar when the room beside it is
  // real, otherwise on its own row above.
  //
  // Measured rather than decided by a breakpoint, because the pill's width is a
  // function of what is selected and no single constant can be right for all of
  // them. `min-[1360px]` was that arithmetic done once against the 176px
  // variant; a selected curve stacks Bend + left/right + Delete at 254px and so
  // only fits from about 1487px up, which put it 48px past the right edge of a
  // 1366 laptop with Delete half off-screen. Curve + zone adds Fill and
  // curve + ball adds Attach to player, so the next variant would have broken
  // the next constant too. The pill's own box is the only thing that knows.
  const railRef = useRef<HTMLElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const [beside, setBeside] = useState(false)

  // Closed by default, and only ever consulted below `sm` — see PRIMARY.
  const [kitOpen, setKitOpen] = useState(false)

  const measure = useCallback(() => {
    const rail = railRef.current
    const bar = barRef.current
    const pill = pillRef.current
    if (!rail || !bar || !pill) return
    // The rail is the same `inset-x-3` box the bar lives in, so its right edge
    // already carries the page margin and any scrollbar. `offsetWidth` rather
    // than a client rect for the pill, because it carries a `layout` animation
    // and its rect mid-flight is a scaled box, while what has to fit is the
    // untransformed width it is settling on.
    const room = rail.getBoundingClientRect().right - bar.getBoundingClientRect().right
    setBeside(pill.offsetWidth + SIDE_GAP <= room)
  }, [])

  // No dependency array: the pill's width changes with the selection, and the
  // selection is what re-renders this component. Layout rather than passive, so
  // a placement is never painted in the position it is about to leave.
  useLayoutEffect(measure)

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  const one = players.length === 1 ? players[0] : null
  const playerValue = one
    ? `#${one.number ?? ''} ${(one.teamId ?? '').toUpperCase()}`
    : `${players.length} PLAYERS`

  // Drawing is exactly what the editing lock withholds, so the whole strip goes
  // away rather than sitting there inert. Hidden, not disabled: a row of dead
  // buttons invites clicking to find out why.
  if (locked) return null

  return (
    <aside
      ref={railRef}
      className="pointer-events-none absolute inset-x-3 bottom-4 z-20 flex justify-center"
    >
      {/* The bar wraps, and so does the tool group inside it, for the same
          reason the top toolbar does. `flex-none` held it at its 931px max-content
          inside a `justify-center` rail, so below about 955px it centred to a
          negative x and ran off both edges at once: at 375px Select through
          Bend sat at x=-265..2.8 and the last three inks and the whole weight
          slider sat past the right edge, ten of eighteen controls painted
          outside the window. BoardPage clips the band with `overflow-hidden`
          and nothing between here and it scrolls, so there was no way to reach
          any of them. Wrapping rather than `overflow-x-auto`, because the
          context pill is an absolutely positioned child of this bar and
          `overflow-x` other than `visible` computes `overflow-y` to `auto` as
          well, which would clip the pill on the row it takes above. */}
      <div
        ref={barRef}
        className={`pointer-events-auto relative flex flex-wrap items-center justify-center
          gap-x-3 gap-y-2 ${PILL}`}
      >
        <div className="flex flex-wrap items-center justify-center gap-x-0.5 gap-y-1">
          {TOOLS.map((t) => {
            const active = tool === t.id
            // Hidden on a narrow screen unless it is armed. `sm:block` rather
            // than a `contents` wrapper because these are siblings in one flex
            // group and the armed tool moves between the two sets: a wrapper
            // would have to render it in both and put two of it on the bar.
            const tucked = !PRIMARY.includes(t.id) && !active
            return (
              <button
                key={t.id}
                title={t.hint}
                onClick={() => setTool(t.id)}
                className={`relative rounded px-2 py-1 text-[12px] font-medium transition-colors
                  duration-150 ease-out ${active ? 'text-paper' : 'text-ink-2 hover:text-ink'}
                  ${tucked && !kitOpen ? 'hidden roomy:block' : ''}`}
              >
                {active && (
                  <motion.span
                    layoutId="tool-pill"
                    transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.6 }}
                    className="absolute inset-0 -z-10 rounded bg-accent"
                  />
                )}
                {t.label}
              </button>
            )
          })}
        </div>

        {/* The phone toggle, following the top bar's mechanism exactly.
            `contents` where there is room removes the wrapper from the box tree
            entirely, so the ink group and the weight slider stay direct flex
            items of this bar and the desktop layout is what it was. Where there
            is not, it is `hidden`, and this button brings them back. */}
        <button
          onClick={() => setKitOpen((open) => !open)}
          aria-expanded={kitOpen}
          aria-label={kitOpen ? 'Fewer drawing tools' : 'More drawing tools, ink and weight'}
          className="rounded px-2 py-1 text-[12px] font-medium text-ink-2 transition-colors
            duration-150 ease-out hover:text-ink roomy:hidden"
        >
          {kitOpen ? 'Less' : 'More'}
        </button>

        <div className={`${kitOpen ? 'contents' : 'hidden'} roomy:contents`}>
          <span className="h-5 w-px bg-rule" />

          {/* A 16px swatch is the right size to look at and too small to hit,
              so the button is 28px and the swatch is what you see inside it.
              Under a finger the floor in index.css takes the button to 44 and
              leaves the swatch alone, which is the same bargain. */}
          <div className="flex flex-wrap items-center justify-center">
            {INKS.map((c) => (
              <button
                key={c}
                aria-label={`Ink ${c}`}
                aria-pressed={drawStyle.color === c}
                onClick={() => applyStyle({ color: c })}
                className="group grid h-7 w-7 place-items-center rounded"
              >
                <span
                  style={{ background: c }}
                  className={`h-4 w-4 rounded-sm border transition-transform duration-150 ease-out
                    group-hover:scale-125
                    ${drawStyle.color === c ? 'border-ink ring-1 ring-ink' : 'border-rule'}`}
                />
              </button>
            ))}
          </div>

          <div className="w-44">
            <Slider
              min={1}
              max={8}
              step={0.5}
              value={selectedDrawings[0]?.thickness ?? drawStyle.thickness}
              onChange={(v) => applyStyle({ thickness: v })}
              label="Weight"
            />
          </div>
        </div>

        {/* Anchored to the tool group, never inside it, so nothing conditional
            can move Select. Which of the two placements applies is measured
            above; `data-placement` is what says so out loud. */}
        {hasContext && (
          <div
            data-placement={beside ? 'side' : 'above'}
            className={`pointer-events-none absolute flex ${
              beside
                ? 'left-full top-0 ml-3 justify-start'
                : 'bottom-full left-0 right-0 mb-3 justify-center'
            }`}
          >
            {/* The pill wraps only on the row above, and only there because
                that is the one placement whose box has a width to wrap
                against: it is stretched `left-0 right-0` across the bar, so
                below about 420px the widest variants (378 for curve + zone,
                389 for curve + ball) are wider than the bar itself and would
                hang off both ends of a band that clips. The side placement is
                `left-full` with no right edge, so its box shrink-to-fits and
                `flex-wrap` there would fold a pill that has all the room in
                the world into a narrow column. `whitespace-nowrap` stays
                either way: the break belongs between controls, never through
                the middle of "Attach to player". */}
            <motion.div
              ref={pillRef}
              layout
              transition={SPRING_SNAP}
              className={`pointer-events-auto flex items-center gap-3 whitespace-nowrap ${PILL}
                ${beside ? '' : 'flex-wrap justify-center'}`}
            >
              {showCurveSide && (
                <div className="flex items-center gap-1.5">
                  <span className="select-none text-[13px] text-ink-2">Bend</span>
                  <div className="flex items-center gap-0.5 rounded border border-rule bg-sunken p-0.5">
                    {(['left', 'right'] as CurveDirection[]).map((side) => (
                      <Button
                        key={side}
                        variant={drawStyle.curve === side ? 'primary' : 'quiet'}
                        onClick={() => setCurveSide(side)}
                        title={`Bend the ball to the ${side}`}
                        className="px-2 py-0.5 text-[11px] capitalize"
                      >
                        {side}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {showZoneOpacity && (
                <div className="w-28">
                  <Slider
                    min={0.05}
                    max={0.6}
                    step={0.05}
                    value={selectedDrawings[0]?.fillOpacity ?? drawStyle.fillOpacity}
                    onChange={(v) => applyStyle({ fillOpacity: v })}
                    label="Fill"
                  />
                </div>
              )}

              {(canAttach || attached) && (
                <Button
                  className="text-[12px]"
                  onClick={() => {
                    const d = selectedDrawings[0]
                    updateDrawing(d.id, {
                      attachedTokenId: attached ? undefined : selectedTokens[0]?.id,
                    })
                  }}
                >
                  {attached ? 'Detach' : 'Attach to player'}
                </Button>
              )}

              {selectedDrawings.length > 0 && (
                <Button
                  className="text-[12px] text-accent"
                  onClick={() => deleteDrawings(selectedDrawings.map((d) => d.id))}
                >
                  Delete
                </Button>
              )}

              {players.length > 0 && (
                <>
                  <MonoReadout label="SEL" value={playerValue} />

                  {/* One updateToken per player, matching applyStyle above: a
                      recolour of four chips is four undo steps either way, and
                      one batched action for players only would make the two
                      halves of this pill behave differently. */}
                  <div className="flex items-center">
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        aria-label={`Set colour ${c}`}
                        aria-pressed={players.every((t) => t.color === c)}
                        onClick={() => {
                          for (const t of players) updateToken(t.id, { color: c })
                        }}
                        className="group grid h-7 w-7 place-items-center rounded"
                      >
                        <span
                          style={{ background: c }}
                          className={`h-5 w-5 rounded-sm border transition-transform duration-150 ease-out
                            group-hover:scale-110
                            ${players.every((t) => t.color === c) ? 'border-ink ring-1 ring-ink' : 'border-rule'}`}
                        />
                      </button>
                    ))}
                  </div>

                  {one && (
                    <Button
                      className="text-[12px]"
                      title="Number, name, role, team and facing"
                      onClick={(e) => {
                        // Anchored rather than opened under the pointer, so the
                        // panel never covers the chip it is editing. The anchor
                        // is the top of the whole pill, not of the button: the
                        // button sits inside the pill's padding, so clearing
                        // only the button still lands the panel flush on the
                        // launcher. Inspector flips the panel above this point
                        // and measures itself to do it, which is the part the
                        // old call got wrong: it passed `r.top - 320` and the
                        // player panel is 380 tall, so it sat 60px over the
                        // button that opened it.
                        const btn = e.currentTarget.getBoundingClientRect()
                        const launcher = pillRef.current?.getBoundingClientRect()
                        openInspector(one.id, btn.left, launcher?.top ?? btn.top)
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </>
              )}
            </motion.div>
          </div>
        )}
      </div>
    </aside>
  )
}
