import { useId, useState } from 'react'
import { motion } from 'framer-motion'
import { useBoardStore, HOME_COLOR, AWAY_COLOR } from '../../store/boardStore'
import { FORMATION_NAMES } from '../../lib/formations'
import type { BlockHeight } from '../../lib/formations'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Toggle'
import { Popover } from '../ui/Popover'
import { boardHandles } from './boardHandles'
import TokenPalette from './TokenPalette'
import AccountMenu from './AccountMenu'
import BoardPicker from './BoardPicker'
import SaveStatus from './SaveStatus'
import ShareDialog from './ShareDialog'
import PresenceStack from './PresenceStack'
import { useRealtimeStore } from '../../store/realtimeStore'
import { toast } from '../../store/toastStore'
import { toUserMessage } from '../../lib/errors'
import type { PitchView, PitchKind, Side } from '../../lib/types'

const VIEWS: { id: PitchView; label: string }[] = [
  { id: 'fullH', label: 'Full' },
  { id: 'fullV', label: 'Vertical' },
  { id: 'attackHalf', label: 'Att' },
  { id: 'defendHalf', label: 'Def' },
  { id: 'blank', label: 'Blank' },
]
const KINDS: { id: PitchKind; label: string }[] = [
  { id: '11', label: '11' },
  { id: '7aside', label: '7' },
  { id: 'futsal', label: 'Futsal' },
]
const BLOCK_LABELS: Record<BlockHeight, string> = { default: 'Base', mid: 'Mid', high: 'High' }

const TEAMS: { id: Side; label: string; color: string }[] = [
  { id: 'home', label: 'Home', color: HOME_COLOR },
  { id: 'away', label: 'Away', color: AWAY_COLOR },
]

