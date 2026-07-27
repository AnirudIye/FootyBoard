import { motion } from 'framer-motion'
import { useBoardsStore } from '../../store/boardsStore'
import { useAuthStore } from '../../store/authStore'
import { EASE_OUT } from '../../theme/motion'

/**
 * Says whether the work is actually safe.
 *
 * "Is this saved?" should never need a guess, and a failed write stays on
 * screen until one succeeds rather than passing as a toast that has already
 * faded. A guest is told the same thing by the account menu, next to the button
 * that fixes it, so this says nothing at all until there is an account to save
 * to: the two of them side by side said "Not saving" twice.
 */
export default function SaveStatus() {
  const signedIn = useAuthStore((s) => s.email)
  const saveState = useBoardsStore((s) => s.saveState)

  if (!signedIn) return null

  const look = {
    idle: { dot: 'bg-ink-3', text: 'text-ink-3', label: 'Ready' },
    saving: { dot: 'bg-ink-2', text: 'text-ink-3', label: 'Saving' },
    saved: { dot: 'bg-accent', text: 'text-ink-3', label: 'Saved' },
    offline: { dot: 'bg-[rgb(var(--home))]', text: 'text-[rgb(var(--home))]', label: 'Not saved' },
  }[saveState]

  return (
    <span
      title={
        saveState === 'offline'
          ? 'The last change could not be saved. Check that the API is running.'
          : 'Changes are saved to your account automatically.'
      }
      className={`flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] ${look.text}`}
    >
      {/* One fade per change of state, not a pulse that never stops. A light
          that blinks forever in the top bar is a light people learn to ignore,
          which is the opposite of what a save indicator is for. */}
      <motion.span
        key={saveState}
        initial={{ opacity: 0.3 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35, ease: EASE_OUT }}
        className={`h-1.5 w-1.5 rounded-full ${look.dot}`}
      />
      {look.label}
    </span>
  )
}
