import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Voice ID enrollment in the desktop app records through the webview, so it
 * maps the desktop's active mic onto a getUserMedia deviceId by label, and
 * falls back to the default (undefined) on every miss.
 */

const env = vi.hoisted(() => ({
  desktop: true,
  list: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => env.desktop }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: { inputDevices: { list: () => env.list() } },
}))

const { matchInputDeviceId, desktopActiveMic } = await import('../desktop-mic-device')

const input = (deviceId: string, label: string, kind: MediaDeviceKind = 'audioinput') => ({ deviceId, label, kind })

const WEBVIEW_INPUTS = [
  input('default', 'AirPods Pro'),
  input('out1', 'AirPods Pro', 'audiooutput'),
  input('m1', 'MacBook Pro Microphone'),
  input('a1', 'AirPods Pro'),
  input('u1', 'BRIO 4K Stream Edition'),
]

const device = (name: string, over: Record<string, unknown> = {}) => ({
  id: `uid-${name}`,
  name,
  transport: 'usb',
  available: true,
  isDefault: false,
  active: false,
  live: false,
  firstSeenAt: '',
  lastSeenAt: '',
  ...over,
})

const DEFAULT = { deviceId: undefined, labelsHidden: false }

let enumerate: ReturnType<typeof vi.fn>

beforeEach(() => {
  env.desktop = true
  env.list.mockReset()
  enumerate = vi.fn(async () => WEBVIEW_INPUTS)
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: enumerate } })
})

describe('matchInputDeviceId', () => {
  it('matches an audio input by exact label, skipping the default alias and outputs', () => {
    expect(matchInputDeviceId('AirPods Pro', WEBVIEW_INPUTS)).toBe('a1')
    expect(matchInputDeviceId('MacBook Pro Microphone', WEBVIEW_INPUTS)).toBe('m1')
  })

  it('falls back to a case/space-insensitive label, then a single label that wraps the name', () => {
    expect(matchInputDeviceId('macbook  pro microphone', WEBVIEW_INPUTS)).toBe('m1')
    expect(matchInputDeviceId('BRIO', WEBVIEW_INPUTS)).toBe('u1')
  })

  it('no match, an ambiguous wrap, or empty labels (no permission yet) → undefined', () => {
    expect(matchInputDeviceId('Yeti', WEBVIEW_INPUTS)).toBeUndefined()
    expect(matchInputDeviceId('Pro', WEBVIEW_INPUTS)).toBeUndefined()
    expect(matchInputDeviceId('AirPods Pro', [input('x', ''), input('y', '')])).toBeUndefined()
    expect(matchInputDeviceId('', WEBVIEW_INPUTS)).toBeUndefined()
  })
})

describe('desktopActiveMic', () => {
  it('customised list → the active device mapped by label', async () => {
    env.list.mockResolvedValue({
      customised: true,
      devices: [device('AirPods Pro', { transport: 'bluetooth', active: true }), device('MacBook Pro Microphone')],
    })
    expect(await desktopActiveMic()).toEqual({ deviceId: 'a1', labelsHidden: false })
  })

  it('not customised → default (the desktop uses the Mac default too)', async () => {
    env.list.mockResolvedValue({ customised: false, devices: [device('AirPods Pro', { active: true })] })
    expect(await desktopActiveMic()).toEqual(DEFAULT)
    expect(enumerate).not.toHaveBeenCalled()
  })

  it('not customised but a mic chosen for now (the override) → that mic, mapped by label', async () => {
    env.list.mockResolvedValue({
      customised: false,
      overrideId: 'uid-AirPods Pro',
      devices: [device('MacBook Pro Microphone'), device('AirPods Pro', { transport: 'bluetooth', active: true })],
    })
    expect(await desktopActiveMic()).toEqual({ deviceId: 'a1', labelsHidden: false })
  })

  it('no active connected device → default', async () => {
    env.list.mockResolvedValue({ customised: true, devices: [device('AirPods Pro', { active: true, available: false })] })
    expect(await desktopActiveMic()).toEqual(DEFAULT)
  })

  it('desktop 0.2.45 (list rejects), the browser, or enumerate failing → default', async () => {
    env.list.mockRejectedValue('Command list_input_devices not found')
    expect(await desktopActiveMic()).toEqual(DEFAULT)

    env.list.mockResolvedValue({ customised: true, devices: [device('AirPods Pro', { active: true })] })
    enumerate.mockRejectedValueOnce(new Error('nope'))
    expect(await desktopActiveMic()).toEqual(DEFAULT)

    env.desktop = false
    env.list.mockClear()
    expect(await desktopActiveMic()).toEqual(DEFAULT)
    expect(env.list).not.toHaveBeenCalled()
  })

  it('labels hidden (no getUserMedia grant in this document yet) → default, flagged so the caller can look again', async () => {
    env.list.mockResolvedValue({ customised: true, devices: [device('BRIO 4K Stream Edition', { active: true })] })
    // WebKit before the grant: at most one input, with an empty label.
    enumerate.mockResolvedValueOnce([input('', '')])
    expect(await desktopActiveMic()).toEqual({ deviceId: undefined, labelsHidden: true })
    // After the default mic opens, labels are visible and the match lands.
    expect(await desktopActiveMic()).toEqual({ deviceId: 'u1', labelsHidden: false })
  })

  it('labels visible but no matching input → default, not flagged', async () => {
    env.list.mockResolvedValue({ customised: true, devices: [device('Yeti', { active: true })] })
    expect(await desktopActiveMic()).toEqual(DEFAULT)
  })
})
