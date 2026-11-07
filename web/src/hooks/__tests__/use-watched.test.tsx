// @vitest-environment jsdom
/**
 * useWatched (use-watched.ts): the pixel-canvas gate the roster's bots run
 * by. Watched while the caller's surface is on screen (`active`), the page
 * visible, the window focused, and with input in the last PIXEL_IDLE_MS;
 * any one of them failing is enough to stop the bots, and coming back wakes
 * them at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PIXEL_IDLE_MS } from '@/app/account/(dashboard)/backdrop/pixel-canvas-gate'
import { useWatched } from '../use-watched'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let hidden = false
let observed: boolean[]

function Probe({ active, idle }: { active?: boolean; idle?: boolean }) {
  const value = useWatched(active, idle === undefined ? undefined : { idle })
  observed.push(value)
  return h('span', null, String(value))
}

function render(active?: boolean, idle?: boolean) {
  act(() => root.render(h(Probe, { active, idle })))
}

const watched = () => container.textContent
const fire = (target: EventTarget, type: string) => act(() => void target.dispatchEvent(new Event(type)))
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'Date', 'setTimeout', 'clearTimeout'] })
  hidden = false
  observed = []
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useWatched', () => {
  it('is watched with the window focused, the page visible and recent input', () => {
    render()
    expect(watched()).toBe('true')
  })

  it('is not while the caller’s surface is off screen', () => {
    render(false)
    expect(watched()).toBe('false')
    render(true)
    expect(watched()).toBe('true')
  })

  it('stops when the window loses focus, and wakes when it comes back', () => {
    render()
    fire(window, 'blur')
    expect(watched()).toBe('false')
    fire(window, 'focus')
    expect(watched()).toBe('true')
  })

  it('starts unwatched when the window has no focus at mount', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
    render()
    expect(watched()).toBe('false')
    expect(observed).not.toContain(true)
  })

  it('never starts live canvases when mounted in a hidden page', () => {
    hidden = true
    render()
    expect(watched()).toBe('false')
    expect(observed).not.toContain(true)
  })

  it('stops while the page is hidden', () => {
    render()
    hidden = true
    fire(document, 'visibilitychange')
    expect(watched()).toBe('false')
    hidden = false
    fire(document, 'visibilitychange')
    expect(watched()).toBe('true')
  })

  it('stops a minute after the last input, and any input wakes it', () => {
    render()
    advance(PIXEL_IDLE_MS / 2)
    fire(window, 'pointermove')
    advance(PIXEL_IDLE_MS - 1000)
    // The last input was under a minute ago.
    expect(watched()).toBe('true')
    advance(1000)
    expect(watched()).toBe('false')
    fire(window, 'keydown')
    expect(watched()).toBe('true')
  })

  it('idle: false (the voice bird, hands-free) stays watched with no input at all, and listens for none', () => {
    const add = vi.spyOn(window, 'addEventListener')
    render(true, false)
    expect(add.mock.calls.map((c) => c[0])).not.toContain('pointermove')
    advance(PIXEL_IDLE_MS * 10)
    expect(watched()).toBe('true')
    // Focus and visibility still count.
    fire(window, 'blur')
    expect(watched()).toBe('false')
    fire(window, 'focus')
    expect(watched()).toBe('true')
    hidden = true
    fire(document, 'visibilitychange')
    expect(watched()).toBe('false')
  })

  it('lets go of the window when unmounted', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    render()
    act(() => root.unmount())
    expect(remove.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['pointermove', 'keydown', 'focus', 'blur']))
    root = createRoot(container)
  })
})
