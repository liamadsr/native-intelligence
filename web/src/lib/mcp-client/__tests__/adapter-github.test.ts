/**
 * The GitHub integration's server in the adapter: its read tools reach the
 * agent as mcp__github__* beside the person's apps, run without a card, say
 * they are read-only, and come back cut to GITHUB_RESULT_MAX_CHARS and fenced.
 * An app of the person's named GitHub keeps its tools, and a call approved on
 * a card runs on the row built for it (it is never stored).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectedMcpServerRow } from '../types'

const mcp = vi.hoisted(() => ({
  callTool: vi.fn(async (): Promise<{ isError: boolean; content: unknown }> => ({ isError: false, content: [{ type: 'text', text: 'ok' }] })),
  callToolByServerId: vi.fn(async () => ({ isError: false, content: [{ type: 'text', text: 'by id' }] })),
  listTools: vi.fn(async (): Promise<unknown[]> => []),
}))
vi.mock('../index', () => ({
  callTool: mcp.callTool,
  callToolByServerId: mcp.callToolByServerId,
  listTools: mcp.listTools,
  McpTokenExpiredError: class extends Error {},
}))

const gh = vi.hoisted(() => ({ server: null as ConnectedMcpServerRow | null }))
vi.mock('../github-integration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../github-integration')>()
  return { ...actual, loadGitHubIntegrationServer: vi.fn(async () => gh.server) }
})

const { createExternalMcpTools, executeExternalMcpCall, MCP_TRUNCATED_SUFFIX } = await import('../adapter')
const { GITHUB_INTEGRATION_SERVER_ID, GITHUB_RESULT_MAX_CHARS, GITHUB_TOOL_NOTE } = await import('../github-integration')

const githubRow = {
  id: GITHUB_INTEGRATION_SERVER_ID,
  user_id: 'user-1',
  display_name: 'GitHub',
  server_url: 'https://api.githubcopilot.com/mcp/readonly',
  transport: 'streamable_http',
  auth_type: 'bearer',
  access_token_encrypted: 'enc',
  is_enabled: true,
  disabled_tools: [],
  require_approval_tools: [],
  approval_free_tools: ['list_pull_requests', 'pull_request_read'],
  allowed_tools: ['list_pull_requests', 'pull_request_read'],
  tools_cache: [
    { name: 'list_pull_requests', description: 'List pull requests', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    // Not read-shaped by name: it runs without a card because the row lists it approval-free.
    { name: 'pull_request_read', description: 'Read a pull request', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  ],
} as unknown as ConnectedMcpServerRow

const linear = {
  id: 'srv-1', user_id: 'user-1', display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp', is_enabled: true, disabled_tools: [],
  require_approval_tools: [],
  tools_cache: [{ name: 'list_issues', inputSchema: {}, annotations: { readOnlyHint: true } }],
}

function db(rows: unknown[]) {
  return {
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = async () => ({ data: rows, error: null })
      return chain
    },
  } as never
}

type Exec = (input: unknown, opts?: unknown) => Promise<Record<string, unknown>>
const exec = (tool: unknown) => (tool as { execute: Exec }).execute

beforeEach(() => {
  mcp.callTool.mockClear()
  mcp.callToolByServerId.mockClear()
  gh.server = githubRow
})

describe('the GitHub integration’s tools', () => {
  it('reach the agent beside the person’s apps, without a card, saying they are read-only', async () => {
    const { tools, meta, servers } = await createExternalMcpTools('user-1', db([linear]))
    expect(Object.keys(tools).sort()).toEqual(['mcp__github__list_pull_requests', 'mcp__github__pull_request_read', 'mcp__linear__list_issues'])
    // Read-only by the row: no confirm tool, nothing waits for a card.
    expect(tools.mcp_confirm_call).toBeUndefined()
    expect(meta.get('mcp__github__pull_request_read')).toMatchObject({ serverId: GITHUB_INTEGRATION_SERVER_ID, serverName: 'GitHub', requiresApproval: false })
    const description = (tools.mcp__github__list_pull_requests as { description?: string }).description ?? ''
    expect(description).toContain('[GitHub]')
    expect(description).toContain(GITHUB_TOOL_NOTE)
    expect(description).not.toMatch(/Approval required/)
    // The prompt's server block reads this list: GitHub is on it.
    expect(servers.map((s) => s.display_name)).toEqual(['Linear', 'GitHub'])
  })

  it('still come when the apps read fails, and not at all without the integration', async () => {
    const failing = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: 'down' } }) }) }) } as never
    expect(Object.keys((await createExternalMcpTools('user-1', failing)).tools)).toContain('mcp__github__list_pull_requests')
    gh.server = null
    expect(Object.keys((await createExternalMcpTools('user-1', db([linear]))).tools)).toEqual(['mcp__linear__list_issues'])
  })

  it('an app of the person’s named GitHub wins whole: a tool they switched off never comes back through the integration', async () => {
    const theirs = {
      ...linear, id: 'srv-gh', display_name: 'GitHub', disabled_tools: ['pull_request_read'],
      tools_cache: [
        { name: 'list_pull_requests', inputSchema: {}, annotations: { readOnlyHint: true } },
        { name: 'pull_request_read', inputSchema: {}, annotations: { readOnlyHint: true } },
      ],
    }
    const { meta, servers } = await createExternalMcpTools('user-1', db([theirs]))
    expect(meta.get('mcp__github__list_pull_requests')?.serverId).toBe('srv-gh')
    expect(meta.has('mcp__github__pull_request_read')).toBe(false)
    expect(servers.map((s) => s.id)).toEqual(['srv-gh'])
    // Their app switched off: still nothing from the integration under its names.
    const off = await createExternalMcpTools('user-1', db([{ ...theirs, is_enabled: false }]))
    expect(Object.keys(off.tools)).toEqual([])
  })

  it('marks its tools pinned reads (a home turn runs them), and no other server’s', async () => {
    const { meta } = await createExternalMcpTools('user-1', db([linear]))
    expect(meta.get('mcp__github__pull_request_read')?.pinnedRead).toBe(true)
    expect(meta.get('mcp__linear__list_issues')?.pinnedRead).toBeUndefined()
  })

  it('a sign-in GitHub refuses tells the agent to have the person reconnect GitHub', async () => {
    mcp.callTool.mockRejectedValueOnce(Object.assign(new Error('Streamable HTTP error: unauthorized: token authentication failed'), { code: 401 }))
    const { tools } = await createExternalMcpTools('user-1', db([]))
    const out = await exec(tools.mcp__github__list_pull_requests)({ owner: 'o', repo: 'r' })
    expect(out).toMatchObject({ success: false, code: 'GITHUB_RECONNECT' })
    expect(String(out.instruction)).toMatch(/reconnect GitHub in Settings/)
    // Another server's 401 keeps the plain error.
    mcp.callTool.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { code: 401 }))
    const linearOut = await exec((await createExternalMcpTools('user-1', db([linear]))).tools.mcp__linear__list_issues)({})
    expect(linearOut.code).toBeUndefined()
  })

  it('a result is cut to the cap before it is fenced', async () => {
    mcp.callTool.mockResolvedValueOnce({ isError: false, content: [{ type: 'text', text: 'x'.repeat(GITHUB_RESULT_MAX_CHARS * 2) }] })
    const { tools } = await createExternalMcpTools('user-1', db([]))
    const out = await exec(tools.mcp__github__list_pull_requests)({ owner: 'o', repo: 'r' })
    expect(mcp.callTool).toHaveBeenCalledWith(githubRow, 'list_pull_requests', { owner: 'o', repo: 'r' })
    const text = String((out.content as Array<{ text: string }>)[0].text)
    expect(text.length).toBeLessThan(GITHUB_RESULT_MAX_CHARS + 500)
    expect(text).toContain(MCP_TRUNCATED_SUFFIX)
    expect(text).toMatch(/UNTRUSTED|untrusted/)
  })

  it('a call approved on a card runs on the row built for it, never looked up by id', async () => {
    const out = await executeExternalMcpCall(db([]), 'user-1', 'mcp__github__pull_request_read', { owner: 'o', repo: 'r', pullNumber: 1 })
    expect(out.success).toBe(true)
    expect(mcp.callTool).toHaveBeenCalledWith(githubRow, 'pull_request_read', { owner: 'o', repo: 'r', pullNumber: 1 })
    expect(mcp.callToolByServerId).not.toHaveBeenCalled()
  })
})
