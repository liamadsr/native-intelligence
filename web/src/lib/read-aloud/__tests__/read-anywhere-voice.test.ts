/**
 * Read anywhere reads in the read-aloud voice (../read-anywhere-voice): the
 * web hands the desktop the read-aloud voice when it differs, and stays quiet
 * in a browser, on an older desktop, or when the desktop refuses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const state = vi.hoisted(() => ({
  desktop: true,
  status: { supported: true, voice: null as string | null },
  stored: null as string | null,
  setVoice: vi.fn<(voice: string | null) => Promise<unknown>>(async () => ({})),
  statusError: null as unknown,
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => state.desktop }))
vi.mock('../settings', () => ({ getReadAloudVoice: () => state.stored }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    readSelectionStatus: async () => {
      if (state.statusError) throw state.statusError
      return state.status
    },
    readSelectionSetVoice: (voice: string | null) => state.setVoice(voice),
  },
}))

import { syncReadAnywhereVoice } from '../read-anywhere-voice'

describe('syncReadAnywhereVoice', () => {
  beforeEach(() => {
    state.desktop = true
    state.status = { supported: true, voice: null }
    state.stored = null
    state.statusError = null
    state.setVoice.mockClear()
  })

  it('hands Read anywhere the stored read-aloud voice when it differs', async () => {
    state.stored = 'ava'
    await syncReadAnywhereVoice()
    expect(state.setVoice).toHaveBeenCalledWith('ava')
  })

  it('takes the voice just picked over the stored one', async () => {
    state.stored = 'ava'
    await syncReadAnywhereVoice('nilo')
    expect(state.setVoice).toHaveBeenCalledWith('nilo')
  })

  it('puts Read anywhere back on the default (null) when read aloud is on it', async () => {
    state.status = { supported: true, voice: 'milton' }
    await syncReadAnywhereVoice(null)
    expect(state.setVoice).toHaveBeenCalledWith(null)
  })

  it('does nothing when the voices already match', async () => {
    state.status = { supported: true, voice: 'ava' }
    state.stored = 'ava'
    await syncReadAnywhereVoice()
    // Both on the default: null on each side.
    state.status = { supported: true, voice: null }
    state.stored = null
    await syncReadAnywhereVoice()
    await syncReadAnywhereVoice(null)
    expect(state.setVoice).not.toHaveBeenCalled()
  })

  it('does nothing in a browser or on a desktop without Read anywhere', async () => {
    state.stored = 'ava'
    state.desktop = false
    await syncReadAnywhereVoice()
    state.desktop = true
    state.status = { supported: false, voice: null }
    await syncReadAnywhereVoice()
    expect(state.setVoice).not.toHaveBeenCalled()
  })

  it('stays quiet when the desktop errors', async () => {
    state.statusError = new Error('no such command')
    await expect(syncReadAnywhereVoice('ava')).resolves.toBeUndefined()
    state.statusError = null
    state.setVoice.mockRejectedValueOnce(new Error('refused'))
    await expect(syncReadAnywhereVoice('ava')).resolves.toBeUndefined()
  })
})
