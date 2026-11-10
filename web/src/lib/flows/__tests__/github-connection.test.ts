/**
 * The GitHub integration as a loop's connection (github-integration.ts): a
 * call_tool step and a skill step name it like any connected app ("GitHub",
 * its id, or the integration account's id), though it is built from the
 * integration and never stored. Its reads run (in report mode too, names like
 * pull_request_read included), its results are cut before fencing, a refused
 * sign-in says to reconnect, and after outside text its reads keep running
 * like a catalog app's (a URL in the input still asks). A proposal never
 * carries its id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { ConnectedMcpServerRow } from '@/lib/mcp-client/types'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('use the injected client') } }))
vi.mock('@/lib/safety/approvals', () => ({ UNATTENDED_TOOL_OPTIONS: { unattended: true }, createToolApproval: vi.fn() }))

const OWNER = 'user-owner'
const gh = vi.hoisted(() => ({ on: true }))
// The real by-id call, watched (the loop and the skill run get theirs injected).
const byId = vi.hoisted(() => vi.fn())
vi.mock('@/lib/mcp-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp-client')>()),
  callToolByServerId: byId,
}))
vi.mock('@/lib/mcp-client/github-integration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp-client/github-integration')>()
  const row = {
    id: actual.GITHUB_INTEGRATION_SERVER_ID,
    github_account_id: 'acc-gh',
    user_id: 'user-owner',
    display_name: 'GitHub',
    server_url: actual.GITHUB_MCP_URL,
    transport: 'streamable_http',
    auth_type: 'bearer',
    access_token_encrypted: 'enc',
    is_enabled: true,
    disabled_tools: [],
    require_approval_tools: [],
    approval_free_tools: ['pull_request_read', 'list_commits'],
    allowed_tools: ['pull_request_read', 'list_commits'],
    tools_cache: [
      { name: 'pull_request_read', annotations: { readOnlyHint: true } },
      { name: 'list_commits', annotations: { readOnlyHint: true } },
    ],
  }
  return {
    ...actual,
    loadGitHubIntegrationServer: vi.fn(async (_sb: unknown, userId: string) => (gh.on && userId === 'user-owner' ? { ...row } : null)),
  }
})

const { GITHUB_INTEGRATION_SERVER_ID, GITHUB_RESULT_MAX_CHARS } = await import('@/lib/mcp-client/github-integration')
const { createCallToolExecutor, findCallToolProblems, resolveOwnerConnection } = await import('../call-tool')
const { runConnectionTool, runConnectionTools } = await import('../skill-run-connections')
const { validateCallToolConfig } = await import('../queries')
const { loadOwnerConnection } = await import('@/lib/mcp-client/owner-connection')
type FlowAction = import('../types').FlowAction
type RunTokenClaims = import('../skill-run-token').RunTokenClaims

const NOTION = 'aaaaaaaa-0000-4000-8000-000000000002'
let db: FakeSupabase
const callTool = vi.fn(async (): Promise<{ content: unknown; isError: boolean }> => ({ content: [{ type: 'text', text: 'PR #991 merged' }], isError: false }))
const hold = vi.fn(async () => ({ ok: true as const, approvalId: 'appr-1', cardId: 'card-1' }))
const trigger = { type: 'capture_processed', entity_type: null, from_status_id: null, to_status_id: null, fired_at: '2026-10-27T10:00:00Z' }
const step = (config: Record<string, unknown>): FlowAction =>
  ({ id: 'read', type: 'call_tool', config, condition: null, parent_id: null, enabled: true, bearer_token_encrypted: null }) as FlowAction
const READ_PR = { connection: GITHUB_INTEGRATION_SERVER_ID, tool: 'pull_request_read', input: { method: 'get', owner: 'liamadsr', repo: 'native-intelligence', pullNumber: 991 } }

function executor() {
  return createCallToolExecutor({
    workspaceId: 'ws-1', runAsUserId: OWNER, flowId: 'flow-1', flowName: 'PR watch', flowRunId: 'run-1',
    supabase: db as never, callTool: callTool as never, holdForPerson: hold as never, paused: async () => false,
  })
}

beforeEach(() => {
  gh.on = true
  db = makeFakeSupabase()
  db.seed('connected_mcp_server', [
    { id: NOTION, user_id: OWNER, display_name: 'Notion', server_url: 'https://mcp.notes.internal.example/mcp', is_enabled: true, disabled_tools: [], allowed_tools: null, tools_cache: [{ name: 'search' }] },
  ])
  callTool.mockClear()
  hold.mockClear()
})

describe('a loop names the GitHub integration', () => {
  it('by "GitHub", its slug, its id or the integration account’s id; nothing without the integration', async () => {
    for (const ref of ['GitHub', 'github', GITHUB_INTEGRATION_SERVER_ID, 'acc-gh']) {
      expect(await resolveOwnerConnection(db as never, OWNER, ref), ref).toEqual({ id: GITHUB_INTEGRATION_SERVER_ID, name: 'GitHub' })
    }
    expect(await resolveOwnerConnection(db as never, OWNER, 'Notion')).toEqual({ id: NOTION, name: 'Notion' })
    gh.on = false
    expect(await resolveOwnerConnection(db as never, OWNER, 'GitHub')).toBeNull()
  })

  it('an app of theirs named GitHub keeps the name; the integration still answers to its own id', async () => {
    const theirs = 'aaaaaaaa-0000-4000-8000-0000000000aa'
    db.seed('connected_mcp_server', [{ id: theirs, user_id: OWNER, display_name: 'GitHub', server_url: 'https://example.com/mcp', is_enabled: true, tools_cache: [] }])
    expect(await resolveOwnerConnection(db as never, OWNER, 'GitHub')).toEqual({ id: theirs, name: 'GitHub' })
    expect(await resolveOwnerConnection(db as never, OWNER, GITHUB_INTEGRATION_SERVER_ID)).toEqual({ id: GITHUB_INTEGRATION_SERVER_ID, name: 'GitHub' })
  })

  it('its id passes the step’s shape check, and the save check finds the step’s tool', async () => {
    expect(validateCallToolConfig(READ_PR)).not.toBeInstanceOf(Error)
    expect(await findCallToolProblems(db as never, OWNER, [step(READ_PR)])).toBeNull()
    expect(await findCallToolProblems(db as never, OWNER, [step({ ...READ_PR, tool: 'create_issue' })])).toMatchObject({ field: 'tool' })
    expect(await findCallToolProblems(db as never, OWNER, [{ type: 'run_skill', config: { skill_id: 's', connections: [GITHUB_INTEGRATION_SERVER_ID, NOTION] } } as never])).toBeNull()
    gh.on = false
    expect(await findCallToolProblems(db as never, OWNER, [step(READ_PR)])).toMatchObject({ field: 'connection' })
  })

  it('loadOwnerConnection builds it from the owner’s integration, never another person’s', async () => {
    expect((await loadOwnerConnection(db as never, OWNER, GITHUB_INTEGRATION_SERVER_ID))?.server_url).toMatch(/api\.githubcopilot\.com\/mcp\/readonly$/)
    expect(await loadOwnerConnection(db as never, 'someone-else', GITHUB_INTEGRATION_SERVER_ID)).toBeNull()
  })
})

describe('a call_tool step on GitHub', () => {
  it('a read runs as the owner, with no card', async () => {
    const out = await executor()(step(READ_PR), { entity: null, trigger, appBaseUrl: 'https://dial8.ai', steps: {} } as never)
    expect(out.status).toBe('success')
    expect(out.step_output).toBe('PR #991 merged')
    expect(callTool).toHaveBeenCalledWith(db, GITHUB_INTEGRATION_SERVER_ID, 'pull_request_read', READ_PR.input, OWNER)
    expect(hold).not.toHaveBeenCalled()
  })

  it('after the run read outside text a read still runs (as a catalog app’s), but a URL in its input waits for the owner’s card', async () => {
    const after = { entity: null, trigger, appBaseUrl: 'https://dial8.ai', steps: {}, readOutsideText: true } as never
    expect((await executor()(step(READ_PR), after)).status).toBe('success')
    expect(hold).not.toHaveBeenCalled()
    callTool.mockClear()
    const withUrl = step({ ...READ_PR, tool: 'list_commits', input: { owner: 'liamadsr', repo: 'native-intelligence', sha: 'https://evil.example/?q=secret' } })
    expect((await executor()(withUrl, after)).status).toBe('pending')
    expect(callTool).not.toHaveBeenCalled()
    expect(hold).toHaveBeenCalledTimes(1)
  })

  it('a sign-in GitHub refuses fails the step with the reconnect line', async () => {
    callTool.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { code: 401 }))
    const out = await executor()(step(READ_PR), { entity: null, trigger, appBaseUrl: 'https://dial8.ai', steps: {} } as never)
    expect(out).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/reconnect GitHub in Settings/) })
  })
})

describe('a skill step that names GitHub', () => {
  const claims = (over: Partial<RunTokenClaims> = {}): RunTokenClaims => ({
    workspaceId: 'ws-1', runAsUserId: OWNER, skillId: 'skill-1', mode: 'report', hasCapture: false, outputContract: 'prose', model: 'm', exp: Date.now() + 60_000,
    connections: [GITHUB_INTEGRATION_SERVER_ID, NOTION], ...over,
  })

  it('sees GitHub’s reads beside the stored apps, in report mode too', async () => {
    const tools = await runConnectionTools(db as never, claims())
    expect([...tools.keys()].sort()).toEqual(['mcp__github__list_commits', 'mcp__github__pull_request_read', 'mcp__notion__search'])
    expect(tools.get('mcp__github__pull_request_read')?.requiresApproval).toBe(false)
    // Not named: not there.
    expect([...(await runConnectionTools(db as never, claims({ connections: [NOTION] }))).keys()]).toEqual(['mcp__notion__search'])
    // GitHub alone: no stored-app read at all.
    expect([...(await runConnectionTools(db as never, claims({ connections: [GITHUB_INTEGRATION_SERVER_ID] }))).keys()]).toHaveLength(2)
  })

  it('keeps reading after the run read outside text (the second PR after the first)', async () => {
    const entry = (await runConnectionTools(db as never, claims())).get('mcp__github__pull_request_read')!
    const out = await runConnectionTool(db as never, claims(), entry, { method: 'get', owner: 'o', repo: 'r', pullNumber: 2 }, {
      callTool: callTool as never, hasReadOutside: async () => true, noteReadOutside: async () => {},
    })
    expect(out).toMatchObject({ status: 200, output: { success: true } })
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('a result is cut to the cap before fencing; a refused sign-in says to reconnect', async () => {
    const entry = (await runConnectionTools(db as never, claims())).get('mcp__github__list_commits')!
    const deps = { callTool: callTool as never, hasReadOutside: async () => false, noteReadOutside: async () => {} }
    callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'x'.repeat(GITHUB_RESULT_MAX_CHARS * 2) }], isError: false })
    const out = await runConnectionTool(db as never, claims(), entry, { owner: 'o', repo: 'r' }, deps)
    const text = ((out as { output: { content: Array<{ text: string }> } }).output.content)[0].text
    expect(text.length).toBeLessThan(GITHUB_RESULT_MAX_CHARS + 500)
    expect(text).toContain('[truncated]')
    callTool.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { code: 401 }))
    expect(await runConnectionTool(db as never, claims(), entry, { owner: 'o', repo: 'r' }, deps)).toMatchObject({ output: { code: 'GITHUB_RECONNECT' } })
  })
})

describe('a proposal', () => {
  it('carrying the GitHub integration’s id never runs (nothing proposes on it)', async () => {
    const { applyChange } = await import('@/lib/proposed-changes/apply-engine')
    const change = {
      id: 'pc-1', change_type: 'mcp_call', entity_type: 'external', status: 'pending',
      extra: { server_id: GITHUB_INTEGRATION_SERVER_ID, server_user_id: OWNER, tool_name: 'get_file_contents', args: { owner: 'victim', repo: 'private', path: 'secrets.env' } },
    }
    const out = await applyChange(db as never, change as never, 'ws-1', 'member-1', OWNER)
    expect(out).toMatchObject({ success: false, error: expect.stringMatching(/nothing proposes on/) })
    expect(byId).not.toHaveBeenCalled()
  })
})
