/**
 * Every MCP dial and every OAuth fetch goes through the whole SSRF guard
 * (F2 review, second pass):
 *   - both SDK transports get a fetch that refuses redirects, so the GETs the
 *     SDK opens itself (the streamable-HTTP standalone stream, the SSE
 *     EventSource), which ignore requestInit, can't be redirected either;
 *   - withClient checks the server's URL, DNS included, before it dials;
 *   - the server-supplied OAuth URLs (resource metadata, an issuer, the
 *     registration and token endpoints) are DNS-checked before each fetch;
 *   - a host found public is trusted for 60 s, a refusal never.
 * DNS is a stub here (no real lookup).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectedMcpServerRow } from '../types'

const dns = vi.hoisted(() => ({ answer: [{ address: '93.184.216.34' }] as Array<{ address: string }>, calls: [] as string[] }))
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => {
    dns.calls.push(host)
    return dns.answer
  },
}))
const sdk = vi.hoisted(() => ({ transportOpts: [] as Array<Record<string, unknown>>, connect: vi.fn(async () => {}) }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = sdk.connect
    listTools = async () => ({ tools: [] })
    close = async () => {}
  },
}))
// The real error classes (index.ts tells an HTTP 401 by them).
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  StreamableHTTPClientTransport: class {
    constructor(_url: URL, opts: Record<string, unknown>) {
      sdk.transportOpts.push(opts)
    }
  },
}))
// The real error classes (index.ts tells an HTTP 401 by them).
vi.mock('@modelcontextprotocol/sdk/client/sse.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SSEClientTransport: class {
    constructor(_url: URL, opts: Record<string, unknown>) {
      sdk.transportOpts.push(opts)
    }
  },
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/crypto/credentials', () => ({ decryptCredential: (v: string) => v, encryptCredential: (v: string) => v }))

const { listTools, noRedirectFetch } = await import('../index')
const { _resetPublicHostCacheForTests, ensurePublicMcpUrl, PUBLIC_HOST_TTL_MS } = await import('../url-guard-dns')
const { fetchProtectedResourceMetadata, registerClient } = await import('../oauth')

const row = (over: Partial<ConnectedMcpServerRow> = {}) =>
  ({ id: 's', user_id: 'u', display_name: 'X', server_url: 'https://mcp.example.com/mcp', transport: 'streamable_http', auth_type: 'none', ...over }) as ConnectedMcpServerRow

beforeEach(() => {
  dns.answer = [{ address: '93.184.216.34' }]
  dns.calls = []
  sdk.transportOpts = []
  sdk.connect.mockClear()
  _resetPublicHostCacheForTests()
})

describe('the transports', () => {
  it('both get the no-redirect fetch, and keep requestInit', async () => {
    await listTools(row())
    await listTools(row({ transport: 'sse', server_url: 'https://mcp.example.com/sse' }))
    expect(sdk.transportOpts).toHaveLength(2)
    for (const opts of sdk.transportOpts) {
      expect(opts.fetch).toBe(noRedirectFetch)
      expect(opts.requestInit).toMatchObject({ redirect: 'error' })
    }
  })

  it('a server Dial8 builds sends its own headers, but never its own Authorization', async () => {
    await listTools(row({
      auth_type: 'bearer',
      access_token_encrypted: 'the-token',
      extra_headers: { 'X-MCP-Toolsets': 'repos,issues', authorization: 'Bearer planted' },
    }))
    const headers = (sdk.transportOpts[0].requestInit as { headers: Record<string, string> }).headers
    expect(headers).toEqual({ 'X-MCP-Toolsets': 'repos,issues', Authorization: 'Bearer the-token' })
  })

  it('the no-redirect fetch forces redirect: error over whatever the SDK passes', async () => {
    const seen: RequestInit[] = []
    vi.stubGlobal('fetch', async (_u: unknown, init: RequestInit) => {
      seen.push(init)
      return new Response('')
    })
    await noRedirectFetch('https://mcp.example.com/mcp', { method: 'GET', redirect: 'follow', headers: { a: 'b' } })
    expect(seen[0]).toMatchObject({ method: 'GET', redirect: 'error', headers: { a: 'b' } })
    vi.unstubAllGlobals()
  })
})

describe('withClient', () => {
  it('a host that resolves to a private address is never dialled', async () => {
    dns.answer = [{ address: '10.1.2.3' }]
    await expect(listTools(row({ server_url: 'https://rebound.example/mcp' }))).rejects.toThrow(/not public/)
    expect(sdk.transportOpts).toEqual([])
    expect(sdk.connect).not.toHaveBeenCalled()
  })
})

describe('server-supplied OAuth URLs', () => {
  it('resource metadata and a registration endpoint are DNS-checked before any fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    dns.answer = [{ address: '169.254.169.254' }]
    await expect(fetchProtectedResourceMetadata('https://meta.example/.well-known/oauth-protected-resource')).rejects.toThrow(/not public/)
    await expect(registerClient('https://reg.example/register', 'https://app/cb')).rejects.toThrow(/not public/)
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('ensurePublicMcpUrl', () => {
  it('trusts a public host for 60 s, then looks again; never caches a refusal', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34' }])
    await ensurePublicMcpUrl('https://a.example/mcp', lookup, 1_000)
    await ensurePublicMcpUrl('https://a.example/other', lookup, 1_000 + PUBLIC_HOST_TTL_MS - 1)
    expect(lookup).toHaveBeenCalledTimes(1)
    await ensurePublicMcpUrl('https://a.example/mcp', lookup, 1_000 + PUBLIC_HOST_TTL_MS + 1)
    expect(lookup).toHaveBeenCalledTimes(2)

    const bad = vi.fn(async () => [{ address: '127.0.0.1' }])
    await expect(ensurePublicMcpUrl('https://b.example/mcp', bad, 5_000)).rejects.toThrow()
    await expect(ensurePublicMcpUrl('https://b.example/mcp', bad, 5_001)).rejects.toThrow()
    expect(bad).toHaveBeenCalledTimes(2)
    // The name and literal checks still come first, with no lookup.
    await expect(ensurePublicMcpUrl('http://plain.example/mcp', lookup)).rejects.toThrow()
  })
})
