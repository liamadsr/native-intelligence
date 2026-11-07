// @vitest-environment jsdom
/**
 * The call's audio level for the HUD's glow (../hud-audio-levels.ts) and how
 * each host feeds it. Pinned:
 *   - a capture's raw levels become the glow's 0–1 the way the main
 *     composer's call glow made them (louder of mic and system × the gain);
 *   - an attached source listens only while someone subscribes, and reads 0
 *     once nobody does;
 *   - the desktop HUD window hears the native capture's `audio-level`
 *     broadcast itself, listening only while the glow does: the call live
 *     (not paused) and the window showing;
 *   - the web HUD reads the recording's own level store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Handler = (e: { payload: unknown }) => void
const tauri = vi.hoisted(() => ({ global: new Map<string, (e: { payload: unknown }) => void>(), listens: 0 }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, cb: Handler) => {
    tauri.listens++
    tauri.global.set(event, cb)
    return () => tauri.global.delete(event)
  },
  emit: async () => {},
  emitTo: async () => {},
}))
const beam = vi.hoisted(() => ({ props: null as null | { active: boolean; level: () => number } }))
vi.mock('voice-glow', () => ({
  VoiceBeam: (props: { active: boolean; level: () => number }) => {
    beam.props = props
    return null
  },
}))
vi.mock('@/components/live-chat/use-live-chat', () => ({
  useLiveChat: () => ({ messages: [], status: 'ready', error: undefined, loading: false, send: async () => true, answerQuestion: () => {}, stop: () => {} }),
  sendToLiveChat: async () => true,
  BEFORE_SEND_CAP_MS: 1200,
}))
vi.mock('../use-live-agent-name', () => ({ useLiveAgentName: () => 'Sales Coach' }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1', setClientWorkspaceId: vi.fn() }))

import { CAPTURE_LEVEL_GAIN } from '@/app/account/(dashboard)/chat/composer-voice-glow'
import { createAttachedLevels, gainedCaptureLevel, readAudioLevelPayload, type HudAudioLevels } from '../hud-audio-levels'
import { AUDIO_LEVEL_EVENT, useWindowAudioLevels } from '@/app/hud/agent/agent-hud'
import { AgentHudView } from '../agent-hud-view'
import { EMPTY_HUD_FEED, type AgentHudFeed } from '../hud-feed'
import type { HudRecordingState } from '@/lib/live-agent/hud-recording'

// Microtasks, then a macrotask: an unlisten that lands before its listen
// resolved runs a macrotask later (lib/tauri-unlisten listenScoped).
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  tauri.global.clear()
  tauri.listens = 0
  beam.props = null
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  delete (document as unknown as { hidden?: boolean }).hidden
})

describe('the level helpers', () => {
  it('gains the louder of mic and system the way the composer glow did, capped at 1', () => {
    expect(gainedCaptureLevel({ micLevel: 0.01, systemLevel: 0.02 })).toBeCloseTo(0.02 * CAPTURE_LEVEL_GAIN)
    expect(gainedCaptureLevel({ micLevel: 0.5, systemLevel: 0 })).toBe(1)
    expect(gainedCaptureLevel({ micLevel: Number.NaN, systemLevel: -1 })).toBe(0)
    expect(gainedCaptureLevel(null)).toBe(0)
  })

  it('reads an audio-level payload', () => {
    expect(readAudioLevelPayload({ micLevel: 0.1, systemLevel: 0.2, timestamp: 3 })).toEqual({ micLevel: 0.1, systemLevel: 0.2 })
    expect(readAudioLevelPayload({ micLevel: 0.1 })).toEqual({ micLevel: 0.1, systemLevel: 0 })
    expect(readAudioLevelPayload({})).toBeNull()
    expect(readAudioLevelPayload('loud')).toBeNull()
  })

  it('an attached source listens only while subscribed, and reads 0 once nobody does', () => {
    let push: ((l: { micLevel: number; systemLevel: number }) => void) | null = null
    const stop = vi.fn()
    const attach = vi.fn((p: typeof push) => {
      push = p
      return stop
    })
    const levels = createAttachedLevels(attach as never)
    expect(attach).not.toHaveBeenCalled()
    const a = vi.fn()
    const b = vi.fn()
    const offA = levels.subscribe(a)
    const offB = levels.subscribe(b)
    expect(attach).toHaveBeenCalledTimes(1)
    push!({ micLevel: 0.02, systemLevel: 0 })
    expect(levels.get()).toBeCloseTo(0.02 * CAPTURE_LEVEL_GAIN)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    expect(stop).not.toHaveBeenCalled()
    offB()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(levels.get()).toBe(0)
  })
})

describe('the desktop HUD window', () => {
  let levels: HudAudioLevels | null = null
  function Probe() {
    levels = useWindowAudioLevels()
    return null
  }

  it("hears the native capture's audio-level broadcast, only while subscribed", async () => {
    await act(async () => root.render(h(Probe)))
    await flush()
    expect(tauri.global.has(AUDIO_LEVEL_EVENT)).toBe(false)
    const onLevel = vi.fn()
    const off = levels!.subscribe(onLevel)
    await flush()
    expect(tauri.global.has(AUDIO_LEVEL_EVENT)).toBe(true)
    tauri.global.get(AUDIO_LEVEL_EVENT)!({ payload: { micLevel: 0, systemLevel: 0.03, timestamp: 1 } })
    expect(onLevel).toHaveBeenCalledTimes(1)
    expect(levels!.get()).toBeCloseTo(0.03 * CAPTURE_LEVEL_GAIN)
    off()
    await flush()
    expect(tauri.global.has(AUDIO_LEVEL_EVENT)).toBe(false)
  })

  it('the HUD listens only while the call is live and the window showing; the glow follows the level', async () => {
    function Hud({ recording }: { recording: HudRecordingState | null }) {
      const audioLevels = useWindowAudioLevels()
      const feed: AgentHudFeed = { ...EMPTY_HUD_FEED, recording }
      return h(AgentHudView, { host: 'window', feed, actions: { sendVoiceIdAction: () => {} }, audioLevels })
    }
    const rec = (paused: boolean): HudRecordingState => ({ captureId: 'cap-1', paused, finalizing: false, transcription: 'connected', elapsedSec: 1, at: 1 })
    const render = async (recording: HudRecordingState | null) => {
      await act(async () => root.render(h(Hud, { recording })))
      await flush()
    }

    // The recording hasn't said yet: nothing listens.
    await render(null)
    expect(tauri.global.has(AUDIO_LEVEL_EVENT)).toBe(false)

    await render(rec(false))
    expect(tauri.global.has(AUDIO_LEVEL_EVENT)).toBe(true)
    await act(async () => tauri.global.get(AUDIO_LEVEL_EVENT)!({ payload: { micLevel: 0.03, systemLevel: 0 } }))
    // In the waiting box (no conversation yet), beside its textarea.
    const glow = container.querySelector('[data-hud-audio-glow="beam"]')!
    expect(glow.parentElement!.querySelector('textarea')).not.toBeNull()
    expect(beam.props!.active).toBe(true)
    expect(beam.props!.level()).toBeCloseTo(0.03 * CAPTURE_LEVEL_GAIN)

    // Paused: gone, not listening.
    await render(rec(true))
    expect(container.querySelector('[data-hud-audio-glow]')).toBeNull()
    expect(tauri.global.has(AUDIO_LEVEL_EVENT)).toBe(false)

    // Resumed, then the window hides: not listening.
    await render(rec(false))
    expect(tauri.global.has(AUDIO_LEVEL_EVENT)).toBe(true)
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    expect(tauri.global.has(AUDIO_LEVEL_EVENT)).toBe(false)

    // The call ends.
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await render(null)
    expect(tauri.global.has(AUDIO_LEVEL_EVENT)).toBe(false)
  })
})
