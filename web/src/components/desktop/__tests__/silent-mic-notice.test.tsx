// @vitest-environment jsdom
/**
 * The mic in use sending only silence (`audio://input-silent`): one toast per
 * episode, only while something listens (a capture, a voice conversation,
 * Interactive, dictation / Voice ID's hold); an episode that began before is
 * told once the listening starts; sound back closes it, so the next silence
 * is a new episode. Nothing in the browser.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { InputSilentEvent } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const env = vi.hoisted(() => ({
  desktop: true,
  recording: { isRecording: false, isStarting: false },
  listeners: new Set<(e: InputSilentEvent) => void>(),
  toasts: [] as string[],
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => env.desktop }))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => env.recording }))
vi.mock('@/lib/voice/messages', () => ({ voiceToast: (m: string) => void env.toasts.push(m) }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsCancel: async () => {},
    onInputSilent: (cb: (e: InputSilentEvent) => void) => {
      env.listeners.add(cb)
      return () => env.listeners.delete(cb)
    },
  },
}))

import { SilentMicNotice, createSilentMicNotifier, silentMicMessage } from '../silent-mic-notice'
import { claimVoiceSession, releaseVoiceSession } from '@/lib/voice/session-claim'
import { __resetInteractiveVoiceForTests, setInteractivePhase } from '@/lib/voice/interactive-store'

const MESSAGE = 'Shure MV7 isn’t sending any sound. Check it isn’t muted, or pick another mic.'
const silent = (silent: boolean, deviceId: string | null = 'usb-1', name = 'Shure MV7'): InputSilentEvent => ({ deviceId, name, silent })

describe('createSilentMicNotifier', () => {
  it('one notice per episode, only while listening; sound back opens the next one', () => {
    let active = true
    const told: string[] = []
    const n = createSilentMicNotifier({ isActive: () => active, notify: (name) => void told.push(name) })
    n.onEvent(silent(true))
    n.onEvent(silent(true))
    expect(told).toEqual(['Shure MV7'])
    n.onEvent(silent(false))
    n.onEvent(silent(true))
    expect(told).toEqual(['Shure MV7', 'Shure MV7'])

    // Began while nothing listened: told once listening starts, once.
    active = false
    n.onEvent(silent(false))
    n.onEvent(silent(true, 'bt-2', 'AirPods'))
    expect(told).toHaveLength(2)
    active = true
    n.activeChanged()
    n.activeChanged()
    expect(told).toEqual(['Shure MV7', 'Shure MV7', 'AirPods'])
  })

  it('another device going silent is a new episode; an unnamed recovery closes whatever is open', () => {
    const told: string[] = []
    const n = createSilentMicNotifier({ isActive: () => true, notify: (name) => void told.push(name) })
    n.onEvent(silent(true, 'a', 'A'))
    n.onEvent(silent(true, 'b', 'B'))
    n.onEvent(silent(false, null, ''))
    n.onEvent(silent(true, 'b', 'B'))
    expect(told).toEqual(['A', 'B', 'B'])
  })

  it('the message names the mic, or says "Your microphone"', () => {
    expect(silentMicMessage('Shure MV7')).toBe(MESSAGE)
    expect(silentMicMessage('  ')).toBe('Your microphone isn’t sending any sound. Check it isn’t muted, or pick another mic.')
  })
})

describe('SilentMicNotice', () => {
  let container: HTMLDivElement
  let root: Root
  const owner = {}

  const fire = async (e: InputSilentEvent) => {
    await act(async () => {
      for (const l of env.listeners) l(e)
    })
  }

  beforeEach(() => {
    env.desktop = true
    env.recording = { isRecording: false, isStarting: false }
    env.listeners.clear()
    env.toasts = []
    __resetInteractiveVoiceForTests()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    releaseVoiceSession(owner)
  })

  it('nothing in the browser', async () => {
    env.desktop = false
    await act(async () => root.render(h(SilentMicNotice)))
    expect(env.listeners.size).toBe(0)
  })

  it('a voice conversation: one toast for the episode', async () => {
    await act(async () => root.render(h(SilentMicNotice)))
    act(() => claimVoiceSession(owner, () => {}))
    await fire(silent(true))
    await fire(silent(true))
    expect(env.toasts).toEqual([MESSAGE])
  })

  it('nothing listening: no toast; Interactive starting to listen tells it then', async () => {
    await act(async () => root.render(h(SilentMicNotice)))
    await fire(silent(true))
    expect(env.toasts).toEqual([])
    await act(async () => setInteractivePhase('listening'))
    expect(env.toasts).toEqual([MESSAGE])
  })

  it('a capture recording counts as listening', async () => {
    env.recording = { isRecording: true, isStarting: false }
    await act(async () => root.render(h(SilentMicNotice)))
    await fire(silent(true))
    expect(env.toasts).toEqual([MESSAGE])
  })

  it('unmounted: no longer listening for the event', async () => {
    await act(async () => root.render(h(SilentMicNotice)))
    expect(env.listeners.size).toBe(1)
    act(() => root.unmount())
    expect(env.listeners.size).toBe(0)
    root = createRoot(container)
  })
})
