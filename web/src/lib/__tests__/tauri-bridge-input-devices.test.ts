import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Bridge contract for Input Device Priority. The website ships ahead of the
 * desktop, so on a desktop without the commands (0.2.45) `list()` must reject
 * — the settings section reads a rejection as "hide me" — and nothing may
 * touch Tauri in the browser.
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

const { tauriBridge, toInputDevicesSnapshot, INPUT_DEVICES_CHANGED_EVENT, InputDevicesCommandMissingError } =
  await import('../tauri-bridge')

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

const device = (over: Record<string, unknown> = {}) => ({
  id: 'BuiltInMicrophoneDevice',
  name: 'MacBook Pro Microphone',
  transport: 'builtIn',
  available: true,
  isDefault: true,
  active: true,
  live: false,
  firstSeenAt: '2026-09-26T01:00:00.000Z',
  lastSeenAt: '2026-09-26T01:00:00.000Z',
  ...over,
})

const snapshot = { customised: false, overrideId: null, devices: [device()] }

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.listen.mockReset()
  tauri.desktop = true
})

describe('inputDevices commands', () => {
  it('list passes a well-formed snapshot through', async () => {
    tauri.invoke.mockResolvedValueOnce(snapshot)
    expect(await tauriBridge.inputDevices.list()).toEqual(snapshot)
    expect(tauri.invoke).toHaveBeenCalledWith('list_input_devices', undefined)
  })

  it('list rejects on a desktop without the command (0.2.45) and on junk', async () => {
    tauri.invoke.mockRejectedValueOnce('Command list_input_devices not found')
    await expect(tauriBridge.inputDevices.list()).rejects.toBeDefined()
    tauri.invoke.mockResolvedValueOnce(null)
    await expect(tauriBridge.inputDevices.list()).rejects.toThrow(/malformed/)
    tauri.invoke.mockResolvedValueOnce({ devices: [] })
    await expect(tauriBridge.inputDevices.list()).rejects.toThrow(/malformed/)
  })

  it('every call rejects in the browser without touching Tauri', async () => {
    tauri.desktop = false
    await expect(tauriBridge.inputDevices.list()).rejects.toBeDefined()
    await expect(tauriBridge.inputDevices.setPriority(['a'])).rejects.toBeDefined()
    await expect(tauriBridge.inputDevices.reset()).rejects.toBeDefined()
    await expect(tauriBridge.inputDevices.forget('a')).rejects.toBeDefined()
    await expect(tauriBridge.inputDevices.setOverride('a')).rejects.toBeDefined()
    expect(tauri.invoke).not.toHaveBeenCalled()
    const off = tauriBridge.inputDevices.onChanged(() => {})
    off()
    await settle()
    expect(tauri.listen).not.toHaveBeenCalled()
  })

  it('setPriority / reset / forget send the exact command args', async () => {
    tauri.invoke.mockResolvedValue(snapshot)
    await tauriBridge.inputDevices.setPriority(['b', 'a'])
    await tauriBridge.inputDevices.reset()
    await tauriBridge.inputDevices.forget('gone')
    expect(tauri.invoke.mock.calls).toEqual([
      ['set_input_priority', { ids: ['b', 'a'] }],
      ['reset_input_priority', undefined],
      ['forget_input_device', { id: 'gone' }],
    ])
  })

  it('forget surfaces the desktop refusal for a connected device', async () => {
    tauri.invoke.mockRejectedValueOnce('device is connected')
    await expect(tauriBridge.inputDevices.forget('x')).rejects.toBe('device is connected')
  })

  it('setOverride sends the id, or null to clear, and answers the snapshot', async () => {
    const overridden = { ...snapshot, overrideId: 'BuiltInMicrophoneDevice' }
    tauri.invoke.mockResolvedValueOnce(overridden).mockResolvedValueOnce(snapshot)
    expect(await tauriBridge.inputDevices.setOverride('BuiltInMicrophoneDevice')).toEqual(overridden)
    expect(await tauriBridge.inputDevices.setOverride(null)).toEqual(snapshot)
    expect(tauri.invoke.mock.calls).toEqual([
      ['set_input_override', { id: 'BuiltInMicrophoneDevice' }],
      ['set_input_override', { id: null }],
    ])
  })

  it('a desktop without set_input_override → InputDevicesCommandMissingError; a refusal passes through', async () => {
    tauri.invoke.mockRejectedValueOnce('Command set_input_override not found')
    const missing = await tauriBridge.inputDevices.setOverride('x').catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(InputDevicesCommandMissingError)
    expect((missing as InstanceType<typeof InputDevicesCommandMissingError>).command).toBe('set_input_override')

    tauri.invoke.mockRejectedValueOnce('Command set_input_override not allowed by ACL')
    await expect(tauriBridge.inputDevices.setOverride('x')).rejects.toBeInstanceOf(InputDevicesCommandMissingError)

    // The desktop's own refusal (e.g. an unknown device) is not a missing command.
    tauri.invoke.mockRejectedValueOnce('device not found')
    await expect(tauriBridge.inputDevices.setOverride('x')).rejects.toBe('device not found')
  })
})

