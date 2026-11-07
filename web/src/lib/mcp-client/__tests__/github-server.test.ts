/**
 * GitHub's read-only endpoint as plain facts (github-server.ts): which URLs it
 * is, what the approval policy makes of a tool there, and callToolByServerId
 * reaching the GitHub integration's server by its id (built from the caller's
 * own integration, never looked up in the table).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectedMcpServerRow } from '../types'

const dns = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => {
    dns.calls.push(host)
    return [{ address: '140.82.112.21' }]
  },
}))
const sdk = vi.hoisted(() => ({ urls: [] as string[], calls: [] as Array<{ name: string }> }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = async () => {}
    callTool = async (params: { name: string }) => {
      sdk.calls.push(params)
      return { content: [{ type: 'text', text: 'ok' }], isError: false }
    }
    close = async () => {}
  },
}))
// The real error classes (index.ts tells an HTTP 401 by them).
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  StreamableHTTPClientTransport: class {
    constructor(url: URL) {
      sdk.urls.push(String(url))
    }
  },
}))
// The real error classes (index.ts tells an HTTP 401 by them).
vi.mock('@modelcontextprotocol/sdk/client/sse.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), SSEClientTransport: class {} }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/crypto/credentials', () => ({ decryptCredential: (v: string) => v, encryptCredential: (v: string) => v }))

const gh = vi.hoisted(() => ({ server: null as ConnectedMcpServerRow | null, calls: [] as unknown[][] }))
vi.mock('../github-integration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../github-integration')>()),
  loadGitHubIntegrationServer: async (...args: unknown[]) => {
    gh.calls.push(args)
    return gh.server
  },
}))

const { GITHUB_INTEGRATION_SERVER_ID, GITHUB_MCP_URL, isGitHubReadOnlyServerUrl } = await import('../github-server')
const { isReadOnlyForServer, mcpToolRequiresApproval } = await import('../approval-policy')
const { callToolByServerId } = await import('../index')

const githubRow = {
  id: GITHUB_INTEGRATION_SERVER_ID, user_id: 'u1', display_name: 'GitHub', server_url: GITHUB_MCP_URL, transport: 'streamable_http',
  auth_type: 'bearer', access_token_encrypted: 'tok', is_enabled: true, disabled_tools: [], require_approval_tools: [],
  approval_free_tools: ['pull_request_read'], allowed_tools: ['pull_request_read'],
  tools_cache: [{ name: 'pull_request_read', annotations: { readOnlyHint: true } }],
} as unknown as ConnectedMcpServerRow

beforeEach(() => {
  sdk.urls = []
  sdk.calls = []
  gh.calls = []
  gh.server = githubRow
})

describe('isGitHubReadOnlyServerUrl', () => {
  it('only GitHub’s own read-only endpoints', () => {
    expect(isGitHubReadOnlyServerUrl(GITHUB_MCP_URL)).toBe(true)
    expect(isGitHubReadOnlyServerUrl('https://api.githubcopilot.com/mcp/readonly/')).toBe(true)
    expect(isGitHubReadOnlyServerUrl('https://api.githubcopilot.com/mcp/x/issues/readonly')).toBe(true)
    for (const url of [
      'https://api.githubcopilot.com/mcp/',
      'https://api.githubcopilot.com/mcp/x/issues',
      'http://api.githubcopilot.com/mcp/readonly',
      'https://api.githubcopilot.com:8443/mcp/readonly',
      'https://api.githubcopilot.com/mcp/readonly?write=1',
      'https://api.githubcopilot.com.evil.example/mcp/readonly',
      'https://evil.example/api.githubcopilot.com/mcp/readonly',
      'not a url',
      null,
    ]) {
      expect(isGitHubReadOnlyServerUrl(url), String(url)).toBe(false)
    }
  })
})

describe('the approval policy on GitHub’s read-only endpoint', () => {
  it('every tool there is a read, whatever its name, unless it says otherwise', () => {
    const at = { server_url: GITHUB_MCP_URL }
    expect(isReadOnlyForServer({ name: 'pull_request_read', annotations: { readOnlyHint: true } }, at)).toBe(true)
    expect(isReadOnlyForServer({ name: 'issue_read' }, at)).toBe(true)
    expect(isReadOnlyForServer({ name: 'odd', annotations: { destructiveHint: true } }, at)).toBe(false)
    expect(mcpToolRequiresApproval({ name: 'issue_read' }, at)).toBe(false)
    // The person's own "ask first" still wins.
    expect(mcpToolRequiresApproval({ name: 'issue_read' }, { ...at, require_approval_tools: ['issue_read'] })).toBe(true)
    // Anywhere else the name rule stands.
    expect(isReadOnlyForServer({ name: 'issue_read', annotations: { readOnlyHint: true } }, { server_url: 'https://mcp.example.com/mcp' })).toBe(false)
  })
})

describe('callToolByServerId on the GitHub integration’s id', () => {
  it('builds the caller’s own GitHub server and dials GitHub, never the table', async () => {
    const from = vi.fn()
    const out = await callToolByServerId({ from } as never, GITHUB_INTEGRATION_SERVER_ID, 'pull_request_read', { pullNumber: 1 }, 'u1')
    expect(out).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false })
    expect(from).not.toHaveBeenCalled()
    expect(gh.calls[0][1]).toBe('u1')
    expect(sdk.urls).toEqual([GITHUB_MCP_URL])
    expect(sdk.calls).toEqual([{ name: 'pull_request_read', arguments: { pullNumber: 1 } }])
  })

  it('refuses a tool it does not keep, and an integration that is off', async () => {
    await expect(callToolByServerId({ from: vi.fn() } as never, GITHUB_INTEGRATION_SERVER_ID, 'create_issue', {}, 'u1')).rejects.toThrow(/not one of GitHub's read tools/)
    gh.server = null
    await expect(callToolByServerId({ from: vi.fn() } as never, GITHUB_INTEGRATION_SERVER_ID, 'pull_request_read', {}, 'u1')).rejects.toThrow(/not connected/)
    expect(sdk.calls).toEqual([])
  })
})
