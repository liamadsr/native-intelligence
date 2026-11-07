// @vitest-environment jsdom
/**
 * Settings → Voice → Read anywhere (../read-anywhere-section), folded into the
 * Voice page on 2026-10-22.
 *
 * Contract pinned here:
 *  - Nothing in a browser, on a desktop without the commands, or until the
 *    on-device voice is ready.
 *  - No voice picker of its own: it hands the desktop the read-aloud voice.
 *  - The permission row first, then the switch (off until Accessibility is
 *    granted), then the shortcut once it is on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ReadSelectionStatus } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  status: null as unknown,
  voiceReady: true,
  synced: 0,
  setEnabled: vi.fn(),
}))

vi.mock('@/hooks/use-local-module', () => ({
  useLocalModule: () => ({ supported: true, info: state.voiceReady ? { enabled: true, state: 'ready' } : null }),
}))
vi.mock('@/lib/read-aloud/read-anywhere-voice', () => ({
  syncReadAnywhereVoice: async () => {
    state.synced++
  },
}))
vi.mock('../shortcut-field', () => ({ ShortcutField: () => h('div', { 'data-testid': 'shortcut-field' }) }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    readSelectionStatus: async () => state.status,
    readSelectionSetEnabled: async (on: boolean) => {
      state.setEnabled(on)
      return { ...(state.status as object), enabled: on }
    },
    readSelectionRequestAccess: async () => state.status,
    readSelectionRelaunch: async () => {},
  },
}))

import { ReadAnywhereSection } from '../read-anywhere-section'

const base: ReadSelectionStatus = {
  supported: true,
  enabled: false,
  accessibility: true,
  keystrokes: true,
  hotkey: 'ctrl-alt-r',
  hotkeyLabel: '⌃⌥R',
  hotkeys: [],
  customHotkeyLabel: null,
  voice: null,
  hotkeyError: null,
}

let container: HTMLDivElement
let root: Root

async function render() {
  await act(async () => root.render(h(ReadAnywhereSection)))
  await act(async () => {})
}

const toggle = () => container.querySelector<HTMLButtonElement>('[aria-label="Read selected text aloud"]')

describe('ReadAnywhereSection', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    state.status = { ...base }
    state.voiceReady = true
    state.synced = 0
    state.setEnabled.mockClear()
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders nothing on a desktop without Read anywhere (or a browser)', async () => {
    state.status = { ...base, supported: false }
    await render()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing until the on-device voice is ready', async () => {
    state.voiceReady = false
    await render()
    expect(container.innerHTML).toBe('')
  })

  it('stays reachable to turn off when it is on and the voice is not ready', async () => {
    state.voiceReady = false
    state.status = { ...base, enabled: true }
    await render()
    expect(toggle()?.disabled).toBe(false)
    await act(async () => toggle()?.click())
    expect(state.setEnabled).toHaveBeenCalledWith(false)
  })

  it('can’t be turned on while the voice is not ready', async () => {
    state.voiceReady = false
    state.status = { ...base, enabled: true }
    await render()
    await act(async () => toggle()?.click())
    // Now off and the voice still not ready: hidden again, so it can't be turned back on.
    expect(container.innerHTML).toBe('')
  })

  it('has no voice picker of its own, and brings the voice in step on show', async () => {
    await render()
    expect(container.textContent).toContain('Read anywhere')
    expect(container.textContent).toContain('in the voice above')
    expect(container.querySelector('[aria-label="Voice"]')).toBeNull()
    expect(state.synced).toBe(1)
  })

  it('asks for the permission first and keeps the switch off without it', async () => {
    state.status = { ...base, accessibility: false, keystrokes: false }
    await render()
    expect(container.textContent).toContain('Allow Dial8 to read your selection')
    expect(toggle()?.disabled).toBe(true)
  })

  it('turns on with the permission, then shows the shortcut', async () => {
    await render()
    expect(container.querySelector('[data-testid="shortcut-field"]')).toBeNull()
    await act(async () => toggle()?.click())
    expect(state.setEnabled).toHaveBeenCalledWith(true)
    expect(container.querySelector('[data-testid="shortcut-field"]')).not.toBeNull()
  })
})
