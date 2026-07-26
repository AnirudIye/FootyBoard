import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

interface Props {
  trigger: ReactNode
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

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative inline-block">
      <span onClick={() => setOpen(!open)}>{trigger}</span>
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
