/**
 * GEN-1171: a stored OAuth server that refuses its token (the transport's
 * HTTP 401) gets one forced refresh and one retry. Refused again, it is this
 * call's error, never a mark (only the token endpoint's verdict marks). A
 * JSON-RPC error carrying 401 (the tool's own answer, after it ran), another
 * error, a bearer server and a probe row are never retried.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
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
const transports = vi.hoisted(() => ({ tokens: [] as string[] }))
// The real error classes (index.ts tells an HTTP 401 by them).
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  StreamableHTTPClientTransport: class {
    constructor(_url: URL, opts: { requestInit: { headers: Record<string, string> } }) {
      transports.tokens.push(opts.requestInit.headers.Authorization ?? '')
    }
  },
}))
vi.mock('../url-guard', () => ({ ensureSafeMcpUrl: (raw: string) => new URL(raw) }))
vi.mock('../url-guard-dns', () => ({ ensurePublicMcpUrl: async (raw: string) => new URL(raw) }))
vi.mock('@/lib/crypto/credentials', () => ({ decryptCredential: (v: string) => v, encryptCredential: (v: string) => v }))

const refresh = vi.hoisted(() => ({ ensureFreshAccessToken: vi.fn() }))
vi.mock('../token-refresh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../token-refresh')>()),
  ensureFreshAccessToken: refresh.ensureFreshAccessToken,
}))

const { callTool, McpTokenExpiredError } = await import('../index')

const STORED = '22222222-2222-4222-8222-222222222222'
const unauthorized = () => new StreamableHTTPError(401, 'Error POSTing to endpoint: unauthorized')

function server(over: Partial<ConnectedMcpServerRow> = {}): ConnectedMcpServerRow {
  return {
    id: STORED,
    display_name: 'Typefully',
    server_url: 'https://mcp.typefully.com/mcp',
    transport: 'streamable_http',
    auth_type: 'oauth2',
    access_token_encrypted: 'old',
    refresh_token_encrypted: 'r',
    token_expires_at: null,
    ...over,
  } as ConnectedMcpServerRow
}

beforeEach(() => {
  sdk.connect.mockReset().mockResolvedValue(undefined)
  sdk.callTool.mockReset()
  sdk.close.mockClear()
  transports.tokens = []
  refresh.ensureFreshAccessToken.mockReset()
  refresh.ensureFreshAccessToken.mockImplementation(async (row: ConnectedMcpServerRow, opts: { force?: boolean }) =>
    opts?.force ? { ...row, access_token_encrypted: 'new' } : row,
  )
})

describe('withClient on an HTTP 401', () => {
  it('refreshes once (forced) and retries with the new token', async () => {
    sdk.connect.mockRejectedValueOnce(unauthorized())
    sdk.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    await expect(callTool(server(), 'list_drafts', {})).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false })
    expect(refresh.ensureFreshAccessToken).toHaveBeenCalledTimes(2)
    expect(refresh.ensureFreshAccessToken.mock.calls[1][1]).toMatchObject({ force: true })
    expect(transports.tokens).toEqual(['Bearer old', 'Bearer new'])
    expect(sdk.callTool).toHaveBeenCalledTimes(1)
  })

  it('refused again with the new token: this call fails, and nothing is marked (not MCP_TOKEN_EXPIRED)', async () => {
    sdk.connect.mockRejectedValue(unauthorized())
    const err = await callTool(server(), 'list_drafts', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(McpTokenExpiredError)
    expect(String((err as Error).message)).toMatch(/refused its sign-in even after it was renewed/)
    expect(refresh.ensureFreshAccessToken).toHaveBeenCalledTimes(2)
    expect(sdk.callTool).not.toHaveBeenCalled()
  })

  it('an HTTP 401 on the call itself (after the handshake) is retried too: the server ran nothing', async () => {
    sdk.callTool.mockRejectedValueOnce(unauthorized()).mockResolvedValueOnce({ content: [] })
    await expect(callTool(server(), 'list_drafts', {})).resolves.toEqual({ content: [], isError: false })
    expect(sdk.callTool).toHaveBeenCalledTimes(2)
  })

  it('never retries a JSON-RPC error carrying 401: the tool already ran', async () => {
    sdk.callTool.mockRejectedValue(new McpError(401, 'upstream API refused'))
    await expect(callTool(server(), 'create_draft', {})).rejects.toBeInstanceOf(McpError)
    expect(sdk.callTool).toHaveBeenCalledTimes(1)
    expect(refresh.ensureFreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it('never retries another error, or an object that merely has code 401', async () => {
    sdk.callTool.mockRejectedValueOnce(new StreamableHTTPError(500, 'boom'))
    await expect(callTool(server(), 'list_drafts', {})).rejects.toThrow('boom')
    sdk.callTool.mockRejectedValueOnce(Object.assign(new Error('look-alike'), { code: 401 }))
    await expect(callTool(server(), 'list_drafts', {})).rejects.toThrow('look-alike')
    expect(sdk.callTool).toHaveBeenCalledTimes(2)
    expect(refresh.ensureFreshAccessToken.mock.calls.every((c) => !(c[1] as { force?: boolean })?.force)).toBe(true)
  })

  it('never retries a bearer server or a probe row', async () => {
    sdk.connect.mockRejectedValue(unauthorized())
    await expect(callTool(server({ auth_type: 'bearer' }), 'x', {})).rejects.toBeInstanceOf(StreamableHTTPError)
    await expect(callTool(server({ id: 'probe' }), 'x', {})).rejects.toBeInstanceOf(StreamableHTTPError)
    expect(refresh.ensureFreshAccessToken.mock.calls.every((c) => !(c[1] as { force?: boolean })?.force)).toBe(true)
  })
})
