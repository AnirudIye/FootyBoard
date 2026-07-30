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
import { useAuthStore, selectSignedIn } from '../../store/authStore'
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

// The tooltips have to name the key the reader's own keyboard has.
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? 'Cmd' : 'Ctrl'

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
function Segmented<T extends string>({
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
  const signedIn = useAuthStore(selectSignedIn)

  const activeTeam = useBoardStore((s) => s.activeTeam)
  const setActiveTeam = useBoardStore((s) => s.setActiveTeam)
  const [block, setBlock] = useState<BlockHeight>('default')
  const names = FORMATION_NAMES[view.kind]
  const [formation, setFormation] = useState(names[0])
  const current = names.includes(formation) ? formation : names[0]

  // Every group in here wraps, and that is load-bearing rather than tidy.
  // `flex-wrap` on the outer row alone only ever moved whole groups onto new
  // lines; a group that was itself wider than the viewport simply overflowed,
  // and because BoardPage clips the whole column nothing looked cut off. At
  // 375px that put High at x=353 and Apply at x=409, both painted outside the
  // window with no scrollbar anywhere to reach them, so a phone could not apply
  // a formation at all. Wrapping rather than scrolling the bar, because every
  // popover in here (Boards, Pitch options, Saved shapes, Account) is an
  // absolutely positioned child rather than a portal, and `overflow-x-auto`
  // computes `overflow-y` to `auto` as well, which would clip all four of them
  // open downwards at every width. The column layout already expects a tall bar.
  return (
    <header className="relative z-20 shrink-0 border-b border-rule bg-surface/95 backdrop-blur-[2px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        {/* The wordmark is the way back out. A logo in the top left is the one
            piece of chrome people already expect to be a link home, and until
            now this was a bare span, so the board was a room with no marked
            door. Nothing here is lost by leaving: a signed-in board is already
            saved, and a guest board was never being kept. */}
        <Link
          to="/"
          aria-label="FootyBoard home"
          className="pr-3 mr-1 border-r border-rule font-display text-[15px] font-semibold
            tracking-[-0.02em] transition-colors duration-150 ease-out hover:text-accent
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-accent rounded-sm"
        >
          FootyBoard
        </Link>

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
          <div className="flex flex-wrap items-center gap-2">
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
            <Segmented options={TEAMS} value={activeTeam} onChange={setActiveTeam} />
            <Segmented options={BLOCKS} value={block} onChange={setBlock} />
            {/* Accent-washed rather than solid accent: the header's one filled
                green belongs to the only thing here a guest cannot already do.
                The `!` is load-bearing. Tailwind emits `bg-surface`, `border-rule`
                and `text-ink` after their accent counterparts, so an override of
                equal specificity coming from `className` silently loses however
                it is ordered in the attribute. */}
            <Button
              variant="secondary"
              className="!border-accent/40 !bg-[var(--accent-wash)] !text-accent hover:!border-accent"
              onClick={() => applyFormation(activeTeam, current, block)}
            >
              Apply
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={undoAction} disabled={!canUndo || locked} title={`Undo (${MOD} Z)`}>
            Undo
          </Button>
          <Button onClick={redoAction} disabled={!canRedo || locked} title={`Redo (${MOD} Shift Z)`}>
            Redo
          </Button>
          {/* Fitting and exporting are yours regardless — they change nothing. */}
          <Button onClick={() => boardHandles.fitPitch?.()} title="Fit the pitch to the window (F)">
            Fit
          </Button>
          <Button
            title="Export the board as a PNG"
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

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <PresenceStack />
          {/* Sits next to Share because the two are the same job from opposite
              ends: one hands out a code, the other takes one. Hidden from a
              guest for the same reason ShareDialog is: /join only redirects
              them to /login, so the button's whole outcome is a dead end. */}
          {signedIn && (
            <Link
              to="/join"
              className="rounded border border-rule bg-surface px-3 py-1.5 text-[13px] leading-none
                text-ink-2 transition-colors duration-150 hover:border-rule-strong hover:text-ink
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                focus-visible:outline-accent"
            >
              Join by code
            </Link>
          )}
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
