import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useBoardStore } from '../../store/boardStore'
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

export default function FrameStrip() {
  const frames = useBoardStore((s) => s.frames)
  const playback = useBoardStore((s) => s.playback)
  const addFrame = useBoardStore((s) => s.addFrame)
  const deleteFrame = useBoardStore((s) => s.deleteFrame)
  const recaptureFrame = useBoardStore((s) => s.recaptureFrame)
  const setPlayback = useBoardStore((s) => s.setPlayback)

  const [exporting, setExporting] = useState<SequenceKind | null>(null)
  const hasFrames = frames.length > 0
  const canPlay = frames.length >= 2
  const lastFrame = Math.max(0, frames.length - 1)
  const nearest = playback.position >= 0 ? Math.round(playback.position) : -1
  const activeFrame = nearest >= 0 ? frames[nearest] : undefined

  const runExport = async (kind: SequenceKind) => {
    setExporting(kind)
    try {
      await boardHandles.exportSequence?.(kind)
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
      setExporting(null)
    }
  }

  const jumpTo = (i: number) => setPlayback({ position: i, playing: false })
  const stopPlayhead = () => setPlayback({ position: -1, playing: false })

  return (
    <div className="flex shrink-0 justify-center px-4 pb-2">
      <motion.div
        layout
        transition={spring}
        className="flex items-center gap-3 rounded-lg border border-rule bg-surface/95 px-3 py-2 shadow-2 backdrop-blur-[2px]"
      >
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={addFrame} title="Capture the current positions as a frame">
            + Frame
          </Button>
          {hasFrames && (
            <span className="font-mono text-[11px] text-ink-3">
              {frames.length} {frames.length === 1 ? 'frame' : 'frames'}
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
              className="flex items-center gap-3 overflow-hidden"
            >
              <span className="h-6 w-px bg-rule" />

              <div className="flex items-center gap-1.5">
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

              <span className="h-6 w-px bg-rule" />

              <div className="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  disabled={!canPlay}
                  onClick={() => setPlayback({ playing: !playback.playing })}
                  className="w-16"
                >
                  {playback.playing ? 'Pause' : 'Play'}
                </Button>

                <input
                  type="range"
                  min={0}
                  max={lastFrame}
                  step={0.01}
                  value={playback.position < 0 ? 0 : playback.position}
                  disabled={!canPlay}
                  onChange={(e) => setPlayback({ position: Number(e.target.value), playing: false })}
                  // A hundredth of a frame is the right grain for a pointer and
                  // hopeless for a key, which would need a hundred presses to
                  // reach the next frame. Arrows step whole frames instead.
                  onKeyDown={(e) => {
                    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
                    const to =
                      step !== 0
                        ? Math.round(Math.max(0, playback.position)) + step
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
                      variant={playback.speed === sp ? 'primary' : 'quiet'}
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
                    onClick={() => setPlayback({ [key]: !playback[key] })}
                    aria-pressed={playback[key]}
                    // 28x26 was under the 24px floor once the padding is taken
                    // off the text; the inset pseudo-element widens the target
                    // without moving the label.
                    className={`relative rounded px-1.5 py-1 text-[12px] transition-colors
                      before:absolute before:-inset-1.5 before:content-[''] ${
                        playback[key] ? 'text-accent' : 'text-ink-3 hover:text-ink'
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

              <span className="h-6 w-px bg-rule" />

              <div className="flex items-center gap-1.5">
                <Button
                  disabled={!canPlay || exporting !== null}
                  onClick={() => runExport('gif')}
                  className="text-[12px]"
                >
                  {exporting === 'gif' ? 'Rendering…' : 'GIF'}
                </Button>
                <Button
                  disabled={!canPlay || exporting !== null}
                  onClick={() => runExport('webm')}
                  className="text-[12px]"
                >
                  {exporting === 'webm' ? 'Recording…' : 'Video'}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
