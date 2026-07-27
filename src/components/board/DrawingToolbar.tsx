import { motion } from 'framer-motion'
import { useBoardStore } from '../../store/boardStore'
import type { ToolMode } from '../../store/boardStore'
import { isZone, isCurve, curveControl } from '../../lib/drawings'
import type { CurveDirection } from '../../lib/drawings'
import { Slider } from '../ui/Slider'
import { Button } from '../ui/Button'
import { useRealtimeStore } from '../../store/realtimeStore'

const TOOLS: { id: ToolMode; label: string; hint: string }[] = [
  { id: 'select', label: 'Select', hint: 'Select and move (Esc)' },
  { id: 'pen', label: 'Pen', hint: 'Freehand' },
  { id: 'line', label: 'Line', hint: 'Straight line' },
  { id: 'arrow', label: 'Run', hint: 'Run or dribble arrow' },
  { id: 'dashedArrow', label: 'Pass', hint: 'Pass arrow (dashed)' },
  { id: 'curveArrow', label: 'Bend', hint: 'Curved run or shot. Pick which way it bends' },
  { id: 'curvePass', label: 'Bent pass', hint: 'Curved pass (dashed). Pick which way it bends' },
  { id: 'zoneRect', label: 'Box', hint: 'Rectangular zone' },
  { id: 'zoneEllipse', label: 'Oval', hint: 'Elliptical zone' },
  { id: 'zonePoly', label: 'Shape', hint: 'Free polygon: click points, Enter to close' },
  { id: 'text', label: 'Text', hint: 'Text label' },
]

// Inks that read on the floodlit pitch; black is kept for the chalk theme.
const INKS = ['#2ae07a', '#f4f2ef', '#e85c42', '#529ae0', '#e0b23c', '#17191d']

export default function DrawingToolbar() {
  const tool = useBoardStore((s) => s.tool)
  const setTool = useBoardStore((s) => s.setTool)
  const drawStyle = useBoardStore((s) => s.drawStyle)
  const setDrawStyle = useBoardStore((s) => s.setDrawStyle)
  const selection = useBoardStore((s) => s.selection)
  const drawings = useBoardStore((s) => s.drawings)
  const tokens = useBoardStore((s) => s.tokens)
  const updateDrawing = useBoardStore((s) => s.updateDrawing)
  const deleteDrawings = useBoardStore((s) => s.deleteDrawings)
  const locked = useRealtimeStore((s) => s.locked)

  const selectedDrawings = drawings.filter((d) => selection.includes(d.id))
  const selectedTokens = tokens.filter((t) => selection.includes(t.id))
  const hasZoneSelected = selectedDrawings.some((d) => isZone(d.type))
  const showZoneOpacity = hasZoneSelected || (tool !== 'select' && isZone(tool))

  const selectedCurves = selectedDrawings.filter((d) => isCurve(d.type))
  const showCurveSide = selectedCurves.length > 0 || (tool !== 'select' && isCurve(tool))

  // Sets which way the bend goes: on a selected curve it re-bends it now, and
  // it becomes the default for the next one either way.
  const setCurveSide = (curve: CurveDirection) => {
    for (const d of selectedCurves) updateDrawing(d.id, { control: curveControl(d.points, curve) })
    setDrawStyle({ curve })
  }

  // Applying a style change hits the selection when there is one, otherwise it
  // becomes the default for the next drawing.
  const applyStyle = (patch: { color?: string; thickness?: number; fillOpacity?: number }) => {
    if (selectedDrawings.length > 0) {
      for (const d of selectedDrawings) updateDrawing(d.id, patch)
    }
    setDrawStyle(patch)
  }

  const canAttach = selectedDrawings.length === 1 && selectedTokens.length === 1
  const attached = selectedDrawings.length === 1 && selectedDrawings[0].attachedTokenId

  // Drawing is exactly what the editing lock withholds, so the whole strip goes
  // away rather than sitting there inert. Hidden, not disabled: a row of dead
  // buttons invites clicking to find out why.
  if (locked) return null

  return (
    <aside
      className="absolute left-1/2 -translate-x-1/2 bottom-[4.75rem] z-20 flex items-center gap-3
        rounded-lg border border-rule bg-surface/95 px-3 py-2 shadow-2 backdrop-blur-[2px]"
    >
      <div className="flex items-center gap-0.5">
        {TOOLS.map((t) => {
          const active = tool === t.id
          return (
            <button
              key={t.id}
              title={t.hint}
              onClick={() => setTool(t.id)}
              className={`relative rounded px-2 py-1 text-[12px] font-medium transition-colors
                duration-150 ease-out ${active ? 'text-[#fbf9f5]' : 'text-ink-2 hover:text-ink'}`}
            >
              {active && (
                <motion.span
                  layoutId="tool-pill"
                  transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.6 }}
                  className="absolute inset-0 -z-10 rounded bg-accent"
                />
              )}
              {t.label}
            </button>
          )
        })}
      </div>

      <span className="h-5 w-px bg-rule" />

      <div className="flex items-center gap-1.5">
        {INKS.map((c) => (
          <button
            key={c}
            aria-label={`Ink ${c}`}
            onClick={() => applyStyle({ color: c })}
            style={{ background: c }}
            className={`h-4 w-4 rounded-sm border transition-transform duration-150 ease-out
              hover:scale-125 ${drawStyle.color === c ? 'border-ink ring-1 ring-ink' : 'border-rule'}`}
          />
        ))}
      </div>

      <div className="w-44">
        <Slider
          min={1}
          max={8}
          step={0.5}
          value={selectedDrawings[0]?.thickness ?? drawStyle.thickness}
          onChange={(v) => applyStyle({ thickness: v })}
          label="Weight"
        />
      </div>

      {showCurveSide && (
        <div className="flex items-center gap-1.5">
          <span className="select-none text-[13px] text-ink-2">Bend</span>
          <div className="flex items-center gap-0.5 rounded border border-rule bg-sunken p-0.5">
            {(['left', 'right'] as CurveDirection[]).map((side) => (
              <Button
                key={side}
                variant={drawStyle.curve === side ? 'primary' : 'quiet'}
                onClick={() => setCurveSide(side)}
                title={`Bend the ball to the ${side}`}
                className="px-2 py-0.5 text-[11px] capitalize"
              >
                {side}
              </Button>
            ))}
          </div>
        </div>
      )}

      {showZoneOpacity && (
        <div className="w-28">
          <Slider
            min={0.05}
            max={0.6}
            step={0.05}
            value={selectedDrawings[0]?.fillOpacity ?? drawStyle.fillOpacity}
            onChange={(v) => applyStyle({ fillOpacity: v })}
            label="Fill"
          />
        </div>
      )}

      {(canAttach || attached) && (
        <Button
          className="text-[12px]"
          onClick={() => {
            const d = selectedDrawings[0]
            updateDrawing(d.id, {
              attachedTokenId: attached ? undefined : selectedTokens[0]?.id,
            })
          }}
        >
          {attached ? 'Detach' : 'Attach to player'}
        </Button>
      )}

      {selectedDrawings.length > 0 && (
        <Button
          className="text-[12px] text-accent"
          onClick={() => deleteDrawings(selectedDrawings.map((d) => d.id))}
        >
          Delete
        </Button>
      )}
    </aside>
  )
}
