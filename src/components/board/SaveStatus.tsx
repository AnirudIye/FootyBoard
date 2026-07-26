import { useBoardsStore } from '../../store/boardsStore'
import { useAuthStore } from '../../store/authStore'

/**
 * Says whether the work is actually safe.
 *
 * "Is this saved?" should never need a guess: a guest is told plainly that
 * nothing is kept, and a failed write stays on screen until one succeeds,
 * rather than passing as a toast that has already faded.
 */
export default function SaveStatus() {
  const signedIn = useAuthStore((s) => s.email)
  const saveState = useBoardsStore((s) => s.saveState)

  if (!signedIn) {
    return (
      <span
        title="Sign in and your boards are kept. As a guest nothing is saved."
        className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-ink-3" />
        Not saving
      </span>
    )
  }

  const look = {
    idle: { dot: 'bg-ink-3', text: 'text-ink-3', label: 'Ready' },
    saving: { dot: 'bg-ink-2 animate-pulse', text: 'text-ink-3', label: 'Saving' },
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
      <span className={`h-1.5 w-1.5 rounded-full ${look.dot}`} />
      {look.label}
    </span>
  )
}
