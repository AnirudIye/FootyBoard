import { useId, useState, type ReactNode } from 'react'
import { field } from './AuthShell'

/**
 * A password box you can look at.
 *
 * Until this existed there was no way to see what you had typed anywhere in the
 * product, and the phone work is what made that urgent rather than merely
 * missing: a coach on a touchline typing into a phone keyboard has no way to
 * find a typo except to fail and start again. This product has no reset email,
 * so failing costs a security question rather than a click.
 *
 * **One component rather than a toggle per form.** There were eleven bare
 * `type="password"` inputs across seven files when this was written, and a
 * reveal is four separate decisions that each have exactly one right answer —
 * none of which is visible from the call site. All eleven go through here now,
 * and there are no bare ones left under `src/`; a twelfth should use this rather
 * than reopen any of those four questions.
 *
 * It takes what a bare `<input>` takes, plus the label, and renders the same
 * `<label>`/`<span>`/`<input>` shape the rest of `src/components/auth` uses. The
 * label is associated by `htmlFor` rather than by wrapping, which is the one
 * departure and is forced: a `<label>` may not contain a labelable element other
 * than the control it names, and the toggle is a `<button>`.
 *
 * **`hint` is a description and not part of the name.** The pages that carry one
 * used to put the sentence inside the `<label>`, where it became part of the
 * input's accessible name: a screen reader read the whole explanation as the
 * field's title every time focus landed there. `aria-describedby` is announced
 * after the name instead, which is what a sentence explaining *why* a field is
 * being asked for actually is.
 */
type Props = Omit<React.ComponentPropsWithoutRef<'input'>, 'type'> & {
  label: string
  hint?: ReactNode
}

export function PasswordField({ label, hint, className, ...input }: Props) {
  const id = useId()
  const hintId = `${id}-hint`
  /**
   * Component state and nothing more, deliberately.
   *
   * Not lifted, not in a store, and not in `localStorage`. Somewhere a
   * preference persists is somewhere a password sits in plain text on a screen
   * nobody asked to have it on: the next form, the next visit, or a phone handed
   * across a touchline. Every field starts concealed, every time.
   */
  const [revealed, setRevealed] = useState(false)

  return (
    <div className="block">
      <label
        htmlFor={id}
        className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3"
      >
        {label}
      </label>

      <div className="relative">
        <input
          {...input}
          id={id}
          aria-describedby={hint ? hintId : undefined}
          type={revealed ? 'text' : 'password'}
          /* Set unconditionally rather than only while revealed, because a phone
             keyboard reads them when the field takes focus and the reveal
             happens mid-typing. Without them a revealed password gets its first
             letter capitalised and a red underline drawn under it as you keep
             going, which turns a feature for catching typos into one that makes
             them. They cost nothing on a concealed field: a password input has
             no autocapitalise or spellcheck to turn off in the first place. */
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          /* `pr-16` clears the button rather than being a guess at it. Under a
             coarse pointer the floor in `index.css` makes both the input and the
             button 44px tall, so they meet exactly; the width is what the word
             costs, and `Show` and `Hide` are the same four characters so the
             field does not resize when it is toggled. */
          className={`${field} pr-16 ${className ?? ''}`}
        />

        {/* A real button, and `type="button"` is the load-bearing half of that:
            these all live inside a form, where the default is submit, so getting
            it wrong means looking at your password posts the form.

            The name changes with the state and carries the noun. `Show` alone
            would be the visible word and a fine label in isolation; on a form
            with two of these it says nothing about which box it opens. */}
        <button
          type="button"
          aria-pressed={revealed}
          aria-label={revealed ? 'Hide password' : 'Show password'}
          onClick={() => setRevealed((on) => !on)}
          className="absolute inset-y-0 right-0 flex items-center justify-center px-3
            font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3
            transition-colors duration-150 hover:text-ink
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {revealed ? 'Hide' : 'Show'}
        </button>
      </div>

      {hint && (
        <span id={hintId} className="mt-1.5 block text-[12px] leading-relaxed text-ink-3">
          {hint}
        </span>
      )}
    </div>
  )
}
