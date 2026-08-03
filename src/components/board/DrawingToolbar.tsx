import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useBoardStore, armedDrawing } from '../../store/boardStore'
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
  // Beside the Pen, because that is the pair: the tool that puts ink down and
  // the tool that takes it off again. Nothing else on this bar removes anything.
  { id: 'eraser', label: 'Erase', hint: 'Erase whatever you drag over' },
  { id: 'line', label: 'Line', hint: 'Straight line' },
  { id: 'arrow', label: 'Run', hint: 'Run or dribble arrow' },
  { id: 'dashedArrow', label: 'Pass', hint: 'Pass arrow (dashed)' },
  { id: 'curveArrow', label: 'Bend', hint: 'Curved run or shot. Pick which way it bends' },
  { id: 'curvePass', label: 'Bent pass', hint: 'Curved pass (dashed). Pick which way it bends' },
  { id: 'zoneRect', label: 'Box', hint: 'Rectangular zone' },
  { id: 'zoneEllipse', label: 'Oval', hint: 'Elliptical zone' },
  // A triangle is dragged like the two zones above it, so the hint spends its
  // words on the one thing that is not guessable from a button that looks like
  // theirs: the drag starts at the point rather than at a corner of a box, and
  // the shape opens out behind the finger. Say where to press and the rest
  // follows from doing it once.
  {
    id: 'zoneTriangle',
    label: 'Triangle',
    hint: 'Triangular zone: press where the point goes, then drag it out',
  },
  // The Shape tool takes either gesture, and the drag is named first because it
  // is the one that needs nothing but the finger already on the glass. Of the
  // two ways to close a clicked shape the double-click likewise comes before
  // Enter, and that is not arbitrary either: it is the half that works without
  // a keyboard.
  {
    id: 'zonePoly',
    label: 'Shape',
    hint: 'Free shape: drag to trace one, or click its corners and double-click (or Enter) to close',
  },
  { id: 'text', label: 'Text', hint: 'Text label' },
]

/**
 * What stays on the bar below `roomy`. Everything else is a tap away.
 *
 * Raising every target to 44px took this bar from 138px to 262px on a 375x812
 * phone — a third of the screen, floating over the pitch, leaving 295px of
 * clear playing surface and colliding with the bench rails on the way. The
 * targets are not negotiable and neither is the pitch, so what gives is how
 * much of the kit is on screen at once. Plan 009 lists this as the first of its
 * options for the vertical budget, and the top bar already works this way.
 *
 * **The test these five have to pass is "used constantly, and needed in a
 * hurry", and it is not the same test as "makes a mark".** Four of them are the
 * marks a tactics board is mostly made of plus the way to stop making them.
 * Zones, curves, text and the polygon are chosen once for a diagram and then
 * drawn with, so they can afford a tap; the ink and the weight are behind the
 * toggle for that same reason.
 *
 * The eraser is the fifth and it is here on the other half of the test. It is
 * the only tool on the bar that takes something off the board, and the moment it
 * is wanted is the moment a stroke has just gone wrong — which on a phone is
 * oftener than anywhere else, because a fingertip is a blunter instrument than a
 * mouse. Undo covers the stroke you have just made; the eraser is for the wrong
 * one out of nine, and putting it behind `More` would mean two taps and a hunt
 * every time a diagram needed tidying. That is also why it did not simply take
 * Pass's place: a coach draws passes constantly and mends them constantly, and
 * the two are not alternatives.
 *
 * A fifth button is not free. At 44px minimums the primary row plus `More` comes
 * to roughly 330px of the 351px a 375px phone leaves between the rail's margins,
 * so it still fits on one line — but only just, and a sixth would wrap the row
 * rather than being refused. Anything proposed for this list from here on has to
 * argue against that wrap, not merely for itself.
 *
 * The armed tool is always shown even when it is not one of these, because a
 * bar that hides which tool it is in is a bar that draws the wrong thing.
 */
