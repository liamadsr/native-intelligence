// @vitest-environment jsdom
/**
 * The computer card's store (src/lib/cloud-browser/computer-client.ts): reads
 * the state, fetches the preview with the hub token only while the browser
 * runs (asking in `thumbnail` mode, which never wakes it), swaps frames
 * without leaking them, and keeps the last frame when a read fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetComputerForTests, getComputer, refreshComputer, refreshThumbnail, setDriver } from '../computer-client'

const calls: { url: string; init?: RequestInit }[] = []
let routes: Record<string, () => Response> = {}
beforeEach(() => {
  __resetComputerForTests()
  calls.length = 0
  routes = {}
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const key = `${init?.method ?? 'GET'} ${url}`
    if (!routes[key]) throw new Error(`unexpected ${key}`)
    return routes[key]()
  }))
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:frame-${++n}`)
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => vi.unstubAllGlobals())

const running = { state: 'running', token: 'hub-token', viewerUrl: 'wss://hub/viewer', thumbnailUrl: 'https://hub/thumbnail', control: false, driver: 'agent' }

describe('the computer store', () => {
  it('reads the computer’s state', async () => {
    routes['GET /api/account/browser/live'] = () => Response.json({ exists: true, status: 'running', driver: 'person', busy: true, liveView: true })
    await refreshComputer()
    expect(getComputer()).toMatchObject({ exists: true, status: 'running', driver: 'person', busy: true, liveView: true })
  })

  it('fetches the preview with the hub token, asking in thumbnail mode, and frees the frame it replaces', async () => {
    routes['POST /api/account/browser/live'] = () => Response.json(running)
    routes['GET https://hub/thumbnail'] = () => new Response(new Blob(['jpeg']), { status: 200 })
    await refreshThumbnail()
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ mode: 'thumbnail' })
    expect(new Headers(calls[1].init?.headers).get('authorization')).toBe('Bearer hub-token')
    expect(getComputer().thumbnail).toBe('blob:frame-1')
    await refreshThumbnail()
    expect(getComputer().thumbnail).toBe('blob:frame-2')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-1')
  })

  it('fetches nothing while the browser sleeps, and keeps the last frame when the hub fails', async () => {
    routes['POST /api/account/browser/live'] = () => Response.json(running)
    routes['GET https://hub/thumbnail'] = () => new Response(new Blob(['jpeg']), { status: 200 })
    await refreshThumbnail()
    routes['POST /api/account/browser/live'] = () => Response.json({ state: 'asleep' })
    calls.length = 0
    await refreshThumbnail()
    expect(calls.map(call => call.url)).toEqual(['/api/account/browser/live'])
    routes['POST /api/account/browser/live'] = () => Response.json(running)
    routes['GET https://hub/thumbnail'] = () => new Response('busy', { status: 503 })
    await refreshThumbnail()
    expect(getComputer().thumbnail).toBe('blob:frame-1')
  })

  it('records the driver only when the server takes it', async () => {
    routes['POST /api/account/browser/driver'] = () => Response.json({ error: 'Your browser isn’t running.' }, { status: 409 })
    expect(await setDriver('person')).toBe(false)
    expect(getComputer().driver).toBe('agent')
    routes['POST /api/account/browser/driver'] = () => Response.json({ driver: 'person' })
    expect(await setDriver('person')).toBe(true)
    expect(getComputer().driver).toBe('person')
  })
})
