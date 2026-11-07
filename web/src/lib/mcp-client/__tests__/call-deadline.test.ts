/**
 * callTool / withClient under a deadline (McpCallOptions.signal): the signal
 * rides the handshake and the request, an abort closes the client at once,
 * and a call without a signal is exactly what it was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ConnectedMcpServerRow } from '../types'

const sdk = vi.hoisted(() => ({
  connect: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  callTool: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  close: vi.fn<() => Promise<void>>(async () => {}),
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = sdk.connect
    callTool = sdk.callTool
    close = sdk.close
  },
}))
// The real error classes (index.ts tells an HTTP 401 by them).
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  StreamableHTTPClientTransport: class {},
}))
// The real error classes (index.ts tells an HTTP 401 by them).
vi.mock('@modelcontextprotocol/sdk/client/sse.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), SSEClientTransport: class {} }))
vi.mock('../url-guard', () => ({ ensureSafeMcpUrl: (raw: string) => new URL(raw) }))
// The guard's DNS half has its own test (dial-guard.test.ts).
vi.mock('../url-guard-dns', () => ({ ensurePublicMcpUrl: async (raw: string) => new URL(raw) }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) }),
}))
const oauth = vi.hoisted(() => ({ refreshAccessToken: vi.fn<(input: { signal?: AbortSignal }) => Promise<unknown>>() }))
vi.mock('../oauth', () => ({ refreshAccessToken: (input: { signal?: AbortSignal }) => oauth.refreshAccessToken(input) }))
vi.mock('@/lib/crypto/credentials', () => ({
  decryptCredential: (v: string) => v,
  decryptCredentialOrNull: (v: string | null | undefined) => v ?? null,
  encryptCredential: (v: string) => v,
}))

const { callTool, McpTokenExpiredError } = await import('../index')

const server = {
  id: 'srv-1',
  display_name: 'Jira',
  server_url: 'https://mcp.example.com/mcp',
  transport: 'streamable_http',
  auth_type: 'none',
} as ConnectedMcpServerRow

beforeEach(() => {
  sdk.connect.mockClear()
  sdk.callTool.mockReset()
  sdk.close.mockClear()
})

describe('callTool with a deadline signal', () => {
  it('passes the signal to the handshake and the request', async () => {
    sdk.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    const controller = new AbortController()
    await expect(callTool(server, 'get_issue', { key: 'A-1' }, { signal: controller.signal })).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })
    expect(sdk.connect).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal })
    expect(sdk.callTool).toHaveBeenCalledWith({ name: 'get_issue', arguments: { key: 'A-1' } }, undefined, {
      signal: controller.signal,
    })
    expect(sdk.close).toHaveBeenCalled()
  })

  it('an abort mid-request closes the client at once', async () => {
    const controller = new AbortController()
    sdk.callTool.mockImplementation(
      (...args: unknown[]) =>
        new Promise((_resolve, reject) => {
          const { signal } = args[2] as { signal: AbortSignal }
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const pending = callTool(server, 'get_issue', {}, { signal: controller.signal })
    await vi.waitFor(() => expect(sdk.callTool).toHaveBeenCalled())
    expect(sdk.close).not.toHaveBeenCalled()
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    expect(sdk.close).toHaveBeenCalled()
  })

  it('an already-aborted signal never dials', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(callTool(server, 'get_issue', {}, { signal: controller.signal })).rejects.toThrow()
    expect(sdk.connect).not.toHaveBeenCalled()
  })

  it('without a signal the calls are exactly what they were', async () => {
    sdk.callTool.mockResolvedValue({ content: [], isError: true })
    await expect(callTool(server, 'get_issue', {})).resolves.toEqual({ content: [], isError: true })
    expect(sdk.connect.mock.calls[0]).toHaveLength(1)
    expect(sdk.callTool.mock.calls[0]).toEqual([{ name: 'get_issue', arguments: {} }])
  })

  it('the deadline stops the wait for the OAuth refresh (which keeps its own bound), and is not reported as an expired connection', async () => {
    const controller = new AbortController()
    let refreshSignal: AbortSignal | undefined
    oauth.refreshAccessToken.mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          refreshSignal = input.signal
          input.signal?.addEventListener('abort', () => reject(new Error('refresh aborted')))
        }),
    )
    const expiring = {
      ...server,
      auth_type: 'oauth2',
      access_token_encrypted: 'a',
      refresh_token_encrypted: 'r',
      token_expires_at: new Date(Date.now() - 1_000).toISOString(),
      oauth_metadata: { token_endpoint: 'https://auth.example.com/token', client_id: 'c' },
      // A stored row (a uuid): only those are refreshed.
      id: '00000000-0000-4000-8000-000000000001',
    } as ConnectedMcpServerRow
    const pending = callTool(expiring, 'get_issue', {}, { signal: controller.signal })
    await vi.waitFor(() => expect(oauth.refreshAccessToken).toHaveBeenCalled())
    // Its own time bound, never the caller's: a refresh the caller gave up on still lands and is saved
    // (an aborted token request may already have rotated the token at the provider).
    expect(refreshSignal).toBeInstanceOf(AbortSignal)
    expect(refreshSignal).not.toBe(controller.signal)
    controller.abort()
    const err = await pending.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(McpTokenExpiredError)
    expect(sdk.connect).not.toHaveBeenCalled()
  })
})
