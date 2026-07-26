interface Props {
  min: number
  max: number
  step?: number
  value: number
  onChange: (value: number) => void
  label?: string
}

export function Slider({ min, max, step = 1, value, onChange, label }: Props) {
  return (
    // min-w-0 on the row and the track lets the range shrink to its container
    // instead of forcing the label wider than the panel that holds it.
    <label className="flex w-full min-w-0 items-center gap-2 text-[13px] text-ink-2">
      {label && <span className="shrink-0 select-none">{label}</span>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ accentColor: 'rgb(var(--accent))' }}
        className="h-2 min-w-0 flex-1 cursor-pointer"
      />
      <span className="w-8 shrink-0 text-right font-mono text-[12px] tabular-nums text-ink-2">
        {value}
      </span>
    </label>
  )
}
