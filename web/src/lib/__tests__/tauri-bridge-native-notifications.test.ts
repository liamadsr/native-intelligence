import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Bridge contract for a bot's banner (bots v3, phase 7). The website ships
 * ahead of the desktop, so:
 *
 *   • a banner with no extras sends exactly the four args it always has, and
 *     the extras (threadId, subtitle, image) ride only when set: an older
 *     binary reads only the args it names, so it ignores them;
 *   • removeDeliveredNotification names the new command, and its rejection on
 *     an older binary reaches the caller (who must not disable banners on it).
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

describe('showNativeNotification', () => {
  it('with no extras, sends the four args it always has', async () => {
    tauri.invoke.mockResolvedValue(true)
    await tauriBridge.showNativeNotification({ id: 'n1', title: 'Dana commented' })
    expect(tauri.invoke).toHaveBeenCalledWith('show_native_notification', {
      id: 'n1',
      title: 'Dana commented',
      body: null,
      payload: null,
    })
  })

  it('adds the thread, subtitle and image a bot’s banner carries', async () => {
    tauri.invoke.mockResolvedValue(true)
    await tauriBridge.showNativeNotification({
      id: 'n2',
      title: 'Triage',
      body: 'I triaged it.',
      payload: '{}',
      threadId: 'tm-triage',
      subtitle: 'Acme',
      image: 'data:image/png;base64,AAAA',
    })
    expect(tauri.invoke).toHaveBeenCalledWith('show_native_notification', {
      id: 'n2',
      title: 'Triage',
      body: 'I triaged it.',
      payload: '{}',
      threadId: 'tm-triage',
      subtitle: 'Acme',
      image: 'data:image/png;base64,AAAA',
    })
  })
})

describe('removeDeliveredNotification', () => {
  it('asks the desktop to take the banner down', async () => {
    tauri.invoke.mockResolvedValue(true)
    await expect(tauriBridge.removeDeliveredNotification('n1')).resolves.toBe(true)
    expect(tauri.invoke).toHaveBeenCalledWith('remove_delivered_notification', { id: 'n1' })
  })

  it('rejects on a binary without the command, for the caller to latch', async () => {
    tauri.invoke.mockRejectedValue(new Error('command remove_delivered_notification not found'))
    await expect(tauriBridge.removeDeliveredNotification('n1')).rejects.toThrow()
  })
})
