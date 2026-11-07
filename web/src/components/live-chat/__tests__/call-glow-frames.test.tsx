// @vitest-environment jsdom
/**
 * HudAudioGlow with the real voice-glow beam: its frame loop runs only while
 * the beam is mounted (audio flowing on a live call) and is cancelled the
 * moment the call ends, pauses or the HUD hides: no frame is scheduled after.
 * requestAnimationFrame is a manual queue here and no frame is ever run
 * (jsdom has no SVG filter or canvas to paint): only what's scheduled counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { HudAudioLevels } from '@/components/live-hud/hud-audio-levels'
import { HudAudioGlow } from '../call-glow'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let frames = new Map<number, FrameRequestCallback>()
let nextId = 1
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  frames = new Map()
  nextId = 1
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (document as unknown as { hidden?: boolean }).hidden
})

function source() {
  let level = 0
  const listeners = new Set<() => void>()
  const levels: HudAudioLevels = {
    get: () => level,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  return {
    levels,
    emit: (next: number) =>
      act(() => {
        level = next
        for (const cb of [...listeners]) cb()
      }),
  }
}

describe("the real beam's frame loop", () => {
  it('runs while audio flows on a live call, and stops for good when the call ends', () => {
    const s = source()
    act(() => root.render(h(HudAudioGlow, { levels: s.levels, live: true })))
    // Live but silent: no beam, no frames.
    expect(frames.size).toBe(0)
    s.emit(0.5)
    expect(container.querySelector('[data-voice-beam]')).not.toBeNull()
    expect(frames.size).toBeGreaterThan(0)

    act(() => root.render(h(HudAudioGlow, { levels: s.levels, live: false })))
    expect(container.querySelector('[data-voice-beam]')).toBeNull()
    expect(frames.size).toBe(0)
    s.emit(0.8)
    expect(frames.size).toBe(0)
  })

  it('stops when the HUD hides', () => {
    const s = source()
    act(() => root.render(h(HudAudioGlow, { levels: s.levels, live: true })))
    s.emit(0.5)
    expect(frames.size).toBeGreaterThan(0)
    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(container.querySelector('[data-voice-beam]')).toBeNull()
    expect(frames.size).toBe(0)
  })
})
