// @vitest-environment jsdom
/**
 * SystemAudioWarning — the live-capture "recording your mic only" notice and
 * its grant flow for the permissionDenied case.
 *
 * The follow-up line is driven by what request_system_audio_permission came
 * back with (granted / opened-settings / denied), and after a denial the
 * button re-renders as "Open System Settings" — the next request can only
 * open the pane. On an old desktop build the command is missing and the
 * legacy probe answers instead; its "granted" can't be trusted there, so the
 * old non-committal "Permission requested" copy stays.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { bridge, track } = vi.hoisted(() => ({
  bridge: {
    requestSystem: vi.fn<() => Promise<string>>(),
    requestScreenCapture: vi.fn<() => Promise<string>>(),
  },
  track: vi.fn(),
}))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    requestSystemAudioPermission: () => bridge.requestSystem(),
    requestScreenCapturePermission: () => bridge.requestScreenCapture(),
  },
}))
vi.mock('@/lib/recording-telemetry', () => ({
  trackRecordingEvent: (...args: unknown[]) => track(...args),
}))

import { SystemAudioWarning } from '../system-audio-warning'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  bridge.requestSystem.mockReset()
  bridge.requestScreenCapture.mockReset()
  track.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function mount() {
  await act(async () => {
    root.render(h(SystemAudioWarning, { status: 'permissionDenied' }))
  })
}

const button = () => host.querySelector('button')
async function clickButton() {
  const b = button()
  expect(b).toBeTruthy()
  await act(async () => {
    b!.click()
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

describe('SystemAudioWarning — grant flow', () => {
  it('granted: says so and asks for a restart (the live stream cannot switch on mid-capture)', async () => {
    bridge.requestSystem.mockResolvedValue('granted')
    await mount()
    expect(button()?.textContent).toBe('Grant permission')

    await clickButton()
    expect(host.textContent).toContain(
      'Permission granted. Stop and restart the capture to include system audio.',
    )
    expect(button()).toBeNull()
    expect(bridge.requestScreenCapture).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledExactlyOnceWith('system_audio_permission_requested', {
      source: 'live_warning',
      result: 'granted',
    })
  })

  it('denied: explains where to fix it, and the button becomes Open System Settings', async () => {
    bridge.requestSystem.mockResolvedValue('denied')
    await mount()

    await clickButton()
    expect(host.textContent).toContain('Permission was denied. Turn it on under System Settings')
    expect(button()?.textContent).toBe('Open System Settings')

    // Second click: already denied, so the command opens the pane.
    bridge.requestSystem.mockResolvedValue('opened-settings')
    await clickButton()
    expect(bridge.requestSystem).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain(
      'System Settings opened — turn on Dial8 under Screen & System Audio Recording, then stop and restart the capture.',
    )
    expect(button()).toBeNull()
  })

  it('old desktop build: falls back to the legacy probe and never claims a verified grant', async () => {
    bridge.requestSystem.mockRejectedValue(new Error('Command request_system_audio_permission not found'))
    bridge.requestScreenCapture.mockResolvedValue('granted')
    await mount()

    await clickButton()
    expect(bridge.requestScreenCapture).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain(
      'Permission requested. Stop and restart the capture to include system audio.',
    )
    expect(host.textContent).not.toContain('Permission granted')
  })

  it('both commands rejecting leaves the button to retry', async () => {
    bridge.requestSystem.mockRejectedValue(new Error('Command request_system_audio_permission not found'))
    bridge.requestScreenCapture.mockRejectedValue(new Error('ipc down'))
    await mount()

    await clickButton()
    expect(button()?.textContent).toBe('Grant permission')
    expect(track).toHaveBeenCalledExactlyOnceWith('system_audio_permission_requested', {
      source: 'live_warning',
      result: 'error',
    })
  })

  it('offers no grant in the Windows app: Windows has no system-audio permission', async () => {
    window.__TAURI_INTERNALS__ = {}
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true })
    try {
      await mount()
      expect(host.textContent).toContain('Recording your mic only')
      expect(host.textContent).not.toContain('needs permission')
      expect(host.querySelector('button')).toBeNull()
    } finally {
      delete window.__TAURI_INTERNALS__
      delete (navigator as { userAgent?: string }).userAgent
    }
  })
})