const PRIMARY: ToolMode[] = ['select', 'pen', 'eraser', 'arrow', 'dashedArrow']

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

  // The armed tool as a kind of drawing, or null for the two that are not one.
  // `tool !== 'select'` used to be enough to hand it to `isZone`; the eraser is
  // the reason it is not, and `armedDrawing` is where that question is settled
  // rather than in each of the two lines below. See `ToolMode`.
  const armed = armedDrawing(tool)
  const hasZoneSelected = selectedDrawings.some((d) => isZone(d.type))
  const showZoneOpacity = hasZoneSelected || (armed !== null && isZone(armed))

  const selectedCurves = selectedDrawings.filter((d) => isCurve(d.type))
  const showCurveSide = selectedCurves.length > 0 || (armed !== null && isCurve(armed))

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

  // What is left in the context slot, which is everything conditional except the
  // bend control: keeping it out of the tool group is what holds that group at a
  // constant width and stops Select sliding under the pointer.
  //
  // `showCurveSide` is deliberately not part of this any more. Bend now has its
  // own row inside the bar, so a curve tool armed over an empty selection puts
  // nothing in the pill and the pill does not appear at all — which it used to,
  // holding one control.
  const hasContext = showZoneOpacity || selectedDrawings.length > 0 || players.length > 0

  // Where the context pill goes: beside the bar when the room beside it is
  // real, otherwise on its own row above.
  //
  // Measured rather than decided by a breakpoint, because the pill's width is a
  // function of what is selected and no single constant can be right for all of
  // them. `min-[1360px]` was that arithmetic done once against the 176px
  // variant; the pill it then failed against was a selected curve at 254px,
  // which needs about 1487px and so hung 48px past the right edge of a 1366
  // laptop with Delete half off-screen.
  //
  // **Those numbers are history rather than the current widest case**, and the
  // reason is that all three of them — 254 for a curve, 378 for curve + zone,
  // 389 for curve + ball — were measured with Bend inside this pill, which it no
  // longer is. What is left here is Fill, Attach to player, Delete, and the
  // player half (SEL, six swatches, Edit); none has been re-measured, and none
  // needs to be, because the argument never rested on any particular number. It
  // rests on the spread: the narrowest pill this bar can show is a lone Delete
  // and the widest is the whole player half, they differ by hundreds of pixels,
  // and a constant chosen for either is wrong for the other. The pill's own box
  // is the only thing that knows.
  const railRef = useRef<HTMLElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const [beside, setBeside] = useState(false)

  // Closed by default, and only ever consulted below `roomy` — see PRIMARY.
  const [kitOpen, setKitOpen] = useState(false)

  const measure = useCallback(() => {
    const rail = railRef.current
    const bar = barRef.current
    const pill = pillRef.current
    if (!rail || !bar || !pill) return
    // The rail is the box the bar lives in, so its right edge already carries
    // the page margin and any scrollbar. `offsetWidth` rather than a client rect
    // for the pill, because it carries a `layout` animation and its rect
    // mid-flight is a scaled box, while what has to fit is the untransformed
    // width it is settling on.
    //
    // **That holds in both of the rail's layouts, and it holds by construction
    // rather than by luck.** Floating at `overlay` the rail is `inset-x-3`;
    // docked it is an ordinary row with `mx-3`. Both put its right edge 12px
    // inside the band, so this is the same measurement of the same gap either
    // way — and the docked half uses a margin rather than padding for exactly
    // that reason. Padding would have left the border box on the band's own
    // edge and reported 12px of room that is not there.
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
      /* Floating over the bottom of the board at `overlay`, docked under it
         otherwise — the last row of the board's column, beneath the bench. See
         `BoardPage` for the column and `measure` above for why the 12px stays a
         margin here rather than becoming padding.

         `order-2` and not a different position in the file. Docked, this belongs
         under the bench rails; in the DOM it comes before them, because at
         `overlay` the rails and the HUD are both `z-10` and paint in tree order,
         and reordering the source would change which of them wins where a long
         bench reaches the top-left corner. `order` cannot do that damage,
         because an absolutely positioned child of a flex container is not a flex
         item and never sees it. */
      className="pointer-events-none order-2 mx-3 mb-2 flex justify-center
        overlay:absolute overlay:inset-x-3 overlay:bottom-4 overlay:z-20 overlay:mx-0 overlay:mb-0"
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

        {/**
         * Which way the ball bends, on its own row inside the bar rather than in
         * the floating pill it used to share with Delete.
         *
         * It was being missed, and the pill is why: it appears beside the bar or
         * above it depending on a measurement, so the one control a curve tool
         * cannot be used without was the one control that was never twice in the
         * same place. Here it is under the tools every time, at every width, and
         * — unlike the eight tucked tools around it — it can never end up behind
         * the `More` toggle, because it is not part of that group.
         *
         * `w-full` is what makes it a row: a full-width item in a wrapping flex
         * container takes a line of its own. It is the last item rather than the
         * first so that the desktop bar keeps its single row of tools, inks and
         * weight and grows one line underneath it, instead of splitting that row
         * in two. The bar is anchored `bottom-4`, so the line arrives by pushing
         * the tools up; that is the cost of "directly underneath", and it is
         * paid once when a curve tool is armed rather than on every selection.
         *
         * A label and two toggles, not a readout: the coach is being asked a
         * question they have to answer before the curve is any use, and the
         * answer they are on has the accent behind it while the other one is
         * quiet. `aria-pressed` says the same thing without the colour.
         */}
        {showCurveSide && (
          <div
            role="group"
            aria-label="Bend direction"
            className="flex w-full items-center justify-center gap-2 border-t border-rule pt-2"
          >
            <span className="select-none text-[12px] font-medium tracking-[0.02em] text-ink-2">
              Bend
            </span>
            <div className="flex items-center gap-0.5 rounded border border-rule bg-sunken p-0.5">
              {(['left', 'right'] as CurveDirection[]).map((side) => (
                <Button
                  key={side}
                  variant={drawStyle.curve === side ? 'primary' : 'quiet'}
                  aria-pressed={drawStyle.curve === side}
                  onClick={() => setCurveSide(side)}
                  title={`Bend the ball to the ${side}`}
                  className="px-3 py-0.5 text-[12px] capitalize"
                >
                  {side}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Anchored to the tool group, never inside it, so nothing that comes
            and goes with the selection can slide Select along the row under a
            pointer already on its way to it. The bend row above is the one
            conditional thing now inside the bar, and it takes a line of its own
            rather than a place in that row for exactly this reason. Which of the
            two placements applies is measured above; `data-placement` is what
            says so out loud.

            **The pill is the one piece of this bar that still floats below
            `roomy`, and what it floats over has changed for the better rather
            than being fixed.** It is positioned against the bar, so the `above`
            placement goes wherever the bar's top edge is: that used to be a bar
            hanging `bottom-4` over the board, which put the pill squarely on the
            pitch. Docked, the same placement lands on the bench row and the
            readout underneath the canvas instead. It is only ever chrome over
            chrome while the pill is shorter than that stack — roughly 90px on a
            phone — and the player half of it wraps to two rows of swatches under
            a finger, so a tall pill can still reach the canvas box. Whether it
            should become a row of the bar the way Bend did is a real question
            and not one this change answers. */}
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
                against: it is stretched `left-0 right-0` across the bar, so a
                variant wider than the bar would hang off both ends of a band
                that clips. That was measured at 378 for curve + zone and 389
                for curve + ball against a phone-width bar — both of those
                included Bend, which has moved into the bar, so the wrap is
                needed at some narrower width now rather than at none. It is
                still needed: the player half alone puts seven swatches in this
                pill, and under a finger the 44px floor makes those 308px before
                SEL, Edit or the padding, on a bar that has 351px to live in at
                375px wide. The side placement is
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
