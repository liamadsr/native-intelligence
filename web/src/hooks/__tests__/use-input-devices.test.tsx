// @vitest-environment jsdom
/**
 * useInputDevices — the desktop's input-device priority list.
 *
 * Drives the REAL hook against an in-memory bridge (list / setters and the
 * audio://input-devices-changed event on a fake bus; no @tauri-apps import).
 *
 * Pinned:
 *  1. list() resolves → ready with its snapshot; rejects (0.2.45) → unsupported.
 *  2. A live event replaces the snapshot.
 *  3. setPriority is optimistic (reordered + customised at once), then takes
 *     the desktop's answer; a refusal reverts.
 *  4. Events during a drag are held and applied when the drag ends; events
 *     during a write never flash the old order back.
 *  5. reset / forget are optimistic and revert on refusal.
 *  6. `enabled: false` asks nothing and subscribes to nothing (unsupported);
 *     turning it on loads the list.
 *  7. setOverride ("for now") moves the check, never the order, then takes
 *     the answer; null goes back to the order's pick; a refusal reverts. A
 *     desktop without set_input_override answers 'unsupported' (reverted) and
 *     is never asked again this session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { InputDevice, InputDevicesSnapshot } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const env = vi.hoisted(() => {
  const listeners = new Set<(s: unknown) => void>()
  class CommandMissing extends Error {
    readonly command: string
    constructor(command: string) {
      super(`Command ${command} not found`)
      this.command = command
    }
  }
  return {
    listeners,
    emit: (s: unknown) => { for (const cb of [...listeners]) cb(s) },
    desktop: true,
    list: vi.fn(),
    setPriority: vi.fn(),
    setOverride: vi.fn(),
    reset: vi.fn(),
    forget: vi.fn(),
    CommandMissing,
  }
})

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => env.desktop }))
vi.mock('@/lib/tauri-bridge', () => ({
  InputDevicesCommandMissingError: env.CommandMissing,
  tauriBridge: {
    inputDevices: {
      list: () => env.list(),
      setPriority: (ids: string[]) => env.setPriority(ids),
      setOverride: (id: string | null) => env.setOverride(id),
      reset: () => env.reset(),
      forget: (id: string) => env.forget(id),
      onChanged: (cb: (s: unknown) => void) => {
        env.listeners.add(cb)
        return () => { env.listeners.delete(cb) }
      },
    },
  },
}))

const { useInputDevices, applyPriority, applyOverride, priorityPick, __resetInputOverrideSupportForTests } =
  await import('../use-input-devices')
type Api = ReturnType<typeof useInputDevices>

const dev = (id: string, over: Partial<InputDevice> = {}): InputDevice => ({
  id,
  name: id.toUpperCase(),
  transport: 'usb',
  available: true,
  isDefault: false,
  active: false,
  live: false,
  firstSeenAt: '2026-09-26T01:00:00.000Z',
  lastSeenAt: '2026-09-26T01:00:00.000Z',
  ...over,
})
const snap = (ids: string[], customised = false): InputDevicesSnapshot => ({
  customised,
  overrideId: null,
  devices: ids.map((id, i) => dev(id, { isDefault: i === 0 && !customised, active: i === 0 })),
})
const ids = (api: Api) => api.snapshot?.devices.map((d) => d.id)
const activeId = (s: InputDevicesSnapshot | null | undefined) => s?.devices.find((d) => d.active)?.id
/** snap(ids) as the desktop answers with `id` in use for now. */
const overridden = (base: InputDevicesSnapshot, id: string): InputDevicesSnapshot => ({
  ...base,
  overrideId: id,
  devices: base.devices.map((d) => ({ ...d, active: d.id === id })),
})

let container: HTMLDivElement
let root: Root
let api: Api

function Harness({ enabled }: { enabled?: boolean }) {
  api = useInputDevices(enabled === undefined ? undefined : { enabled })
  return null
}

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
}

