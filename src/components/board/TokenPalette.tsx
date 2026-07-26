import { useBoardStore } from '../../store/boardStore'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import type { TokenType } from '../../lib/types'

const PROPS: { type: TokenType; label: string; color: string }[] = [
  { type: 'cone', label: 'Cone', color: '#c08a2e' },
  { type: 'pole', label: 'Pole', color: '#e7e2d6' },
  { type: 'goal', label: 'Mini goal', color: '#f0ece2' },
  { type: 'mannequin', label: 'Mannequin', color: '#4a4e54' },
  { type: 'arrowMarker', label: 'Marker', color: '#9c3b22' },
  { type: 'ball', label: 'Second ball', color: '#ffffff' },
]

export default function TokenPalette() {
  const addToken = useBoardStore((s) => s.addToken)

  return (
    <Popover
      align="right"
      className="w-[172px]"
      trigger={<Button>Add props</Button>}
    >
      <div className="flex flex-col gap-1.5">
        {PROPS.map((p) => (
          <Button
            key={p.type}
            className="justify-start"
            onClick={() =>
              addToken({
                type: p.type,
                color: p.color,
                x: 50,
                y: 50,
                rotation: 0,
              })
            }
          >
            <span
              aria-hidden
              style={{ background: p.color }}
              className="mr-1.5 inline-block h-3 w-3 rounded-sm border border-rule"
            />
            {p.label}
          </Button>
        ))}
        <span className="mt-1 text-[11px] leading-snug text-ink-3">
          Added at the centre. Drag into place, rotate from the inspector.
        </span>
      </div>
    </Popover>
  )
}
