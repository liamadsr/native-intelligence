/**
 * Where the browser's traffic leaves (relay/exit-control.ts): one decider,
 * serialized, reading again after every wait. The review's race (a cloud
 * switch in flight when the Mac comes back and a task pins the Mac) ends in
 * `mac` and never touches the cloud; a drop holds `mac` (refusing) for the
 * grace, longer while the person drives; a failed server call fails closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exitControl, GRACE_MS } from '../exit-control'

function route(up = false) {
  const listeners = new Set<(up: boolean) => void>()
  let mode: 'mac' | 'cloud' = 'mac'
  const r = {
    up,
    tunnelUp: () => r.up, tunnelDevice: () => (r.up ? 'mac-1' : null), mode: () => mode,
    setMode: vi.fn((next: 'mac' | 'cloud') => { mode = next }),
    onTunnel: (listener: (up: boolean) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: boolean) => { r.up = next; for (const listener of [...listeners]) listener(next) },
  }
  return r
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the exit controller', () => {
  it('serializes switches: a cloud switch in flight never lands over the Mac coming back and a task pinned to it', async () => {
    const r = route(false)
    let release = (_ok: boolean) => {}
    const report = vi.fn((mode: string) => mode === 'cloud' ? new Promise<boolean>(resolve => { release = resolve }) : Promise.resolve(true))
    const control = exitControl({ exit: r, report, bootMode: 'cloud', capable: true })
    void control.sync()
    await flush()
    expect(report).toHaveBeenLastCalledWith('cloud', { up: false, deviceId: null })
    // The Mac comes back and a task pins it while the cloud switch waits on the server.
    r.set(true)
    const pinned = control.pin('mac')
    release(true)
    await pinned
    await flush()
    expect(r.mode()).toBe('mac')
    expect(r.setMode.mock.calls.map(([m]) => m)).not.toContain('cloud')
    expect(report).toHaveBeenLastCalledWith('mac', { up: true, deviceId: 'mac-1' })
  })

  it('holds the Mac (refusing) for the grace after a drop, then goes to the cloud', async () => {
    const r = route(true)
    const report = vi.fn(async () => true)
    const control = exitControl({ exit: r, report, bootMode: 'cloud', capable: true })
    await control.sync()
    expect(r.mode()).toBe('mac')
    r.set(false)
    await flush()
    expect(r.mode()).toBe('mac')
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1000)
    expect(r.mode()).toBe('mac')
    await vi.advanceTimersByTimeAsync(2000)
    await flush()
    expect(r.mode()).toBe('cloud')
  })

  it('keeps the Mac while the person drives, and while a command is pinned to it', async () => {
    const r = route(true)
    const control = exitControl({ exit: r, report: async () => true, bootMode: 'cloud', capable: true })
    await control.sync()
    control.setDriver('person')
    r.set(false)
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)
    expect(r.mode()).toBe('mac')
    control.setDriver('agent')
    await flush()
    expect(r.mode()).toBe('cloud')
    r.set(true)
    await flush()
    await control.pin('mac')
    r.set(false)
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)
    expect(r.mode()).toBe('mac')
    control.release()
    await flush()
    expect(r.mode()).toBe('cloud')
  })

  it('a relay that starts in mac mode waits the grace for its Mac before the cloud', async () => {
    const r = route(false)
    const control = exitControl({ exit: r, report: async () => true, bootMode: 'mac', capable: true })
    await control.sync()
    expect(r.mode()).toBe('mac')
    r.set(true)
    await flush()
    expect(r.mode()).toBe('mac')
  })

  it('fails closed when the server can’t open the policy, and tries again', async () => {
    const r = route(false)
    const report = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const control = exitControl({ exit: r, report, bootMode: 'cloud', capable: true, retryMs: 1000 })
    await control.sync()
    expect(r.mode()).toBe('mac')
    await vi.advanceTimersByTimeAsync(1100)
    await flush()
    expect(r.mode()).toBe('cloud')
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('without a hub, always the cloud', async () => {
    const r = route(false)
    const control = exitControl({ exit: r, report: async () => true, bootMode: 'mac', capable: false })
    await control.pin('mac')
    expect(r.mode()).toBe('cloud')
    expect(control.choose()).toBe('cloud')
  })
})