// The team you're currently setting up. Identified by its own colour, not the
// accent, so it reads as "who am I editing" rather than a generic toggle.
function TeamSwitch({ active, onChange }: { active: Side; onChange: (side: Side) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded border border-rule bg-sunken p-0.5">
      {TEAMS.map((t) => {
        const on = active === t.id
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            aria-pressed={on}
            className={`relative flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] font-medium
              transition-colors duration-150 ${on ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
          >
            {on && (
              <motion.span
                layoutId="team-switch-pill"
                transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.6 }}
                className="absolute inset-0 -z-10 rounded bg-surface shadow-1"
              />
            )}
            <span
              className="h-2 w-2 rounded-full ring-1 ring-black/15"
              style={{ background: t.color, opacity: on ? 1 : 0.5 }}
            />
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: { id: T; label: string }[]
  value: T
  onChange: (v: T) => void
  disabled?: boolean
}) {
  // A shared layoutId slides the active pill between options.
  const group = useId()
  return (
    <div
      className={`inline-flex items-center gap-0.5 rounded border border-rule bg-sunken p-0.5
        ${disabled ? 'opacity-45' : ''}`}
    >
      {options.map((o) => {
        const active = value === o.id
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            disabled={disabled}
            className={`relative rounded px-2.5 py-1 text-[12px] font-medium transition-colors duration-150
              disabled:cursor-not-allowed
              ${active ? 'text-[#fbf9f5]' : 'text-ink-2 hover:text-ink'}`}
          >
            {active && (
              <motion.span
                layoutId={`seg-${group}`}
                transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.6 }}
                className="absolute inset-0 -z-10 rounded bg-accent"
              />
            )}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export default function Toolbar() {
  const view = useBoardStore((s) => s.view)
  const setView = useBoardStore((s) => s.setView)
  const setPitchKind = useBoardStore((s) => s.setPitchKind)
  const applyFormation = useBoardStore((s) => s.applyFormation)
  const saveCustomFormation = useBoardStore((s) => s.saveCustomFormation)
  const customFormations = useBoardStore((s) => s.customFormations)
  const applyCustomFormation = useBoardStore((s) => s.applyCustomFormation)
  const undoAction = useBoardStore((s) => s.undoAction)
  const redoAction = useBoardStore((s) => s.redoAction)
  const canUndo = useBoardStore((s) => s.history.past.length > 0)
  const canRedo = useBoardStore((s) => s.history.future.length > 0)

  const locked = useRealtimeStore((s) => s.locked)

  const activeTeam = useBoardStore((s) => s.activeTeam)
  const setActiveTeam = useBoardStore((s) => s.setActiveTeam)
  const [block, setBlock] = useState<BlockHeight>('default')
  const names = FORMATION_NAMES[view.kind]
  const [formation, setFormation] = useState(names[0])
  const current = names.includes(formation) ? formation : names[0]

  return (
    <header className="absolute inset-x-0 top-0 z-20 border-b border-rule bg-surface/95 backdrop-blur-[2px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <span className="pr-3 mr-1 border-r border-rule font-display text-[15px] font-semibold tracking-[-0.02em]">
          Soccerboard
        </span>

        <BoardPicker />
        <SaveStatus />

        {/* View and format change what the board *is*, so they follow the lock.
            Everything below that only changes what you are looking at stays
            available to a viewer. */}
        <Segmented
          options={VIEWS}
          value={view.view}
          onChange={(v) => setView({ view: v })}
          disabled={locked}
        />
        <Segmented options={KINDS} value={view.kind} onChange={setPitchKind} disabled={locked} />

        {!locked && (
          <div className="flex items-center gap-2">
            <select
              value={current}
              onChange={(e) => setFormation(e.target.value)}
              aria-label="Formation"
              className="rounded border border-rule bg-surface px-2 py-1 text-[13px] text-ink
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <TeamSwitch active={activeTeam} onChange={setActiveTeam} />
            <Segmented
              options={(['default', 'mid', 'high'] as BlockHeight[]).map((b) => ({
                id: b,
                label: BLOCK_LABELS[b],
              }))}
              value={block}
              onChange={setBlock}
            />
            <Button variant="primary" onClick={() => applyFormation(activeTeam, current, block)}>
              Apply
            </Button>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button onClick={undoAction} disabled={!canUndo || locked}>
            Undo
          </Button>
          <Button onClick={redoAction} disabled={!canRedo || locked}>
            Redo
          </Button>
          {/* Fitting and exporting are yours regardless — they change nothing. */}
          <Button onClick={() => boardHandles.fitPitch?.()}>Fit</Button>
          <Button
            onClick={async () => {
              try {
                await boardHandles.exportPng?.()
                toast('Board exported as PNG')
              } catch (err) {
                toast(toUserMessage(err, 'The board could not be exported. Try again.'))
              }
            }}
          >
            Export
          </Button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <PresenceStack />
          <ShareDialog />
          <AccountMenu />
          <TokenPalette />
          <Popover
            align="right"
            className="w-[220px]"
            trigger={<Button>Pitch options</Button>}
          >
            <div className="flex flex-col gap-2.5">
              <Toggle checked={view.grass} onChange={(v) => setView({ grass: v })} label="Mow stripes" />
              <Toggle
                checked={view.overlayGrid}
                onChange={(v) => setView({ overlayGrid: v })}
                label="Channels and thirds"
              />
              <Toggle
                checked={view.pitchTheme === 'light'}
                onChange={(v) => setView({ pitchTheme: v ? 'light' : 'dark' })}
                label="Chalk pitch"
              />
              <Toggle checked={view.snap} onChange={(v) => setView({ snap: v })} label="Snap to grid" />
              <label className="mt-1 flex items-center justify-between text-[13px] text-ink-2">
                <span>Line colour</span>
                <input
                  type="color"
                  value={view.lineColor}
                  onChange={(e) => setView({ lineColor: e.target.value })}
                  aria-label="Line colour"
                  className="h-6 w-9 cursor-pointer rounded-sm border border-rule bg-transparent p-0"
                />
              </label>
            </div>
          </Popover>

          <Popover
            align="right"
            className="w-[230px]"
            trigger={<Button>Saved shapes</Button>}
          >
            <div className="flex flex-col gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  saveCustomFormation(`Shape ${customFormations.length + 1}`)
                  toast(`Saved the current ${activeTeam} shape`)
                }}
              >
                Save current {activeTeam} shape
              </Button>
              {customFormations.length === 0 && (
                <span className="text-[12px] text-ink-3">Nothing saved yet.</span>
              )}
              {customFormations.map((cf) => (
                <div key={cf.id} className="flex items-center gap-1.5">
                  <span className="flex-1 truncate text-[13px]">{cf.name}</span>
                  <Button className="px-2 py-1 text-[12px]" onClick={() => applyCustomFormation(cf.id, activeTeam)}>
                    Apply
                  </Button>
                </div>
              ))}
            </div>
          </Popover>
        </div>
      </div>
    </header>
  )
}
