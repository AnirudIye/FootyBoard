import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useBoardStore, HOME_COLOR, AWAY_COLOR } from '../../store/boardStore'
import { FORMATION_NAMES } from '../../lib/formations'
import type { BlockHeight } from '../../lib/formations'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Toggle'
import { Popover } from '../ui/Popover'
import { Segmented } from '../ui/Segmented'
import type { Option } from '../ui/Segmented'
import { ThemeControl } from '../ui/ThemeControl'
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

  // Closed by default, and only ever consulted below `sm` — see the toggle.
  const [toolsOpen, setToolsOpen] = useState(false)

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

        {/* The phone toggle, and why the groups below hide behind it.
         *
         * Wrapping fixed reachability and cost height. Measured on a 375×812
         * phone: this bar wrapped to **308px**, so the pitch started at y=309
         * and got 453px of an 812px screen — the toolbar was 38% of the
         * display before the board began.
         *
         * `contents` is what makes this safe. The wrapper below is not a box:
         * where there is room it is `display: contents`, so the formation and
         * history groups stay *direct children of the same flex row* and the
         * desktop layout is byte-identical to what it was. Where there is not,
         * it becomes `hidden`, which hides its children, and the toggle brings
         * them back.
         *
         * `roomy` rather than `sm`, because a phone held sideways is 812px
         * wide and 375px tall: wide enough to clear `sm` and far too short to
         * spend 181px of the screen on this bar. See the variant in
         * `tailwind.config.ts`.
         *
         * Deliberately not `overflow-x-auto`, for the reason written above:
         * every popover in this bar is an absolutely positioned child rather
         * than a portal, and scrolling x computes y to `auto`, which clips all
         * four of them open downwards at every width. This adds no overflow
         * anywhere.
         */}
        <Button
          className="roomy:hidden"
          aria-expanded={toolsOpen}
          onClick={() => setToolsOpen((open) => !open)}
        >
          {toolsOpen ? 'Fewer tools' : 'More tools'}
        </Button>

        <div className={`${toolsOpen ? 'contents' : 'hidden'} roomy:contents`}>
        {/* View and format change what the board *is*, so they follow the lock.
            Everything below that only changes what you are looking at stays
            available to a viewer. Both are set once for a session rather than
            reached for repeatedly, which is why they sit behind the phone
            toggle: on a 375px row each one costs a whole 32px line. */}
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
          {/* Its own popover rather than a row inside "Pitch options", and
              deliberately not inside the account menu either. Everything in
              "Pitch options" is part of the board: shared with the room, saved,
              and visible in an export. This is a preference of one browser. And
              the account menu has three states, two of which are not a popover
              at all, so putting it there would have hidden it from every
              visitor and every guest. */}
          <Popover align="right" className="w-[220px]" trigger="Appearance">
            <ThemeControl />
          </Popover>
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
