import { useBoardStore } from '../../store/boardStore'
import { useRealtimeStore, useRoomSize } from '../../store/realtimeStore'
import { useAuthStore, selectSignedIn } from '../../store/authStore'
import { MonoReadout } from '../ui/MonoReadout'

/**
 * The room readout replaced a decorative six-character id that was generated on
 * load and meant nothing. It now says whether the socket is actually up and how
 * many people are in here, which is the only thing worth a slot in the HUD.
 *
 * A guest has no room at all, so it is not rendered for them rather than
 * reading OFFLINE, which describes a connection that failed rather than one
 * that was never attempted. Nothing takes its place: the account menu already
 * says a guest is not saving, beside the button that fixes it.
 *
 * That used to carry a second reason — that a tooltip here could never fire,
 * because the container is `pointer-events-none`. It is only half true now. The
 * HUD is `pointer-events-none` where it floats over the board and takes pointer
 * events like any other row where it is docked below it, so the account menu is
 * the whole of the argument and the class list below is where that split lives.
 */
function RoomReadout() {
  const status = useRealtimeStore((s) => s.status)
  const size = useRoomSize()

  const label: Record<typeof status, string> = {
    connecting: 'JOINING',
    live: size > 1 ? `${size} HERE` : 'LIVE',
    reconnecting: 'RECONNECTING',
    offline: 'OFFLINE',
  }

  const tone =
    status === 'live' ? 'text-accent' : status === 'offline' ? 'text-ink-3' : 'text-ink-2'

  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          status === 'live'
            ? 'bg-accent'
            : status === 'reconnecting' || status === 'connecting'
              ? 'animate-pulse bg-ink-2'
              : 'bg-ink-3'
        }`}
      />
      <MonoReadout label="ROOM" value={label[status]} className={tone} />
    </span>
  )
}

export default function HUD() {
  const zoom = useBoardStore((s) => s.zoom)
  // The shape of the team being worked on, not of whoever was arranged last:
  // the readout sits beside the controls that act on the active team, so naming
  // the other side's shape there is naming the wrong thing.
  const lastFormation = useBoardStore((s) => s.lastFormation[s.activeTeam])
  const kind = useBoardStore((s) => s.view.kind)
  const selectionCount = useBoardStore((s) => s.selection.length)
  const locked = useRealtimeStore((s) => s.locked)
  const signedIn = useAuthStore(selectSignedIn)

  return (
    <div
      /* A card floating in the corner of the board at `overlay`, and a docked
         row under it otherwise. `BoardPage` builds the column; this is the half of
         the arrangement that has to be said here.

         **It is deliberately the shortest thing in the docked stack.** Every
         pixel this row takes comes out of the canvas above it, and unlike the
         bench and the drawing bar there is nothing here to hit: at most six
         readouts of 11px mono, so one line of type, 8px of padding and a
         hairline — 20px, against 62 for the bench and 62 for the drawing bar.

         `flex-wrap` is the one behavioural change in the docked half and it is
         not cosmetic. Four readouts come to roughly 334px of 11px mono and all
         six to about 490px; a flex row defaults to `nowrap`, so on a 375px phone
         the row would run past the right edge and the band's `overflow-hidden`
         would take the end of it. Docked it has a width to wrap against, so it
         wraps, and the second line costs 15px on the screens that need it.
         `overlay:flex-nowrap` leaves the floating card the single line it has
         always been, because up there it is not the problem.

         `pointer-events-none` goes with the floating half and only with it. Its
         job is to stop a readout eating a press meant for the pitch underneath;
         docked there is no pitch underneath, and switching pointer events off
         there would achieve nothing except making the text unselectable. */
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-rule px-3 py-1
        overlay:pointer-events-none overlay:absolute overlay:top-4 overlay:left-4 overlay:z-10
        overlay:flex-nowrap overlay:gap-4 overlay:rounded overlay:border overlay:bg-surface/90
        overlay:py-1.5 overlay:shadow-1"
    >
      {selectionCount > 0 && <MonoReadout label="SEL" value={String(selectionCount)} />}
      {lastFormation && <MonoReadout label="SHAPE" value={lastFormation} />}
      <MonoReadout label="PITCH" value={kind === '11' ? '11v11' : kind === '7aside' ? '7v7' : 'futsal'} />
      <MonoReadout label="ZOOM" value={`${Math.round(zoom * 100)}%`} />
      {signedIn && <RoomReadout />}
      {locked && <MonoReadout label="MODE" value="VIEW ONLY" className="text-ink-2" />}
    </div>
  )
}
