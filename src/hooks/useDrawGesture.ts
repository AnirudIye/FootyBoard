import { useCallback, useEffect, useState } from 'react'
import { useBoardStore } from '../store/boardStore'
import { createDrawing, isDragType } from '../lib/drawings'
import { dist } from '../lib/geometry'
import type { Drawing, DrawingType } from '../lib/types'

export interface Draft {
  type: DrawingType
  points: number[]
}

export interface TextDraft {
  screenX: number
  screenY: number
  nx: number
  ny: number
}

type Norm = { x: number; y: number } | null

/**
 * Turns pointer gestures into drawings while a draw tool is active. Returns
 * `handled` from the pointer handlers so the canvas knows to skip its
 * marquee/selection behaviour.
 */
export function useDrawGesture(pointerNorm: () => Norm) {
  const tool = useBoardStore((s) => s.tool)
  const drawStyle = useBoardStore((s) => s.drawStyle)
  const addDrawing = useBoardStore((s) => s.addDrawing)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null)

  const drawing = tool !== 'select'

  const cancel = useCallback(() => {
    setDraft(null)
    setTextDraft(null)
  }, [])

  const commitPoly = useCallback(() => {
    setDraft((d) => {
      if (d && d.type === 'zonePoly' && d.points.length >= 6) {
        addDrawing(createDrawing('zonePoly', d.points, drawStyle))
      }
      return null
    })
  }, [addDrawing, drawStyle])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
      if (e.key === 'Enter') commitPoly()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel, commitPoly])

  const onPointerDown = useCallback(
    (screenX: number, screenY: number): boolean => {
      if (!drawing) return false
      const n = pointerNorm()
      if (!n) return true

      if (tool === 'text') {
        setTextDraft({ screenX, screenY, nx: n.x, ny: n.y })
        return true
      }
      if (tool === 'zonePoly') {
        setDraft((d) =>
          d && d.type === 'zonePoly'
            ? { ...d, points: [...d.points, n.x, n.y] }
            : { type: 'zonePoly', points: [n.x, n.y] },
        )
        return true
      }
      if (tool === 'pen') {
        setDraft({ type: 'pen', points: [n.x, n.y] })
        return true
      }
      setDraft({ type: tool, points: [n.x, n.y, n.x, n.y] })
      return true
    },
    [drawing, tool, pointerNorm],
  )

  const onPointerMove = useCallback((): boolean => {
    if (!draft) return false
    const n = pointerNorm()
    if (!n) return true
    if (draft.type === 'pen') {
      setDraft((d) => (d ? { ...d, points: [...d.points, n.x, n.y] } : d))
    } else if (draft.type !== 'zonePoly') {
      setDraft((d) => (d ? { ...d, points: [d.points[0], d.points[1], n.x, n.y] } : d))
    }
    return true
  }, [draft, pointerNorm])

  const onPointerUp = useCallback((): boolean => {
    if (!draft) return false
    // Polygons stay open until explicitly closed.
    if (draft.type === 'zonePoly') return true

    const p = draft.points
    const meaningful =
      draft.type === 'pen'
        ? p.length >= 6
        : isDragType(draft.type) && dist(p[0], p[1], p[2], p[3]) > 1.2

    if (meaningful) addDrawing(createDrawing(draft.type, p, drawStyle))
    setDraft(null)
    return true
  }, [draft, addDrawing, drawStyle])

  const commitText = useCallback(
    (value: string) => {
      if (textDraft && value.trim()) {
        addDrawing(
          createDrawing('text', [textDraft.nx, textDraft.ny], drawStyle, { text: value.trim() }),
        )
      }
      setTextDraft(null)
    },
    [textDraft, addDrawing, drawStyle],
  )

  // A live preview of the in-progress gesture, shaped like a real drawing.
  const preview: Drawing | null = draft
    ? { ...createDrawing(draft.type, draft.points, drawStyle), id: '__draft__' }
    : null

  return {
    drawing,
    draft,
    preview,
    textDraft,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    commitPoly,
    commitText,
    cancel,
  }
}
