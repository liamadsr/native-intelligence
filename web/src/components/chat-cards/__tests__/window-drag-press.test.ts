// @vitest-environment jsdom
/**
 * Liam, 11-26: "if I click and hold to move the app it should also work
 * without first going to home, then I have to grab it again". A press on the
 * window's drag surface is followed to its end (window-drag-press.ts): a
 * click puts the card away, the window's move keeps it, and nothing happens
 * at the press itself. The real drag is the OS's: only the Mac app shows it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let moved: (() => void) | null = null
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onMoved: async (cb: () => void) => {
      moved = cb
      return () => {}
    },
  }),
}))

import {
  CLICK_SLOP_PX,
  UNHEARD_SLOP_PX,
  __resetWindowDragPressForTests,
  dragPressIsClick,
  followWindowDragPress,
  isFollowedDragPress,
  isWindowDragPress,
  watchWindowMoves,
} from '../window-drag-press'

const internals = window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> }
const flush = () => new Promise((r) => setTimeout(r, 0))

function pointer(type: string, init: { x?: number; y?: number; buttons?: number; button?: number } = {}): PointerEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: init.button ?? 0, buttons: init.buttons ?? 0, screenX: init.x ?? 100, screenY: init.y ?? 20 })
  return e as PointerEvent
}

let strip: HTMLElement
beforeEach(() => {
  __resetWindowDragPressForTests()
  moved = null
  internals.__TAURI_INTERNALS__ = {}
  document.body.innerHTML = `<div data-tauri-drag-region id="strip"></div><div data-tauri-drag-region="false" id="off"></div><div data-tauri-drag-region id="parent"><span id="child">x</span></div>`
  strip = document.getElementById('strip')!
})
afterEach(() => {
  delete internals.__TAURI_INTERNALS__
  document.body.innerHTML = ''
})

describe('dragPressIsClick', () => {
  it('a release heard where it was pressed is a click; past the slop, or the window moved, it is not', () => {
    expect(dragPressIsClick({ heard: true, dragged: false, distance: 0, windowMoved: false })).toBe(true)
    expect(dragPressIsClick({ heard: true, dragged: false, distance: CLICK_SLOP_PX, windowMoved: null })).toBe(true)
    expect(dragPressIsClick({ heard: true, dragged: false, distance: CLICK_SLOP_PX + 1, windowMoved: false })).toBe(false)
    expect(dragPressIsClick({ heard: true, dragged: false, distance: 0, windowMoved: true })).toBe(false)
    expect(dragPressIsClick({ heard: true, dragged: true, distance: 0, windowMoved: false })).toBe(false)
  })

  it('a release the drag loop took: a click when the window did not move; by the screen alone where its moves are not heard', () => {
    expect(dragPressIsClick({ heard: false, dragged: false, distance: 40, windowMoved: false })).toBe(true)
    expect(dragPressIsClick({ heard: false, dragged: false, distance: 0, windowMoved: true })).toBe(false)
    expect(dragPressIsClick({ heard: false, dragged: false, distance: UNHEARD_SLOP_PX, windowMoved: null })).toBe(true)
    expect(dragPressIsClick({ heard: false, dragged: false, distance: UNHEARD_SLOP_PX + 1, windowMoved: null })).toBe(false)
  })
})

describe('isWindowDragPress', () => {
  it('in the desktop app: the attributed element itself, never its child nor one marked "false"', () => {
    expect(isWindowDragPress(strip)).toBe(true)
    expect(isWindowDragPress(document.getElementById('parent'))).toBe(true)
    expect(isWindowDragPress(document.getElementById('child'))).toBe(false)
    expect(isWindowDragPress(document.getElementById('off'))).toBe(false)
    expect(isWindowDragPress(null)).toBe(false)
  })

  it('never in a browser: there the press is an empty press like any other, as before', () => {
    delete internals.__TAURI_INTERNALS__
    expect(isWindowDragPress(strip)).toBe(false)
  })
})

describe('followWindowDragPress', () => {
  function follow() {
    const onClick = vi.fn()
    const down = pointer('pointerdown', { buttons: 1 })
    strip.dispatchEvent(down)
    const stop = followWindowDragPress(down, onClick)
    return { onClick, down, stop }
  }

  it('a click: put away at its release, never at the press, and only once', () => {
    const { onClick, down } = follow()
    expect(isFollowedDragPress(down)).toBe(true)
    expect(onClick).not.toHaveBeenCalled()
    strip.dispatchEvent(pointer('pointerup', { x: 102, y: 21 }))
    expect(onClick).toHaveBeenCalledTimes(1)
    strip.dispatchEvent(pointer('pointerup'))
    strip.dispatchEvent(pointer('pointermove'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('the window moved: the card stays, however the press ends', async () => {
    watchWindowMoves()
    await flush()
    const { onClick } = follow()
    moved!()
    strip.dispatchEvent(pointer('pointerup'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('a drag the page heard (the pointer far on the screen while held): stays', () => {
    const { onClick } = follow()
    strip.dispatchEvent(pointer('pointermove', { x: 160, y: 80, buttons: 1 }))
    strip.dispatchEvent(pointer('pointerup', { x: 100, y: 20 }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('the release unheard (the drag loop took it): ends at the first move with the button up', async () => {
    watchWindowMoves()
    await flush()
    // Held, released unheard, the window still: a click, wherever the pointer goes next.
    const a = follow()
    strip.dispatchEvent(pointer('pointermove', { x: 100, y: 20, buttons: 1 }))
    expect(a.onClick).not.toHaveBeenCalled()
    strip.dispatchEvent(pointer('pointermove', { x: 130, y: 20 }))
    expect(a.onClick).toHaveBeenCalledTimes(1)
    // A drag: the window moved, the release unheard.
    const b = follow()
    moved!()
    strip.dispatchEvent(pointer('pointermove', { x: 400, y: 300 }))
    expect(b.onClick).not.toHaveBeenCalled()
  })

  it('the window’s moves not yet heard: the screen decides', () => {
    const near = follow()
    strip.dispatchEvent(pointer('pointermove', { x: 105, y: 24 }))
    expect(near.onClick).toHaveBeenCalledTimes(1)
    const far = follow()
    strip.dispatchEvent(pointer('pointermove', { x: 400, y: 300 }))
    expect(far.onClick).not.toHaveBeenCalled()
  })

  it('a cancel, another press (a double click’s second) or the caller’s stop: nothing put away', () => {
    const a = follow()
    strip.dispatchEvent(pointer('pointercancel'))
    strip.dispatchEvent(pointer('pointerup'))
    expect(a.onClick).not.toHaveBeenCalled()
    const b = follow()
    strip.dispatchEvent(pointer('pointerdown', { buttons: 1 }))
    strip.dispatchEvent(pointer('pointerup'))
    expect(b.onClick).not.toHaveBeenCalled()
    const c = follow()
    c.stop()
    strip.dispatchEvent(pointer('pointerup'))
    expect(c.onClick).not.toHaveBeenCalled()
  })

  it('a secondary button’s release is not the end', () => {
    const { onClick } = follow()
    strip.dispatchEvent(pointer('pointerup', { button: 2 }))
    expect(onClick).not.toHaveBeenCalled()
    strip.dispatchEvent(pointer('pointerup'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
