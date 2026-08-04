import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useBoardStore, HOME_COLOR, AWAY_COLOR } from '../../store/boardStore'
import { FORMATION_NAMES } from '../../lib/formations'
import type { BlockHeight } from '../../lib/formations'
import { Button, buttonClass } from '../ui/Button'
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


/**
 * Putting the board back to the state it opens in.
 *
 * `resetBoardAction` has existed since the assistant could be asked to do it,
 * and until now that was the only way to reach it: typing "reset the board" at a
 * panel that has to be open, on an installation that has the assistant switched
 * on. This is the control for it.
 *
 * **It confirms, and the reason is not that it is irreversible — it is that it
 * is broad and it is shared.** Reset pushes an undo step, so Ctrl Z brings the
 * whole board back for the person who pressed it. What undo does not undo
 * cheaply is the `replaced` message that goes to everybody else in the room the
 * instant it lands: in a live session every other screen jumps to a blank 4-3-3
 * and then jumps back. A control that does that to other people should not fire
 * on one stray tap of a button sitting between Fit and Export.
 *
 * A popover rather than `window.confirm`, following `/delete-account`: a native
 * confirm cannot say what is about to go, and this needs four lines to do that
 * honestly. Controlled, so it closes itself once the work is done rather than
 * leaving a stale panel over a board that has already changed.
 */
function ResetBoard() {
  const resetBoardAction = useBoardStore((s) => s.resetBoardAction)
  const [open, setOpen] = useState(false)

  return (
    /* `align="right"` and it is measured rather than copied from the popovers in
       the right-hand group. `Popover` defaults to opening leftwards from the
       trigger's left edge, and on a phone this trigger sits at x274 once the
       toolbar has wrapped: a 260px panel from there runs to x534 of a 375px
       screen, which put **the confirm button itself off the screen** while the
       panel looked fine. Anchored to the trigger's right edge instead it spans
       75..335 there, and on a desktop it opens leftwards into a row that has
       hundreds of pixels to its left. */
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="right"
      /* The height clamp that this panel needed lives in `Popover` now, because
         it turned out to be every panel's problem rather than this one's — see
         the layout effect there. The copy below was still cut to about 200px,
         so that on the screens where the cap bites it has the least to scroll. */
      className="w-[260px]"
      trigger="Reset"
    >
      <div className="flex flex-col gap-2.5">
        <p className="text-[13px] leading-relaxed text-ink-2">
          Both teams return to a 4-3-3 with full benches, the ball to the centre spot, and the
          pitch to a full 11v11 view.
        </p>
        {/* Named one by one rather than as "everything", because these are work
            somebody did and would not expect a button called Reset to take.
            `buildDefaultData` returns `customFormations: []`, so the saved
            shapes really do go, and that is the one people would be sorriest to
            lose without having been told. */}
        <p className="text-[13px] leading-relaxed text-ink-2">
          <strong className="text-ink">Drawings, frames and saved shapes are cleared.</strong> The
          board keeps its name, sharing and members.
        </p>
        <p className="text-[13px] leading-relaxed text-ink-3">
          Undo brings it back, though everyone else in the room sees the board change twice.
        </p>
        <Button
          variant="primary"
          onClick={() => {
            resetBoardAction()
            setOpen(false)
            toast('Board reset — undo brings it back')
          }}
        >
          Reset the board
        </Button>
      </div>
    </Popover>
  )
}

/**
 * The way off the board to the pages that are about it.
 *
 * **Measured against the live site rather than reasoned about: `/board` linked
 * to `/` and `/signup` and to nothing else.** No privacy policy, no terms, no
 * accessibility statement, and no contact form — on the one page the product
 * actually is. Everything else lives in a footer, and the board is `h-screen`
 * with `overflow-hidden` and has never had one.
 *
 * That is worse than an inconvenience for two of these. A policy has to be
 * reachable from the service it describes, and the contact form is the route
 * both policies name for a data protection request — so the promise and the
 * only way to act on it were on opposite sides of a page nobody using the board
 * ever visits. Asked "where is the contact form", the honest answer was that
 * you had to scroll to y3906 of the 3962px landing page, or type the address.
 *
 * `Help` rather than `About`, because the word somebody scans for when they
 * want a human is help. Contact leads, since it is the one that was missing and
 * the one that does something; the three policies follow in the order the
 * footers already list them.
 *
 * In the tucked group with Reset, so a phone pays nothing for it until `More
 * tools` is open, and a desktop gets one more quiet button on a bar that has
 * the room. It is not in `AccountMenu`, which would have been the other
 * candidate: that component returns three different trees for signed-out, guest
 * and signed-in, so it has no one place to put this, and the people most likely
 * to want it are exactly the ones who are not signed in.
 */
function HelpMenu() {
  const link = buttonClass('secondary', 'w-full justify-start')
  return (
    <Popover align="right" className="w-[200px]" trigger="Help">
      <div className="flex flex-col gap-1.5">
        <Link to="/contact" className={link}>
          Contact us
        </Link>
        <Link to="/privacy" className={link}>
          Privacy Policy
        </Link>
        <Link to="/terms" className={link}>
          Terms of Service
        </Link>
        <Link to="/accessibility" className={link}>
          Accessibility
        </Link>
      </div>
    </Popover>
  )
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
            saved, and a guest board was never being kept.

            `inline-flex items-center justify-center` because this is a flex
            item of the header row and therefore blockified, which is what puts
            it inside the coarse-pointer floor's reach: on a phone the wordmark
            grew to 44px and printed itself along the top edge of that box while
            the rule beside it ran the full height. Inert on a mouse. */}
        <Link
          to="/"
          aria-label="FootyBoard home"
          className="inline-flex items-center justify-center pr-3 mr-1 border-r border-rule
            font-display text-[15px] font-semibold
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
          {/* Beside Undo rather than in "Pitch options", which is the other place
              it could have gone. Everything in that popover is a property of the
              board you set once and look at; this is an action you take, and the
              group it is in is the one for actions on the board as a whole.
              Fit and Export sit here and are yours regardless, because they
              change nothing; this one changes everything, so it follows the lock.

              Gone rather than disabled under the lock, which the formation group
              above does for the same reason. `Popover` renders its own trigger
              and takes no `disabled`, and the obvious substitute —
              `pointer-events-none` on the trigger — only stops a pointer: the
              button stays in the tab order and Enter still opens it, so the lock
              would hold against a mouse and not against a keyboard. */}
          {!locked && <ResetBoard />}
          {/* Beside Reset because both are about the board as a whole rather than
              what is on it, and unlike Reset this one is for everybody: it does
              not follow the lock, since reading a policy is not an edit. */}
          <HelpMenu />
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
              className="inline-flex items-center justify-center rounded border border-rule
                bg-surface px-3 py-1.5 text-[13px] leading-none
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
