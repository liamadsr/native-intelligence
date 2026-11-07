// @vitest-environment jsdom
/**
 * The real voice-glow beam (HUD call glow), as patched by
 * patches/voice-glow+0.2.1.patch (applied by `postinstall`):
 *   - it never reads layout after it has written styles in a frame. Each
 *     read of clientWidth/clientHeight after a style write forces a whole
 *     style recalc and layout of the beam on the spot, on top of the one the
 *     frame does anyway: unpatched, the band canvas's draw read the box size
 *     after the frame's first writes, a fifth of the beam's main-thread time
 *     in WebKit. It now gets the size read at the top of the frame;
 *   - it updates 30 times a second, every second frame of a 60 Hz display
 *     (unpatched: every frame), halving its restyle and repaint cost.
 *
 * jsdom has no layout or canvas, so the box gets a size and the canvas a 2D
 * context that draws nothing; requestAnimationFrame is a manual queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { HudAudioLevels } from '@/components/live-hud/hud-audio-levels'
import { HudAudioGlow } from '../call-glow'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Entry = 'read' | 'write'

let frames = new Map<number, FrameRequestCallback>()
let nextId = 1
let log: Entry[] = []
let container: HTMLDivElement
let root: Root
const sizeProps = ['clientWidth', 'clientHeight'] as const
const originalSize = sizeProps.map((p) => Object.getOwnPropertyDescriptor(Element.prototype, p))

/** A 2D context that accepts every call and draws nothing. */
function fakeContext(): CanvasRenderingContext2D {
  const store: Record<PropertyKey, unknown> = {}
  return new Proxy(store, {
    get: (target, prop) => {
      if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} })
      if (prop in target) return target[prop]
      return () => {}
    },
    set: (target, prop, value) => {
      target[prop] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

beforeEach(() => {
  frames = new Map()
  nextId = 1
  log = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => fakeContext() as unknown as ReturnType<HTMLCanvasElement['getContext']>,
  )
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
  // The HUD chat box's size, and a log of every read of it.
  for (const p of sizeProps) {
    Object.defineProperty(Element.prototype, p, {
      configurable: true,
      get() {
        log.push('read')
        return p === 'clientWidth' ? 420 : 64
      },
    })
  }
  const setProperty = CSSStyleDeclaration.prototype.setProperty
  vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty').mockImplementation(function (
    this: CSSStyleDeclaration,
    ...args: Parameters<CSSStyleDeclaration['setProperty']>
  ) {
    log.push('write')
    return setProperty.apply(this, args)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sizeProps.forEach((p, i) => {
    const d = originalSize[i]
    if (d) Object.defineProperty(Element.prototype, p, d)
    else delete (Element.prototype as unknown as Record<string, unknown>)[p]
  })
})

/** Run the frames queued so far, one display frame apart. */
function runFrame(now: number): Entry[] {
  const due = [...frames.entries()]
  frames.clear()
  log = []
  for (const [, cb] of due) cb(now)
  return log
}

/** Mount the HUD glow with audio flowing, so the beam is on. */
function mountFlowing() {
  let level = 0
  const listeners = new Set<() => void>()
  const levels: HudAudioLevels = {
    get: () => level,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  act(() => root.render(h(HudAudioGlow, { levels, live: true })))
  act(() => {
    level = 0.6
    for (const cb of [...listeners]) cb()
  })
  expect(container.querySelector('[data-voice-beam] canvas')).not.toBeNull()
}

// If these fail, voice-glow is unpatched: run `npm install` (postinstall
// applies patches/).
describe("the HUD call glow's frame", () => {
  it('reads the box size before it writes styles, never after', () => {
    mountFlowing()
    let updates = 0
    for (let i = 1; i <= 8; i++) {
      const frame = runFrame(1000 + i * (1000 / 60))
      if (!frame.includes('write')) continue
      updates++
      // The frame measured the box, then wrote the beam's styles, and read
      // no layout once the writes began (each read would force a style
      // recalc and layout mid-frame).
      expect(frame[0]).toBe('read')
      expect(frame.slice(frame.indexOf('write'))).not.toContain('read')
    }
    expect(updates).toBeGreaterThan(0)
  })

  it('updates on every second frame of a 60 Hz display: 30 a second', () => {
    mountFlowing()
    const updated = Array.from({ length: 8 }, (_, i) =>
      runFrame(1000 + (i + 1) * (1000 / 60)).includes('write'),
    )
    expect(updated).toEqual([true, false, true, false, true, false, true, false])
  })
})
