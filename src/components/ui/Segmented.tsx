import { useId } from 'react'
import { motion } from 'framer-motion'

/**
 * A row of mutually exclusive options with the chosen one underlined.
 *
 * Lived inside `Toolbar` until the theme control needed the same thing in the
 * account popover. Moved rather than copied: the reasoning under it is about
 * this palette rather than about the toolbar, and it is the kind of reasoning
 * that gets half-remembered by a second copy.
 */
export interface Option<T extends string> {
  id: T
  label: string
  /** A colour dot before the label, for options that are a thing not a mode. */
  dot?: string
}

// The active option is marked, not filled. A solid accent pill forces its label
// down to --paper, and near-black-on-green was the one place in the product
// where "selected" was written in the darkest ink on screen; the accent is a
// floodlit green, so nothing light enough to read as white survives on it
// (--ink on --accent measures 1.56:1 against a 4.5:1 floor, and no off-white
// can fix that). Underlining instead keeps the accent as the thing that marks
// the position and leaves the label on the group's own dark ground, where
// --ink reaches 17.33:1.
//
// This is also why there is no longer a tone variant. The old `team` tone
// existed only to opt out of the accent pill, on the grounds that the team you
// are editing is identified by its own colour rather than by the accent. With
// no pill to opt out of, the two readings render identically and the dot is
// still doing that job, so keeping two entries that differ in nothing was
// keeping a fork open for the next person to make them drift.
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: Option<T>[]
  value: T
  onChange: (v: T) => void
  disabled?: boolean
}) {
  // A shared layoutId slides the active marker between options.
  const group = useId()
  return (
    // `opacity-45` fades the group as one composite, label and bg-sunken
    // together, so the disabled label is read against a ground that faded with
    // it: 4.27:1 active, 2.59:1 inactive. Both sit under the 4.5:1 floor and
    // both are fine, because WCAG 1.4.3 exempts inactive components.
    //
    // The figures are written down because the near-miss is easy to make and
    // has been made: blending the label 45% toward the ground *after* the
    // ground has already faded charges the text for the opacity twice and
    // reads 4.18:1 / 2.52:1. Opacity applies to the group once. An element
    // with `opacity` renders itself and its descendants into one buffer, where
    // the label is still fully opaque over bg-sunken, and only that buffer is
    // blended over the header.
    <div
      className={`inline-flex flex-wrap items-center gap-0.5 rounded border border-rule bg-sunken p-0.5
        ${disabled ? 'opacity-45' : ''}`}
    >
      {options.map((o) => {
        const active = value === o.id
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            disabled={disabled}
            aria-pressed={active}
            className={`relative flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] font-medium
              transition-colors duration-150 disabled:cursor-not-allowed
              ${active ? 'text-ink' : 'text-ink-2 hover:text-ink'}`}
          >
            {active && (
              // No negative z-index here, unlike the pill this replaces: that
              // one had to sit behind its own label, and an underline never
              // overlaps one. Left at `auto` it paints above the group's
              // background, which is the only thing it has to clear.
              <motion.span
                layoutId={`seg-${group}`}
                transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.6 }}
                className="absolute inset-x-1.5 bottom-0 h-[2px] rounded-full bg-accent"
              />
            )}
            {o.dot && (
              <span
                className="h-2 w-2 rounded-full ring-1 ring-black/15"
                style={{ background: o.dot, opacity: active ? 1 : 0.5 }}
              />
            )}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}