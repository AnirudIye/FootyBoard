interface Props {
  label: string
  value: string
  /** Overrides the value's colour, for readouts that carry a state. */
  className?: string
}

export function MonoReadout({ label, value, className }: Props) {
  return (
    <div className="flex items-baseline gap-1.5 font-mono text-[11px] leading-none">
      <span className="text-ink-3 tracking-[0.08em]">{label}</span>
      <span className={`tabular-nums ${className ?? 'text-ink'}`}>{value}</span>
    </div>
  )
}
