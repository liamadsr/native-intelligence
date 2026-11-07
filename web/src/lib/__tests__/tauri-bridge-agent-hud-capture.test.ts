import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Bridge contract for the live-agent HUD's screen-share eye
 * (`agentHudCapture`). The website ships ahead of the desktop: a build without
 * the commands must read as "no eye" (null), and the browser never touches
 * Tauri.
 *
 * Hermetic: @tauri-apps/api is mocked directly.
 */

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), desktop: true }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => tauri.desktop }))

const { tauriBridge } = await import('../tauri-bridge')

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.desktop = true
})

describe('agentHudCapture', () => {
  it('get reads the desktop state', async () => {
    tauri.invoke.mockResolvedValue(false)
    expect(await tauriBridge.agentHudCapture.get()).toBe(false)
    tauri.invoke.mockResolvedValue(true)
    expect(await tauriBridge.agentHudCapture.get()).toBe(true)
    expect(tauri.invoke).toHaveBeenCalledWith('get_agent_hud_capture_visible', undefined)
  })

  it('get is null on a desktop without the command, or an answer that is not a boolean', async () => {
    tauri.invoke.mockRejectedValue('Command get_agent_hud_capture_visible not found')
    expect(await tauriBridge.agentHudCapture.get()).toBeNull()
    tauri.invoke.mockResolvedValue(undefined)
    expect(await tauriBridge.agentHudCapture.get()).toBeNull()
  })

  it('get is null off the desktop app, without touching Tauri', async () => {
    tauri.desktop = false
    expect(await tauriBridge.agentHudCapture.get()).toBeNull()
    expect(tauri.invoke).not.toHaveBeenCalled()
  })

  it('set sends the wanted state and resolves to the one the desktop reports', async () => {
    tauri.invoke.mockResolvedValue(true)
    expect(await tauriBridge.agentHudCapture.set(true)).toBe(true)
    expect(tauri.invoke).toHaveBeenCalledWith('set_agent_hud_capture_visible', { visible: true })
  })

  it('set rejects when the window is gone, and off the desktop app', async () => {
    tauri.invoke.mockRejectedValue('agent HUD window is not open')
    await expect(tauriBridge.agentHudCapture.set(true)).rejects.toBe('agent HUD window is not open')
    tauri.desktop = false
    tauri.invoke.mockReset()
    await expect(tauriBridge.agentHudCapture.set(false)).rejects.toThrow('not in the desktop app')
    expect(tauri.invoke).not.toHaveBeenCalled()
  })
})
