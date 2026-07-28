import { motion } from 'framer-motion'

interface Props {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}

export function Toggle({ checked, onChange, label }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2 text-[13px] text-ink-2 hover:text-ink
        transition-colors duration-150 ease-out rounded
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-accent"
    >
      <motion.span
        aria-hidden
        animate={{
          backgroundColor: checked ? 'rgb(var(--accent))' : 'rgb(var(--surface-sunken))',
          borderColor: checked ? 'rgb(var(--accent))' : 'rgb(var(--rule-strong))',
        }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className="relative h-[18px] w-[32px] shrink-0 rounded-full border"
      >
        {/* `left-[2px]` is load-bearing, not decoration. Without a horizontal
            anchor the knob resolves to its CSS static position and the `x`
            transform is measured from there rather than from the track, which
            put it past the track's right edge and on top of the label: the
            switches read as "nstructor mode" and "nonymous guests".

            Track is 32px wide with a 1px border, so the padding box is 30 and
            the knob travels 2 -> 16, sitting 2px inside each end. */}
        <motion.span
          animate={{ x: checked ? 14 : 0 }}
          transition={{ type: 'spring', stiffness: 620, damping: 34, mass: 0.5 }}
          className="absolute left-[2px] top-[2px] h-[12px] w-[12px] rounded-full
            bg-[#fbf9f5] shadow-1"
        />
      </motion.span>
      <span className="select-none">{label}</span>
    </button>
  )
}
