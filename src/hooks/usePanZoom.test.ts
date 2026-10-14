import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, fireEvent } from '@testing-library/react'
import { usePanZoom } from './usePanZoom'

/**
 * Space is the board's pan modifier, and the board has to actually own it.
 *
 * It did not. The hook set a flag on keydown and let the browser carry on with
 * its own idea of what Space means, and a browser's idea is *activate whatever
 * has focus*. In Chrome a button keeps focus after it is clicked with the
 * mouse, so after pressing Fit, `+ Frame`, Apply or Reset the very next
 * Space-drag to look around the pitch ended by clicking that button again:
 * Fit snapped the view back to where it started, `+ Frame` added a frame per
 * pan, Apply put every player back in the formation. Measured in a real
 * browser: one frame, then five after four pans.
 *
 * The second half is the gate. `isTypingTarget` counted a `<select>` as
 * somebody typing and a `<button>` as nobody, which is backwards for both. A
 * formation dropdown keeps focus after a choice, and Chrome always reports a
 * select as keyboard-focused, so after picking a shape Space did not pan at all:
 * it opened the dropdown, and the drag became a marquee.
 *
 * And the flag was never let go of. Hold Space, Alt-Tab, release it somewhere
 * else, and the keyup is never seen: every press after that was a pan, so the
 * board could not be selected from or drawn on until Space was pressed and
 * released again.
 *
 * What these assert is the contract, not the mechanism: Space belongs to the
 * board unless a text field or a control the *keyboard* is operating needs it.
 */

const space = { code: 'Space', key: ' ' }

/** A real element in the document, because focus and `closest` need one. */
const mount = <T extends HTMLElement>(el: T): T => {
  document.body.append(el)
  return el
}

const mouseUsed = (el: Element) => fireEvent.pointerDown(el)

