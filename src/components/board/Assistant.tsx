import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useAssistantStore } from '../../store/assistantStore'
import { useNotesStore } from '../../store/notesStore'
import { useBoardStore } from '../../store/boardStore'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { api } from '../../lib/api'
import { runAssistant } from './runAssistant'

const PROMPTS = [
  'Set up a 4-3-3',
  'Put the away team in a 4-4-2 mid block',
  'Clear the arrows',
  'Read the board',
]

/**
 * The one opener that is offered only once the online half is on.
 *
 * A tactical question is the thing the offline assistant cannot answer, so
 * suggesting it to somebody running offline is suggesting a dead end. The other
 * four work either way, which is why they are always there.
 */
const TACTICS_PROMPT = 'How do I play against a 4-2-3-1?'

const spring = { type: 'spring' as const, stiffness: 380, damping: 32, mass: 0.7 }

interface NoticeSpec {
  text: string
  action?: { label: string; run: () => void }
  onDismiss?: () => void
}

/** The strip above the composer. There is at most one, and it says one thing. */
function Notice({ text, action, onDismiss }: NoticeSpec) {
  return (
    <div className="flex items-center gap-2 border-t border-rule bg-sunken/60 px-3 py-1.5 text-[11px] text-ink-3">
      <span className="flex-1">{text}</span>
      {action && (
        <button
          onClick={action.run}
          className="shrink-0 font-medium text-accent hover:text-accent-hover"
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 font-medium text-ink-2 hover:text-ink">
          Got it
        </button>
      )}
    </div>
  )
}

