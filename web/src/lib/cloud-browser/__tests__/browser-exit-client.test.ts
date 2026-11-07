/**
 * The Mac exit on the desktop (browser-exit-client.ts): only the main window
 * drives it; it hands the app this window's session, then the server's
 * ticket; a stopped browser lets it go; a run-out token gets a fresh one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  desktop: true, label: 'main' as string | null,
  status: { state: 'off', needsToken: false, sitesToday: [] as { host: string; count: number }[] },
  start: vi.fn(async (_url: string, _token: string) => null), stop: vi.fn(async () => null),
  setAuthToken: vi.fn(async (_token: string) => {}), session: 'session-jwt' as string | null,
  listener: null as ((status: unknown) => void) | null,
}))
vi.mock('../browser-exit-bridge', () => ({
  isDesktopAppForExit: () => bridge.desktop,
  getThisWebviewLabel: async () => bridge.label,
  sessionAccessToken: async () => bridge.session,
  tauriBridge: {
    setAuthToken: bridge.setAuthToken,
    browserExit: { status: async () => bridge.status, start: bridge.start, stop: bridge.stop,
      onStatus: (cb: (status: unknown) => void) => { bridge.listener = cb; return () => {} } },
    localAgent: { device: async () => ({ ok: true, value: { deviceId: 'mac-1' } }) },
  },
}))

import { __resetBrowserExitForTests, browserDown, browserUp } from '../browser-exit-client'

const fetched = vi.fn()
beforeEach(() => {
  __resetBrowserExitForTests()
  bridge.desktop = true
  bridge.label = 'main'
  bridge.status = { state: 'off', needsToken: false, sitesToday: [] }
  bridge.start.mockClear(); bridge.stop.mockClear(); bridge.setAuthToken.mockClear()
  bridge.session = 'session-jwt'
  fetched.mockReset().mockResolvedValue(Response.json({ state: 'running', url: 'wss://sb-abc.vercel.run/exit', token: 'exit-token' }))
  vi.stubGlobal('fetch', fetched)
})

describe('the Mac exit on the desktop', () => {
  it('hands the server’s ticket to the app, saying which Mac asks, after this window’s session', async () => {
    await browserUp()
    expect(JSON.parse(fetched.mock.calls[0][1].body)).toEqual({ deviceId: 'mac-1' })
    expect(bridge.start).toHaveBeenCalledWith('wss://sb-abc.vercel.run/exit', 'exit-token')
    // The app checks the ticket's account against the session it holds: never a start before it.
    expect(bridge.setAuthToken).toHaveBeenCalledWith('session-jwt')
    expect(bridge.setAuthToken.mock.invocationCallOrder[0]).toBeLessThan(bridge.start.mock.invocationCallOrder[0])
  })

  it('does nothing in a pop-out window or on the web', async () => {
    bridge.label = 'workspace-2'
    await browserUp()
    __resetBrowserExitForTests()
    bridge.label = 'main'
    bridge.desktop = false
    await browserUp()
    expect(fetched).not.toHaveBeenCalled()
    expect(bridge.start).not.toHaveBeenCalled()
  })

  it('never connects to a sleeping browser, lets go when it stops, and fetches a fresh token when one ran out', async () => {
    fetched.mockResolvedValueOnce(Response.json({ state: 'asleep' }))
    await browserUp()
    expect(bridge.start).not.toHaveBeenCalled()
    await browserDown()
    expect(bridge.stop).toHaveBeenCalled()
    bridge.listener!({ state: 'off', needsToken: true, sitesToday: [] })
    await vi.waitFor(() => expect(bridge.start).toHaveBeenCalledTimes(1))
  })

})