beforeEach(() => {
  // Reduced motion, so `fitPitch` is immediate and a test does not wait for a
  // spring. `useReducedMotion` reads this at mount.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('usePanZoom: Space as the pan modifier', () => {
  it('is held while Space is down and let go when it comes up', () => {
    const { result } = renderHook(() => usePanZoom())

    fireEvent.keyDown(document.body, space)
    expect(result.current.spaceHeldRef.current).toBe(true)
    expect(result.current.spaceHeld).toBe(true)

    fireEvent.keyUp(document.body, space)
    expect(result.current.spaceHeldRef.current).toBe(false)
    expect(result.current.spaceHeld).toBe(false)
  })

  it('takes Space away from the browser, so it cannot scroll the page', () => {
    renderHook(() => usePanZoom())
    // `fireEvent` answers false when the event was cancelled.
    expect(fireEvent.keyDown(document.body, space)).toBe(false)
  })

  describe('against a control the mouse last used', () => {
    it('does not let the release click a button that still has focus', () => {
      const { result } = renderHook(() => usePanZoom())
      const fit = mount(document.createElement('button'))
      mouseUsed(fit)
      fit.focus()

      // The keydown has to be cancelled for Chrome to leave the button alone
      // and the keyup for Firefox to, which fires the click on release.
      expect(fireEvent.keyDown(fit, space)).toBe(false)
      expect(result.current.spaceHeldRef.current).toBe(true)
      expect(fireEvent.keyUp(fit, space)).toBe(false)
    })

    it('pans after a choice from a dropdown, which keeps focus', () => {
      const { result } = renderHook(() => usePanZoom())
      const shape = mount(document.createElement('select'))
      mouseUsed(shape)
      shape.focus()

      expect(fireEvent.keyDown(shape, space)).toBe(false)
      expect(result.current.spaceHeldRef.current).toBe(true)
    })

    it('treats a switch or a checkbox the same way', () => {
      const { result } = renderHook(() => usePanZoom())
      const sw = mount(document.createElement('div'))
      sw.setAttribute('role', 'switch')
      sw.tabIndex = 0
      mouseUsed(sw)
      sw.focus()

      expect(fireEvent.keyDown(sw, space)).toBe(false)
      expect(result.current.spaceHeldRef.current).toBe(true)
    })
  })

  describe('against a control the keyboard is operating', () => {
    it('leaves Space to a button reached with Tab, which is how it is pressed', () => {
      const { result } = renderHook(() => usePanZoom())
      const apply = mount(document.createElement('button'))
      mouseUsed(document.body)
      fireEvent.keyDown(document.body, { code: 'Tab', key: 'Tab' })
      apply.focus()

      expect(fireEvent.keyDown(apply, space)).toBe(true)
      expect(result.current.spaceHeldRef.current).toBe(false)
      expect(fireEvent.keyUp(apply, space)).toBe(true)
    })

    it('assumes the keyboard until a pointer has said otherwise', () => {
      // A control can only be focused without a pointer press by the keyboard
      // or by assistive technology, and neither should lose Space to a pan.
      const { result } = renderHook(() => usePanZoom())
      const apply = mount(document.createElement('button'))
      apply.focus()

      expect(fireEvent.keyDown(apply, space)).toBe(true)
      expect(result.current.spaceHeldRef.current).toBe(false)
    })

    it('goes back to the mouse the moment it is used again', () => {
      const { result } = renderHook(() => usePanZoom())
      const apply = mount(document.createElement('button'))
      fireEvent.keyDown(document.body, { code: 'Tab', key: 'Tab' })
      apply.focus()
      mouseUsed(apply)

      expect(fireEvent.keyDown(apply, space)).toBe(false)
      expect(result.current.spaceHeldRef.current).toBe(true)
    })
  })

  describe('against somebody typing', () => {
    const fields: [string, () => HTMLElement][] = [
      ['a text box', () => Object.assign(document.createElement('input'), { type: 'text' })],
      ['a password box', () => Object.assign(document.createElement('input'), { type: 'password' })],
      ['a text area', () => document.createElement('textarea')],
      [
        'an editable label',
        () => {
          const d = document.createElement('div')
          d.setAttribute('contenteditable', 'true')
          return d
        },
      ],
    ]

    it.each(fields)('never takes Space from %s, even after a mouse press', (_, make) => {
      const { result } = renderHook(() => usePanZoom())
      const field = mount(make())
      mouseUsed(field)
      field.focus()

      expect(fireEvent.keyDown(field, space)).toBe(true)
      expect(result.current.spaceHeldRef.current).toBe(false)
    })
  })

  describe('letting go', () => {
    it('lets go when the window loses focus, because the keyup will not arrive', () => {
      const { result } = renderHook(() => usePanZoom())
      fireEvent.keyDown(document.body, space)
      expect(result.current.spaceHeldRef.current).toBe(true)

      fireEvent.blur(window)

      expect(result.current.spaceHeldRef.current).toBe(false)
      expect(result.current.spaceHeld).toBe(false)
    })

    it('lets go when the tab is hidden', () => {
      const { result } = renderHook(() => usePanZoom())
      fireEvent.keyDown(document.body, space)

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      fireEvent(document, new Event('visibilitychange'))

      expect(result.current.spaceHeldRef.current).toBe(false)
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    })

    it('does not pan on a plain drag after it has let go', () => {
      const { result } = renderHook(() => usePanZoom())
      const press = { evt: { button: 0, clientX: 10, clientY: 10, preventDefault: () => {} } }
      fireEvent.keyDown(document.body, space)
      fireEvent.blur(window)

      act(() => result.current.onPointerDown(press as never))

      expect(result.current.panning).toBe(false)
    })
  })

  describe('only plain Space', () => {
    it.each([
      ['Ctrl', { ctrlKey: true }],
      ['Alt', { altKey: true }],
      ['Meta', { metaKey: true }],
    ])('leaves %s+Space to the system', (_, mod) => {
      const { result } = renderHook(() => usePanZoom())

      expect(fireEvent.keyDown(document.body, { ...space, ...mod })).toBe(true)
      expect(result.current.spaceHeldRef.current).toBe(false)
    })
  })
})

describe('usePanZoom: F fits the pitch', () => {
  const wheelIn = {
    evt: { deltaY: -100, preventDefault: () => {} },
    target: { getStage: () => ({ getPointerPosition: () => ({ x: 100, y: 100 }) }) },
  }

  it('puts the view back', () => {
    const { result } = renderHook(() => usePanZoom())
    act(() => result.current.onWheel(wheelIn as never))
    expect(result.current.scale).toBeGreaterThan(1)

    fireEvent.keyDown(document.body, { code: 'KeyF', key: 'f' })

    expect(result.current.scale).toBe(1)
  })

  it('is not Ctrl+F, which is the browser looking for a word', () => {
    // It used to refit the view as well, so searching the page threw away
    // wherever you had panned to.
    const { result } = renderHook(() => usePanZoom())
    act(() => result.current.onWheel(wheelIn as never))
    const zoomed = result.current.scale

    fireEvent.keyDown(document.body, { code: 'KeyF', key: 'f', ctrlKey: true })

    expect(result.current.scale).toBe(zoomed)
  })

  it('is not typed into a text field', () => {
    const { result } = renderHook(() => usePanZoom())
    act(() => result.current.onWheel(wheelIn as never))
    const zoomed = result.current.scale
    const box = mount(document.createElement('input'))
    box.focus()

    fireEvent.keyDown(box, { code: 'KeyF', key: 'f' })

    expect(result.current.scale).toBe(zoomed)
  })
})
