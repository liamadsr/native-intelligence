// @vitest-environment jsdom
/**
 * HudAudioGlow: the main chat's audio-reactive glow (ComposerVoiceGlow, i.e.
 * voice-glow's VoiceBeam) on the HUD's chat box, driven by the call's level.
 * Pinned:
 *   - it samples the host's level getter (the beam's `level` IS the source's
 *     getter), on once audio flows;
 *   - silence for SILENCE_HOLD_MS fades it out, then it unmounts; sound
 *     brings it back;
 *   - the call ending or pausing (`live` false) and a hidden HUD unmount it on
 *     the spot and drop the level subscription: nothing listens, no timer;
 *   - while listening, a level sets state only when audio starts (one render);
 *   - reduced motion: a still tint, no beam, no subscription, no frames;
 *   - no levels: nothing.
 * The real beam's frame loop starting and stopping: ./call-glow-frames.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { HudAudioLevels } from '@/components/live-hud/hud-audio-levels'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type BeamProps = { active: boolean; level: () => number; onDeactivate: () => void }
const beam = vi.hoisted(() => ({ props: null as BeamProps | null, renders: 0 }))
vi.mock('voice-glow', () => ({
  VoiceBeam: (props: BeamProps) => {
    beam.props = props
    beam.renders++
    return null
  },
}))

import { FLOWING_LEVEL, HudAudioGlow, SILENCE_HOLD_MS } from '../call-glow'

/** A level source the test drives: `set` a level, `emit` it. */
function source(initial = 0) {
  let level = initial
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
    listeners,
    emit: (next: number) =>
      act(() => {
        level = next
        for (const cb of [...listeners]) cb()
      }),
  }
}

let reduced = false
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  reduced = false
  beam.props = null
  beam.renders = 0
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('prefers-reduced-motion') && reduced
    },
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (document as unknown as { hidden?: boolean }).hidden
})

const render = (props: { levels: HudAudioLevels | null; live: boolean }) => act(() => root.render(h(HudAudioGlow, props)))
const setHidden = (hidden: boolean) =>
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    document.dispatchEvent(new Event('visibilitychange'))
  })

describe('HudAudioGlow', () => {
  it("samples the source's level, on once audio flows", () => {
    const s = source()
    render({ levels: s.levels, live: true })
    expect(s.listeners.size).toBe(1)
    // Silence so far: listening, nothing mounted.
    expect(beam.props).toBeNull()
    s.emit(FLOWING_LEVEL / 2)
    expect(beam.props).toBeNull()

    s.emit(0.4)
    expect(beam.props!.active).toBe(true)
    // The beam samples the source's own getter each frame.
    expect(beam.props!.level).toBe(s.levels.get)
    expect(beam.props!.level()).toBe(0.4)
    s.emit(0.7)
    expect(beam.props!.level()).toBe(0.7)
  })

  it('a level re-renders only when audio starts, not for every level', () => {
    const s = source()
    render({ levels: s.levels, live: true })
    s.emit(0.4)
    const renders = beam.renders
    for (let i = 0; i < 20; i++) s.emit(0.2 + (i % 5) / 10)
    expect(beam.renders).toBe(renders)
  })

  it('fades out after SILENCE_HOLD_MS of silence, unmounts, and comes back with the next sound', () => {
    vi.useFakeTimers()
    const s = source()
    render({ levels: s.levels, live: true })
    s.emit(0.5)
    act(() => vi.advanceTimersByTime(SILENCE_HOLD_MS - 1000))
    s.emit(0.5) // still talking: the hold starts over
    act(() => vi.advanceTimersByTime(SILENCE_HOLD_MS - 500))
    expect(beam.props!.active).toBe(true)
    s.emit(0)
    act(() => vi.advanceTimersByTime(600))
    expect(beam.props!.active).toBe(false)
    // Once it's quiet only the fade's unmount fallback is left (ComposerVoiceGlow).
    expect(vi.getTimerCount()).toBe(1)
    // The beam's fade-out ends: unmounted, and no timer left.
    const last = beam.props!
    beam.props = null
    act(() => last.onDeactivate())
    expect(vi.getTimerCount()).toBe(0)
    beam.renders = 0
    s.emit(0)
    expect(beam.renders).toBe(0)
    s.emit(0.3)
    expect(beam.props!.active).toBe(true)
  })

  it('the call ending or pausing unmounts it at once and stops listening', () => {
    vi.useFakeTimers()
    const s = source()
    render({ levels: s.levels, live: true })
    s.emit(0.5)
    expect(beam.props!.active).toBe(true)
    beam.renders = 0
    render({ levels: s.levels, live: false })
    expect(container.querySelector('[data-hud-audio-glow]')).toBeNull()
    expect(s.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    s.emit(0.9)
    expect(beam.renders).toBe(0)
    // Live again (resumed): listening again.
    render({ levels: s.levels, live: true })
    expect(s.listeners.size).toBe(1)
  })

  it('a hidden HUD unmounts it and stops listening; shown again, it listens again', () => {
    const s = source()
    render({ levels: s.levels, live: true })
    s.emit(0.5)
    expect(container.querySelector('[data-hud-audio-glow="beam"]')).not.toBeNull()
    setHidden(true)
    expect(container.querySelector('[data-hud-audio-glow]')).toBeNull()
    expect(s.listeners.size).toBe(0)
    setHidden(false)
    expect(s.listeners.size).toBe(1)
  })

  it('reduced motion: a still tint, no beam, nothing listening, no frames', () => {
    reduced = true
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const s = source(0.8)
    render({ levels: s.levels, live: true })
    s.emit(0.8)
    const still = container.querySelector('[data-hud-audio-glow="still"]')
    expect(still).not.toBeNull()
    expect(still!.className).toBe('hud-audio-glow-still')
    expect(beam.props).toBeNull()
    expect(s.listeners.size).toBe(0)
    expect(raf).not.toHaveBeenCalled()
    // Not live: not even the tint.
    render({ levels: s.levels, live: false })
    expect(container.querySelector('[data-hud-audio-glow]')).toBeNull()
  })

  it('no level source: nothing', () => {
    render({ levels: null, live: true })
    expect(container.innerHTML).toBe('')
    expect(beam.props).toBeNull()
  })
})
