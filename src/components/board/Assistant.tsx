import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useAssistantStore } from '../../store/assistantStore'
import { useBoardStore } from '../../store/boardStore'
import { api } from '../../lib/api'
import { runAssistant } from './runAssistant'

const PROMPTS = [
  'Set up a 4-3-3',
  'Put the away team in a 4-4-2 mid block',
  'Clear the arrows',
  'Read the board',
]

const spring = { type: 'spring' as const, stiffness: 380, damping: 32, mass: 0.7 }

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
  const undoAction = useBoardStore((s) => s.undoAction)

  const [value, setValue] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, open, thinking])

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

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={spring}
            style={{ transformOrigin: 'bottom right' }}
            className="flex h-[min(460px,70vh)] w-[min(340px,32vw)] min-w-[300px] flex-col overflow-hidden
              rounded-lg border border-rule bg-surface shadow-2"
          >
            <header className="flex items-center justify-between border-b border-rule px-3 py-2">
              <div className="flex items-baseline gap-2">
                <span className="text-[14px] font-semibold tracking-[-0.01em]">Assistant</span>
                <span className="font-mono text-[10px] tracking-[0.08em] text-ink-3">OFFLINE</span>
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
                    Tell me what to set up. I run on your machine, so nothing you type here goes
                    anywhere.
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {PROMPTS.map((p) => (
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

            {/* The offer, not the switch. An earlier build promised in this very
                panel that an online assistant would ask first; a configured key
                makes the AI available, and this is where it gets turned on. */}
            {aiAvailable && !aiConsented && (
              <div className="flex items-center gap-2 border-t border-rule bg-sunken/60 px-3 py-1.5 text-[11px] text-ink-3">
                <span className="flex-1">
                  For anything it doesn't recognise, this can ask Google Gemini. That sends your
                  message and a summary of the board off the device. Everything it already
                  understands stays offline either way.
                </span>
                <button
                  onClick={() => setAiConsented(true)}
                  className="shrink-0 font-medium text-accent hover:text-accent-hover"
                >
                  Turn on
                </button>
              </div>
            )}

            {aiAvailable && aiConsented && !noticeDismissed && (
              <div className="flex items-center gap-2 border-t border-rule bg-sunken/60 px-3 py-1.5 text-[11px] text-ink-3">
                <span className="flex-1">
                  Anything the built-in commands don't cover goes to Google Gemini.{' '}
                  <button
                    onClick={() => setAiConsented(false)}
                    className="font-medium text-ink-2 underline hover:text-ink"
                  >
                    Keep it offline
                  </button>
                </span>
                <button onClick={dismissNotice} className="shrink-0 font-medium text-ink-2 hover:text-ink">
                  Got it
                </button>
              </div>
            )}

            {!aiAvailable && !noticeDismissed && (
              <div className="flex items-center gap-2 border-t border-rule bg-sunken/60 px-3 py-1.5 text-[11px] text-ink-3">
                <span className="flex-1">
                  This one is offline. Nothing you type here leaves the device.
                </span>
                <button onClick={dismissNotice} className="font-medium text-ink-2 hover:text-ink">
                  Got it
                </button>
              </div>
            )}

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
                className="flex-1 rounded border border-rule bg-paper px-2.5 py-1.5 text-[13px]
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              />
              <motion.button
                type="submit"
                whileTap={{ scale: 0.92 }}
                disabled={!value.trim()}
                className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-[#fbf9f5]
                  transition-colors duration-150 hover:bg-accent-hover disabled:opacity-40"
              >
                Send
              </motion.button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {!open && (
        <motion.button
          layout
          onClick={toggle}
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.95 }}
          transition={spring}
          className="liquid-glass flex items-center gap-2 rounded-full border border-rule-strong
            bg-surface px-4 py-2.5 text-[13px] font-medium text-ink shadow-2"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          Assistant
        </motion.button>
      )}
    </div>
  )
}
