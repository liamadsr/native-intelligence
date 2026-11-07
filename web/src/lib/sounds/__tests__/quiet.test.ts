// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/tauri-bridge', () => ({ tauriBridge: { ttsCancel: vi.fn(async () => {}) } }))

import { __resetSoundQuietForTests, holdSoundQuiet, isSoundQuiet, useSoundQuietWhile } from '../quiet'
import { holdReadAloud } from '@/lib/read-aloud/mic-guard'

describe('sound quiet', () => {
  afterEach(() => __resetSoundQuietForTests())

  it('is quiet exactly while a hold is in place (holds nest, release is idempotent)', async () => {
    expect(await isSoundQuiet()).toBe(false)
    const a = holdSoundQuiet('capture')
    const b = holdSoundQuiet('dictation')
    expect(await isSoundQuiet()).toBe(true)
    a()
    a()
    expect(await isSoundQuiet()).toBe(true)
    b()
    expect(await isSoundQuiet()).toBe(false)
  })

  it('every read-aloud hold (dictation, Voice ID enrollment) keeps sounds quiet', async () => {
    const dictation = holdReadAloud({ mic: false })
    expect(await isSoundQuiet()).toBe(true)
    dictation()
    expect(await isSoundQuiet()).toBe(false)
    const enrollment = holdReadAloud()
    expect(await isSoundQuiet()).toBe(true)
    enrollment()
    expect(await isSoundQuiet()).toBe(false)
  })

  it('useSoundQuietWhile holds while its flag is on (a capture recording)', async () => {
    function Probe({ on }: { on: boolean }) {
      useSoundQuietWhile(on, 'capture')
      return null
    }
    const el = document.createElement('div')
    let root: Root
    act(() => {
      root = createRoot(el)
      root.render(h(Probe, { on: false }))
    })
    expect(await isSoundQuiet()).toBe(false)
    act(() => root.render(h(Probe, { on: true })))
    expect(await isSoundQuiet()).toBe(true)
    act(() => root.render(h(Probe, { on: false })))
    expect(await isSoundQuiet()).toBe(false)
    act(() => root.render(h(Probe, { on: true })))
    act(() => root.unmount())
    expect(await isSoundQuiet()).toBe(false)
  })
})
