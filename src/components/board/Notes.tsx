import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useNotesStore } from '../../store/notesStore'
import { useAssistantStore } from '../../store/assistantStore'
import { useBoardStore } from '../../store/boardStore'
import { useRealtimeStore } from '../../store/realtimeStore'
import { MAX_NOTES } from '../../lib/persistence'

/**
 * The board's notes pad.
 *
 * Built as the assistant's twin on purpose: same corner, same spring, same
 * header with a `–` that puts it away, same launcher pill. Somebody who has
 * opened one knows how to open the other, and two panels that behave differently
 * in the same corner of the same board is how an interface starts feeling like
 * two products.
 *
 * Three things make it not simply a copy, and each is a decision rather than a
 * detail.
 *
 * **It is expandable.** A conversation is a column of short messages and 340px
 * suits it; a paragraph about a set piece is not, and the pad is where somebody
 * writes the one thing on this board that is prose. Expanded it is 680px wide
 * and most of the height, which is a text editor rather than a chat window.
 *
 * **What is typed here is the board's, not this browser's.** It lives in
 * `boardStore` beside the tokens, saves on the same debounce, travels to the
 * room as an op, and goes into the database inside the same `encrypt()` the rest
 * of the board payload does — so the notes on disk are AES-256-GCM ciphertext
 * and the key is in the environment. `notesStore` holds only whether the panel
 * is open and how big it is.
 *
 * **It follows the editing lock.** Notes are board content, so a member the
 * owner has locked out reads them and cannot write them, exactly as with a chip.
 * Read-only rather than hidden: instructor mode is for stopping people editing
 * the board, not for taking the team talk off their screen.
 */

const spring = { type: 'spring' as const, stiffness: 380, damping: 32, mass: 0.7 }

/** Where the counter stops being decoration and starts being a warning. */
const NEARLY_FULL = MAX_NOTES - 100

