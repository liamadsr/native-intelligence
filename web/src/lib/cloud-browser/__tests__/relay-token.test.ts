/**
 * The cloud browser relay's token (src/lib/cloud-browser/relay-token.ts):
 * signed for one user, workspace and sandbox, domain-separated from every
 * other run token, and accepted only with the relay's own mark header, which
 * no page can send without a CORS preflight.
 */
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintBrowserRelayToken, relayDeviceId, requireBrowserRelay, RELAY_MARK_HEADER, RELAY_TOKEN_HEADER, verifyBrowserRelayToken } from '../relay-token'

const claims = { userId: 'user-1', workspaceId: 'ws-1', sandbox: 'browser-abc' }
const request = (headers: Record<string, string>) => new Request('https://browser-relay.dial8.ai/api/browser-relay/next', { headers })

beforeEach(() => {
  vi.stubEnv('BROWSER_INTERNAL_SECRET', 'browser-secret')
  vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', 'root-secret')
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

describe('the relay token', () => {
  it('round-trips its claims', () => {
    expect(verifyBrowserRelayToken(mintBrowserRelayToken(claims, 60_000))).toMatchObject({ aud: 'browser-relay', ...claims })
  })

  it('is refused once expired, tampered with, or signed without the relay prefix', () => {
    vi.useFakeTimers()
    const token = mintBrowserRelayToken(claims, 1000)
    vi.advanceTimersByTime(1001)
    expect(verifyBrowserRelayToken(token)).toBeNull()
    vi.useRealTimers()

    const [payload, signature] = mintBrowserRelayToken(claims, 60_000).split('.')
    const other = Buffer.from(JSON.stringify({ ...claims, userId: 'someone-else', aud: 'browser-relay', exp: Date.now() + 60_000 })).toString('base64url')
    expect(verifyBrowserRelayToken(`${other}.${signature}`)).toBeNull()
    // Another family's HMAC over the bare payload, even with the same key, never verifies here.
    const bare = createHmac('sha256', 'browser-secret').update(payload).digest('base64url')
    expect(verifyBrowserRelayToken(`${payload}.${bare}`)).toBeNull()
  })

  it('needs its shape and a secret', () => {
    const secret = 'browser-secret'
    const forge = (body: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify(body)).toString('base64url')
      return `${payload}.${createHmac('sha256', secret).update('browser-relay.v1.' + payload).digest('base64url')}`
    }
    expect(verifyBrowserRelayToken(forge({ aud: 'utility', ...claims, exp: Date.now() + 60_000 }))).toBeNull()
    expect(verifyBrowserRelayToken(forge({ aud: 'browser-relay', ...claims, workspaceId: '', exp: Date.now() + 60_000 }))).toBeNull()
    expect(verifyBrowserRelayToken(forge({ aud: 'browser-relay', ...claims, exp: Date.now() + 60_000 }))).not.toBeNull()
    vi.stubEnv('BROWSER_INTERNAL_SECRET', '')
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', '')
    expect(verifyBrowserRelayToken(forge({ aud: 'browser-relay', ...claims, exp: Date.now() + 60_000 }))).toBeNull()
    expect(() => mintBrowserRelayToken(claims, 1000)).toThrow(/not set/)
  })

  it('falls back to the root secret, as every family does', () => {
    vi.stubEnv('BROWSER_INTERNAL_SECRET', '')
    expect(verifyBrowserRelayToken(mintBrowserRelayToken(claims, 60_000))).not.toBeNull()
  })
})

describe('requireBrowserRelay', () => {
  it('accepts the token only beside the relay’s mark', async () => {
    const token = mintBrowserRelayToken(claims, 60_000)
    expect(requireBrowserRelay(request({ [RELAY_TOKEN_HEADER]: token, [RELAY_MARK_HEADER]: '1' }))).toMatchObject(claims)
    const refusedHeaders: Record<string, string>[] = [{ [RELAY_TOKEN_HEADER]: token }, { [RELAY_MARK_HEADER]: '1' }, { [RELAY_TOKEN_HEADER]: 'x.y', [RELAY_MARK_HEADER]: '1' }]
    for (const headers of refusedHeaders) {
      const refused = requireBrowserRelay(request(headers))
      expect(refused).toBeInstanceOf(Response)
      expect((refused as Response).status).toBe(401)
    }
  })

  it('still accepts a relay started before the rename, under its old header names', () => {
    const token = mintBrowserRelayToken(claims, 60_000)
    expect(requireBrowserRelay(request({ 'x-dial8-relay-token': token, 'x-dial8-relay': '1' }))).toMatchObject(claims)
    // Never a mix: the token must come under the same name as the mark beside it.
    const refusedHeaders: Record<string, string>[] = [{ 'x-dial8-relay-token': token }, { 'x-dial8-relay-token': token, [RELAY_MARK_HEADER]: '1' }, { [RELAY_TOKEN_HEADER]: token, 'x-dial8-relay': '1' }]
    for (const headers of refusedHeaders) expect((requireBrowserRelay(request(headers)) as Response).status).toBe(401)
  })

  it('names the device by its sandbox', () => {
    expect(relayDeviceId({ aud: 'browser-relay', ...claims, exp: 0 })).toBe('cloud:browser-abc')
  })
})
