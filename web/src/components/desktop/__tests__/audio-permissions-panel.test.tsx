// @vitest-environment jsdom
/**
 * AudioPermissionsPanel — what each Settings → Recording permission row shows
 * per state, and the old-desktop-build acceptance case.
 *
 * The honesty contract: "Granted" appears only when the passive check said so.
 * An old desktop build (the system-audio commands reject) keeps the mic row's
 * real status — builds ≥ 0.2.41 have the mic commands — while the system row
 * is an honest "Can't verify" with a legacy "Request" that runs the old probe
 * and never turns into "Granted" (on those builds the probe can't see a
 * denial, which is exactly how the old single button came to always say
 * "Granted").
 *
 * The bridge and telemetry are mocked; the real hook drives the rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { bridge, track } = vi.hoisted(() => ({
  bridge: {
    checkMic: vi.fn<() => Promise<string>>(),
    requestMic: vi.fn<() => Promise<string>>(),
    checkSystem: vi.fn<() => Promise<string>>(),
    requestSystem: vi.fn<() => Promise<string>>(),
    requestScreenCapture: vi.fn<() => Promise<string>>(),
  },
  track: vi.fn(),
}))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    checkMicPermission: () => bridge.checkMic(),
    requestMicPermission: () => bridge.requestMic(),
    checkSystemAudioPermission: () => bridge.checkSystem(),
    requestSystemAudioPermission: () => bridge.requestSystem(),
    requestScreenCapturePermission: () => bridge.requestScreenCapture(),
  },
}))
vi.mock('@/lib/recording-telemetry', () => ({
  trackRecordingEvent: (...args: unknown[]) => track(...args),
}))

import { AudioPermissionsPanel } from '../audio-permissions-panel'

const notFound = (cmd: string) => new Error(`Command ${cmd} not found`)

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  for (const fn of Object.values(bridge)) fn.mockReset()
  track.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

async function mount() {
  await act(async () => {
    root.render(h(AudioPermissionsPanel))
  })
  await flush()
}

const row = (id: 'microphone' | 'system-audio') =>
  host.querySelector(`[data-testid="permission-row-${id}"]`) as HTMLElement
const buttonIn = (el: HTMLElement, label: RegExp) =>
  [...el.querySelectorAll('button')].find((b) => label.test(b.textContent || ''))
const click = async (el: HTMLButtonElement | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => {
    el!.click()
  })
  await flush()
}

describe('AudioPermissionsPanel', () => {
  it('shows Checking… with no controls until the first passive read lands', async () => {
    bridge.checkMic.mockReturnValue(new Promise(() => {}))
    bridge.checkSystem.mockReturnValue(new Promise(() => {}))
    await mount()

    for (const id of ['microphone', 'system-audio'] as const) {
      expect(row(id).textContent).toContain('Checking…')
      expect(row(id).querySelector('button')).toBeNull()
    }
  })

  it('granted rows show Granted and nothing to click', async () => {
    bridge.checkMic.mockResolvedValue('granted')
    bridge.checkSystem.mockResolvedValue('granted')
    await mount()

    for (const id of ['microphone', 'system-audio'] as const) {
      expect(row(id).textContent).toContain('Granted')
      expect(row(id).querySelector('button')).toBeNull()
    }
  })

  it('not-determined: Allow runs the real request, then the row follows the passive check', async () => {
    bridge.checkMic.mockResolvedValue('granted')
    bridge.checkSystem.mockResolvedValue('not-determined')
    await mount()
    expect(row('system-audio').textContent).toContain('Not granted')

    bridge.requestSystem.mockResolvedValue('granted')
    bridge.checkSystem.mockResolvedValue('granted')
    await click(buttonIn(row('system-audio'), /^allow$/i))

    expect(bridge.requestSystem).toHaveBeenCalledTimes(1)
    expect(bridge.requestScreenCapture).not.toHaveBeenCalled()
    expect(row('system-audio').textContent).toContain('Granted')
    expect(track).toHaveBeenCalledExactlyOnceWith('system_audio_permission_requested', {
      source: 'settings',
      result: 'granted',
    })
  })

  it('denied: Open System Settings plus where to flip the toggle, per permission', async () => {
    bridge.checkMic.mockResolvedValue('denied')
    bridge.checkSystem.mockResolvedValue('denied')
    await mount()

    const mic = row('microphone')
    expect(mic.textContent).toContain('Denied')
    expect(mic.textContent).toContain('Privacy & Security → Microphone')
    expect(buttonIn(mic, /open system settings/i)).toBeTruthy()

    const system = row('system-audio')
    expect(system.textContent).toContain('Denied')
    expect(system.textContent).toContain('Privacy & Security → Screen & System Audio Recording')
    expect(system.textContent).toContain('This page updates automatically.')

    // Same request command: once denied it opens the right Settings pane.
    bridge.requestMic.mockResolvedValue('opened-settings')
    await click(buttonIn(mic, /open system settings/i))
    expect(bridge.requestMic).toHaveBeenCalledTimes(1)
    expect(row('microphone').textContent).toContain('Denied')
    // Only system-audio requests are reported.
    expect(track).not.toHaveBeenCalled()
  })

  it('macOS without Core Audio taps: Unavailable on this macOS, no button', async () => {
    bridge.checkMic.mockResolvedValue('granted')
    bridge.checkSystem.mockResolvedValue('unsupported')
    await mount()

    expect(row('system-audio').textContent).toContain('Unavailable on this macOS')
    expect(row('system-audio').querySelector('button')).toBeNull()
  })

  it("old desktop build: mic status still shows; system audio is Can't verify, and Request never turns it into Granted", async () => {
    bridge.checkMic.mockResolvedValue('granted')
    bridge.checkSystem.mockRejectedValue(notFound('check_system_audio_permission'))
    bridge.requestSystem.mockRejectedValue(notFound('request_system_audio_permission'))
    bridge.requestScreenCapture.mockResolvedValue('granted') // the probe that can't see a denial
    await mount()

    expect(row('microphone').textContent).toContain('Granted')
    const system = row('system-audio')
    expect(system.textContent).toContain("Can't verify")
    expect(system.textContent).toContain("Update Dial8 to see this permission's status.")

    await click(buttonIn(system, /^request$/i))

    // The old probe still runs (it raises the OS prompt the first time)…
    expect(bridge.requestScreenCapture).toHaveBeenCalledTimes(1)
    // …but its "granted" is not proof on this build.
    expect(row('system-audio').textContent).toContain("Can't verify")
    expect(row('system-audio').textContent).not.toContain('Granted')
    expect(row('system-audio').textContent).toContain("can't confirm the result")
    expect(track).toHaveBeenCalledExactlyOnceWith('system_audio_permission_requested', {
      source: 'settings',
      result: 'granted',
    })
  })

  it("a build without the mic commands (pre-0.2.41) shows Can't verify for the mic with no button", async () => {
    bridge.checkMic.mockRejectedValue(notFound('check_mic_permission'))
    bridge.checkSystem.mockResolvedValue('granted')
    await mount()

    expect(row('microphone').textContent).toContain("Can't verify")
    expect(row('microphone').querySelector('button')).toBeNull()
  })

  describe('in the Windows app', () => {
    beforeEach(() => {
      window.__TAURI_INTERNALS__ = {}
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        configurable: true,
      })
    })
    afterEach(() => {
      delete window.__TAURI_INTERNALS__
      delete (navigator as { userAgent?: string }).userAgent
    })

    it('has no system-audio row (Windows has no such permission)', async () => {
      bridge.checkMic.mockResolvedValue('granted')
      bridge.checkSystem.mockResolvedValue('not_applicable')
      await mount()

      expect(row('microphone').textContent).toContain('Granted')
      expect(row('system-audio')).toBeNull()
    })

    it('a denied mic points at Windows Settings, and the button opens it', async () => {
      bridge.checkMic.mockResolvedValue('denied')
      bridge.checkSystem.mockResolvedValue('not_applicable')
      await mount()

      const mic = row('microphone')
      expect(mic.textContent).toContain('Settings → Privacy & security → Microphone')
      expect(mic.textContent).not.toContain('System Settings')
      bridge.requestMic.mockResolvedValue('opened-settings')
      await click(buttonIn(mic, /^open settings$/i))
      expect(bridge.requestMic).toHaveBeenCalledTimes(1)
    })
  })
})
