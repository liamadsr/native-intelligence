// @vitest-environment jsdom
/**
 * Hovering the idle Capture button pours today's calendar out of it (the
 * liquid card), so a meeting can be picked and captured. The pill is liquid
 * too — the card is a drop parked in it — and clicking it still starts a
 * capture straight away.
 *
 * The card holds open while the pointer is over the pill or the card — the gap
 * between them included — and closes after a short grace once it leaves both,
 * on Escape, or on a press outside. Keyboard focus opens it too. It never opens
 * for touch, or while a capture is starting or recording, and a capture that
 * starts while it's open puts it away for good rather than until that capture
 * ends. Its calendar mounts only while it's shown (plus the close animation).
 *
 * In the top bar (the default, cardSide="bottom") the card HANGS below the
 * pill, only as tall as the room below it allows — a short window scrolls the
 * calendar inside the card rather than pushing it off screen — and only as wide
 * as the room to the pill's right edge on a very narrow window.
 *
 * With cardSide="top" (where it used to sit, the chat composer) the card RISES
 * out of the pill instead: the same pour, mirrored, only as tall as the room
 * above the pill allows, and while it's out it lifts itself over the chat and
 * the content windows. A recording's tooltips open above the pill there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, forwardRef, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  isRecording: false,
  isStarting: false,
  startRecording: vi.fn(),
}))

vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({
    isRecording: state.isRecording,
    isStarting: state.isStarting,
    captureId: null,
    recordingError: null,
    transcriptionStatus: 'connected',
    startRecording: state.startRecording,
    isPaused: false,
    isAgentFinalizing: false,
    pauseRecording: () => {},
    resumeRecording: () => {},
    stopRecording: () => {},
  }),
  useRecordingElapsed: () => 0,
}))
vi.mock('@/hooks/use-recording', () => ({ formatTime: () => '0:00' }))
vi.mock('@/components/desktop-titlebar', () => ({
  useIsDesktop: () => true,
  subscribeMounted: () => () => {},
  getMountedSnapshot: () => true,
  getMountedServerSnapshot: () => false,
}))
vi.mock('@/app/account/(dashboard)/main-chat/main-chat-context', () => ({
  useCardDeliveries: () => null,
}))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children, side }: { children: ReactNode; side?: string }) =>
    h('div', { 'data-tooltip': '', 'data-side': side }, children),
}))
vi.mock('@/app/account/(dashboard)/top-bar/capture-calendar', () => ({
  CaptureCalendar: ({ hint }: { hint?: ReactNode }) => h('div', { 'data-calendar': '' }, hint),
}))
// The liquid is a silhouette painted behind the content; what matters here is
// where each item is sent, so the stand-in records x / y / scale.
vi.mock('liquid-gooey', () => {
  const Liquid = Object.assign(
    forwardRef<HTMLDivElement, Record<string, unknown>>(function Liquid(props, ref) {
      const { blur: _b, contrast: _c, fill: _f, shadow: _s, filterPadding: _p, children, ...rest } = props
      return h('div', { ...rest, ref }, children as ReactNode)
    }),
    {
      Item: ({ x, y, scale, className, children }: { x?: number; y?: number; scale?: number; className?: string; children?: ReactNode }) =>
        h('div', { className, 'data-item': '', 'data-x': x, 'data-y': y, 'data-scale': scale ?? 1 }, children),
    },
  )
  return { Liquid }
})

import { CaptureBarButton } from '../capture-bar-button'
import { CAPTURE_CARD_UP_ATTR } from '../../chat/composer-liquid-pill'

let container: HTMLDivElement
let root: Root

function render(props: { cardSide?: 'bottom' | 'top' } = {}) {
  act(() => {
    root.render(h(CaptureBarButton, props))
  })
}

const button = () => container.querySelector<HTMLButtonElement>('[data-onboarding-target="capture"]')!
const pill = () => button().parentElement!
const card = () => container.querySelector<HTMLElement>('[data-capture-calendar]')!
const cardItem = () => card().parentElement!
/** The liquid items that aren't the card — the pill's own blob. */
const pillBlobItems = () => [...container.querySelectorAll<HTMLElement>('[data-item]')].filter((el) => el !== cardItem())
const isOpen = () => container.querySelector('[data-capture-liquid]')!.hasAttribute('data-open')
/** The button's own wrapper, round the liquid. */
const wrapper = () => container.querySelector<HTMLElement>('[data-capture-liquid]')!.parentElement!
const lifted = () => document.documentElement.hasAttribute(CAPTURE_CARD_UP_ATTR)
const calendarMounted = () => !!container.querySelector('[data-calendar]')