describe('toInputDevicesSnapshot', () => {
  it('unavailableReason: only `lid_closed` is kept (the MacBook mic, lid shut, still `available`)', () => {
    const snap = toInputDevicesSnapshot({
      customised: false,
      devices: [
        device({ id: 'lid', unavailableReason: 'lid_closed' }),
        device({ id: 'odd', isDefault: false, active: false, unavailableReason: 'on_fire' }),
        device({ id: 'plain', isDefault: false, active: false }),
      ],
    })
    expect(snap?.devices[0]).toMatchObject({ id: 'lid', available: true, unavailableReason: 'lid_closed' })
    expect(snap?.devices[1]).not.toHaveProperty('unavailableReason')
    expect(snap?.devices[2]).not.toHaveProperty('unavailableReason')
  })

  it('normalises rows: drops id-less and duplicate rows, unknown transport → other, one active', () => {
    const snap = toInputDevicesSnapshot({
      customised: true,
      devices: [
        device({ id: 'a', transport: 'bluetooth', active: true, live: true }),
        device({ id: 'b', transport: 'laser', active: true, live: true, name: '' }),
        device({ id: '' }),
        { name: 'no id' },
        device({ id: 'a' }),
        'junk',
      ],
    })
    expect(snap?.customised).toBe(true)
    expect(snap?.devices.map((d) => [d.id, d.transport, d.active, d.live, d.name])).toEqual([
      ['a', 'bluetooth', true, true, 'MacBook Pro Microphone'],
      ['b', 'other', false, false, 'b'],
    ])
  })

  it('overrideId: kept when it names a row; null when absent (older desktop), not a string, or unknown', () => {
    const rows = [device({ id: 'a' }), device({ id: 'b', active: false })]
    expect(toInputDevicesSnapshot({ customised: false, overrideId: 'b', devices: rows })?.overrideId).toBe('b')
    expect(toInputDevicesSnapshot({ customised: false, devices: rows })?.overrideId).toBeNull()
    expect(toInputDevicesSnapshot({ customised: false, overrideId: null, devices: rows })?.overrideId).toBeNull()
    expect(toInputDevicesSnapshot({ customised: false, overrideId: 7, devices: rows })?.overrideId).toBeNull()
    expect(toInputDevicesSnapshot({ customised: false, overrideId: 'gone', devices: rows })?.overrideId).toBeNull()
    // A row dropped by the normaliser can't be the override either.
    expect(toInputDevicesSnapshot({ customised: false, overrideId: '', devices: [...rows, device({ id: '' })] })?.overrideId).toBeNull()
  })

  it('rejects non-snapshots', () => {
    expect(toInputDevicesSnapshot(undefined)).toBeNull()
    expect(toInputDevicesSnapshot({ customised: 'yes', devices: [] })).toBeNull()
    expect(toInputDevicesSnapshot({ customised: false, devices: {} })).toBeNull()
  })
})

describe('inputDevices.onChanged', () => {
  it('delivers normalised snapshots from audio://input-devices-changed and drops junk', async () => {
    let handler: ((e: { payload: unknown }) => void) | null = null
    const unlisten = vi.fn()
    tauri.listen.mockImplementation(async (name: string, h: (e: { payload: unknown }) => void) => {
      expect(name).toBe(INPUT_DEVICES_CHANGED_EVENT)
      expect(name).toBe('audio://input-devices-changed')
      handler = h
      return unlisten
    })
    const cb = vi.fn()
    const off = tauriBridge.inputDevices.onChanged(cb)
    // The bridge attaches through a lazy import, which a loaded machine can
    // hold for any number of ticks: wait for the listener, not a tick count.
    await vi.waitFor(() => expect(handler).not.toBeNull())
    handler!({ payload: snapshot })
    handler!({ payload: { nope: true } })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(snapshot)
    off()
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
    handler!({ payload: snapshot })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('unsubscribing before the listener attaches still detaches it', async () => {
    const unlisten = vi.fn()
    let resolve: (fn: () => void) => void = () => {}
    tauri.listen.mockImplementation(() => new Promise((r) => { resolve = r }))
    const off = tauriBridge.inputDevices.onChanged(() => {})
    await vi.waitFor(() => expect(tauri.listen).toHaveBeenCalled())
    off()
    resolve(unlisten)
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
  })
})
