import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Bridge contract for `presence_state` (docs/plans/reach-follows-you.md §1):
 * the Mac's idle seconds and lock, or null outside the desktop, on a build
 * without the command (asked once, then remembered), off macOS
 * ("unsupported", also remembered), on any other failure, and for a
 * malformed answer. The presence client falls back to the web rule on null.
 *
 * Hermetic: @tauri-apps/api is mocked directly; each test loads a fresh
 * module so the remembered "unavailable" never leaks between tests.
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  desktop: true,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => tauri.desktop }))

async function load() {
  vi.resetModules()
  return import('../tauri-bridge')
}

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.desktop = true
})

describe('toDesktopPresence', () => {
  it('reads the camelCase answer', async () => {
    const { toDesktopPresence } = await load()
    expect(toDesktopPresence({ idleSeconds: 12.5, locked: false })).toEqual({ idleSeconds: 12.5, locked: false })
    expect(toDesktopPresence({ idleSeconds: 0, locked: true })).toEqual({ idleSeconds: 0, locked: true })
  })

  it('drops anything else', async () => {
    const { toDesktopPresence } = await load()
    for (const raw of [null, 'x', 3, {}, { idleSeconds: '3', locked: false }, { idleSeconds: -1, locked: false }, { idleSeconds: Number.NaN, locked: false }, { idleSeconds: 3, locked: 'no' }, { idle_seconds: 3, locked: false }]) {
      expect(toDesktopPresence(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe('presenceState', () => {
  it('asks the desktop, with no arguments', async () => {
    const { presenceState } = await load()
    tauri.invoke.mockResolvedValueOnce({ idleSeconds: 4, locked: false })
    expect(await presenceState()).toEqual({ idleSeconds: 4, locked: false })
    expect(tauri.invoke).toHaveBeenCalledWith('presence_state', undefined)
  })

  it('is null in the browser, without touching Tauri', async () => {
    const { presenceState } = await load()
    tauri.desktop = false
    expect(await presenceState()).toBeNull()
    expect(tauri.invoke).not.toHaveBeenCalled()
  })

  it('is null on an older desktop without the command, and asks it only once', async () => {
    const { presenceState } = await load()
    tauri.invoke.mockRejectedValue('Command presence_state not found')
    expect(await presenceState()).toBeNull()
    expect(await presenceState()).toBeNull()
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
  })

  it('a command the ACL refuses reads the same as a missing one', async () => {
    const { presenceState } = await load()
    tauri.invoke.mockRejectedValue(new Error('presence_state not allowed. Command not found'))
    expect(await presenceState()).toBeNull()
    expect(await presenceState()).toBeNull()
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
  })

  it('is null off macOS ("unsupported"), remembered', async () => {
    const { presenceState } = await load()
    tauri.invoke.mockRejectedValue('unsupported')
    expect(await presenceState()).toBeNull()
    expect(await presenceState()).toBeNull()
    expect(tauri.invoke).toHaveBeenCalledTimes(1)
  })

  it('a passing failure or a malformed answer is null, and the next call asks again', async () => {
    const { presenceState } = await load()
    tauri.invoke.mockRejectedValueOnce('idle time unavailable (NaN)')
    expect(await presenceState()).toBeNull()
    tauri.invoke.mockResolvedValueOnce({ idleSeconds: 'soon' })
    expect(await presenceState()).toBeNull()
    tauri.invoke.mockResolvedValueOnce({ idleSeconds: 200, locked: false })
    expect(await presenceState()).toEqual({ idleSeconds: 200, locked: false })
    expect(tauri.invoke).toHaveBeenCalledTimes(3)
  })
})
