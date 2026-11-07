/**
 * The live view's routes (docs/plans/cloud-browser.md, C3): `view` wakes the
 * browser and signs a short viewer token (with input only while the person
 * drives); `thumbnail` never wakes it; taking over and handing back set the
 * driver; nothing works without the live view's signing key.
 */
import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  ensure: vi.fn(), running: vi.fn(), touch: vi.fn(), driver: 'agent', setDriver: vi.fn(), feature: true,
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ user: { id: 'u1' }, workspaceId: 'w1', supabase: {} }) }))
vi.mock('@/lib/editions', () => ({ resolveWorkspaceEdition: async () => ({}), isFeatureEnabled: () => mock.feature }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/cloud-browser/host', () => ({ ensureCloudBrowser: mock.ensure, runningHubOrigin: mock.running, touchCloudBrowser: mock.touch }))
vi.mock('@/lib/cloud-browser/store', () => ({ readDriver: async () => mock.driver, setDriver: mock.setDriver }))

import { sandboxVerifyKey, verifySandboxToken } from '@/lib/cloud-browser/viewer-token'
import { cloudBrowserSandboxName } from '@/lib/cloud-browser/ids'
import { POST as LIVE } from '../live/route'
import { POST as PING } from '../live/ping/route'
import { POST as DRIVER } from '../driver/route'

const { privateKey } = generateKeyPairSync('ed25519')
const verifyKey = sandboxVerifyKey(privateKey)
const SANDBOX = cloudBrowserSandboxName('u1', 'w1', 'local')
const live = (mode?: string) => LIVE(new Request('http://localhost/api/account/browser/live', { method: 'POST', body: JSON.stringify(mode ? { mode } : {}) }))

beforeEach(() => {
  vi.stubEnv('CLOUD_BROWSER_SIGNING_KEY', privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
  mock.ensure.mockReset().mockResolvedValue({ hubOrigin: 'https://sb-4000.vercel.run' })
  mock.running.mockReset().mockResolvedValue('https://sb-4000.vercel.run')
  mock.touch.mockReset().mockResolvedValue(undefined)
  mock.setDriver.mockReset().mockResolvedValue(true)
  mock.driver = 'agent'
  mock.feature = true
})

describe('the live view', () => {
  it('wakes the browser and hands a view-only token for its hub', async () => {
    const body = await (await live()).json()
    expect(mock.ensure).toHaveBeenCalledWith({ userId: 'u1', workspaceId: 'w1' })
    expect(mock.touch).toHaveBeenCalled()
    expect(body).toMatchObject({ state: 'running', control: false, viewerUrl: 'wss://sb-4000.vercel.run/viewer', thumbnailUrl: 'https://sb-4000.vercel.run/thumbnail' })
    expect(verifySandboxToken(body.token, 'browser-viewer', SANDBOX, verifyKey)).toMatchObject({ userId: 'u1', workspaceId: 'w1', control: false })
  })

  it('gives input only while the person drives, and never to a thumbnail', async () => {
    mock.driver = 'person'
    expect(verifySandboxToken((await (await live('view')).json()).token, 'browser-viewer', SANDBOX, verifyKey)).toMatchObject({ control: true })
    expect(verifySandboxToken((await (await live('thumbnail')).json()).token, 'browser-viewer', SANDBOX, verifyKey)).toMatchObject({ control: false })
  })

  it('never wakes a sleeping browser for its thumbnail', async () => {
    mock.running.mockResolvedValue(null)
    expect(await (await live('thumbnail')).json()).toEqual({ state: 'asleep' })
    expect(mock.ensure).not.toHaveBeenCalled()
    expect(mock.touch).not.toHaveBeenCalled()
  })

  it('needs the signing key, the browser feature, a known mode, and a browser that starts', async () => {
    mock.ensure.mockRejectedValueOnce(new Error('quota'))
    expect(await (await live()).json()).toMatchObject({ code: 'BROWSER_UNAVAILABLE' })
    expect((await live('stream')).status).toBe(400)
    mock.feature = false
    expect((await live()).status).toBe(403)
    mock.feature = true
    vi.stubEnv('CLOUD_BROWSER_SIGNING_KEY', '')
    expect(await (await live()).json()).toMatchObject({ code: 'LIVE_VIEW_UNCONFIGURED' })
  })

  it('counts a visible view as activity', async () => {
    await PING()
    expect(mock.touch).toHaveBeenCalledWith({ userId: 'u1', workspaceId: 'w1' })
  })
})

describe('taking over', () => {
  const drive = (driver: unknown) => DRIVER(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ driver }) }))
  it('sets who drives', async () => {
    expect(await (await drive('person')).json()).toEqual({ driver: 'person' })
    expect(mock.setDriver).toHaveBeenCalledWith({ userId: 'u1', workspaceId: 'w1' }, 'person')
    expect((await drive('robot')).status).toBe(400)
    mock.setDriver.mockResolvedValue(false)
    expect(await (await drive('agent')).json()).toMatchObject({ code: 'BROWSER_NOT_STARTED' })
  })
})
