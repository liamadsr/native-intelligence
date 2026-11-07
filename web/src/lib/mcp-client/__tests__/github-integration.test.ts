/**
 * The agent's GitHub tools ride the person's GitHub integration (one GitHub
 * connection): a read-only server on GitHub's `/readonly` URL with the
 * integration's token, built per call and never stored, its tools listed once
 * per instance, and nothing at all when the integration is off, needs a
 * reconnect or has no token. Never throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createSupabaseMock } from '@/test/supabase-mock'
import type { McpToolDescriptor } from '../types'

process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('base64')

vi.mock('../index', () => ({ listTools: vi.fn() }))

const { decryptCredential } = await import('@/lib/crypto/credentials')
const {
  _resetGitHubToolsForTests,
  GITHUB_INTEGRATION_SERVER_ID,
  GITHUB_MCP_TOOLSETS,
  GITHUB_MCP_URL,
  GITHUB_TOOLS_RETRY_MS,
  GITHUB_TOOLS_TTL_MS,
  isGitHubIntegrationServer,
  isGitHubSignInRefused,
  loadGitHubIntegrationServer,
  shadowsGitHubIntegration,
} = await import('../github-integration')

const ACCOUNT = { id: 'acc-gh', created_at: '2026-10-27T20:25:43Z', reauth_required_at: null }
const TOKENS = [{ access_token: 'gho_test_token', account_id: 'acc-gh' }]
const TOOLS: McpToolDescriptor[] = [
  { name: 'list_pull_requests', annotations: { readOnlyHint: true } },
  { name: 'list_commits', annotations: { readOnlyHint: true } },
  // Neither kept: a tool GitHub does not mark read-only, and a destructive one.
  { name: 'create_issue', annotations: {} },
  { name: 'odd_read', annotations: { readOnlyHint: true, destructiveHint: true } },
]

function db(accounts: unknown[] = [ACCOUNT], tokens: unknown[] = TOKENS) {
  return createSupabaseMock({
    tables: {
      connected_account: { data: accounts, error: null },
      user_oauth_tokens: { data: tokens, error: null },
    },
  }) as never
}

beforeEach(() => {
  _resetGitHubToolsForTests()
})

describe('loadGitHubIntegrationServer', () => {
  it('builds a read-only GitHub server on the integration token, with only the read tools, none asking', async () => {
    const listTools = vi.fn(async () => TOOLS)
    const server = await loadGitHubIntegrationServer(db(), 'u1', { listTools })
    expect(server).not.toBeNull()
    expect(isGitHubIntegrationServer(server!)).toBe(true)
    expect(server).toMatchObject({
      id: GITHUB_INTEGRATION_SERVER_ID,
      user_id: 'u1',
      display_name: 'GitHub',
      server_url: GITHUB_MCP_URL,
      transport: 'streamable_http',
      auth_type: 'bearer',
      is_enabled: true,
      extra_headers: { 'X-MCP-Toolsets': GITHUB_MCP_TOOLSETS },
      github_account_id: 'acc-gh',
    })
    expect(GITHUB_MCP_URL).toMatch(/\/readonly$/)
    // Stored the way a connected app's token is, never in the clear.
    expect(server!.access_token_encrypted).not.toContain('gho_test_token')
    expect(decryptCredential(server!.access_token_encrypted!)).toBe('gho_test_token')
    expect(server!.tools_cache!.map((t) => t.name)).toEqual(['list_pull_requests', 'list_commits'])
    expect(server!.approval_free_tools).toEqual(['list_pull_requests', 'list_commits'])
    expect(server!.allowed_tools).toEqual(['list_pull_requests', 'list_commits'])
    // The listing dialled the same read-only server, under a deadline.
    expect(listTools).toHaveBeenCalledTimes(1)
    const [row, opts] = listTools.mock.calls[0] as unknown as [{ server_url: string }, { signal?: AbortSignal }]
    expect(row.server_url).toBe(GITHUB_MCP_URL)
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('nothing without an enabled account, with one that needs a reconnect, or without a token', async () => {
    const listTools = vi.fn(async () => TOOLS)
    expect(await loadGitHubIntegrationServer(db([]), 'u1', { listTools })).toBeNull()
    expect(await loadGitHubIntegrationServer(db([{ ...ACCOUNT, reauth_required_at: '2026-10-27T00:00:00Z' }]), 'u1', { listTools })).toBeNull()
    expect(await loadGitHubIntegrationServer(db([ACCOUNT], []), 'u1', { listTools })).toBeNull()
    expect(await loadGitHubIntegrationServer(db([ACCOUNT], [{ access_token: '', account_id: 'acc-gh' }]), 'u1', { listTools })).toBeNull()
    expect(listTools).not.toHaveBeenCalled()
  })

  it('uses the enabled account’s own token, never another account’s (one turned off lends nothing)', async () => {
    const listTools = vi.fn(async () => TOOLS)
    // Only the switched-off account B holds a token (the newest): A gets nothing.
    expect(await loadGitHubIntegrationServer(db([ACCOUNT], [{ access_token: 'gho_b', account_id: 'acc-b' }]), 'u1', { listTools })).toBeNull()
    // Both hold one: A's, though B's is newer.
    const server = await loadGitHubIntegrationServer(
      db([ACCOUNT], [{ access_token: 'gho_b', account_id: 'acc-b' }, { access_token: 'gho_a', account_id: 'acc-gh' }]),
      'u1',
      { listTools },
    )
    expect(decryptCredential(server!.access_token_encrypted!)).toBe('gho_a')
    expect(server!.github_account_id).toBe('acc-gh')
    // A needs a reconnect: B (enabled, its own token) is used instead.
    const b = await loadGitHubIntegrationServer(
      db([{ ...ACCOUNT, reauth_required_at: '2026-10-27T00:00:00Z' }, { id: 'acc-b', created_at: '2026-10-27T21:00:00Z', reauth_required_at: null }], [{ access_token: 'gho_a', account_id: 'acc-gh' }, { access_token: 'gho_b', account_id: 'acc-b' }]),
      'u1',
      { listTools },
    )
    expect(b!.github_account_id).toBe('acc-b')
    expect(decryptCredential(b!.access_token_encrypted!)).toBe('gho_b')
  })

  it('lists GitHub’s tools once per instance for everyone; past the TTL the kept list serves while one re-list runs', async () => {
    let now = 1_000_000
    const listTools = vi.fn(async () => TOOLS)
    const deps = { listTools, now: () => now }
    await loadGitHubIntegrationServer(db(), 'u1', deps)
    await loadGitHubIntegrationServer(db(), 'u2', deps)
    expect(listTools).toHaveBeenCalledTimes(1)
    now += GITHUB_TOOLS_TTL_MS + 1
    // The re-list hangs: the turn still gets the kept list at once.
    let finish: (tools: McpToolDescriptor[]) => void = () => {}
    listTools.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const stale = await loadGitHubIntegrationServer(db(), 'u1', deps)
    expect(stale!.tools_cache!.map((t) => t.name)).toEqual(['list_pull_requests', 'list_commits'])
    // One re-list for everyone meanwhile.
    await loadGitHubIntegrationServer(db(), 'u2', deps)
    expect(listTools).toHaveBeenCalledTimes(2)
    finish([{ name: 'get_me', annotations: { readOnlyHint: true } }])
    await new Promise((r) => setTimeout(r, 0))
    const fresh = await loadGitHubIntegrationServer(db(), 'u1', deps)
    expect(fresh!.tools_cache!.map((t) => t.name)).toEqual(['get_me'])
  })

  it('a re-list that fails keeps the list it had', async () => {
    let now = 1_000_000
    const listTools = vi.fn(async (): Promise<McpToolDescriptor[]> => TOOLS)
    const deps = { listTools, now: () => now }
    await loadGitHubIntegrationServer(db(), 'u1', deps)
    now += GITHUB_TOOLS_TTL_MS + 1
    listTools.mockRejectedValueOnce(new Error('503'))
    await loadGitHubIntegrationServer(db(), 'u1', deps)
    await new Promise((r) => setTimeout(r, 0))
    expect((await loadGitHubIntegrationServer(db(), 'u2', deps))!.tools_cache).toHaveLength(2)
  })

  it('a listing that throws before it awaits anything never leaves the instance stuck without tools', async () => {
    const throwing = vi.fn((): Promise<McpToolDescriptor[]> => {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY is not set')
    })
    expect(await loadGitHubIntegrationServer(db(), 'u1', { listTools: throwing })).toBeNull()
    await new Promise((r) => setTimeout(r, 0))
    // Someone else, next: a real listing runs.
    const listTools = vi.fn(async () => TOOLS)
    expect(await loadGitHubIntegrationServer(db(), 'u2', { listTools })).not.toBeNull()
    expect(listTools).toHaveBeenCalledTimes(1)
  })

  it('a failed listing gives no tools, and only that person waits to try again', async () => {
    let now = 1_000_000
    const listTools = vi.fn(async (): Promise<McpToolDescriptor[]> => {
      throw new Error('401 Bad credentials')
    })
    const deps = { listTools, now: () => now }
    expect(await loadGitHubIntegrationServer(db(), 'u1', deps)).toBeNull()
    expect(await loadGitHubIntegrationServer(db(), 'u1', deps)).toBeNull()
    expect(listTools).toHaveBeenCalledTimes(1)
    // Someone else's token is tried.
    listTools.mockResolvedValueOnce(TOOLS)
    expect(await loadGitHubIntegrationServer(db(), 'u2', deps)).not.toBeNull()
    expect(listTools).toHaveBeenCalledTimes(2)
    // The first person is tried again after the wait, and the kept listing serves them.
    now += GITHUB_TOOLS_RETRY_MS + 1
    expect(await loadGitHubIntegrationServer(db(), 'u1', deps)).not.toBeNull()
    expect(listTools).toHaveBeenCalledTimes(2)
  })

  it('a listing with no read-only tool counts as a failure', async () => {
    const listTools = vi.fn(async () => [{ name: 'create_issue', annotations: {} }])
    expect(await loadGitHubIntegrationServer(db(), 'u1', { listTools })).toBeNull()
  })

  it('a person’s own app named like it wins: shadowsGitHubIntegration (never the integration’s own row)', () => {
    const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    expect(shadowsGitHubIntegration([{ display_name: 'GitHub' }], slug)).toBe(true)
    expect(shadowsGitHubIntegration([{ display_name: 'github' }], slug)).toBe(true)
    expect(shadowsGitHubIntegration([{ display_name: 'Linear' }, { display_name: null }], slug)).toBe(false)
    expect(shadowsGitHubIntegration([{ id: GITHUB_INTEGRATION_SERVER_ID, display_name: 'GitHub' }], slug)).toBe(false)
  })

  it('cachedOnly (a live turn) never waits: with no list yet it lists in the background and gives nothing now', async () => {
    let finish: (tools: McpToolDescriptor[]) => void = () => {}
    const listTools = vi.fn(() => new Promise<McpToolDescriptor[]>((resolve) => { finish = resolve }))
    expect(await loadGitHubIntegrationServer(db(), 'u1', { listTools, cachedOnly: true })).toBeNull()
    expect(listTools).toHaveBeenCalledTimes(1)
    finish(TOOLS)
    await new Promise((r) => setTimeout(r, 0))
    expect((await loadGitHubIntegrationServer(db(), 'u1', { listTools, cachedOnly: true }))!.tools_cache).toHaveLength(2)
    expect(listTools).toHaveBeenCalledTimes(1)
  })

  it('a 401 from GitHub reads as a refused sign-in, nothing else does', () => {
    expect(isGitHubSignInRefused(Object.assign(new Error('Streamable HTTP error: unauthorized'), { code: 401 }))).toBe(true)
    expect(isGitHubSignInRefused(Object.assign(new Error('rate limited'), { code: 429 }))).toBe(false)
    expect(isGitHubSignInRefused(new Error('401 in the text only'))).toBe(false)
    expect(isGitHubSignInRefused(null)).toBe(false)
  })

  it('reads only the caller’s own account and token (the queries filter by user)', async () => {
    const { makeFakeSupabase } = await import('@/lib/work/__tests__/fake-supabase')
    const fake = makeFakeSupabase()
    fake.seed('connected_account', [
      { id: 'acc-1', user_id: 'u1', provider: 'github', capability: 'github', is_enabled: true, reauth_required_at: null, created_at: '2026-10-27T00:00:00Z' },
      { id: 'acc-off', user_id: 'u3', provider: 'github', capability: 'github', is_enabled: false, reauth_required_at: null, created_at: '2026-10-27T00:00:00Z' },
    ])
    fake.seed('user_oauth_tokens', [
      { user_id: 'u1', account_id: 'acc-1', provider: 'github', capability: 'github', access_token: 'gho_u1', updated_at: '2026-10-27T00:00:00Z' },
      { user_id: 'u3', account_id: 'acc-off', provider: 'github', capability: 'github', access_token: 'gho_u3', updated_at: '2026-10-27T00:00:00Z' },
    ])
    const listTools = vi.fn(async () => TOOLS)
    const mine = await loadGitHubIntegrationServer(fake as never, 'u1', { listTools })
    expect(decryptCredential(mine!.access_token_encrypted!)).toBe('gho_u1')
    // Someone with no GitHub of their own gets nothing, never u1's.
    expect(await loadGitHubIntegrationServer(fake as never, 'u2', { listTools })).toBeNull()
    // A switched-off account lends nothing, its token on file or not.
    expect(await loadGitHubIntegrationServer(fake as never, 'u3', { listTools })).toBeNull()
  })

  it('never throws, whatever the database does', async () => {
    const broken = { from: () => { throw new Error('boom') } } as never
    await expect(loadGitHubIntegrationServer(broken, 'u1', { listTools: vi.fn(async () => TOOLS) })).resolves.toBeNull()
  })
})