async function mount() {
  await act(async () => { root.render(h(Harness)) })
  await flush()
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  env.listeners.clear()
  env.desktop = true
  env.list.mockReset().mockResolvedValue(snap(['a', 'b', 'c']))
  env.setPriority.mockReset()
  env.setOverride.mockReset()
  env.reset.mockReset()
  env.forget.mockReset()
  __resetInputOverrideSupportForTests()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

describe('useInputDevices: load + gating', () => {
  it('ready with the listed snapshot, subscribed to changes', async () => {
    await mount()
    expect(api.status).toBe('ready')
    expect(ids(api)).toEqual(['a', 'b', 'c'])
    expect(env.listeners.size).toBe(1)
  })

  it('list() rejecting (desktop 0.2.45) → unsupported, unsubscribed', async () => {
    env.list.mockRejectedValue('Command list_input_devices not found')
    await mount()
    expect(api.status).toBe('unsupported')
    expect(api.snapshot).toBeNull()
    expect(env.listeners.size).toBe(0)
  })

  it('outside the desktop shell → unsupported without calling the bridge', async () => {
    env.desktop = false
    await mount()
    expect(api.status).toBe('unsupported')
    expect(env.list).not.toHaveBeenCalled()
  })

  it('unmount unsubscribes', async () => {
    await mount()
    await act(async () => { root.unmount() })
    expect(env.listeners.size).toBe(0)
    root = createRoot(container)
  })
})

describe('useInputDevices: live events', () => {
  it('an event replaces the snapshot', async () => {
    await mount()
    await act(async () => { env.emit(snap(['c', 'a'])) })
    expect(ids(api)).toEqual(['c', 'a'])
  })

  it('an event that beats the list() answer wins', async () => {
    const d = deferred<InputDevicesSnapshot>()
    env.list.mockReturnValue(d.promise)
    await mount()
    await act(async () => { env.emit(snap(['z'])) })
    d.resolve(snap(['a', 'b']))
    await flush()
    expect(ids(api)).toEqual(['z'])
    expect(api.status).toBe('ready')
  })

  it('events during a drag are held, the latest applied on drag end', async () => {
    await mount()
    act(() => api.setDragging(true))
    await act(async () => {
      env.emit(snap(['b', 'a', 'c']))
      env.emit(snap(['c', 'b', 'a']))
    })
    expect(ids(api)).toEqual(['a', 'b', 'c'])
    act(() => api.setDragging(false))
    expect(ids(api)).toEqual(['c', 'b', 'a'])
  })
})

describe('useInputDevices: writes', () => {
  it('setPriority applies at once (customised), then takes the answer', async () => {
    const d = deferred<InputDevicesSnapshot>()
    env.setPriority.mockReturnValue(d.promise)
    await mount()
    let result: Promise<boolean> = Promise.resolve(false)
    act(() => { result = api.setPriority(['c', 'a']) })
    expect(env.setPriority).toHaveBeenCalledWith(['c', 'a'])
    // Optimistic: c, a, then b (left out → kept after), customised.
    expect(ids(api)).toEqual(['c', 'a', 'b'])
    expect(api.snapshot?.customised).toBe(true)
    // A stale event mid-write doesn't flash the old order back.
    await act(async () => { env.emit(snap(['a', 'b', 'c'])) })
    expect(ids(api)).toEqual(['c', 'a', 'b'])
    await act(async () => { d.resolve(snap(['c', 'a', 'b'], true)) })
    expect(await result).toBe(true)
    expect(ids(api)).toEqual(['c', 'a', 'b'])
    expect(api.snapshot?.customised).toBe(true)
    // Events flow again afterwards.
    await act(async () => { env.emit(snap(['b', 'c', 'a'], true)) })
    expect(ids(api)).toEqual(['b', 'c', 'a'])
  })

  it('setPriority refused → reverts to the previous snapshot', async () => {
    env.setPriority.mockRejectedValue(new Error('nope'))
    await mount()
    let ok = true
    await act(async () => { ok = await api.setPriority(['c', 'b', 'a']) })
    expect(ok).toBe(false)
    expect(ids(api)).toEqual(['a', 'b', 'c'])
    expect(api.snapshot?.customised).toBe(false)
  })

  it('setPriority refused → an event held during the write wins over the revert', async () => {
    const d = deferred<InputDevicesSnapshot>()
    env.setPriority.mockReturnValue(d.promise)
    await mount()
    act(() => { void api.setPriority(['c']) })
    await act(async () => { env.emit(snap(['a', 'b', 'c', 'd'])) })
    await act(async () => { d.reject(new Error('nope')) })
    expect(ids(api)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reset: optimistic customised=false, answer applied; refusal reverts', async () => {
    env.list.mockResolvedValue(snap(['b', 'a'], true))
    env.reset.mockResolvedValueOnce(snap(['a', 'b'], false))
    await mount()
    await act(async () => { await api.reset() })
    expect(api.snapshot?.customised).toBe(false)
    expect(ids(api)).toEqual(['a', 'b'])

    await act(async () => { env.emit(snap(['b', 'a'], true)) })
    env.reset.mockRejectedValueOnce(new Error('nope'))
    let ok = true
    await act(async () => { ok = await api.reset() })
    expect(ok).toBe(false)
    expect(api.snapshot?.customised).toBe(true)
  })

  it('forget: optimistic removal; refusal (device connected) reverts', async () => {
    env.forget.mockResolvedValueOnce(snap(['a', 'c']))
    await mount()
    await act(async () => { await api.forget('b') })
    expect(env.forget).toHaveBeenCalledWith('b')
    expect(ids(api)).toEqual(['a', 'c'])

    env.forget.mockRejectedValueOnce('device is connected')
    let ok = true
    await act(async () => { ok = await api.forget('c') })
    expect(ok).toBe(false)
    expect(ids(api)).toEqual(['a', 'c'])
  })

  it('an answer that lands during a new drag is held until the drag ends', async () => {
    const d = deferred<InputDevicesSnapshot>()
    env.setPriority.mockReturnValue(d.promise)
    await mount()
    act(() => { void api.setPriority(['b', 'a', 'c']) })
    act(() => api.setDragging(true))
    await act(async () => { d.resolve(snap(['b', 'a', 'c'], true)) })
    act(() => api.setDragging(false))
    expect(ids(api)).toEqual(['b', 'a', 'c'])
  })
})

describe('useInputDevices: setOverride (for now)', () => {
  it('moves the check at once without reordering, then takes the answer', async () => {
    const d = deferred<InputDevicesSnapshot>()
    env.setOverride.mockReturnValue(d.promise)
    await mount()
    let result: Promise<string> = Promise.resolve('')
    act(() => { result = api.setOverride('c') })
    expect(env.setOverride).toHaveBeenCalledWith('c')
    expect(ids(api)).toEqual(['a', 'b', 'c'])
    expect(api.snapshot?.overrideId).toBe('c')
    expect(activeId(api.snapshot)).toBe('c')
    expect(api.snapshot?.customised).toBe(false)
    // A stale event mid-write doesn't flash the old check back.
    await act(async () => { env.emit(snap(['a', 'b', 'c'])) })
    expect(activeId(api.snapshot)).toBe('c')
    await act(async () => { d.resolve(overridden(snap(['a', 'b', 'c']), 'c')) })
    expect(await result).toBe('ok')
    expect(api.snapshot?.overrideId).toBe('c')
    expect(env.setPriority).not.toHaveBeenCalled()
  })

  it('null goes back to the order: the check returns to its pick', async () => {
    env.list.mockResolvedValue(overridden(snap(['a', 'b', 'c'], true), 'b'))
    const d = deferred<InputDevicesSnapshot>()
    env.setOverride.mockReturnValue(d.promise)
    await mount()
    expect(api.snapshot?.overrideId).toBe('b')
    act(() => { void api.setOverride(null) })
    expect(env.setOverride).toHaveBeenCalledWith(null)
    expect(api.snapshot?.overrideId).toBeNull()
    expect(activeId(api.snapshot)).toBe('a')
    expect(ids(api)).toEqual(['a', 'b', 'c'])
    await act(async () => { d.resolve(snap(['a', 'b', 'c'], true)) })
    expect(api.snapshot?.overrideId).toBeNull()
  })

  it('refused → reverts, answers refused', async () => {
    env.setOverride.mockRejectedValue('device not found')
    await mount()
    let result = ''
    await act(async () => { result = await api.setOverride('b') })
    expect(result).toBe('refused')
    expect(api.snapshot?.overrideId).toBeNull()
    expect(activeId(api.snapshot)).toBe('a')
    // A plain refusal isn't remembered: the next call asks again.
    env.setOverride.mockResolvedValueOnce(overridden(snap(['a', 'b', 'c']), 'b'))
    await act(async () => { result = await api.setOverride('b') })
    expect(result).toBe('ok')
    expect(env.setOverride).toHaveBeenCalledTimes(2)
  })

  it('a desktop without the command → unsupported (reverted), and never asked again this session', async () => {
    env.setOverride.mockRejectedValue(new env.CommandMissing('set_input_override'))
    await mount()
    let result = ''
    await act(async () => { result = await api.setOverride('b') })
    expect(result).toBe('unsupported')
    expect(api.snapshot?.overrideId).toBeNull()
    expect(activeId(api.snapshot)).toBe('a')

    await act(async () => { result = await api.setOverride('c') })
    expect(result).toBe('unsupported')
    expect(env.setOverride).toHaveBeenCalledTimes(1)
    expect(activeId(api.snapshot)).toBe('a')

    // A remount (another composer) remembers it too.
    await act(async () => { root.unmount() })
    root = createRoot(container)
    await mount()
    await act(async () => { result = await api.setOverride('c') })
    expect(result).toBe('unsupported')
    expect(env.setOverride).toHaveBeenCalledTimes(1)
  })

  it('setPriority keeps the override', async () => {
    env.list.mockResolvedValue(overridden(snap(['a', 'b', 'c'], true), 'c'))
    env.setPriority.mockReturnValue(new Promise(() => {}))
    await mount()
    act(() => { void api.setPriority(['b', 'a', 'c']) })
    expect(ids(api)).toEqual(['b', 'a', 'c'])
    expect(api.snapshot?.overrideId).toBe('c')
    expect(activeId(api.snapshot)).toBe('c')
  })
})

describe('applyPriority', () => {
  it('orders by ids, ignores unknown and duplicate ids, keeps the rest after', () => {
    const out = applyPriority(snap(['a', 'b', 'c', 'd']), ['c', 'zz', 'a', 'c'])
    expect(out.customised).toBe(true)
    expect(out.devices.map((d) => d.id)).toEqual(['c', 'a', 'b', 'd'])
  })
})

describe('priorityPick', () => {
  it('customised: the highest connected; otherwise the connected default', () => {
    const s = snap(['a', 'b', 'c'], true)
    s.devices[0] = { ...s.devices[0], available: false }
    expect(priorityPick(s)?.id).toBe('b')
    const d = snap(['a', 'b', 'c'])
    d.devices = [dev('x', { available: false }), dev('y'), dev('z', { isDefault: true })]
    expect(priorityPick(d)?.id).toBe('z')
    // Ignores an override.
    expect(priorityPick(overridden(snap(['a', 'b'], true), 'b'))?.id).toBe('a')
    expect(priorityPick({ customised: true, overrideId: null, devices: [dev('q', { available: false })] })).toBeNull()
  })

  it('skips the MacBook mic with the lid closed (connected, but deaf), as the desktop does', () => {
    const s = snap(['a', 'b'], true)
    s.devices[0] = { ...s.devices[0], unavailableReason: 'lid_closed' }
    expect(priorityPick(s)?.id).toBe('b')
    const d = snap(['a', 'b'])
    d.devices = [dev('mac', { isDefault: true, unavailableReason: 'lid_closed' }), dev('usb')]
    expect(priorityPick(d)?.id).toBe('usb')
  })
})

describe('applyOverride', () => {
  it('sets overrideId and the check, keeps the order; a live stream moves with the check', () => {
    const s = snap(['a', 'b', 'c'])
    s.devices[0] = { ...s.devices[0], live: true }
    const out = applyOverride(s, 'c')
    expect(out.overrideId).toBe('c')
    expect(out.devices.map((d) => d.id)).toEqual(['a', 'b', 'c'])
    expect(out.devices.map((d) => [d.active, d.live])).toEqual([[false, false], [false, false], [true, true]])
  })

  it('null, or a mic that isn\'t connected: back to the order\'s pick', () => {
    const s = overridden(snap(['a', 'b', 'c'], true), 'c')
    expect(activeId(applyOverride(s, null))).toBe('a')
    expect(applyOverride(s, null).overrideId).toBeNull()
    s.devices[1] = { ...s.devices[1], available: false }
    expect(applyOverride(s, 'b').overrideId).toBeNull()
    expect(activeId(applyOverride(s, 'b'))).toBe('a')
  })

  it('a mic with the lid closed is never the one in use for now', () => {
    const s = snap(['a', 'b', 'c'], true)
    s.devices[2] = { ...s.devices[2], unavailableReason: 'lid_closed' }
    expect(applyOverride(s, 'c').overrideId).toBeNull()
    expect(activeId(applyOverride(s, 'c'))).toBe('a')
  })
})

describe('useInputDevices: enabled', () => {
  it('off: no list() call and no subscription; on: loads the list', async () => {
    await act(async () => { root.render(h(Harness, { enabled: false })) })
    await flush()
    expect(api.status).toBe('unsupported')
    expect(env.list).not.toHaveBeenCalled()
    expect(env.listeners.size).toBe(0)

    await act(async () => { root.render(h(Harness, { enabled: true })) })
    await flush()
    expect(env.list).toHaveBeenCalledTimes(1)
    expect(api.status).toBe('ready')
    expect(ids(api)).toEqual(['a', 'b', 'c'])
    expect(env.listeners.size).toBe(1)

    await act(async () => { root.render(h(Harness, { enabled: false })) })
    await flush()
    expect(api.status).toBe('unsupported')
    expect(env.listeners.size).toBe(0)
  })
})
