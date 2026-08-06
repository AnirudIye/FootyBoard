import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useBoardStore } from '../../store/boardStore'
import { MAX_FRAMES } from '../../lib/frames'
import { SPRING_SNAP } from '../../theme/motion'
import { Button } from '../ui/Button'
import { boardHandles } from './boardHandles'
import type { SequenceKind } from './exportSequence'
import { toast } from '../../store/toastStore'
import { toUserMessage } from '../../lib/errors'

const spring = { type: 'spring' as const, stiffness: 460, damping: 34, mass: 0.6 }
const SPEEDS = [0.5, 1, 2]
const FLAGS = [
  ['loop', 'Loop', 'Loop'],
  ['eased', 'Ease', 'Ease movement'],
] as const

/**
 * What is tucked away below `strip`, and what it takes to bring it back.
 *
 * `contents` rather than a second bar: the wrapper leaves the box tree, so the
 * controls inside it stay direct flex items of the strip and the wide layout is
 * the one that shipped, in the same source order, with the same dividers
 * between the same groups. It is the trick `Toolbar` and `DrawingToolbar` both
 * use for their own `More`, and it is here for the same reason — a phone cannot
 * hold the whole bar and a desktop must not be changed to prove it.
 *
 * `strip:` and not `roomy:`, and the difference is measured: this bar is 920px
 * at three frames where a toolbar is 300, so `roomy`'s 640 left a 768px tablet
 * wrapping to three rows and eating 80px of pitch to do it, and a 1024px one
 * showing the whole bar with the assistant's launcher sitting on `Video`. See
 * the variant's own argument in `tailwind.config.ts`.
 */
const tuck = (open: boolean) => `${open ? 'contents' : 'hidden'} strip:contents`

/**
 * The rules between the groups, which only mean anything while the groups are
 * side by side.
 *
 * Closed, the bar is one line and they separate three groups on it. Opened on a
 * phone the groups wrap onto rows of their own, and a vertical hairline between
 * two stacked rows separates nothing — it just dangles at the end of a line. So
 * they go while the panel is open, and come back at `strip:` where the bar is
 * one line again whatever the disclosure says.
 */
const rule = (open: boolean) => `h-6 w-px bg-rule ${open ? 'hidden' : ''} strip:block`

