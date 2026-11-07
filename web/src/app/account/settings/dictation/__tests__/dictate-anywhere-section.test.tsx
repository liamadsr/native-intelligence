// @vitest-environment jsdom
/**
 * Settings → Dictation → Dictate anywhere (../dictate-anywhere-section).
 *
 * Contract pinned here:
 *  - Nothing in a browser or on a desktop without the commands, or until the
 *    on-device transcription is ready (unless it's already on).
 *  - One switch, off until the Accessibility permission is granted.
 *  - The switch turns it on and off through dictate_set_enabled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { DictateStatus } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  status: null as unknown,
  sttReady: true,
  setEnabled: vi.fn(),
}))

vi.mock('@/hooks/use-local-module', () => ({
  useLocalModule: () => ({ supported: true, info: state.sttReady ? { enabled: true, state: 'ready' } : null }),
}))
vi.mock('@/app/account/settings/voice/shortcut-field', () => ({ ShortcutField: () => null }))
vi.mock('@/lib/read-aloud/read-anywhere-voice', () => ({ syncReadAnywhereVoice: async () => {} }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    dictateStatus: async () => state.status,
    dictateSetEnabled: async (on: boolean) => {
      state.setEnabled(on)
      return { ...(state.status as object), enabled: on }
    },
    readSelectionRequestAccess: async () => ({}),
    readSelectionRelaunch: async () => {},
  },
}))

import { DictateAnywhereSection } from '../dictate-anywhere-section'

const base: DictateStatus = { supported: true, enabled: false, accessibility: true, keystrokes: true, error: null }

let container: HTMLDivElement
let root: Root

async function mount() {
  // A fresh mount each time: the section reads its status when it mounts.
  act(() => root.unmount())
  root = createRoot(container)
  await act(async () => {
    root.render(<DictateAnywhereSection />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label="Type with your voice"]')

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  state.status = { ...base }
  state.sttReady = true
  state.setEnabled.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('DictateAnywhereSection', () => {
  it('renders nothing on a desktop without it', async () => {
    state.status = { ...base, supported: false }
    await mount()
    expect(container.querySelector('[data-testid="dictate-anywhere-section"]')).toBeNull()
  })

  it('renders nothing until on-device transcription is ready, unless it is already on', async () => {
    state.sttReady = false
    await mount()
    expect(container.querySelector('[data-testid="dictate-anywhere-section"]')).toBeNull()
    state.status = { ...base, enabled: true }
    await mount()
    expect(container.querySelector('[data-testid="dictate-anywhere-section"]')).not.toBeNull()
  })

  it('one switch: off until Accessibility is granted, then it turns the feature on', async () => {
    state.status = { ...base, accessibility: false, keystrokes: false }
    await mount()
    expect(toggle()?.disabled).toBe(true)

    state.status = { ...base }
    await mount()
    expect(toggle()?.disabled).toBe(false)
    await act(async () => {
      toggle()?.click()
    })
    expect(state.setEnabled).toHaveBeenCalledWith(true)
    expect(container.textContent).toContain('tap the right ⌥ key')
  })
})
