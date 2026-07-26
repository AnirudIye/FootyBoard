import { AnimatePresence, motion } from 'framer-motion'
import { useToastStore } from '../../store/toastStore'

export default function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 460, damping: 34, mass: 0.6 }}
            className="pointer-events-auto flex items-center gap-3 rounded border border-rule-strong
              bg-surface px-3.5 py-2 text-[13px] text-ink shadow-2"
          >
            <span>{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action?.run()
                  dismiss(t.id)
                }}
                className="font-medium text-accent hover:text-accent-hover transition-colors duration-150"
              >
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
