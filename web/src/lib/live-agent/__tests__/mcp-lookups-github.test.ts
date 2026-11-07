/**
 * The GitHub integration in a live call (mcp-lookups.ts loadLiveMcpServers):
 * its server joins the person's enabled apps from GitHub's kept tool list
 * (never waiting on GitHub), carries no token unless the route dials it, and
 * yields to an enabled app of theirs named GitHub. On GitHub's read-only
 * endpoint a read like pull_request_read is a lookup; elsewhere its name still
 * keeps it out. The writer's block offers nothing to stage on it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeQuery } from './helpers/live-turn-fixture'
import type { ConnectedMcpServerRow } from '@/lib/mcp-client/types'

const gh = vi.hoisted(() => ({ server: null as unknown, opts: [] as unknown[] }))
vi.mock('@/lib/mcp-client/github-integration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp-client/github-integration')>()),
  loadGitHubIntegrationServer: async (_sb: unknown, _userId: string, opts: unknown) => {
    gh.opts.push(opts)
    return gh.server
  },
}))

const { GITHUB_INTEGRATION_SERVER_ID, GITHUB_MCP_URL } = await import('@/lib/mcp-client/github-integration')
const { buildLiveLookupCatalog, isLiveLookupTool, loadLiveMcpServers } = await import('../mcp-lookups')
const { loadLiveMcpContext } = await import('../turn-composition')

const GITHUB = {
  id: GITHUB_INTEGRATION_SERVER_ID, user_id: 'u1', display_name: 'GitHub', server_url: GITHUB_MCP_URL, is_enabled: true,
  access_token_encrypted: 'enc', disabled_tools: [], require_approval_tools: [],
  approval_free_tools: ['pull_request_read', 'list_commits'], allowed_tools: ['pull_request_read', 'list_commits'],
  tools_cache: [
    { name: 'pull_request_read', description: 'Get a pull request', inputSchema: { type: 'object', properties: { pullNumber: { type: 'number' } } }, annotations: { readOnlyHint: true } },
    { name: 'list_commits', description: 'List commits', annotations: { readOnlyHint: true } },
  ],
}
const JIRA = { id: 'srv-jira', display_name: 'Jira', server_url: 'https://mcp.atlassian.com/v1/sse', is_enabled: true, disabled_tools: [], require_approval_tools: [], tools_cache: [{ name: 'create_issue', description: 'Create a Jira issue' }] }

function db(rows: unknown[]) {
  return createFakeSupabase((q: FakeQuery) => (q.table === 'connected_mcp_server' ? { data: rows, error: null } : undefined))
}

beforeEach(() => {
  gh.server = { ...GITHUB }
  gh.opts = []
})

describe('loadLiveMcpServers and the GitHub integration', () => {
  it('joins the person’s apps only where lookups may run; composing never waits on GitHub, the tool route may', async () => {
    expect((await loadLiveMcpServers(db([JIRA]).client, 'u1')).map((s) => s.display_name)).toEqual(['Jira'])
    expect(gh.opts).toEqual([])
    const plain = await loadLiveMcpServers(db([JIRA]).client, 'u1', { github: true })
    expect(plain.map((s) => s.display_name)).toEqual(['Jira', 'GitHub'])
    expect(plain[1].access_token_encrypted).toBeNull()
    expect(gh.opts).toEqual([{ cachedOnly: true }])
    const dialled = await loadLiveMcpServers(db([JIRA]).client, 'u1', { credentials: true, github: true })
    expect(dialled[1].access_token_encrypted).toBe('enc')
    expect(gh.opts[1]).toEqual({ cachedOnly: false })
  })

  it('yields to an enabled app of theirs named GitHub, and is absent without the integration', async () => {
    const theirs = { ...JIRA, id: 'srv-gh', display_name: 'GitHub' }
    expect((await loadLiveMcpServers(db([theirs]).client, 'u1', { github: true })).map((s) => s.id)).toEqual(['srv-gh'])
    gh.server = null
    expect((await loadLiveMcpServers(db([JIRA]).client, 'u1', { github: true })).map((s) => s.id)).toEqual(['srv-jira'])
  })
})

describe('GitHub reads as live lookups', () => {
  it('pull_request_read is a lookup on GitHub’s read-only endpoint, not elsewhere', () => {
    const tool = GITHUB.tools_cache[0]
    expect(isLiveLookupTool(tool, { server_url: GITHUB_MCP_URL, require_approval_tools: [] })).toBe(true)
    expect(isLiveLookupTool(tool, { server_url: 'https://mcp.example.com/mcp', require_approval_tools: [] })).toBe(false)
    // Still needs the server's read-only hint, and the person's "ask first" still wins.
    expect(isLiveLookupTool({ name: 'issue_read' }, { server_url: GITHUB_MCP_URL, require_approval_tools: [] })).toBe(false)
    expect(isLiveLookupTool(tool, { server_url: GITHUB_MCP_URL, require_approval_tools: ['pull_request_read'] })).toBe(false)
    // Of GitHub's reads, only the few a call uses ride each turn.
    expect(isLiveLookupTool({ name: 'list_releases', annotations: { readOnlyHint: true } }, { server_url: GITHUB_MCP_URL, require_approval_tools: [] })).toBe(false)
    expect(isLiveLookupTool({ name: 'search_issues', annotations: { readOnlyHint: true } }, { server_url: GITHUB_MCP_URL, require_approval_tools: [] })).toBe(true)
    expect(buildLiveLookupCatalog([GITHUB as unknown as ConnectedMcpServerRow] as never).map((l) => l.name)).toEqual([
      'mcp__github__pull_request_read',
      'mcp__github__list_commits',
    ])
  })

  it('the writer’s block names GitHub as read-only, with nothing to stage', async () => {
    const ctx = await loadLiveMcpContext(db([JIRA]).client, 'u1', { lookups: true })
    expect(ctx.lookups.map((l) => l.name)).toEqual(['mcp__github__pull_request_read', 'mcp__github__list_commits'])
    expect(ctx.block).toContain('**GitHub** — read-only')
    expect(ctx.block).not.toContain('`mcp__github__')
    expect(ctx.block).toContain('`mcp__jira__create_issue`')
    // Lookups off (a note-taker turn): GitHub is not even read, so no line at all.
    gh.opts = []
    expect((await loadLiveMcpContext(db([JIRA]).client, 'u1', { lookups: false })).block).not.toContain('GitHub')
    expect(gh.opts).toEqual([])
  })
})