function box(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() {} } as DOMRect
}

/** Lay the pill and the open card out where they sit in the header (jsdom lays
 *  nothing out): the pill at 1150,6 and the card right-aligned 8px below it. */
function layOut() {
  vi.spyOn(pill(), 'getBoundingClientRect').mockReturnValue(box(1150, 6, 91, 36))
  vi.spyOn(card(), 'getBoundingClientRect').mockReturnValue(box(921, 50, 320, 320))
}

const hover = (el: Element, pointerType = 'mouse') =>
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType, clientX: 1190, clientY: 24 }))
  })
const moveTo = (x: number, y: number) =>
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: x, clientY: y }))
  })
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  state.isRecording = false
  state.isStarting = false
  state.startRecording.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('hovering the Capture button', () => {
  it('pours today’s calendar out of the pill, and puts it back once the pointer leaves', () => {
    render()
    layOut()
    expect(isOpen()).toBe(false)
    expect(calendarMounted()).toBe(false)
    // Closed, the card is collapsed into the pill's right cap and takes no
    // pointer.
    expect(cardItem().dataset).toMatchObject({ x: '142', y: '-142', scale: '0' })
    expect(card().hasAttribute('inert')).toBe(true)

    hover(pill())
    expect(isOpen()).toBe(true)
    expect(calendarMounted()).toBe(true)
    expect(cardItem().dataset).toMatchObject({ x: '0', y: '42', scale: '1' })
    expect(card().hasAttribute('inert')).toBe(false)
    expect(button().getAttribute('aria-expanded')).toBe('true')

    // Off both the pill and the card: shut after the grace, and the calendar
    // unmounts once the card has shrunk away.
    moveTo(600, 500)
    wait(200)
    expect(isOpen()).toBe(true)
    wait(40)
    expect(isOpen()).toBe(false)
    wait(300)
    expect(calendarMounted()).toBe(true)
    wait(300)
    expect(calendarMounted()).toBe(false)
  })

  it('paints the pill with the liquid too, so the card pours out of one body', () => {
    render()
    // The controls carry no surface of their own; one blob of the liquid is
    // the pill's, there whether or not the card is out.
    expect(pill().className).not.toMatch(/(^|\s)(bg-white|border)(\s|$)/)
    expect(pillBlobItems()).toHaveLength(1)
    expect(pillBlobItems()[0].dataset.scale).toBe('1')
    hover(pill())
    expect(pillBlobItems()[0].dataset.scale).toBe('1')
  })

  it('stays open while the hand crosses the gap and moves about the card', () => {
    render()
    layOut()
    hover(pill())

    moveTo(1200, 46) // the gap under the pill
    moveTo(1000, 200) // inside the card, well left of the pill
    wait(1000)
    expect(isOpen()).toBe(true)
  })

  it('still starts a capture straight away when the pill is clicked, and puts the card away', () => {
    render()
    hover(pill())
    act(() => button().click())
    expect(state.startRecording).toHaveBeenCalledTimes(1)
    expect(isOpen()).toBe(false)
  })

  it('closes on Escape, and on a press outside', () => {
    render()
    hover(pill())
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(isOpen()).toBe(false)

    hover(pill())
    act(() => {
      card().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(isOpen()).toBe(true)
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(isOpen()).toBe(false)
  })

  it('does not open for touch', () => {
    render()
    hover(pill(), 'touch')
    expect(isOpen()).toBe(false)
  })

  it('opens on keyboard focus, and closes once focus leaves', () => {
    render()
    act(() => button().focus())
    expect(isOpen()).toBe(true)
    act(() => button().blur())
    wait(240)
    expect(isOpen()).toBe(false)
  })

  it('stays shut while recording, where the tooltip still offers the way back', () => {
    state.isRecording = true
    render()
    hover(pill())
    expect(isOpen()).toBe(false)
    expect(container.querySelector('[data-tooltip]')?.textContent).toBe('Return to active capture')
  })

  it('has no tooltip when idle — the card header carries the hint', () => {
    // The shortcut's label follows the platform: ⌘N on a Mac, Ctrl+N elsewhere.
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    try {
      render()
      expect(container.querySelector('[data-tooltip]')).toBeNull()
      hover(pill())
      expect(container.querySelector('[data-calendar]')?.textContent).toContain('⌘N')
    } finally {
      delete (navigator as { platform?: string }).platform
    }
  })

  it('says Ctrl+N off a Mac', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    try {
      render()
      hover(pill())
      expect(container.querySelector('[data-calendar]')?.textContent).toContain('Ctrl+N')
    } finally {
      delete (navigator as { platform?: string }).platform
    }
  })

  it('is put away for good by a capture starting, and does not pop back when it ends', () => {
    render()
    hover(pill())
    expect(isOpen()).toBe(true)

    state.isStarting = true
    render()
    expect(isOpen()).toBe(false)

    state.isStarting = false
    render()
    expect(isOpen()).toBe(false)
  })
})

describe('the rising card (cardSide="top" — the chat composer’s)', () => {
  /** The pill low on the screen, at 1150,700, and the open card right-aligned
   *  above it: its bottom 6px over the pill's top. */
  function layOutRising() {
    vi.spyOn(pill(), 'getBoundingClientRect').mockReturnValue(box(1150, 700, 91, 36))
    vi.spyOn(card(), 'getBoundingClientRect').mockReturnValue(box(921, 374, 320, 320))
  }

  it('parks in the pill’s right cap like the hanging card, and pours UP out of it', () => {
    render({ cardSide: 'top' })
    layOutRising()
    // Closed, exactly where the hanging card parks: collapsed to a point on the
    // centre of the pill's right cap.
    expect(cardItem().dataset).toMatchObject({ x: '142', y: '-142', scale: '0' })

    hover(pill())
    expect(isOpen()).toBe(true)
    // Open, still right-aligned (x 0), lifted its own height (320) plus the
    // mirrored gap: its bottom at -6, as the hanging card's top is at 42 — 8.5px
    // clear of the pill's blob either way.
    expect(cardItem().dataset).toMatchObject({ x: '0', y: '-326', scale: '1' })
    expect(card().hasAttribute('inert')).toBe(false)
  })

  it('stays open while the hand crosses the gap up into the card, and closes once it leaves both', () => {
    render({ cardSide: 'top' })
    layOutRising()
    hover(pill())
    // Risen, full height, with ample room above the pill.
    expect(cardItem().dataset).toMatchObject({ x: '0', y: '-326', scale: '1' })

    moveTo(1200, 697) // the gap above the pill
    moveTo(1000, 450) // inside the card, well left of the pill
    wait(1000)
    expect(isOpen()).toBe(true)

    moveTo(600, 200)
    wait(240)
    expect(isOpen()).toBe(false)
  })

  it('lifts itself over the chat while it’s out, until it has shrunk back into the pill', () => {
    render({ cardSide: 'top' })
    expect(lifted()).toBe(false)
    expect(wrapper().className).toMatch(/(^|\s)z-10(\s|$)/)

    hover(pill())
    expect(lifted()).toBe(true)
    expect(wrapper().className).toMatch(/(^|\s)z-\[46\](\s|$)/)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(isOpen()).toBe(false)
    // Still shrinking back: still on top.
    expect(lifted()).toBe(true)
    wait(600)
    expect(lifted()).toBe(false)
    expect(wrapper().className).toMatch(/(^|\s)z-10(\s|$)/)
  })

  it('lets go of the lift when it unmounts mid-pour', () => {
    render({ cardSide: 'top' })
    hover(pill())
    expect(lifted()).toBe(true)
    act(() => root.render(null))
    expect(lifted()).toBe(false)
  })

  it('shrinks to the room above the pill when a short window leaves less than its height', () => {
    render({ cardSide: 'top' })
    // The pill 200px down an unclipped page: 200 - the 6px gap - 8px clear.
    vi.spyOn(pill(), 'getBoundingClientRect').mockReturnValue(box(1150, 200, 91, 36))
    hover(pill())
    expect(card().style.height).toBe('186px')
    expect(cardItem().dataset).toMatchObject({ x: '0', y: '-192', scale: '1' })
  })

  it('measures up to the nearest ancestor that clips it, and again as the window resizes', () => {
    render({ cardSide: 'top' })
    // The chat strip clips from 480; the pill sits at 700.
    container.style.overflowY = 'hidden'
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(box(0, 480, 1400, 400))
    const pillBox = vi.spyOn(pill(), 'getBoundingClientRect').mockReturnValue(box(1150, 700, 91, 36))
    hover(pill())
    expect(card().style.height).toBe('206px')
    expect(cardItem().dataset).toMatchObject({ y: '-212' })

    // A taller window: the whole card fits again.
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(box(0, 0, 1400, 900))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(card().style.height).toBe('320px')
    expect(cardItem().dataset).toMatchObject({ y: '-326' })

    // Squeezed right down: never below the floor.
    pillBox.mockReturnValue(box(1150, 60, 91, 36))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(card().style.height).toBe('160px')
    expect(cardItem().dataset).toMatchObject({ y: '-166' })
  })

  it('is fitted while still closed, so its first pour comes out of the pill', () => {
    // Laid out before the button mounts — as on a tab switch into a short
    // window: the pill 200px down an unclipped page.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(box(1150, 200, 91, 36))
    render({ cardSide: 'top' })
    expect(isOpen()).toBe(false)
    // Already sized for that room, and parked on the cap's centre for THAT
    // height (18 - 186/2) — not for the full 320, 67px above the pill, where
    // the pour would otherwise spring from.
    expect(card().style.height).toBe('186px')
    expect(cardItem().dataset).toMatchObject({ x: '142', y: '-75', scale: '0' })

    hover(pill())
    expect(cardItem().dataset).toMatchObject({ x: '0', y: '-192', scale: '1' })
  })

  it('refits while closed as the composer grows and the window resizes, and stops watching once gone', () => {
    const observers: { fire: () => void; targets: Element[]; disconnected: boolean }[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private entry: (typeof observers)[number]
        constructor(callback: () => void) {
          this.entry = { fire: callback, targets: [], disconnected: false }
          observers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.targets.push(target)
        }
        unobserve() {}
        disconnect() {
          this.entry.disconnected = true
        }
      },
    )
    container.setAttribute('data-chat-input-root', '')
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(box(1150, 700, 91, 36))
    render({ cardSide: 'top' })
    expect(observers.flatMap((o) => o.targets)).toContain(container)
    expect(card().style.height).toBe('320px')
    expect(cardItem().dataset).toMatchObject({ y: '-142', scale: '0' })

    // A draft grows: the composer gets taller and lifts the pill to 200.
    rect.mockReturnValue(box(1150, 200, 91, 36))
    act(() => observers.forEach((o) => o.fire()))
    expect(card().style.height).toBe('186px')
    expect(cardItem().dataset).toMatchObject({ y: '-75', scale: '0' })

    // The window grows (the draft sent): room for the whole card again.
    rect.mockReturnValue(box(1150, 700, 91, 36))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(card().style.height).toBe('320px')
    expect(cardItem().dataset).toMatchObject({ y: '-142', scale: '0' })

    act(() => root.render(null))
    expect(observers.every((o) => o.disconnected)).toBe(true)
  })

  it('opens a recording’s tooltips above the pill, off the textarea', () => {
    state.isRecording = true
    render({ cardSide: 'top' })
    const sides = () => [...container.querySelectorAll<HTMLElement>('[data-tooltip]')].map((el) => el.dataset.side)
    expect(sides()).toEqual(['top', 'top', 'top'])
    render()
    expect(sides()).toEqual(['bottom', 'bottom', 'bottom'])
  })

  it('is one colour with the composer’s other pills — the app’s background — while the header’s keeps pure white / black', () => {
    const liquid = () => container.querySelector<HTMLElement>('[data-capture-liquid]')!
    render({ cardSide: 'top' })
    expect(liquid().className).not.toMatch(/--background:/)
    render()
    expect(liquid().className).toMatch(/\[--background:0_0%_100%\].*dark:\[--background:0_0%_0%\]/)
  })

  it('never lifts anything for a hanging card (the default)', () => {
    render()
    hover(pill())
    expect(isOpen()).toBe(true)
    expect(cardItem().dataset).toMatchObject({ x: '0', y: '42', scale: '1' })
    expect(card().style.height).toBe('320px')
    expect(lifted()).toBe(false)
    expect(wrapper().className).toMatch(/(^|\s)z-10(\s|$)/)
  })
})