export default function FrameStrip() {
  const frames = useBoardStore((s) => s.frames)

  /**
   * Where the playhead reads, and why the strip stops following it during an
   * export.
   *
   * An export scrubs the board through the whole sequence — 45 to 150 writes of
   * `playback.position` in a few seconds — and every one of them used to
   * re-render this component, which carries a `layout` animation on the strip
   * and another on every frame chip. Framer Motion measures on each of those, so
   * a twelve-frame storyboard paid for a hundred and fifty forced layouts of
   * thirteen elements to animate a scrub nobody asked for: the slider swept and
   * the chips lit up in turn while the person was waiting for a file.
   *
   * Freezing the reading here is what makes that stop, and it is not a
   * micro-optimisation. Measured against `npm run dev` in a Chromium at 375x812
   * under CPU throttling, with byte-identical GIFs out of both builds:
   *
   * ```
   * 3 captured frames,  4x CPU    6.44s -> 4.77s
   * 6 captured frames,  4x CPU   15.27s -> 10.38s
   * 12 captured frames, 6x CPU   40.52s -> 24.74s   worst single block 578ms -> 324ms
   * ```
   *
   * A third of a phone export was this component redrawing itself. It saves most
   * on the longest sequences because the cost is per chip as well as per frame,
   * which is exactly backwards from where it could be afforded.
   *
   * A ref rather than state, and read *inside* the selector, because that is
   * what actually stops the render: zustand re-renders on a selected value
   * changing, so returning the frozen number keeps it `Object.is`-equal and the
   * subscription goes quiet. Reading it after the fact would render and then
   * throw the render away. The two transitions each ride along with the
   * `setExporting` beside them, which is a real state change and does re-render.
   */
  const freeze = useRef<number | null>(null)
  const position = useBoardStore((s) => freeze.current ?? s.playback.position)
  // The rest of `playback` one field at a time, rather than the object: these do
  // not move during an export, and subscribing to the whole of it would have
  // re-rendered on `position` regardless of what `freeze` returned.
  const playing = useBoardStore((s) => s.playback.playing)
  const speed = useBoardStore((s) => s.playback.speed)
  const loop = useBoardStore((s) => s.playback.loop)
  const eased = useBoardStore((s) => s.playback.eased)
  const flagOn = { loop, eased }

  const addFrame = useBoardStore((s) => s.addFrame)
  const deleteFrame = useBoardStore((s) => s.deleteFrame)
  const recaptureFrame = useBoardStore((s) => s.recaptureFrame)
  const setPlayback = useBoardStore((s) => s.setPlayback)

  const [exporting, setExporting] = useState<SequenceKind | null>(null)
  const [progress, setProgress] = useState(0)
  // The `More` disclosure. Closed by default and only ever consulted below
  // `strip`, where `tuck` and `rule` are the things that read it.
  const [open, setOpen] = useState(false)

  const hasFrames = frames.length > 0
  const full = frames.length >= MAX_FRAMES
  const canPlay = frames.length >= 2
  const lastFrame = Math.max(0, frames.length - 1)
  const nearest = position >= 0 ? Math.round(position) : -1
  const activeFrame = nearest >= 0 ? frames[nearest] : undefined

  const runExport = async (kind: SequenceKind) => {
    freeze.current = useBoardStore.getState().playback.position
    setProgress(0)
    setExporting(kind)
    try {
      await boardHandles.exportSequence?.(kind, setProgress)
      toast(`Exported the sequence as ${kind.toUpperCase()}`)
    } catch (err) {
      toast(
        toUserMessage(
          err,
          kind === 'webm'
            ? 'The video could not be recorded. Exporting a GIF usually works.'
            : 'The GIF could not be created. Try again.',
        ),
      )
    } finally {
      freeze.current = null
      setExporting(null)
    }
  }

  const jumpTo = (i: number) => setPlayback({ position: i, playing: false })
  const stopPlayhead = () => setPlayback({ position: -1, playing: false })

  /**
   * An export button's label, which has to say three things in 46px.
   *
   * A percentage rather than "Rendering…" below `roomy`: the word is 90px wide
   * on a bar that has 343px of content to spend on four controls, and it says
   * less. A phone export runs for seconds rather than for a moment — that is
   * what the frame budget in `exportSequence` bought — so what it owes the
   * person holding it is evidence of movement, not a participle.
   */
  const exportLabel = (kind: SequenceKind, idle: string) =>
    exporting === kind ? (
      <>
        <span className="hidden roomy:inline">Rendering&nbsp;</span>
        {Math.round(progress * 100)}%
      </>
    ) : (
      idle
    )

  return (
    /**
     * The lane under the bar, kept for the one shape of screen where the cap on
     * the card below cannot do the job.
     *
     * The launcher floats wherever the board's chrome floats, and `overlay` is
     * true on a *short* screen as well as a wide one. So a 320x568 phone gets a
     * floating launcher and a bar centred in 320px, and there is no horizontal
     * answer at that width: the launcher owns 121px of the right edge, a centred
     * bar has to be under `320 - 242 = 78px` to clear it, and the smallest this
     * bar goes is 288. Capping it there produced a 48px column, which is the
     * measurement that put this rule back.
     *
     * 560 is where the cap starts being able to help — 288px of bar needs
     * `288 + 242` of screen — and the two rules are exact complements, so
     * every screen gets one of them and none gets both.
     */
    /* `px-2` under `strip`, and it buys exactly one pixel where one pixel is the
       whole difference. The compact bar is 329px; a 360x640 Android phone — the
       commonest portrait size there is — leaves 328 inside `px-4`, so `More`
       wrapped to a second row and the bar cost 56px of height to save 16 of
       gutter. Eight a side is ample beside a card that is already centred, and
       `strip:px-4` keeps every wide screen on the gutter it shipped with. The
       cap below is stated against `px-4` and is therefore conservative here
       rather than wrong. */
    <div className="flex shrink-0 justify-center px-2 pb-2 strip:px-4 overlay:max-[559px]:pb-[4.25rem]">
      <motion.div
        layout
        transition={spring}
        /**
         * `max-w-full` and `flex-wrap` are the guarantee, and the disclosure
         * below is what keeps them from ever being needed.
         *
         * This bar was one non-wrapping row centred in the viewport, inside a
         * page that is `overflow-hidden` on both axes. On a 375px phone with a
         * single frame captured it measured 846px wide, spanning -236 to 611:
         * seven of its eleven controls were off screen, `GIF` and `Video` among
         * them, and so was `+ Frame` — so a phone could capture one frame, could
         * not capture a second, and a GIF needs two. The feature was not slow on
         * a phone, it was unreachable. A tablet at 768px lost `+ Frame` at one
         * frame and `GIF` at two, and 812x375 landscape lost `GIF` at three.
         *
         * Wrapping alone would have answered it, at the price of a second row
         * eating the pitch the docked layout was arranged to protect. The
         * disclosure holds it to one line instead; wrapping is what happens when
         * a label grows anyway, and "wraps" is a far better failure than "leaves
         * the screen with nothing to scroll".
         *
         * **`overlay:max-w-` is the second guarantee, and it is about the
         * launchers rather than about the screen.** Where the board's chrome
         * floats, so do they — `bottom-4 right-4` — and this bar is centred, so
         * it reaches that corner the moment it is wider than the window less
         * twice the lane. No breakpoint can hold that off, because the bar's
         * width is a function of how many frames somebody captured rather than
         * of the window: at three frames it is 920px and clears a 1440px desktop
         * easily, and at twelve it is 1262 and does not. Capping the width makes
         * it wrap into the space it has instead of sliding under the buttons.
         *
         * **440 rather than 240, because there are two launchers now.** The
         * notes pad's pill sits beside the assistant's — measured at 1440x900,
         * the pair spans x1229..1424, so the lane is 211px rather than 121 and
         * twice it is 422. The old figure would have left a twelve-frame bar
         * ending at x1304 and the notes pill starting at x1229, which is the
         * exact defect this cap was added to stop, reintroduced by a button
         * somewhere else. The extra 18px over the arithmetic is the same margin
         * 240 carried over its own 242: room for a pill that renders wider than
         * measured, which a fallback font would do.
         *
         * What it costs is stated rather than buried: at 1440 the bar may be
         * 1000px instead of 1200, so a sequence long enough to need more than
         * that wraps a row earlier than it used to. That is the failure this
         * whole arrangement already prefers — a wrapped bar against a bar with
         * controls underneath a button.
         *
         * **The `max(288px, …)` floor is what stops the wider lane reaching
         * screens it would ruin.** A bare `100% - 440` is smaller than this
         * bar's own compact minimum on anything under about 730px, and a
         * max-width below the minimum does not narrow a bar, it turns it into a
         * tall column — the 48px-wide, 302px-high shape that put the lane back
         * in the first place. Those widths are real and are the worst screens
         * the app has: an iPhone SE held sideways is 667x375, and `overlay` is
         * true there on the short-screen clause, so it takes this rule rather
         * than the lane. Floored, such a screen keeps the bar it has today and
         * the cap simply stops applying, which is the same trade as `min-[560px]`
         * below and reached by arithmetic rather than by a second breakpoint.
         *
         * Docked there is no cap, because docked the launcher is a flex item in
         * the readout row and is not over this bar at any width. See `BoardPage`.
         * `min-[560px]` is the other exception and it is not a taste: below that
         * the cap is arithmetically smaller than the bar's own minimum and
         * produces a 48px column, so the row above keeps a lane instead.
         */
        className="flex max-w-full flex-wrap items-center justify-center gap-3 rounded-lg
          border border-rule bg-surface/95 px-3 py-2 shadow-2 backdrop-blur-[2px]
          overlay:min-[560px]:max-w-[max(288px,calc(100%-440px))]"
      >
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            onClick={addFrame}
            disabled={full}
            // The disabled state has to say why, or a control that has quietly
            // stopped working is indistinguishable from one that is broken —
            // and this one is the primary action on the bar.
            title={
              full
                ? `A sequence holds at most ${MAX_FRAMES} frames. Delete one to capture another.`
                : 'Capture the current positions as a frame'
            }
          >
            + Frame
          </Button>
          {hasFrames && (
            // The count is the only thing telling a phone how many frames it
            // has, because the chips it would count are behind `More` there.
            // The word is not: it costs 32px that the primary row does not have.
            <span className="font-mono text-[11px] text-ink-3">
              {frames.length}
              <span className="hidden roomy:inline">
                {' '}
                {frames.length === 1 ? 'frame' : 'frames'}
              </span>
            </span>
          )}
        </div>

        <AnimatePresence>
          {hasFrames && (
            // Scale and fade rather than an animated width: a spring on `width`
            // relaid out the whole strip on every frame, and reduced-motion
            // cannot see a raw width the way it sees a transform.
            <motion.div
              initial={{ opacity: 0, scaleX: 0.92 }}
              animate={{ opacity: 1, scaleX: 1 }}
              exit={{ opacity: 0, scaleX: 0.92 }}
              transition={SPRING_SNAP}
              style={{ transformOrigin: 'left center' }}
              // `flex-wrap` here as well as on the strip: opened, this holds
              // every control the bar has, and it has to give way on the axis
              // that is short rather than push its ends past the screen.
              className="flex max-w-full flex-wrap items-center justify-center gap-3"
            >
              {/* The frames themselves: a phone gets them from `More`. Chosen
                  over `Play` and the export pair for the tuck because they are
                  how a sequence is *edited*, and the three that stay are how it
                  is built, checked and sent — which is the whole of what a
                  phone is for here. */}
              <div className={tuck(open)}>
                <span className={rule(open)} />

                <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5">
                  <AnimatePresence initial={false}>
                    {frames.map((f, i) => {
                      const active = nearest === i
                      return (
                        <motion.button
                          key={f.id}
                          layout
                          initial={{ opacity: 0, scale: 0.92 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.92 }}
                          whileTap={{ scale: 0.9 }}
                          transition={spring}
                          onClick={() => jumpTo(i)}
                          onDoubleClick={() => recaptureFrame(f.id)}
                          title="Click to view, double-click to recapture"
                          className={`grid h-8 w-8 place-items-center rounded border font-mono text-[12px]
                            transition-colors duration-150 ${
                              active
                                ? 'border-accent bg-accent text-paper'
                                : 'border-rule bg-paper text-ink-2 hover:border-rule-strong'
                            }`}
                        >
                          {f.label}
                        </motion.button>
                      )
                    })}
                  </AnimatePresence>
                </div>

                {activeFrame && (
                  <Button
                    variant="quiet"
                    className="text-[12px] text-accent"
                    onClick={() => deleteFrame(activeFrame.id)}
                  >
                    Delete {activeFrame.label}
                  </Button>
                )}
              </div>

              <span className={rule(open)} />

              {/* Every group wraps, not only the bar. A nested row that cannot
                  wrap is a hole in the guarantee the bar makes: opened on a
                  phone this group holds `Play`, the 160px scrub, three speeds
                  and two flags — 485px of controls — and it took them from x-55
                  to x430 of a 375px screen while the bar around it sat neatly
                  inside its margins. Found by measuring the opened panel rather
                  than by looking at it, because the bar's own box was right. */}
              <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5">
                <Button
                  variant="secondary"
                  disabled={!canPlay}
                  onClick={() => setPlayback({ playing: !playing })}
                  className="w-16"
                >
                  {playing ? 'Pause' : 'Play'}
                </Button>

                {/* Everything that shapes playback rather than starting it. The
                    scrub is the widest control on the bar at 160px, and it is
                    the one a phone can do without: the chips it duplicates are
                    a tap away in the same panel. */}
                <div className={tuck(open)}>
                  <input
                    type="range"
                    min={0}
                    max={lastFrame}
                    step={0.01}
                    value={position < 0 ? 0 : position}
                    disabled={!canPlay}
                    onChange={(e) => setPlayback({ position: Number(e.target.value), playing: false })}
                    // A hundredth of a frame is the right grain for a pointer and
                    // hopeless for a key, which would need a hundred presses to
                    // reach the next frame. Arrows step whole frames instead.
                    onKeyDown={(e) => {
                      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
                      const to =
                        step !== 0
                          ? Math.round(Math.max(0, position)) + step
                          : e.key === 'Home'
                            ? 0
                            : e.key === 'End'
                              ? lastFrame
                              : null
                      if (to === null) return
                      e.preventDefault()
                      setPlayback({ position: Math.min(lastFrame, Math.max(0, to)), playing: false })
                    }}
                    style={{ accentColor: 'rgb(var(--accent))' }}
                    className="w-40 cursor-pointer"
                    aria-label="Scrub"
                  />

                  <div className="flex items-center gap-0.5 rounded border border-rule bg-sunken p-0.5">
                    {SPEEDS.map((sp) => (
                      <Button
                        key={sp}
                        variant={speed === sp ? 'primary' : 'quiet'}
                        onClick={() => setPlayback({ speed: sp })}
                        className="px-1.5 py-0.5 text-[11px]"
                      >
                        {sp}x
                      </Button>
                    ))}
                  </div>

                  {FLAGS.map(([key, label, hint]) => (
                    <button
                      key={key}
                      onClick={() => setPlayback({ [key]: !flagOn[key] })}
                      aria-pressed={flagOn[key]}
                      // 28x26 was under the 24px floor once the padding is taken
                      // off the text; the inset pseudo-element widens the target
                      // without moving the label.
                      className={`relative rounded px-1.5 py-1 text-[12px] transition-colors
                        before:absolute before:-inset-1.5 before:content-[''] ${
                          flagOn[key] ? 'text-accent' : 'text-ink-3 hover:text-ink'
                        }`}
                      title={hint}
                    >
                      {label}
                    </button>
                  ))}

                  {nearest >= 0 && (
                    <Button variant="quiet" className="text-[12px]" onClick={stopPlayhead}>
                      Live
                    </Button>
                  )}
                </div>
              </div>

              <span className={rule(open)} />

              <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5">
                <Button
                  disabled={!canPlay || exporting !== null}
                  onClick={() => runExport('gif')}
                  aria-busy={exporting === 'gif'}
                  className="text-[12px]"
                >
                  {exportLabel('gif', 'GIF')}
                </Button>
                {/* The video is behind `More` and the GIF is not, and the reason
                    is arithmetic rather than a judgement about which is better.
                    The primary row comes to 313px of the 319px a 375px phone
                    leaves inside the bar; `Video` is 61 more and would wrap it.
                    Of the two, the GIF is the one that plays everywhere it might
                    be sent, which is what an export from a phone is for. */}
                <div className={tuck(open)}>
                  <Button
                    disabled={!canPlay || exporting !== null}
                    onClick={() => runExport('webm')}
                    aria-busy={exporting === 'webm'}
                    className="text-[12px]"
                  >
                    {exportLabel('webm', 'Video')}
                  </Button>
                </div>
              </div>

              {/* The disclosure itself, which exists only where the bar cannot
                  hold everything. `Toolbar` and `DrawingToolbar` both carry the
                  same control with the same two words. */}
              <button
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-label={open ? 'Fewer sequence controls' : 'More sequence controls: frames, scrubbing and video'}
                className="rounded px-1.5 py-1 text-[12px] text-ink-3 transition-colors
                  duration-150 ease-out hover:text-ink strip:hidden"
              >
                {open ? 'Less' : 'More'}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