export default function Assistant() {
  const open = useAssistantStore((s) => s.open)
  const toggle = useAssistantStore((s) => s.toggle)
  const messages = useAssistantStore((s) => s.messages)
  const noticeDismissed = useAssistantStore((s) => s.noticeDismissed)
  const dismissNotice = useAssistantStore((s) => s.dismissNotice)
  const aiAvailable = useAssistantStore((s) => s.aiAvailable)
  const aiConsented = useAssistantStore((s) => s.aiConsented)
  const setAiConsented = useAssistantStore((s) => s.setAiConsented)
  const thinking = useAssistantStore((s) => s.thinking)
  const notesOpen = useNotesStore((s) => s.open)
  const undoAction = useBoardStore((s) => s.undoAction)
  const reduced = useReducedMotion()

  /**
   * Opening this puts the notes pad away, and `Notes` does the same in reverse.
   *
   * Both panels are `bottom-4 right-4` and both are at least 300px wide, so on a
   * 375px phone they cannot both be there. Two of them open would mean deciding
   * which one hides behind the other, and a panel somebody opened being covered
   * by a panel they did not is worse than the one they asked for replacing the
   * one they had finished with. The collapse button uses the plain toggle: it is
   * already closing this one, and nothing should reopen anything.
   */
  const openHere = () => {
    if (!open) useNotesStore.getState().setOpen(false)
    toggle()
  }

  const [value, setValue] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Programmatic smooth scrolling is a vestibular trigger, and neither the
    // CSS block nor MotionConfig can reach it.
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: reduced ? 'auto' : 'smooth',
    })
  }, [messages, open, thinking, reduced])

  // Asked once, the first time the panel is opened. A server with no key never
  // offers the AI at all, so nobody is shown a switch that does nothing.
  useEffect(() => {
    if (!open || aiAvailable) return
    let cancelled = false
    void api
      .assistantStatus()
      .then(({ enabled }) => {
        if (!cancelled && enabled) useAssistantStore.getState().setAiAvailable(true)
      })
      .catch(() => {
        // Offline, signed out, or an older server: stay rule-based in silence.
      })
    return () => {
      cancelled = true
    }
  }, [open, aiAvailable])

  const submit = (text: string) => {
    runAssistant(text)
    setValue('')
  }

  // What the panel actually is right now. Saying OFFLINE while a message is on
  // its way to Google was the one thing this header could not be allowed to do.
  const hybrid = aiAvailable && aiConsented

  const notice = ((): NoticeSpec | null => {
    // The offer, not the switch. An earlier build promised in this very panel
    // that an online assistant would ask first; a configured key makes the AI
    // available, and this is where it gets turned on. It stays until answered.
    if (aiAvailable && !aiConsented) {
      return {
        text:
          "For anything it doesn't recognise, this can ask Google Gemini. That sends your " +
          'message and a summary of the board off the device. Everything it already ' +
          'understands stays offline either way.',
        action: { label: 'Turn on', run: () => setAiConsented(true) },
      }
    }
    if (noticeDismissed) return null
    if (hybrid) {
      return {
        text: "Anything the built-in commands don't cover goes to Google Gemini.",
        action: { label: 'Keep it offline', run: () => setAiConsented(false) },
        onDismiss: dismissNotice,
      }
    }
    return {
      text: 'This one is offline. Nothing you type here leaves the device.',
      onDismiss: dismissNotice,
    }
  })()

  /**
   * The panel and the launcher are two independent things now, where they used
   * to be a positioning wrapper with both inside it.
   *
   * That wrapper never actually stacked anything: the panel renders only while
   * `open` and the launcher only while it is not, so its `flex-col items-end
   * gap-2` had nothing to lay out and it was a `fixed bottom-4 right-4` and
   * nothing else. Flattening it is what lets the launcher dock while the panel
   * goes on floating — see the launcher below for why it has to.
   */
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
            // The panel floats everywhere and always did. It is 300x460 of
            // conversation, which is not a thing any row on a phone can hold,
            // and a panel over the board is the right shape for it anyway.
            className="fixed bottom-4 right-4 z-40 flex h-[min(460px,70vh)] w-[min(340px,32vw)]
              min-w-[300px] flex-col overflow-hidden rounded-lg border border-rule bg-surface shadow-2"
          >
            <header className="flex items-center justify-between border-b border-rule px-3 py-2">
              <div className="flex items-baseline gap-2">
                <span className="text-[14px] font-semibold tracking-[-0.01em]">Assistant</span>
                <span className="font-mono text-[10px] tracking-[0.08em] text-ink-3">
                  {hybrid ? 'HYBRID' : 'OFFLINE'}
                </span>
              </div>
              <button
                onClick={toggle}
                aria-label="Collapse assistant"
                className="text-ink-3 hover:text-ink text-[16px] leading-none transition-colors"
              >
                –
              </button>
            </header>

            <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
              {messages.length === 0 && (
                <div className="space-y-3">
                  <p className="text-[13px] leading-relaxed text-ink-2">
                    {hybrid
                      ? 'Tell me what to set up, or ask how to play with or against a shape. Everything I recognise runs on your machine. Anything else can go to Google Gemini.'
                      : 'Tell me what to set up. I run on your machine, so nothing you type here goes anywhere.'}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {(hybrid ? [...PROMPTS, TACTICS_PROMPT] : PROMPTS).map((p) => (
                      <button
                        key={p}
                        onClick={() => submit(p)}
                        className="rounded border border-rule bg-paper px-2.5 py-1.5 text-left text-[12.5px]
                          text-ink-2 transition-colors duration-150 hover:border-rule-strong hover:text-ink"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((m) => (
                <motion.div
                  key={m.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.16 }}
                  className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
                >
                  <div
                    className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-[13px] leading-snug ${
                      m.role === 'user'
                        ? 'bg-accent text-paper'
                        : 'border border-rule bg-sunken text-ink'
                    }`}
                  >
                    {m.text}
                    {m.undoable && (
                      <button
                        onClick={() => undoAction()}
                        className="ml-2 font-medium text-accent hover:text-accent-hover"
                      >
                        Undo
                      </button>
                    )}
                  </div>
                </motion.div>
              ))}

              {thinking && (
                <motion.div
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="font-mono text-[11px] tracking-[0.08em] text-ink-3"
                >
                  <span className="animate-pulse">thinking…</span>
                </motion.div>
              )}
            </div>

            {notice && <Notice {...notice} />}

            <form
              onSubmit={(e) => {
                e.preventDefault()
                submit(value)
              }}
              className="flex items-center gap-2 border-t border-rule px-2.5 py-2"
            >
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Ask the board to do something"
                // The placeholder is not a name: it is gone the moment anybody
                // types, and several screen readers never announce it at all.
                // This was the one control on the whole board with no
                // accessible name of any kind.
                aria-label="Ask the board to do something"
                className="flex-1 rounded border border-rule bg-paper px-2.5 py-1.5 text-[13px]
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              />
              <motion.button
                type="submit"
                whileTap={{ scale: 0.92 }}
                disabled={!value.trim()}
                className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-paper
                  transition-colors duration-150 hover:bg-accent-hover disabled:opacity-40"
              >
                Send
              </motion.button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {/**
       * The launcher floats where the rest of the board's chrome floats, and
       * docks where the rest of it docks. That is the whole rule, and `overlay:`
       * is the variant that already says it — `HUD` is arranged the same way and
       * argues the same split.
       *
       * **It used to float everywhere, and on a docked screen that meant it
       * stood on the frame strip.** It is `bottom-4 right-4` and 105x44, so it
       * owns the last 60px of the viewport's corner; the strip is a docked row
       * that ends in that same corner. Measured at 375x812 with three frames
       * captured, `elementFromPoint` at the centre of each strip control
       * returned this button for both `GIF` and `More`. They were on screen, the
       * right size, and could not be tapped. A 68px lane on the strip bought its
       * way out of that and cost the vertical pitch 68px to do it; docking costs
       * the HUD row 24 and gives the rest back.
       *
       * Docked it is a flex item at the right-hand end of the readout row, which
       * is the one row in the stack with width to spare — four readouts come to
       * about 334px of the 375 a phone has, and the row is the shortest thing in
       * the column at 20px precisely because there is nothing in it to hit.
       * This is the first thing in it there is.
       *
       * **It stays mounted while the panel is open, and only hides itself where
       * it floats.** Unmounting is what it did before, which was free when it
       * was floating and is not now: a docked row that loses its only 44px child
       * collapses from 44px to 20px, the canvas above it grows, and the pitch
       * re-fits — a visible jump on the half of the screen the panel does not
       * cover, every time somebody opens the assistant. Left in place it also
       * gives the docked panel a second way to be dismissed, which the floating
       * one never needed because it had nowhere to sit.
       */}
      <motion.button
        layout
        onClick={openHere}
        aria-expanded={open}
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.95 }}
        transition={spring}
        /**
         * **The corner positioning moved out to `BoardPage`, and the launcher
         * kept everything else.** There are two of these buttons now — this and
         * the notes pad's — and they share one corner, so the thing that has to
         * be positioned is the pair rather than each of them: two `fixed`
         * buttons at `bottom-4 right-4` would be one button on top of another,
         * and the alternative is a hand-measured inset on the second, which is
         * exactly the arrangement `BoardPage`'s own opening comment rejects for
         * the rest of this chrome. The wrapper carries `overlay:fixed
         * overlay:bottom-4 overlay:right-4 overlay:z-40`; docked it is a flex
         * item in the readout row, which is where this button already lived.
         *
         * `overlay:hidden` still belongs here rather than on the wrapper,
         * because docked the row must keep its children — see the long note
         * below — and it now watches the notes panel too: either panel open
         * covers this corner, and a launcher underneath one is a target
         * `elementFromPoint` cannot reach.
         */
        className={`liquid-glass flex shrink-0 items-center gap-2 self-center rounded-full
          border border-rule-strong bg-surface px-4 py-2.5 text-[13px] font-medium text-ink shadow-2
          ${open || notesOpen ? 'overlay:hidden' : ''}`}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
        Assistant
      </motion.button>
    </>
  )
}
