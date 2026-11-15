/**
 * Which relay requests are accepted (src/lib/cloud-browser/relay-routes.ts,
 * requireAcceptedRelay / relayActor), the one place every relay route passes
 * through. Hosted: the token and the mark, as before. Runtime: also the
 * request's x-real-ip in BROWSER_RELAY_ALLOWED_ADDRESSES (unset or malformed:
 * nobody) AND the token's browser starting or running in its row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ readStatus: vi.fn(async (_ref: unknown) => 'running' as string | null) }))
vi.mock('@/lib/cloud-browser/store', () => store)

import { mintBrowserRelayToken, RELAY_MARK_HEADER, RELAY_TOKEN_HEADER } from '../relay-token'
import { relayActor, relayAddressPolicy, requireAcceptedRelay } from '../relay-routes'

const SERVER = '203.0.113.7'
/** A hosted token (no backend claim, as every token minted before the claim existed), or a runtime VM's. */
const token = (backend?: 'runtime') => mintBrowserRelayToken({ userId: 'user-1', workspaceId: 'ws-1', sandbox: 'browser-abc', ...(backend ? { backend } : {}) }, 60_000)
const request = (headers: Record<string, string>) => new Request('https://browser-relay.nativeintelligence.dev/api/browser-relay/next', { headers })
/** As the relay on the backend under test sends it. */
let kind: 'hosted' | 'runtime' = 'hosted'
const relay = (extra: Record<string, string> = {}) => request({ [RELAY_TOKEN_HEADER]: token(kind === 'runtime' ? 'runtime' : undefined), [RELAY_MARK_HEADER]: '1', ...extra })
const accepted = async (req: Request) => !((await requireAcceptedRelay(req)) instanceof Response)

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('BROWSER_INTERNAL_SECRET', 'browser-secret')
  vi.stubEnv('BROWSER_RELAY_ALLOWED_ADDRESSES', `${SERVER}, 2001:db8::7`)
  store.readStatus.mockReset().mockResolvedValue('running')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('on the hosted backend (the default)', () => {
  it('nothing changes: the token and the mark, whatever the address or the row', async () => {
    kind = 'hosted'
    vi.stubEnv('CLOUD_BROWSER_BACKEND', '')
    vi.stubEnv('BROWSER_RELAY_ALLOWED_ADDRESSES', '')
    expect(await accepted(relay())).toBe(true)
    expect(await accepted(relay({ 'x-real-ip': '198.51.100.1' }))).toBe(true)
    expect(await accepted(request({ [RELAY_TOKEN_HEADER]: token() }))).toBe(false)
    expect(store.readStatus).not.toHaveBeenCalled()
    expect(await relayActor(relay())).toEqual({ userId: 'user-1', workspaceId: 'ws-1', deviceId: 'cloud:browser-abc' })
  })
})

describe('on the runtime backend', () => {
  beforeEach(() => { kind = 'runtime'; vi.stubEnv('CLOUD_BROWSER_BACKEND', 'runtime') })

  it.each([
    // address,           row status,   accepted
    [SERVER, 'running', true],
    [SERVER, 'starting', true],
    [SERVER, 'stopping', false],
    [SERVER, 'stopped', false],
    [SERVER, null, false],
    ['2001:0db8:0:0:0:0:0:7', 'running', true],
    ['::ffff:203.0.113.7', 'running', true],
    ['198.51.100.1', 'running', false],
    ['not-an-ip', 'running', false],
  ] as const)('from %s with the browser %s: %s', async (address, status, expected) => {
    store.readStatus.mockResolvedValue(status)
    expect(await accepted(relay({ 'x-real-ip': address }))).toBe(expected)
  })

  it('reads the row of the token’s own user and workspace', async () => {
    await requireAcceptedRelay(relay({ 'x-real-ip': SERVER }))
    expect(store.readStatus).toHaveBeenCalledWith({ userId: 'user-1', workspaceId: 'ws-1' })
  })

  it('refuses a request with no x-real-ip, and never reads x-forwarded-for', async () => {
    expect(await accepted(relay())).toBe(false)
    expect(await accepted(relay({ 'x-forwarded-for': SERVER }))).toBe(false)
    expect(store.readStatus).not.toHaveBeenCalled()
  })

  it('refuses everything while the list is unset, blank, or holds one malformed entry', async () => {
    for (const value of ['', '   ', `${SERVER}, sandbox-server`, `${SERVER},10.0.0.0/8`]) {
      vi.stubEnv('BROWSER_RELAY_ALLOWED_ADDRESSES', value)
      expect(relayAddressPolicy().kind).toBe('refuse')
      expect(await accepted(relay({ 'x-real-ip': SERVER }))).toBe(false)
    }
    expect(store.readStatus).not.toHaveBeenCalled()
  })

  it('still needs a valid token and the mark from an allowed address', async () => {
    expect(await accepted(request({ 'x-real-ip': SERVER, [RELAY_MARK_HEADER]: '1' }))).toBe(false)
    expect(await accepted(request({ 'x-real-ip': SERVER, [RELAY_TOKEN_HEADER]: 'forged.token', [RELAY_MARK_HEADER]: '1' }))).toBe(false)
    expect(await accepted(request({ 'x-real-ip': SERVER, [RELAY_TOKEN_HEADER]: token('runtime') }))).toBe(false)
  })

  it('refuses when the row cannot be read', async () => {
    store.readStatus.mockRejectedValue(new Error('db down'))
    expect(await accepted(relay({ 'x-real-ip': SERVER }))).toBe(false)
  })
})

describe('an unknown CLOUD_BROWSER_BACKEND', () => {
  it('refuses every relay (fail closed), never a 500', async () => {
    vi.stubEnv('CLOUD_BROWSER_BACKEND', 'vercel')
    const out = await requireAcceptedRelay(relay({ 'x-real-ip': SERVER }))
    expect(out instanceof Response && out.status).toBe(401)
  })
})

describe('a token is good only on the backend it was minted for', () => {
  beforeEach(() => store.readStatus.mockResolvedValue('running'))

  it.each([
    // backend now, token minted for, accepted
    ['hosted', 'hosted', true],
    ['hosted', 'runtime', false],
    ['runtime', 'runtime', true],
    ['runtime', 'hosted', false],
  ] as const)('on %s, a %s token: %s', async (backend, mintedFor, expected) => {
    vi.stubEnv('CLOUD_BROWSER_BACKEND', backend === 'hosted' ? '' : 'runtime')
    const req = request({ 'x-real-ip': SERVER, [RELAY_MARK_HEADER]: '1', [RELAY_TOKEN_HEADER]: token(mintedFor === 'runtime' ? 'runtime' : undefined) })
    expect(await accepted(req)).toBe(expected)
  })

  it('a token naming any other backend never verifies', async () => {
    const { createHmac } = await import('node:crypto')
    const payload = Buffer.from(JSON.stringify({ aud: 'browser-relay', userId: 'user-1', workspaceId: 'ws-1', sandbox: 'browser-abc', backend: 'hosted', exp: Date.now() + 60_000 })).toString('base64url')
    const forged = `${payload}.${createHmac('sha256', 'browser-secret').update('browser-relay.v1.' + payload).digest('base64url')}`
    const { verifyBrowserRelayToken } = await import('../relay-token')
    expect(verifyBrowserRelayToken(forged)).toBeNull()
  })
})
