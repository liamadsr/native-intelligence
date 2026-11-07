// @vitest-environment jsdom
/**
 * trackHudEvent (lib/hud-telemetry.ts): posts the event to its sink, adds the
 * desktop app's version on the desktop (read once), and never throws, whatever
 * fetch does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const desktop = vi.hoisted(() => ({ on: false, getVersion: vi.fn(async () => '0.31.2') }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => desktop.on }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: desktop.getVersion }))

import { documentVisibility, resetHudTelemetryForTests, trackHudEvent } from '../hud-telemetry'

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  desktop.on = false
  desktop.getVersion.mockClear()
  resetHudTelemetryForTests()
  fetchMock = vi.fn(async () => ({ ok: true }) as Response)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const sent = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit]
  return { url, init, body: JSON.parse(init.body as string) }
}

describe('trackHudEvent', () => {
  it('posts the event and its properties to the HUD sink, keepalive', async () => {
    trackHudEvent('live_hud_nudge_displayed', { nudge_id: 'n1', window_visible: false })
    await settle()
    const { url, init, body } = sent()
    expect(url).toBe('/api/analytics/hud-event')
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    expect(body).toEqual({ event: 'live_hud_nudge_displayed', properties: { nudge_id: 'n1', window_visible: false } })
    expect(desktop.getVersion).not.toHaveBeenCalled()
  })

  it("adds the desktop app's version on the desktop, read once", async () => {
    desktop.on = true
    trackHudEvent('live_hud_loaded')
    trackHudEvent('live_hud_shown', { reason: 'after_load' })
    await settle()
    expect(sent(0).body.properties).toEqual({ app_version: '0.31.2' })
    expect(sent(1).body.properties).toEqual({ reason: 'after_load', app_version: '0.31.2' })
    expect(desktop.getVersion).toHaveBeenCalledTimes(1)
  })

  it('names the workspace only when the caller does, null included', async () => {
    trackHudEvent('live_hud_loaded', {}, { workspaceId: 'ws-1' })
    trackHudEvent('live_hud_loaded', {}, { workspaceId: null })
    trackHudEvent('live_hud_loaded')
    await settle()
    expect(sent(0).body.workspaceId).toBe('ws-1')
    expect(sent(1).body).toHaveProperty('workspaceId', null)
    expect(sent(2).body).not.toHaveProperty('workspaceId')
  })

  it('still sends, without a version, when the desktop cannot say', async () => {
    desktop.on = true
    desktop.getVersion.mockRejectedValueOnce(new Error('no plugin'))
    trackHudEvent('live_hud_loaded', { host: 'window' })
    await settle()
    expect(sent().body.properties).toEqual({ host: 'window' })
  })

  it('never throws, whether fetch throws or rejects', async () => {
    fetchMock.mockImplementationOnce(() => {
      throw new Error('sync')
    })
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(() => trackHudEvent('live_hud_loaded')).not.toThrow()
    expect(() => trackHudEvent('live_hud_loaded')).not.toThrow()
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("reads the page's visibility", () => {
    expect(documentVisibility()).toBe(document.visibilityState)
  })
})
