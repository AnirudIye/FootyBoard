import { useBoardStore } from '../../store/boardStore'
import { Popover } from '../ui/Popover'
import { SWATCHES } from './Inspector'
import type { Side } from '../../lib/types'

/**
 * One control that puts a whole side in a kit.
 *
 * **Recolouring a team was eleven separate edits until this existed**, and doing
 * it that way is what made a format change look like a bug: the inspector
 * recolours the chip in front of you, so a coach who selected the eleven on the
 * pitch left five substitutes in the old kit, and going down to futsal and back
 * brought those five on. Nothing was corrupted and nothing was random — the
 * shuffle simply revealed which players had never been recoloured.
 *
 * So the unit here is the squad rather than the selection: pitch, bench, and the
 * team record that everything else reads afterwards. `Inspector`'s swatches stay
 * exactly as they were, because a single chip in a different colour is a real
 * thing to want — a trialist, a neutral player, the one being talked about.
 *
 * In the right-hand group beside `Add props`, which is the group for what is on
 * the pitch rather than for what the pitch is. Behind the lock, like `Reset` and
 * unlike `Appearance`: this is board content, shared with the room and visible
 * in an export, so a locked-out member must not be able to restrip both teams.
 * Gone rather than disabled, for the reason `ResetBoard` gives at more length —
 * `Popover` renders its own trigger, and `pointer-events-none` leaves it in the
 * tab order with Enter still opening it.
 */

const SIDES: [Side, string][] = [
  ['home', 'Home'],
  ['away', 'Away'],
]

export default function TeamKits() {
  const teams = useBoardStore((s) => s.teams)
  const setTeamColor = useBoardStore((s) => s.setTeamColor)

  const colorOf = (side: Side) => teams.find((t) => t.side === side)?.color ?? '#000000'

  return (
    <Popover align="right" className="w-[228px]" trigger="Team kits">
      <div className="flex flex-col gap-3">
        {SIDES.map(([side, label]) => {
          const current = colorOf(side)
          return (
            <div key={side}>
              <span className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-3">
                <span
                  aria-hidden
                  style={{ background: current }}
                  className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-black/15"
                />
                {label}
              </span>
              {/* The same palette the inspector offers, imported rather than
                  restated: two lists of swatches would drift, and the first
                  thing anybody would notice is a colour they can give one
                  player and not a team. */}
              <div className="flex flex-wrap items-center">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    aria-label={`${label} kit ${c}`}
                    aria-pressed={current === c}
                    onClick={() => setTeamColor(side, c)}
                    className="group grid h-7 w-7 place-items-center rounded"
                  >
                    <span
                      style={{ background: c }}
                      className={`h-5 w-5 rounded-sm border transition-transform duration-150 ease-out
                        group-hover:scale-110
                        ${current === c ? 'border-ink ring-1 ring-ink' : 'border-rule'}`}
                    />
                  </button>
                ))}
                <input
                  type="color"
                  value={current}
                  onChange={(e) => setTeamColor(side, e.target.value)}
                  aria-label={`${label} custom kit colour`}
                  className="ml-1 h-7 w-8 cursor-pointer rounded-sm border border-rule bg-transparent p-0"
                />
              </div>
            </div>
          )
        })}
        <p className="text-[12px] leading-relaxed text-ink-3">
          Both sides of the squad, substitutes included. A single player can still be recoloured
          from their own panel.
        </p>
      </div>
    </Popover>
  )
}
