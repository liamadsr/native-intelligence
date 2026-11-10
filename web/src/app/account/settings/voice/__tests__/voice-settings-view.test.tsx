// @vitest-environment jsdom
/**
 * Voice settings view — the two states (not-enrolled vs enrolled) and the
 * Remove-with-confirm flow.
 *
 * We mock the shared voice-profile hook so the render is deterministic, and the
 * settings-shell navigate hook so the CTAs don't need a router. The DELETE call
 * is stubbed on fetch; we assert the confirm dialog gates it and that a 200
 * triggers a refresh.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { VoiceProfileStatus } from '@/lib/voice-profile/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  status: null as VoiceProfileStatus | null,
  loading: false,
  refresh: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@/hooks/use-voice-profile', () => ({
  useVoiceProfile: () => ({
    status: hoisted.status,
    loading: hoisted.loading,
    refresh: hoisted.refresh,
  }),
}))

vi.mock('@/app/account/settings/settings-shell', () => ({
  useSettingsNavigate: () => hoisted.navigate,
}))

// Its own tests cover it (./read-anywhere-section.test.tsx); here it would
// only add async bridge work after each render.
vi.mock('../read-anywhere-section', () => ({ ReadAnywhereSection: () => null }))

import { VoiceSettingsView } from '../voice-settings-view'

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function mount() {
  act(() => root.render(h(VoiceSettingsView)))
}

function text() {
  return container.textContent || ''
}

beforeEach(() => {
  hoisted.status = null
  hoisted.loading = false
  hoisted.refresh.mockReset()
  hoisted.navigate.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch,
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('VoiceSettingsView — not enrolled', () => {
  it('shows the training pitch + CTA and navigates to the flow', () => {
    hoisted.status = { enrolled: false, quality: null, chunkCount: 0, createdAt: null }
    mount()
    expect(text()).toContain('Teach Native Intelligence your voice')
    // Cross-workspace + privacy explainer is always present.
    expect(text()).toContain('you only need to do it once')

    const cta = [...container.querySelectorAll('button')].find((b) =>
      /teach native intelligence your voice/i.test(b.textContent || ''),
    )
    expect(cta).toBeTruthy()
    act(() => cta!.click())
    expect(hoisted.navigate).toHaveBeenCalledWith('/account/voice-enrollment')
  })
})

describe('VoiceSettingsView — read aloud', () => {
  it('shows no Read aloud section in the browser (desktop local-tts only)', async () => {
    hoisted.status = { enrolled: false, quality: null, chunkCount: 0, createdAt: null }
    mount()
    await flush()
    expect(container.querySelector('[data-testid="read-aloud-section"]')).toBeNull()
    expect(text()).not.toContain('Read aloud')
  })
})

describe('VoiceSettingsView — enrolled', () => {
  beforeEach(() => {
    hoisted.status = {
      enrolled: true,
      quality: 0.9,
      chunkCount: 18,
      createdAt: '2026-07-01T12:00:00.000Z',
    }
  })

  it('shows trained status with the Excellent quality label', () => {
    mount()
    expect(text()).toContain('Voice trained')
    expect(text()).toContain('Excellent')
    expect(text()).toContain('Re-train')
    expect(text()).toContain('Remove')
  })

  it('labels a low-quality profile Fair with a re-train hint', () => {
    hoisted.status = {
      enrolled: true,
      quality: 0.5,
      chunkCount: 12,
      createdAt: '2026-07-01T12:00:00.000Z',
    }
    mount()
    expect(text()).toContain('Fair')
    expect(text()).toContain('Consider re-training')
  })

  it('Remove requires the confirm dialog, then DELETEs and refreshes', async () => {
    mount()
    const removeBtn = [...container.querySelectorAll('button')].find((b) =>
      /^\s*Remove\s*$/i.test(b.textContent || '') || /remove/i.test(b.textContent || ''),
    )
    // Opening the confirm should NOT have fired a DELETE yet.
    act(() => removeBtn!.click())
    await flush()
    expect(fetch).not.toHaveBeenCalled()

    // The AlertDialog renders in a portal; find its destructive confirm button.
    const confirm = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Remove' && b !== removeBtn,
    )
    expect(confirm).toBeTruthy()
    await act(async () => {
      confirm!.click()
      await Promise.resolve()
    })
    await flush()

    expect(fetch).toHaveBeenCalledWith('/api/account/voice-profile', { method: 'DELETE' })
    expect(hoisted.refresh).toHaveBeenCalled()
  })
})
