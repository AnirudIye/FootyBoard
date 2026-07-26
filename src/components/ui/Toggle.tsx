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
        <motion.span
          animate={{ x: checked ? 15 : 2 }}
          transition={{ type: 'spring', stiffness: 620, damping: 34, mass: 0.5 }}
          className="absolute top-[2px] h-[12px] w-[12px] rounded-full bg-[#fbf9f5] shadow-1"
        />
      </motion.span>
      <span className="select-none">{label}</span>
    </button>
  )
}
