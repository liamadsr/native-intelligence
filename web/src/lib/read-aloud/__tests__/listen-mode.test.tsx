// @vitest-environment jsdom
/**
 * Listen mode's store (../listen-mode), with the real section player and the
 * desktop bridge mocked: off on a fresh page; turning it on reads nothing by
 * itself (the Listen targets do, listen-target.test.tsx); turning it off
 * pauses what the section player reads, which keeps its place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { TtsStatePayload } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async () => void bridge.calls.push('speak'),
    ttsCancel: async () => void bridge.calls.push('cancel'),
    ttsPrepare: async () => void bridge.calls.push('prepare'),
    onTtsState: (_cb: (p: TtsStatePayload) => void) => () => {},
  },
}))

import { __resetListenModeForTests, isListenModeOn, setListenMode, useListenMode } from '../listen-mode'
import {
  __resetSectionPlayerForTests,
  getSectionPlayerSnapshot,
  playSection,
  setSectionPlayerSupported,
} from '../section-player'
import { __resetResumePointsForTests, getResumePoint } from '../resume-points'

const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })

beforeEach(() => {
  __resetListenModeForTests()
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  setSectionPlayerSupported(true)
  bridge.calls = []
})

afterEach(() => {
  __resetListenModeForTests()
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
})

describe('listen mode', () => {
  it('is off on a fresh page; turning it on reads nothing by itself', async () => {
    expect(isListenModeOn()).toBe(false)
    setListenMode(true)
    await flush()
    expect(isListenModeOn()).toBe(true)
    expect(bridge.calls).toEqual([])
  })

  it('turning it off pauses what the section player reads, keeping its place', async () => {
    setListenMode(true)
    await act(async () => playSection('email:m2', ['One.', 'Two.']))
    await flush()
    bridge.calls = []
    await act(async () => setListenMode(false))
    expect(getSectionPlayerSnapshot().playingKey).toBeNull()
    expect(bridge.calls).toEqual(['cancel'])
    expect(getResumePoint('email:m2')).toBe(0)

    // Nothing playing: nothing to pause.
    setListenMode(true)
    bridge.calls = []
    setListenMode(false)
    await flush()
    expect(bridge.calls).toEqual([])
  })

  it('useListenMode follows it', async () => {
    const seen: boolean[] = []
    function Probe() {
      seen.push(useListenMode())
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(h(Probe)))
    await act(async () => setListenMode(true))
    await act(async () => setListenMode(true)) // no change, no render
    await act(async () => setListenMode(false))
    expect(seen).toEqual([false, true, false])
    await act(async () => root.unmount())
  })
})