export default function Notes() {
  const open = useNotesStore((s) => s.open)
  const expanded = useNotesStore((s) => s.expanded)
  const setOpen = useNotesStore((s) => s.setOpen)
  const setExpanded = useNotesStore((s) => s.setExpanded)
  const assistantOpen = useAssistantStore((s) => s.open)

  const notes = useBoardStore((s) => s.notes)
  const setNotes = useBoardStore((s) => s.setNotes)
  const commit = useBoardStore((s) => s.commit)
  const locked = useRealtimeStore((s) => s.locked)

  const fieldRef = useRef<HTMLTextAreaElement>(null)

  // Opening the pad puts the caret in it. The panel exists to be typed in, and
  // the alternative is a text field somebody has to aim at on a phone.
  useEffect(() => {
    if (open && !locked) fieldRef.current?.focus()
  }, [open, locked])

  /**
   * Closing commits, and that is not tidiness.
   *
   * `setNotes` defers its undo step into `_pending` so a paragraph is one step
   * rather than one per keystroke, and it parks a flag when the note is too long
   * to send as an op. Both are answered by `commit()`. A pad that was closed
   * without one would leave the step open until the next unrelated gesture
   * committed it — which would then undo the drag *and* the typing together —
   * and would leave the room never told about a long note.
   */
  const close = () => {
    commit()
    setOpen(false)
  }

  const remaining = MAX_NOTES - notes.length

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={spring}
            style={{ transformOrigin: 'bottom right' }}
            /**
             * The size change is not animated, and that is deliberate rather
             * than unfinished. Width and height are layout properties, and
             * `plans/003-stop-animating-layout-properties.md` is this repo's
             * standing decision about animating those: every frame of it is a
             * reflow of a panel with a live `<textarea>` in it. The spring above
             * is on the entrance, which is a transform and a filter, and it is
             * the motion the assistant already has.
             *
             * Both sizes are capped in viewport units before they are capped in
             * pixels, so the expanded pad is 92% of a 375px phone rather than
             * 680px of one.
             */
            className={`fixed bottom-4 right-4 z-40 flex min-w-[300px] flex-col overflow-hidden
              rounded-lg border border-rule bg-surface shadow-2 ${
                expanded
                  ? 'h-[min(720px,82vh)] w-[min(680px,92vw)]'
                  : 'h-[min(460px,70vh)] w-[min(340px,32vw)]'
              }`}
          >
            <header className="flex items-center justify-between gap-2 border-b border-rule px-3 py-2">
              <div className="flex items-baseline gap-2">
                <span className="text-[14px] font-semibold tracking-[-0.01em]">Notes</span>
                <span className="font-mono text-[10px] tracking-[0.08em] text-ink-3">
                  {locked ? 'VIEW ONLY' : 'ON THIS BOARD'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {/* A word rather than a glyph, because this product has no
                    icons: plan 009 established there is not one icon-only
                    control anywhere in it, and an arrow-out symbol would be the
                    first thing here with no accessible name of its own. */}
                <button
                  onClick={() => setExpanded(!expanded)}
                  aria-pressed={expanded}
                  className="text-[12px] font-medium text-ink-3 transition-colors hover:text-ink"
                >
                  {expanded ? 'Shrink' : 'Expand'}
                </button>
                <button
                  onClick={close}
                  aria-label="Collapse notes"
                  className="text-ink-3 hover:text-ink text-[16px] leading-none transition-colors"
                >
                  –
                </button>
              </div>
            </header>

            <textarea
              ref={fieldRef}
              value={notes}
              readOnly={locked}
              onChange={(e) => setNotes(e.target.value, true)}
              // Blur ends the run the way lifting a finger ends a drag. Also the
              // moment a phone keyboard goes away, which is the likeliest end of
              // a note that never sees the collapse button.
              onBlur={commit}
              maxLength={MAX_NOTES}
              placeholder={
                locked
                  ? 'The owner has locked editing on this board.'
                  : 'Team talk, set pieces, what to fix at half time. Everyone on this board can read this.'
              }
              aria-label="Board notes"
              aria-describedby="notes-count"
              // `resize-none` because the panel is what resizes: a corner grip
              // would drag the field out past the box it is in.
              className="flex-1 resize-none bg-transparent px-3 py-3 text-[13px] leading-relaxed
                text-ink placeholder:text-ink-3 focus-visible:outline focus-visible:-outline-offset-2
                focus-visible:outline-2 focus-visible:outline-accent"
            />

            <div className="flex items-center justify-between gap-2 border-t border-rule px-3 py-1.5 text-[11px]">
              <span className="text-ink-3">
                {locked ? 'Read only while the board is locked.' : 'Saved with the board.'}
              </span>
              {/* `aria-live` so the count is announced as it approaches the cap
                  rather than only when somebody goes looking for it, and polite
                  so it waits for a gap in the typing. */}
              <span
                id="notes-count"
                aria-live="polite"
                className={`font-mono tracking-[0.04em] ${
                  notes.length >= NEARLY_FULL ? 'text-accent' : 'text-ink-3'
                }`}
              >
                {remaining === 0 ? 'Full' : `${notes.length}/${MAX_NOTES}`}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/**
       * The launcher, and why it hides for the assistant's panel as well as its
       * own.
       *
       * Both panels open in the same corner the two launchers sit in, so where
       * the chrome floats a launcher left standing under an open panel is a
       * 44px target nothing can reach — the same `elementFromPoint` failure the
       * frame strip had against this very button, recorded under item 14 in
       * `handoff.md`. Docked it stays mounted whatever is open, for the reason
       * `Assistant` gives at more length: the readout row is 20px with nothing
       * in it, and a row that loses its children collapses and re-fits the
       * pitch, which is a visible jump on the half of the screen no panel covers.
       *
       * Opening this closes the assistant, and opening the assistant closes
       * this. Two 300px panels cannot share the corner of a 375px phone, and
       * stacking them would mean choosing which one the other hides behind.
       */}
      <motion.button
        layout
        onClick={() => {
          if (open) close()
          else {
            useAssistantStore.getState().setOpen(false)
            setOpen(true)
          }
        }}
        aria-expanded={open}
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.95 }}
        transition={spring}
        className={`liquid-glass flex shrink-0 items-center gap-2 self-center rounded-full
          border border-rule-strong bg-surface px-4 py-2.5 text-[13px] font-medium text-ink shadow-2
          ${open || assistantOpen ? 'overlay:hidden' : ''}`}
      >
        {/* Filled when there is something written, hollow when there is not, so
            the board says whether it carries notes without anybody opening the
            pad to find out. The assistant's dot is always filled; this one has
            something to report. */}
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            notes.length > 0 ? 'bg-accent' : 'border border-ink-3'
          }`}
        />
        Notes
      </motion.button>
    </>
  )
}
