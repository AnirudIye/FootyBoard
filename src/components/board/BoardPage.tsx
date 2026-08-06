import PitchCanvas from './PitchCanvas'
import Toolbar from './Toolbar'
import DrawingToolbar from './DrawingToolbar'
import FrameStrip from './FrameStrip'
import BenchRail from './BenchRail'
import Inspector from './Inspector'
import Toasts from './Toasts'
import HUD from './HUD'
import Assistant from './Assistant'
import Notes from './Notes'
import NameNotice from './NameNotice'
import { useKeyboard } from '../../hooks/useKeyboard'
import { useAutosave } from '../../hooks/useAutosave'
import { usePlayback } from '../../hooks/usePlayback'
import { useRealtime } from '../../hooks/useRealtime'
import { useShareLink } from '../../hooks/useShareLink'

export default function BoardPage() {
  // A `?share=` link is redeemed before anything else, so the board it names is
  // the one that opens rather than whichever was open last.
  useShareLink()
  useAutosave()
  useRealtime()
  useKeyboard()
  usePlayback()

  // A column, not a stack of floating bars at hand-measured offsets. The top
  // bar wraps to a second row at narrow widths and the frame strip grows when
  // frames are captured, so any fixed inset between them was a guess that came
  // apart: the HUD ended up underneath a wrapped toolbar. Here the middle band
  // is whatever is left over, and nothing inside it can reach the chrome.
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-paper">
      <Toolbar />
      {/* A row in the column rather than a floating bar, for the reason above:
          it appears and disappears, and anything overlaying the band would have
          to be measured against a toolbar that wraps. */}
      <NameNotice />

      {/**
       * The board band: a column of docked rows, or a canvas with the same four
       * elements floating over it. Which one is `overlay:`, and the variant's
       * own definition in `tailwind.config.ts` argues each of its three clauses.
       *
       * **At `overlay` nothing about this has changed.** The HUD, the two rails
       * and the drawing bar are all `absolute` there, which takes them out of
       * flow, so the canvas box below is the column's only in-flow child and
       * `flex-1` hands it the whole band. A one-item column with a `gap` puts no
       * gap anywhere. Every desktop is `overlay`, by the variant's first clause,
       * so the desktop layout is byte-for-byte the one that shipped — and that
       * is the test this arrangement had to pass.
       *
       * Docked, those same elements are ordinary rows stacked under the canvas
       * and the canvas box keeps whatever is left. **That is only cheap because
       * of which axis an upright phone is short of, and the arithmetic is the
       * reason the variant is not simply "small".** `computeMapping` fits 105:68
       * inside 90% of the canvas box on each axis, so on a 375px-wide phone the
       * horizontal pitch comes out 337.5 x 218.6 — width-constrained, and it
       * stays exactly that for any canvas box down to 243px tall. The band on a
       * 375x812 phone is about 576px and this chrome is 164px, or 179 with the
       * readout wrapped, so the pitch does not lose its first pixel until the
       * chrome passes 333px. What it buys is the 62.5px of drawn pitch the two
       * bench rails were standing on: 18.5% of the playing surface, and both
       * goalmouths.
       *
       * **One screen still pays, and it is named here rather than smoothed
       * over.** On `fullV` the pitch is height-constrained, so every docked row
       * comes out of it: 335.7 x 518.4 becomes 231.4 x 357.3 on the same phone.
       * That is a real cost and it is the deliberate trade — a smaller pitch
       * with all of itself visible beats a larger one with 21.4% of it behind
       * the chrome, and the goalmouths are the part that was hidden.
       *
       * Landscape is the screen this was measured against and then excluded. A
       * 375px-tall phone has about 188px of band and this chrome wants 164 of
       * it, which left **24px of canvas** while the switch was keyed on `roomy`.
       * The `(max-height: 639px)` clause is that measurement. Landscape floats,
       * is unchanged, and is still 009 step 5.
       */}
      <div className="relative flex flex-1 flex-col gap-1 overflow-hidden">
        {/* The canvas gets a box of its own rather than being the band, because
            the band now has other children in flow. `PitchCanvas` is
            `absolute inset-0`, so at `overlay` this box is the band's exact
            rectangle and it resolves against the same numbers it always did. */}
        <div className="relative min-h-0 flex-1">
          <PitchCanvas />
        </div>

        {/* The two rails, grouped so that docked they are one row: home on the
            left of it, away on the right, each with its own scroller.
            `overlay:contents` takes this wrapper out of the box tree there,
            which leaves the rails' `absolute` resolving against the band rather
            than against a wrapper — Toolbar's `More tools` and DrawingToolbar's
            `More` use the same trick and say why at more length.

            `order-1` rather than moving this below `<HUD />`: docked, the
            readout belongs above the bench, but the rails and the HUD are both
            `z-10` at `overlay` and paint in tree order, so swapping the two in the
            source would change which one wins where a long bench reaches the
            top-left corner. `order` is invisible to absolutely positioned
            children, which are not flex items, so it says the one thing here
            without saying anything there. */}
        <div className="order-1 flex gap-2 px-3 overlay:contents">
          <BenchRail side="home" />
          <BenchRail side="away" />
        </div>

        {/* The readout and the assistant's launcher, which docked are one row
            and floating are two unrelated corners of the board.

            `overlay:contents` again, and it is carrying more here than it does
            for the rails: the two children float to *opposite* corners, `HUD` to
            `top-4 left-4` and the launcher to `bottom-4 right-4`, so a wrapper
            that stayed in the box tree would be an element with no size in one
            corner and two absolutely positioned things resolving against it
            instead of against the band. Taking it out leaves both exactly where
            they were, which is the test: the desktop is unchanged.

            Docked they are a row, and that is the point of putting them
            together. The launcher was `fixed bottom-4 right-4` on every screen,
            which on a docked one is on top of the frame strip's right-hand end —
            `elementFromPoint` returned it for `GIF` and for `More` at 375x812.
            The readout row is the only row in the stack with width to spare and
            the shortest one in it, so 24px there buys the launcher a home and
            gives the strip back the 68px lane it had been holding open.

            The rule and the gutters are on this wrapper rather than on `HUD`,
            because docked they belong to the row and not to the readouts; see
            `HUD`, which gave them up for exactly this. */}
        <div className="flex items-center gap-2 border-t border-rule px-3 overlay:contents">
          <HUD />
          {/* The two launchers, which are one thing to position and two things
              to press. Both panels open at `bottom-4 right-4`, so both pills
              belong in that corner; giving each its own `fixed` would stack one
              on the other, and giving the second a hand-measured inset is the
              arrangement the comment at the top of this file rejects for the
              rest of the chrome — a guess that comes apart the first time a
              label changes width.

              So the pair is the box. Floating it is one `fixed` group in the
              corner; docked it is a single flex item at the right-hand end of
              the readout row, which is where the assistant's launcher already
              was. Each button keeps its own `overlay:hidden` rule, because
              docked the row has to keep its children — an emptied row collapses
              from 44px to 20px and the pitch re-fits underneath it. */}
          <div className="flex items-center gap-2 overlay:fixed overlay:bottom-4 overlay:right-4 overlay:z-40">
            <Notes />
            <Assistant />
          </div>
        </div>
        <DrawingToolbar />
      </div>

      <FrameStrip />

      <Inspector />
      <Toasts />
    </div>
  )
}
