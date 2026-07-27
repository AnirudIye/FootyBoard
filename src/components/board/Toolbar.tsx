import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
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

interface Option<T extends string> {
  id: T
  label: string
  /** A colour dot before the label, for options that are a thing not a mode. */
  dot?: string
}

const VIEWS: Option<PitchView>[] = [
  { id: 'fullH', label: 'Full' },
  { id: 'fullV', label: 'Vertical' },
  { id: 'attackHalf', label: 'Att' },
  { id: 'defendHalf', label: 'Def' },
  { id: 'blank', label: 'Blank' },
]
const KINDS: Option<PitchKind>[] = [
  { id: '11', label: '11' },
  { id: '7aside', label: '7' },
  { id: 'futsal', label: 'Futsal' },
]
const BLOCKS: Option<BlockHeight>[] = [
  { id: 'default', label: 'Base' },
  { id: 'mid', label: 'Mid' },
  { id: 'high', label: 'High' },
]
const TEAMS: Option<Side>[] = [
  { id: 'home', label: 'Home', dot: HOME_COLOR },
  { id: 'away', label: 'Away', dot: AWAY_COLOR },
]

// Two readings of the same control. `accent` is a mode you are switching the
// board into; `team` is who you are currently setting up, which is identified
// by its own colour rather than the accent, so it reads as "who am I editing"
// rather than as a generic toggle.
const TONES = {
  accent: { pill: 'bg-accent', on: 'text-paper', off: 'text-ink-2 hover:text-ink' },
  team: { pill: 'bg-surface shadow-1', on: 'text-ink', off: 'text-ink-3 hover:text-ink-2' },
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  tone = 'accent',
}: {
  options: Option<T>[]
  value: T
  onChange: (v: T) => void
  disabled?: boolean
  tone?: keyof typeof TONES
}) {
  // A shared layoutId slides the active pill between options.
  const group = useId()
  const look = TONES[tone]
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
            aria-pressed={active}
            className={`relative flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] font-medium
              transition-colors duration-150 disabled:cursor-not-allowed
              ${active ? look.on : look.off}`}
          >
            {active && (
              <motion.span
                layoutId={`seg-${group}`}
                transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.6 }}
                className={`absolute inset-0 -z-10 rounded ${look.pill}`}
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
    <header className="relative z-20 shrink-0 border-b border-rule bg-surface/95 backdrop-blur-[2px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <span className="pr-3 mr-1 border-r border-rule font-display text-[15px] font-semibold tracking-[-0.02em]">
          FootyBoard
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
            <Segmented options={TEAMS} value={activeTeam} onChange={setActiveTeam} tone="team" />
            <Segmented options={BLOCKS} value={block} onChange={setBlock} />
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
          {/* Sits next to Share because the two are the same job from opposite
              ends: one hands out a code, the other takes one. */}
          <Link
            to="/join"
            className="rounded border border-rule bg-surface px-3 py-1.5 text-[13px] leading-none
              text-ink-2 transition-colors duration-150 hover:border-rule-strong hover:text-ink
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
              focus-visible:outline-accent"
          >
            Join by code
          </Link>
          <ShareDialog />
          <AccountMenu />
          <TokenPalette />
          <Popover align="right" className="w-[220px]" trigger="Pitch options">
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

          <Popover align="right" className="w-[230px]" trigger="Saved shapes">
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
