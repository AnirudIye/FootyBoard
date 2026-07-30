import { AnimatePresence, motion } from 'framer-motion'
import { useRealtimeStore, peerColor, peerInitial } from '../../store/realtimeStore'

/**
 * Who else is looking at this board.
 *
 * Overlapped initials in each person's own colour — the same colour their
 * cursor and selection ring use on the pitch, so "who is that" is answerable
 * without reading a label. Nothing renders when you are alone, because a stack
 * of one is just clutter.
 */
export default function PresenceStack() {
  const peers = useRealtimeStore((s) => s.peers)
  const list = Object.values(peers)

  if (list.length === 0) return null

  return (
    <div className="flex items-center -space-x-1.5" aria-label={`${list.length} others on this board`}>
      <AnimatePresence initial={false}>
        {list.slice(0, 4).map((peer) => (
          <motion.span
            key={peer.id}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 520, damping: 30, mass: 0.6 }}
            title={peer.displayName}
            style={{ background: peerColor(peer.id) }}
            className="grid h-6 w-6 place-items-center rounded-full font-mono text-[10px]
              font-medium text-paper ring-2 ring-[rgb(var(--surface))]"
          >
            {peerInitial(peer)}
          </motion.span>
        ))}
      </AnimatePresence>

      {list.length > 4 && (
        <span
          className="grid h-6 w-6 place-items-center rounded-full bg-sunken font-mono text-[10px]
            text-ink-2 ring-2 ring-[rgb(var(--surface))]"
          title={list.slice(4).map((p) => p.displayName).join('\n')}
        >
          +{list.length - 4}
        </span>
      )}
    </div>
  )
}
