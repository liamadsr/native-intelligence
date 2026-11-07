import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Bridge contract for app updates (security review 2026-10-31, P0-3): this
 * desktop build decides in Rust (`app_update_check` / `app_update_install`,
 * src-tauri/src/app_update.rs) and no longer grants the updater plugin to the
 * web. A build from before those commands still grants the plugin, so the
 * bridge falls back to it ONLY when the command is missing — never on a real
 * refusal from the Rust side, which would otherwise route around its checks.
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  check: vi.fn(),
  desktop: true,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: tauri.check }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => tauri.desktop }))

async function load() {
  vi.resetModules()
  return (await import('../tauri-bridge')).tauriBridge
}

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.check.mockReset()
  tauri.desktop = true
})

describe('checkForUpdate — this build (Rust decides)', () => {
  it('null when up to date, and the plugin is never asked', async () => {
    tauri.invoke.mockResolvedValueOnce({ available: false, version: null, currentVersion: '0.3.0' })
    const bridge = await load()
    expect(await bridge.checkForUpdate()).toBeNull()
    expect(tauri.invoke).toHaveBeenCalledWith('app_update_check', undefined)
    expect(tauri.check).not.toHaveBeenCalled()
  })

  it('an available update installs through app_update_install, pinned to the version shown', async () => {
    tauri.invoke.mockResolvedValueOnce({ available: true, version: '0.3.1', currentVersion: '0.3.0' })
    const bridge = await load()
    const update = await bridge.checkForUpdate()
    expect(update).toMatchObject({ available: true, version: '0.3.1', via: 'rust' })
    tauri.invoke.mockResolvedValueOnce('0.3.1')
    await update!.install()
    expect(tauri.invoke).toHaveBeenLastCalledWith('app_update_install', { expected: '0.3.1' })
    expect(tauri.check).not.toHaveBeenCalled()
  })

  it('a refusal from Rust is NOT routed to the plugin (it would skip the checks)', async () => {
    tauri.invoke.mockRejectedValueOnce('updates are off in debug builds')
    const bridge = await load()
    await expect(bridge.checkForUpdate()).rejects.toBe('updates are off in debug builds')
    expect(tauri.check).not.toHaveBeenCalled()
  })

  it('a refused install rejects (nothing installed)', async () => {
    tauri.invoke.mockResolvedValueOnce({ available: true, version: '99.0.0', currentVersion: '0.3.0' })
    const bridge = await load()
    const update = await bridge.checkForUpdate()
    tauri.invoke.mockRejectedValueOnce('the update says 99.0.0 but holds 0.2.0: refused')
    await expect(update!.install()).rejects.toBe('the update says 99.0.0 but holds 0.2.0: refused')
  })
})

describe('checkForUpdate — an older build (no app_update_check)', () => {
  it('falls back to the plugin when the command is missing', async () => {
    tauri.invoke.mockRejectedValueOnce('Command app_update_check not found')
    const downloadAndInstall = vi.fn(async () => {})
    tauri.check.mockResolvedValueOnce({ available: true, version: '0.3.1', downloadAndInstall })
    const bridge = await load()
    const update = await bridge.checkForUpdate()
    expect(update).toMatchObject({ available: true, version: '0.3.1', via: 'plugin' })
    await update!.install()
    expect(downloadAndInstall).toHaveBeenCalledOnce()
  })

  it('also when the ACL answers "not allowed" for the unknown command', async () => {
    tauri.invoke.mockRejectedValueOnce('app_update_check not allowed. Command not found')
    tauri.check.mockResolvedValueOnce(null)
    const bridge = await load()
    expect(await bridge.checkForUpdate()).toBeNull()
    expect(tauri.check).toHaveBeenCalledOnce()
  })

  it("the plugin's 'no update' (null, or available: false) is null", async () => {
    tauri.invoke.mockRejectedValue('Command app_update_check not found')
    tauri.check.mockResolvedValueOnce({ available: false, version: '0.3.0' })
    const bridge = await load()
    expect(await bridge.checkForUpdate()).toBeNull()
  })
})