describe('the hanging card (the default — the top bar’s)', () => {
  const realInnerHeight = window.innerHeight
  const setWindowHeight = (height: number) =>
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
  afterEach(() => setWindowHeight(realInnerHeight))

  it('hangs right-aligned below the pill, full size when the window has the room', () => {
    setWindowHeight(900)
    render()
    vi.spyOn(pill(), 'getBoundingClientRect').mockReturnValue(box(1150, 6, 91, 36))
    hover(pill())
    expect(cardItem().dataset).toMatchObject({ x: '0', y: '42', scale: '1' })
    expect(card().style.height).toBe('320px')
    expect(card().style.width).toBe('320px')
  })

  it('shrinks to the room below the pill in a short window, so it never runs off screen', () => {
    // 300 tall, the pill 6px down: 300 - 6 - the 42px drop - 8px clear.
    setWindowHeight(300)
    render()
    vi.spyOn(pill(), 'getBoundingClientRect').mockReturnValue(box(1150, 6, 91, 36))
    hover(pill())
    expect(card().style.height).toBe('244px')
    expect(cardItem().dataset).toMatchObject({ x: '0', y: '42', scale: '1' })
    // The card clips, so the calendar scrolls inside it (its own scroller).
    expect(card().className).toMatch(/(^|\s)overflow-hidden(\s|$)/)
  })

  it('is fitted while still closed, refits as the window resizes, and never shrinks below its floor', () => {
    setWindowHeight(300)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(box(1150, 6, 91, 36))
    render()
    expect(isOpen()).toBe(false)
    // Sized for the room already, and parked on the cap's centre for THAT
    // height (18 - 244/2), so the first pour comes out of the pill.
    expect(card().style.height).toBe('244px')
    expect(cardItem().dataset).toMatchObject({ x: '142', y: '-104', scale: '0' })

    setWindowHeight(900)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(card().style.height).toBe('320px')

    setWindowHeight(150)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(card().style.height).toBe('120px')
  })

  it('narrows to the room left of the pill’s right edge on a very narrow window', () => {
    setWindowHeight(900)
    render()
    // The pill's right edge at 300: 300 - 8px clear.
    const pillBox = vi.spyOn(pill(), 'getBoundingClientRect').mockReturnValue(box(209, 6, 91, 36))
    hover(pill())
    expect(card().style.width).toBe('292px')
    expect(cardItem().dataset).toMatchObject({ x: '0', y: '42', scale: '1' })

    // Narrower still: never below the floor.
    pillBox.mockReturnValue(box(100, 6, 91, 36))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(card().style.width).toBe('240px')
  })

  it('takes the header pills’ pure white / black, and opens a recording’s tooltips below the bar', () => {
    render()
    expect(container.querySelector<HTMLElement>('[data-capture-liquid]')!.className).toMatch(
      /\[--background:0_0%_100%\].*dark:\[--background:0_0%_0%\]/,
    )
    state.isRecording = true
    render()
    const sides = [...container.querySelectorAll<HTMLElement>('[data-tooltip]')].map((el) => el.dataset.side)
    expect(sides).toEqual(['bottom', 'bottom', 'bottom'])
  })
})
