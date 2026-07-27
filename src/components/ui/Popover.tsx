import { useRef, useState } from 'react'
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

  useDismiss(wrapRef, open, () => setOpen(false))

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
            initial={{ opacity: 0, y: -6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.985 }}
            transition={{ duration: 0.19, ease: [0.22, 1, 0.36, 1] }}
            style={{ transformOrigin: align === 'right' ? 'top right' : 'top left' }}
            className={`absolute z-50 mt-2 ${align === 'right' ? 'right-0' : 'left-0'}
              bg-surface border border-rule rounded-lg p-3 shadow-2 ${className}`}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
