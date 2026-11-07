import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Bridge contract for macOS audio health (coreaudiod stuck → Restart audio)
 * and Dial8's Mic Mode. The website ships ahead of the desktop, so on a
 * desktop without the commands both reads fall back to `unknown` (the
 * notices then never show) instead of rejecting, and nothing touches Tauri
 * in the browser.
 *
 * Hermetic: @tauri-apps/api is mocked directly.
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  desktop: true,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => tauri.desktop }))

const { tauriBridge, toAudioHealth, toMicMode, AUDIO_HEALTH_EVENT } = await import('../tauri-bridge')

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.listen.mockReset()
  tauri.desktop = true
})

describe('toAudioHealth', () => {
  it('reads the event payload and the bare command result', () => {
    expect(toAudioHealth({ health: 'unresponsive' })).toBe('unresponsive')
    expect(toAudioHealth('responsive')).toBe('responsive')
    expect(toAudioHealth('unknown')).toBe('unknown')
  })

  it('drops anything else', () => {
    expect(toAudioHealth({ health: 'stuck' })).toBeNull()
    expect(toAudioHealth(null)).toBeNull()
    expect(toAudioHealth(42)).toBeNull()
  })
})

describe('toMicMode', () => {
  it('passes the three modes through and calls anything else unknown', () => {
    expect(toMicMode('standard')).toBe('standard')
    expect(toMicMode('wide-spectrum')).toBe('wide-spectrum')
    expect(toMicMode('voice-isolation')).toBe('voice-isolation')
    expect(toMicMode('isolation')).toBe('unknown')
    expect(toMicMode(undefined)).toBe('unknown')
  })
})

describe('audioHealth', () => {
  it('get asks the desktop', async () => {
    tauri.invoke.mockResolvedValueOnce('unresponsive')
    expect(await tauriBridge.audioHealth.get()).toBe('unresponsive')
    expect(tauri.invoke).toHaveBeenCalledWith('get_audio_health', undefined)
  })

  it('get is unknown on a desktop without the command, and in the browser', async () => {
    tauri.invoke.mockRejectedValueOnce('Command get_audio_health not found')
    expect(await tauriBridge.audioHealth.get()).toBe('unknown')
    tauri.desktop = false
    expect(await tauriBridge.audioHealth.get()).toBe('unknown')
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
  })

  it('onChanged delivers well-formed verdicts and stops after unsubscribe', async () => {
    let handler: ((e: { payload: unknown }) => void) | null = null
    const unlisten = vi.fn()
    tauri.listen.mockImplementation(async (event: string, h: (e: { payload: unknown }) => void) => {
      expect(event).toBe(AUDIO_HEALTH_EVENT)
      handler = h
      return unlisten
    })
    const seen: string[] = []
    const unsubscribe = tauriBridge.audioHealth.onChanged((h) => seen.push(h))
    // The bridge attaches through a lazy import, which a loaded machine can
    // hold for any number of ticks: wait for the listener, not a tick count.
    await vi.waitFor(() => expect(handler).not.toBeNull())
    handler!({ payload: { health: 'unresponsive' } })
    handler!({ payload: { health: 'garbage' } })
    handler!({ payload: { health: 'responsive' } })
    expect(seen).toEqual(['unresponsive', 'responsive'])
    unsubscribe()
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())
    handler!({ payload: { health: 'unresponsive' } })
    expect(seen).toEqual(['unresponsive', 'responsive'])
  })

  it('onChanged drops a listener that attaches after unsubscribe', async () => {
    let attach: ((fn: () => void) => void) | null = null
    tauri.listen.mockImplementation(() => new Promise((resolve) => (attach = resolve)))
    const unsubscribe = tauriBridge.audioHealth.onChanged(() => {})
    unsubscribe()
    const unlisten = vi.fn()
    await vi.waitFor(() => expect(attach).not.toBeNull())
    attach!(unlisten)
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())
  })

  it('restart invokes the desktop and passes a cancel through', async () => {
    tauri.invoke.mockRejectedValueOnce('cancelled')
    await expect(tauriBridge.audioHealth.restart()).rejects.toBe('cancelled')
    expect(tauri.invoke).toHaveBeenCalledWith('restart_core_audio', undefined)
  })
})

describe('micMode', () => {
  it('get asks the desktop, and is unknown without the command', async () => {
    tauri.invoke.mockResolvedValueOnce('voice-isolation')
    expect(await tauriBridge.micMode.get()).toBe('voice-isolation')
    expect(tauri.invoke).toHaveBeenCalledWith('get_mic_mode', undefined)
    tauri.invoke.mockRejectedValueOnce('Command get_mic_mode not found')
    expect(await tauriBridge.micMode.get()).toBe('unknown')
  })

  it('openPicker invokes the desktop', async () => {
    tauri.invoke.mockResolvedValueOnce(undefined)
    await tauriBridge.micMode.openPicker()
    expect(tauri.invoke).toHaveBeenCalledWith('open_mic_mode_picker', undefined)
  })
})
