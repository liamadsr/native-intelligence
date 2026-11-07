// @vitest-environment jsdom
/**
 * Voice gating (docs/plans/chat-voice.md §3.4): the shared voice_status store
 * and useVoiceAvailability, with the bridge mocked.
 *
 *  - The browser (and a desktop without voice_status) → not visible, and the
 *    browser never touches the bridge.
 *  - Visible only when voice_status says `available`; the modes follow its
 *    flags; a module status change or window focus re-probes.
 *  - Blocked while a capture records or Voice ID enrollment holds the mic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { VoiceStatus } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  desktop: true,
  status: null as VoiceStatus | null,
  probes: 0,
  moduleListeners: new Set<() => void>(),
  ttsCancels: 0,
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => bridge.desktop }))
vi.mock('@/lib/tauri-bridge', () => {
  const VOICE_UNAVAILABLE = { available: false, dictation: false, conversation: false, stt: 'unsupported', tts: 'unsupported' }
  return {
    VOICE_UNAVAILABLE,
    tauriBridge: {
      voiceStatus: async () => {
        bridge.probes++
        return bridge.status ?? VOICE_UNAVAILABLE
      },
      onModuleStatus: async (cb: () => void) => {
        bridge.moduleListeners.add(cb)
        return () => bridge.moduleListeners.delete(cb)
      },
      ttsCancel: async () => {
        bridge.ttsCancels++
      },
    },
  }
})

import { useVoiceAvailability, type VoiceAvailability } from '../use-voice-availability'
import { __resetVoiceStatusForTests } from '@/lib/voice/status-store'
import { holdReadAloud } from '@/lib/read-aloud/mic-guard'

const READY: VoiceStatus = { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready' }

let root: Root
let host: HTMLDivElement
let got: VoiceAvailability

function Harness({ recording }: { recording: boolean }) {
  got = useVoiceAvailability({ recording })
  return null
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
  })
}

async function render(recording = false) {
  await act(async () => root.render(h(Harness, { recording })))
  await flush()
}

beforeEach(() => {
  __resetVoiceStatusForTests()
  bridge.desktop = true
  bridge.status = null
  bridge.probes = 0
  bridge.moduleListeners.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useVoiceAvailability', () => {
  it('the browser: nothing visible, and no bridge call', async () => {
    bridge.desktop = false
    bridge.status = READY
    await render()
    expect(got.visible).toBe(false)
    expect(got.dictation).toBe(false)
    expect(bridge.probes).toBe(0)
  })

  it('a desktop without voice (voice_status unavailable): nothing visible', async () => {
    await render()
    expect(bridge.probes).toBe(1)
    expect(got.visible).toBe(false)
  })

  it('ready: visible, both modes', async () => {
    bridge.status = READY
    await render()
    expect(got).toMatchObject({ visible: true, dictation: true, conversation: true, blocked: null })
  })

  it('both models still downloading: nothing visible (no set-up prompt), then the controls appear on their own', async () => {
    bridge.status = { ...READY, dictation: false, conversation: false, stt: 'downloading', tts: 'downloading' }
    await render()
    expect(got).toMatchObject({ visible: false, dictation: false, conversation: false })
    bridge.status = READY
    await act(async () => {
      for (const cb of bridge.moduleListeners) cb()
    })
    await flush()
    expect(got).toMatchObject({ visible: true, dictation: true, conversation: true })
  })

  it('a module finishing its download re-probes (dictation only → both)', async () => {
    bridge.status = { ...READY, conversation: false, tts: 'downloading' }
    await render()
    expect(got).toMatchObject({ visible: true, dictation: true, conversation: false })
    bridge.status = READY
    await act(async () => {
      for (const cb of bridge.moduleListeners) cb()
    })
    await flush()
    expect(got.conversation).toBe(true)
  })

  it('window focus re-probes', async () => {
    bridge.status = READY
    await render()
    const before = bridge.probes
    await act(async () => window.dispatchEvent(new Event('focus')))
    await flush()
    expect(bridge.probes).toBe(before + 1)
  })

  it('blocked while a capture records, or Voice ID enrollment holds the mic', async () => {
    bridge.status = READY
    await render(true)
    expect(got.blocked).toBe('recording')
    await render(false)
    expect(got.blocked).toBeNull()
    let release!: () => void
    await act(async () => {
      release = holdReadAloud()
    })
    await flush()
    expect(got.blocked).toBe('enrollment')
    await act(async () => release())
    await flush()
    expect(got.blocked).toBeNull()
  })

  it('dictation’s own read-aloud hold (no mic claim) does not block voice', async () => {
    bridge.status = READY
    await render(false)
    let release!: () => void
    await act(async () => {
      release = holdReadAloud({ mic: false })
    })
    await flush()
    expect(got.blocked).toBeNull()
    expect(got.dictation).toBe(true)
    await act(async () => release())
  })

  it('one probe for every composer, and the listeners go when the last one does', async () => {
    bridge.status = READY
    const host2 = document.createElement('div')
    const root2 = createRoot(host2)
    await render()
    await act(async () => root2.render(h(Harness, { recording: false })))
    await flush()
    expect(bridge.probes).toBe(1)
    expect(bridge.moduleListeners.size).toBe(1)
    await act(async () => root2.unmount())
    act(() => root.unmount())
    await flush()
    expect(bridge.moduleListeners.size).toBe(0)
    root = createRoot(host)
  })
})
