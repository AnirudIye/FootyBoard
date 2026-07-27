import { useBoardStore } from '../../store/boardStore'
import { useRealtimeStore, useRoomSize } from '../../store/realtimeStore'
import { MonoReadout } from '../ui/MonoReadout'

/**
 * The room readout replaced a decorative six-character id that was generated on
 * load and meant nothing. It now says whether the socket is actually up and how
 * many people are in here, which is the only thing worth a slot in the HUD.
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
  const lastFormation = useBoardStore((s) => s.lastFormation)
  const kind = useBoardStore((s) => s.view.kind)
  const selectionCount = useBoardStore((s) => s.selection.length)
  const locked = useRealtimeStore((s) => s.locked)

  return (
    <div
      className="pointer-events-none absolute top-4 left-4 z-10 flex items-center gap-4
        rounded border border-rule bg-surface/90 px-3 py-1.5 shadow-1"
    >
      {selectionCount > 0 && <MonoReadout label="SEL" value={String(selectionCount)} />}
      {lastFormation && <MonoReadout label="SHAPE" value={lastFormation} />}
      <MonoReadout label="PITCH" value={kind === '11' ? '11v11' : kind === '7aside' ? '7v7' : 'futsal'} />
      <MonoReadout label="ZOOM" value={`${Math.round(zoom * 100)}%`} />
      <RoomReadout />
      {locked && <MonoReadout label="MODE" value="VIEW ONLY" className="text-ink-2" />}
    </div>
  )
}
