import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { buttonClass, pressMotion } from './Button'
import type { Variant } from './Button'
import { useDismiss } from './useDismiss'

interface Props {
  /**
   * Label content for the trigger. The popover renders the button itself: the
   * trigger has to carry `aria-expanded`, and a caller passing its own button
   * would nest one inside another.
   */
  trigger: ReactNode
  triggerVariant?: Variant
  triggerClassName?: string
  children: ReactNode
  align?: 'left' | 'right'
  className?: string
  /**
   * Optional controlled mode, for a popover whose contents have to be fetched
   * when it opens. Left alone, the popover manages its own state as before.
   */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Popover({
  trigger,
  triggerVariant = 'secondary',
  triggerClassName = '',
  children,
  align = 'left',
  className = '',
  open: controlledOpen,
  onOpenChange,
}: Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useDismiss(wrapRef, open, () => setOpen(false))

  /**
   * Hold the open panel inside the window.
   *
   * `align` anchors the panel to one edge of its trigger, which is right until
   * the trigger is near the opposite edge of the screen — and in a wrapping
   * toolbar the trigger's position is a function of how the row broke, not of
   * anything a caller can predict. Measured on the board's own bar, with no
   * caller doing anything wrong: at 375x812 **"Pitch options" opened at x-99**,
   * and at 320x568 "Saved shapes" did too. Both had been doing it since they
   * were written; nothing pointed at them because a panel that is half off the
   * screen still looks like a panel in a screenshot.
   *
   * Measured off `offsetWidth` and the trigger's box rather than off the panel's
   * own rect, because the panel is mid-spring when this runs: `getBoundingClientRect`
   * would include a `scale(0.985)` and quietly under-measure it.
   *
   * The correction rides on framer-motion's `x` rather than a `style` transform,
   * since motion owns this element's transform and the two would overwrite each
   * other.
   */
  const [shift, setShift] = useState(0)
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (!open) {
      setShift(0)
      setMaxHeight(undefined)
      return
    }
    const panel = panelRef.current
    const wrap = wrapRef.current
    if (!panel || !wrap) return

    const MARGIN = 8
    const GAP = 8 // the panel's own `mt-2`
    const width = panel.offsetWidth
    const trigger = wrap.getBoundingClientRect()
    const left = align === 'right' ? trigger.right - width : trigger.left
    const right = left + width

    // A panel wider than the window cannot be satisfied at both edges; pinning
    // the left one keeps its first words readable, which is the half that
    // matters when the alternative is neither.
    if (left < MARGIN) setShift(MARGIN - left)
    else if (right > window.innerWidth - MARGIN) setShift(window.innerWidth - MARGIN - right)
    else setShift(0)

    /**
     * And the same argument downwards, which is the half that bit hardest.
     *
     * A panel opens below its trigger, and in a bar that wraps, the trigger's
     * distance from the bottom of the window is a function of how many rows the
     * bar took — so on a short screen a perfectly ordinary panel finishes below
     * the fold. The board's Reset confirmation was 290px on a 320x568 phone
     * whose toolbar had wrapped to five rows, which left **the confirm button
     * itself under the edge of the screen** on a panel that otherwise looked
     * complete.
     *
     * Capped to the room that is actually there rather than flipped above the
     * trigger, because flipping does not help the case that caused this: a
     * wrapped bar is tall, so the space above is the smaller of the two. A panel
     * that scrolls its last line into reach is worse than one that fits and
     * better than one that cannot be finished.
     */
    setMaxHeight(Math.max(120, window.innerHeight - (trigger.bottom + GAP) - MARGIN))
  }, [open, align])

  return (
    <div ref={wrapRef} className="relative inline-block">
      <motion.button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        // Pointerdown rather than click, so the panel is already there under the
        // finger still on its way down. A keyboard press produces a click with
        // no pointer behind it, which `detail === 0` is the signal for, and that
        // is the other half of the same toggle.
        onPointerDown={(e) => {
          if (e.button === 0) setOpen(!open)
        }}
        onClick={(e) => {
          if (e.detail === 0) setOpen(!open)
        }}
        {...pressMotion}
        className={buttonClass(triggerVariant, triggerClassName)}
      >
        {trigger}
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, y: -6, scale: 0.985, x: shift }}
            animate={{ opacity: 1, y: 0, scale: 1, x: shift }}
            exit={{ opacity: 0, y: -6, scale: 0.985, x: shift }}
            transition={{ duration: 0.19, ease: [0.22, 1, 0.36, 1] }}
            style={{ transformOrigin: align === 'right' ? 'top right' : 'top left', maxHeight }}
            className={`absolute z-50 mt-2 overflow-y-auto ${align === 'right' ? 'right-0' : 'left-0'}
              bg-surface border border-rule rounded-lg p-3 shadow-2 ${className}`}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
