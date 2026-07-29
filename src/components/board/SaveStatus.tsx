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
 *
 * **This must never read "Ready" while a write would be refused.** "Ready" is
 * the resting state of a board that saves, and a board that cannot be saved to
 * has no resting state: it looked identical to a working board for the whole of
 * a session in which nothing the coach did was written anywhere.
 */
export default function SaveStatus() {
  const signedIn = useAuthStore((s) => s.email)
  const saveState = useBoardsStore((s) => s.saveState)

  if (!signedIn) return null

  const look = {
    idle: { dot: 'bg-ink-3', text: 'text-ink-3', label: 'Ready' },
    saving: { dot: 'bg-ink-2', text: 'text-ink-3', label: 'Saving' },
    saved: { dot: 'bg-accent', text: 'text-ink-3', label: 'Saved' },
    // --alert, not --home. This is an alarm and not a team, and while it
    // borrowed the home colour its legibility moved whenever a team's identity
    // did. --home is now the muted brick the chips are actually painted in,
    // which would have taken these two labels from 5.33:1 on the toolbar's
    // ground down to 3.34:1: below the floor, in the one state a coach must not
    // read past.
    offline: { dot: 'bg-alert', text: 'text-alert', label: 'Not saved' },
    blocked: { dot: 'bg-alert', text: 'text-alert', label: 'Not saving' },
  }[saveState]

  const title = {
    idle: 'Changes are saved to your account automatically.',
    saving: 'Changes are saved to your account automatically.',
    saved: 'Changes are saved to your account automatically.',
    offline: 'The last change could not be saved. Check that the API is running.',
    // One sentence for every way a board stops being writable, because they
    // end in the same place: the board could not be opened, the board stopped
    // being shared, this session was ended from somewhere else, or a peer
    // replaced the board with something this version cannot read. Which of them
    // it was is what the toast said; what this has to keep saying is that
    // nothing is being written. Both remedies are named because the tooltip
    // does not know which one applies.
    blocked:
      'Nothing you do on this board is being saved, and your saved copy is untouched. ' +
      'Open another board, or sign in again, to carry on.',
  }[saveState]

  return (
    <span
      title={title}
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
