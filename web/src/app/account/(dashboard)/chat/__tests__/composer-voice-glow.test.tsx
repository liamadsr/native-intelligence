// @vitest-environment jsdom
/**
 * ComposerVoiceGlow — the voice-glow beam on a composer, for whoever drives it
 * (voice mode does): on while `active`, the caller's level getter,
 * `processing` passed through, a fade-out before it unmounts, the app's theme
 * class followed, frozen while the document is hidden.
 *
 * A call no longer drives it: the call's glow moved to the HUD's chat box
 * (components/live-chat/call-glow.tsx; chat-input-voice.test.tsx pins that
 * the main composer stays dark during a call).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { ComposerVoiceGlow, GLOW_UNMOUNT_FALLBACK_MS } from '../composer-voice-glow'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type BeamProps = {
  active: boolean
  paused: boolean
  level: () => number
  theme: 'dark' | 'light'
  processing?: boolean
  distortion?: number
  stream?: MediaStream | null
  onDeactivate: () => void
}
let beam: BeamProps | null = null
vi.mock('voice-glow', () => ({
  VoiceBeam: (props: BeamProps) => {
    beam = props
    return null
  },
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  beam = null
  document.documentElement.classList.remove('dark')
  delete (document as unknown as { hidden?: boolean }).hidden
})

describe('ComposerVoiceGlow', () => {
  const level = () => 0.25

  function renderGlow(props: { active: boolean; level: () => number; processing?: boolean }) {
    if (!container) {
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    }
    act(() => root!.render(h(ComposerVoiceGlow, props)))
  }

  it('mounts while active, with the caller’s level, and fades out before unmounting', () => {
    renderGlow({ active: false, level })
    expect(beam).toBeNull()

    renderGlow({ active: true, level })
    expect(beam?.active).toBe(true)
    expect(beam?.level).toBe(level)
    expect(beam?.stream).toBeUndefined()
    expect(beam?.processing).toBe(false)

    renderGlow({ active: false, level })
    expect(beam?.active).toBe(false)
    expect(container!.childElementCount).toBe(1)
    act(() => beam!.onDeactivate())
    expect(container!.childElementCount).toBe(0)
  })

  it('turns the warp filter off (WebKit runs its feTurbulence on the CPU every frame)', () => {
    renderGlow({ active: true, level })
    expect(beam?.distortion).toBe(0)
  })

  it('unmounts by itself if the fade-out never reports its end (a paused animation)', () => {
    vi.useFakeTimers()
    try {
      renderGlow({ active: true, level })
      renderGlow({ active: false, level })
      expect(container!.childElementCount).toBe(1) // fading out
      act(() => vi.advanceTimersByTime(GLOW_UNMOUNT_FALLBACK_MS - 1))
      expect(container!.childElementCount).toBe(1)
      act(() => vi.advanceTimersByTime(1))
      expect(container!.childElementCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays mounted when it comes back on before the fallback', () => {
    vi.useFakeTimers()
    try {
      renderGlow({ active: true, level })
      renderGlow({ active: false, level })
      act(() => vi.advanceTimersByTime(GLOW_UNMOUNT_FALLBACK_MS / 2))
      renderGlow({ active: true, level })
      act(() => vi.advanceTimersByTime(GLOW_UNMOUNT_FALLBACK_MS * 2))
      expect(container!.childElementCount).toBe(1)
      expect(beam?.active).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes processing through (the travelling beam)', () => {
    renderGlow({ active: true, level, processing: true })
    expect(beam?.processing).toBe(true)
    renderGlow({ active: true, level, processing: false })
    expect(beam?.processing).toBe(false)
  })

  it('follows the app theme class and freezes while the document is hidden', async () => {
    document.documentElement.classList.add('dark')
    renderGlow({ active: true, level })
    expect(beam?.theme).toBe('dark')
    expect(beam?.paused).toBe(false)

    await act(async () => {
      document.documentElement.classList.remove('dark')
    })
    expect(beam?.theme).toBe('light')

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(beam?.paused).toBe(true)
    expect(beam?.active).toBe(true)
  })
})
