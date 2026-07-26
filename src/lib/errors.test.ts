import { describe, it, expect, vi, afterEach } from 'vitest'
import { AppError, toUserMessage } from './errors'

afterEach(() => vi.restoreAllMocks())

describe('toUserMessage', () => {
  it('shows an AppError message as written', () => {
    expect(toUserMessage(new AppError('Capture another position, then export.'))).toBe(
      'Capture another position, then export.',
    )
  })

  it('explains a full storage quota in plain language', () => {
    const quota = new Error('exceeded')
    quota.name = 'QuotaExceededError'
    const msg = toUserMessage(quota)
    expect(msg).toContain('out of storage')
    expect(msg).not.toContain('QuotaExceededError')
  })

  it('explains a blocked canvas read', () => {
    const blocked = new Error('tainted')
    blocked.name = 'SecurityError'
    expect(toUserMessage(blocked)).toContain('Reload the page')
  })

  it('hides raw technical text behind the fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bug = new TypeError("Cannot read properties of undefined (reading 'label')")
    const msg = toUserMessage(bug, 'The frame could not be opened.')
    expect(msg).toBe('The frame could not be opened.')
    expect(msg).not.toContain('undefined')
  })

  it('keeps the technical detail in the console for debugging', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bug = new TypeError('boom')
    toUserMessage(bug)
    expect(spy).toHaveBeenCalledWith('Soccerboard:', bug)
  })

  it('falls back for a non-error value', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(toUserMessage(null)).toBe('That went wrong somewhere. Give it another go.')
    expect(toUserMessage({ weird: true }, 'Export failed.')).toBe('Export failed.')
  })
})
