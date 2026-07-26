import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useBoardStore, HOME_COLOR, AWAY_COLOR } from '../../store/boardStore'
import { Button } from '../ui/Button'
import { Slider } from '../ui/Slider'

const SWATCHES = [HOME_COLOR, AWAY_COLOR, '#3F6B4A', '#6B5B95', '#C08A2E', '#4A4E54', '#F2EDE3']

export default function Inspector() {
  const inspector = useBoardStore((s) => s.inspector)
  const tokens = useBoardStore((s) => s.tokens)
  const updateToken = useBoardStore((s) => s.updateToken)
  const switchPlayerTeam = useBoardStore((s) => s.switchPlayerTeam)
  const setSelection = useBoardStore((s) => s.setSelection)
  const deleteSelection = useBoardStore((s) => s.deleteSelection)
  const closeInspector = useBoardStore((s) => s.closeInspector)
  const ref = useRef<HTMLDivElement>(null)

  const token = inspector ? tokens.find((t) => t.id === inspector.tokenId) : undefined

  useEffect(() => {
    if (!inspector) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeInspector()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeInspector()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [inspector, closeInspector])

  const isPlayer = token?.type === 'player'

  // Keep the panel on screen when opened near an edge.
  const left = inspector ? Math.min(inspector.x, window.innerWidth - 260) : 0
  const top = inspector ? Math.min(inspector.y, window.innerHeight - 300) : 0

  return (
    <AnimatePresence>
      {inspector && token && (
        <motion.div
          ref={ref}
          initial={{ opacity: 0, scale: 0.97, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -4 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          style={{ left, top, transformOrigin: 'top left' }}
          className="fixed z-40 w-[236px] rounded-lg border border-rule bg-surface p-3 shadow-2"
        >
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-rule">
            <span className="font-mono text-[11px] tracking-[0.08em] text-ink-3">
              {isPlayer ? 'PLAYER' : token.type.toUpperCase()}
            </span>
            <button
              onClick={closeInspector}
              aria-label="Close inspector"
              className="text-ink-3 hover:text-ink text-[15px] leading-none transition-colors"
            >
              ×
            </button>
          </div>

          {isPlayer && (
            <>
              <div className="flex gap-2 mb-2.5">
                <label className="flex-1">
                  <span className="block text-[11px] text-ink-3 mb-1">Number</span>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={token.number ?? ''}
                    onChange={(e) => updateToken(token.id, { number: Number(e.target.value) })}
                    className="w-full rounded border border-rule bg-paper px-2 py-1 font-mono text-[13px]
                      focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </label>
                <label className="flex-[2]">
                  <span className="block text-[11px] text-ink-3 mb-1">Name</span>
                  <input
                    type="text"
                    value={token.label ?? ''}
                    placeholder="optional"
                    onChange={(e) => updateToken(token.id, { label: e.target.value })}
                    className="w-full rounded border border-rule bg-paper px-2 py-1 text-[13px]
                      focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </label>
              </div>

              <div className="mb-2.5">
                <span className="block text-[11px] text-ink-3 mb-1">Role</span>
                <div className="flex gap-1.5">
                  <Button
                    variant={token.shape === 'outfield' ? 'primary' : 'secondary'}
                    onClick={() => updateToken(token.id, { shape: 'outfield' })}
                    className="flex-1"
                  >
                    Outfield
                  </Button>
                  <Button
                    variant={token.shape === 'keeper' ? 'primary' : 'secondary'}
                    onClick={() => updateToken(token.id, { shape: 'keeper' })}
                    className="flex-1"
                  >
                    Keeper
                  </Button>
                </div>
              </div>

              <div className="mb-2.5">
                <span className="block text-[11px] text-ink-3 mb-1">Team</span>
                <div className="flex gap-1.5">
                  <Button
                    variant={token.teamId === 'home' ? 'primary' : 'secondary'}
                    onClick={() => token.teamId !== 'home' && switchPlayerTeam(token.id)}
                    className="flex-1"
                  >
                    <span
                      className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle ring-1 ring-black/15"
                      style={{ background: HOME_COLOR }}
                    />
                    Home
                  </Button>
                  <Button
                    variant={token.teamId === 'away' ? 'primary' : 'secondary'}
                    onClick={() => token.teamId !== 'away' && switchPlayerTeam(token.id)}
                    className="flex-1"
                  >
                    <span
                      className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle ring-1 ring-black/15"
                      style={{ background: AWAY_COLOR }}
                    />
                    Away
                  </Button>
                </div>
              </div>
            </>
          )}

          <div className="mb-2.5">
            <span className="block text-[11px] text-ink-3 mb-1">Colour</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  aria-label={`Set colour ${c}`}
                  onClick={() => updateToken(token.id, { color: c })}
                  style={{ background: c }}
                  className={`h-5 w-5 rounded-sm border transition-transform duration-150 ease-out
                    hover:scale-110 ${token.color === c ? 'border-ink ring-1 ring-ink' : 'border-rule'}`}
                />
              ))}
              <input
                type="color"
                value={token.color}
                onChange={(e) => updateToken(token.id, { color: e.target.value })}
                aria-label="Custom colour"
                className="h-5 w-6 cursor-pointer rounded-sm border border-rule bg-transparent p-0"
              />
            </div>
          </div>

          <div className="mb-3">
            <Slider
              min={0}
              max={350}
              step={10}
              value={token.rotation}
              onChange={(v) => updateToken(token.id, { rotation: v })}
              label="Facing"
            />
          </div>

          <Button
            variant="secondary"
            className="w-full text-accent border-accent/40 hover:border-accent"
            onClick={() => {
              setSelection([token.id])
              deleteSelection()
              closeInspector()
            }}
          >
            Remove
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
