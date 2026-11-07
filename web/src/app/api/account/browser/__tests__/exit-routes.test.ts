/**
 * The Mac exit's routes (docs/plans/cloud-browser.md, C4): the desktop's ticket
 * is an exit token naming the running browser's hub, never waking it; the
 * public key is served for the desktop's own check; the relay's switch needs
 * its token and changes the network policy with the mode.
 */
import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ running: vi.fn(), setExit: vi.fn(), rings: [] as string[] }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ user: { id: 'u1', email: 'liam@example.com' }, workspaceId: 'w1', supabase: {} }) }))
vi.mock('@/lib/editions', () => ({ resolveWorkspaceEdition: async () => ({}), isFeatureEnabled: () => true }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/cloud-browser/host', () => ({ runningHubOrigin: mock.running, setExitMode: mock.setExit }))
vi.mock('@/lib/browser-agent/queue', () => ({ ringComputer: async (_ref: unknown, event: string) => { mock.rings.push(event) } }))

import { sandboxVerifyKey, verifySandboxToken } from '@/lib/cloud-browser/viewer-token'
import { cloudBrowserSandboxName } from '@/lib/cloud-browser/ids'
import { mintBrowserRelayToken, RELAY_MARK_HEADER, RELAY_TOKEN_HEADER } from '@/lib/cloud-browser/relay-token'
import { POST as TICKET } from '../exit/route'
import { GET as KEY } from '@/app/api/browser-exit/key/route'
import { POST as SWITCH } from '@/app/api/browser-relay/exit/route'

const { privateKey } = generateKeyPairSync('ed25519')
const SANDBOX = cloudBrowserSandboxName('u1', 'w1', 'local')
const ticket = (body: unknown = {}) => TICKET(new Request('http://localhost/api/account/browser/exit', { method: 'POST', body: JSON.stringify(body) }))
const relaySwitch = (body: unknown, token: string | null = mintBrowserRelayToken({ userId: 'u1', workspaceId: 'w1', sandbox: SANDBOX }, 60_000)) =>
  SWITCH(new Request('https://browser-relay.dial8.ai/api/browser-relay/exit', { method: 'POST', body: JSON.stringify(body),
    headers: token ? { [RELAY_TOKEN_HEADER]: token, [RELAY_MARK_HEADER]: '1' } : {} }))

beforeEach(() => {
  vi.stubEnv('CLOUD_BROWSER_SIGNING_KEY', privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
  vi.stubEnv('BROWSER_INTERNAL_SECRET', 'browser-secret')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
  mock.running.mockReset().mockResolvedValue('https://sb-abc.vercel.run')
  mock.setExit.mockReset().mockResolvedValue(undefined)
  mock.rings = []
})

describe('the desktop’s exit ticket', () => {
  it('is an exit token for the running browser, naming its hub, this Mac and the account (never its email)', async () => {
    const body = await (await ticket({ deviceId: 'mac-1' })).json()
    expect(body).toMatchObject({ state: 'running', url: 'wss://sb-abc.vercel.run/exit' })
    const claims = verifySandboxToken(body.token, 'browser-exit', SANDBOX, sandboxVerifyKey(privateKey))
    expect(claims).toMatchObject({ userId: 'u1', workspaceId: 'w1', hub: 'sb-abc.vercel.run', deviceId: 'mac-1' })
    expect(claims).not.toHaveProperty('email')
    expect(verifySandboxToken(body.token, 'browser-viewer', SANDBOX, sandboxVerifyKey(privateKey))).toBeNull()
  })

  it('never wakes a sleeping browser', async () => {
    mock.running.mockResolvedValue(null)
    expect(await (await ticket()).json()).toEqual({ state: 'asleep' })
  })

  it('needs the signing key, and serves only its public half', async () => {
    const key = (ip?: string) => KEY(new Request('https://dial8.ai/api/browser-exit/key', { headers: ip ? { 'x-forwarded-for': `${ip}, 10.0.0.1` } : {} }))
    expect(await (await key('24.193.1.2')).json()).toEqual({ key: sandboxVerifyKey(privateKey), ip: '24.193.1.2' })
    vi.stubEnv('CLOUD_BROWSER_SIGNING_KEY', '')
    expect((await ticket()).status).toBe(503)
    expect((await key()).status).toBe(503)
  })
})

describe('the relay’s exit switch', () => {
  it('needs the relay’s token', async () => {
    expect((await relaySwitch({ mode: 'mac' }, null)).status).toBe(401)
    expect(mock.setExit).not.toHaveBeenCalled()
  })

  it('switches the mode with the tunnel’s state, for the token’s own browser, and refreshes the card', async () => {
    expect((await relaySwitch({ mode: 'mac', tunnel: { up: true, deviceId: 'mac-1' } })).status).toBe(200)
    expect(mock.setExit).toHaveBeenCalledWith({ userId: 'u1', workspaceId: 'w1' }, 'mac', { up: true, deviceId: 'mac-1' })
    expect(mock.rings).toEqual(['computer-changed'])
    expect((await relaySwitch({ mode: 'somewhere' })).status).toBe(400)
  })
})
