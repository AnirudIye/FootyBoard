import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook, fireEvent } from '@testing-library/react'
import { useDrawGesture } from './useDrawGesture'
import { useBoardStore } from '../store/boardStore'

const at = () => ({ x: 50, y: 50 })

describe('useDrawGesture: Escape', () => {
  beforeEach(() => {
    useBoardStore.getState().initDefaultBoard()
    useBoardStore.getState().setTool('select')
  })

  it('disarms the tool when no gesture is in progress', () => {
    renderHook(() => useDrawGesture(at))
    act(() => useBoardStore.getState().setTool('pen'))

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useBoardStore.getState().tool).toBe('select')
  })

  it('ignores Escape from a text field, which means leave the field', () => {
    renderHook(() => useDrawGesture(at))
    act(() => useBoardStore.getState().setTool('pen'))

    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    input.remove()

    expect(useBoardStore.getState().tool).toBe('pen')
  })

  it('abandons a polygon in progress but keeps the tool armed', () => {
    const { result } = renderHook(() => useDrawGesture(at))
    act(() => useBoardStore.getState().setTool('zonePoly'))
    act(() => {
      result.current.onPointerDown(10, 10)
    })
    expect(result.current.draft).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useBoardStore.getState().tool).toBe('zonePoly')
    expect(result.current.draft).toBeNull()
  })
})
