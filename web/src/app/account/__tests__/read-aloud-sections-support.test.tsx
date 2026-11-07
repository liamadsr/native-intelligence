// @vitest-environment jsdom
/**
 * ReadAloudSectionsSupport (../read-aloud-sections-support, inside
 * AccountProviders) drives the section player's `supported` with the chat
 * read-aloud's gate: local-tts enabled and Ready, no capture recording or
 * starting, not held (dictation, Voice ID enrollment). Unmounting it (leaving
 * /account) turns the player off. Its children render unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { LocalModuleInfo } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const env = vi.hoisted(() => ({
  info: null as LocalModuleInfo | null,
  recording: null as null | { isRecording: boolean; isStarting: boolean },
}))

vi.mock('@/hooks/use-local-module', () => ({
  useLocalModule: () => ({ info: env.info }),
}))
vi.mock('@/hooks/recording-context', () => ({
  useOptionalRecordingStable: () => env.recording,
}))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async () => {},
    ttsCancel: async () => {},
    ttsPrepare: async () => {},
    onTtsState: () => () => {},
  },
}))

import { ReadAloudSectionsSupport } from '../read-aloud-sections-support'
import { __resetSectionPlayerForTests, getSectionPlayerSnapshot } from '@/lib/read-aloud/section-player'
import { holdReadAloud } from '@/lib/read-aloud/mic-guard'

const READY: LocalModuleInfo = {
  id: 'local-tts',
  version: 'e801e7d',
  enabled: true,
  state: 'ready',
  progress: null,
  downloadBytes: 144_200_000,
  assetsPresent: true,
  error: null,
}

let container: HTMLDivElement
let root: Root

async function render() {
  await act(async () => root.render(h(ReadAloudSectionsSupport, null, h('p', { id: 'child' }, 'Page'))))
}

const supported = () => getSectionPlayerSnapshot().supported

beforeEach(() => {
  __resetSectionPlayerForTests()
  env.info = READY
  env.recording = { isRecording: false, isStarting: false }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  __resetSectionPlayerForTests()
})

describe('ReadAloudSectionsSupport', () => {
  it('supported with local-tts Ready and no recording; renders its children unchanged', async () => {
    await render()
    expect(supported()).toBe(true)
    expect(container.innerHTML).toBe('<p id="child">Page</p>')
  })

  it('not supported when the module is off, downloading or missing', async () => {
    for (const info of [{ ...READY, enabled: false, state: 'off' as const }, { ...READY, state: 'downloading' as const }, null]) {
      env.info = info
      await render()
      expect(supported()).toBe(false)
    }
  })

  it('not supported while a capture records or is starting', async () => {
    await render()
    env.recording = { isRecording: true, isStarting: false }
    await render()
    expect(supported()).toBe(false)
    env.recording = { isRecording: false, isStarting: true }
    await render()
    expect(supported()).toBe(false)
    env.recording = { isRecording: false, isStarting: false }
    await render()
    expect(supported()).toBe(true)
  })

  it('not supported while read-aloud is held (dictation, Voice ID enrollment)', async () => {
    await render()
    let release!: () => void
    await act(async () => {
      release = holdReadAloud({ mic: false })
    })
    expect(supported()).toBe(false)
    await act(async () => release())
    expect(supported()).toBe(true)
  })

  it('outside a recording provider it only needs the module', async () => {
    env.recording = null
    await render()
    expect(supported()).toBe(true)
  })

  it('unmounting turns the section player off', async () => {
    await render()
    expect(supported()).toBe(true)
    await act(async () => root.unmount())
    expect(supported()).toBe(false)
    root = createRoot(container) // for afterEach
  })
})
