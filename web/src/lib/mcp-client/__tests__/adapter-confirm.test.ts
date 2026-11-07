/**
 * mcp_confirm_call no longer trusts the model (A5 slice 3): it never runs the
 * call it is handed. With a requester it holds the call for the person (an
 * approval card); without one nothing runs. An approval-gated tool still
 * short-circuits without a side effect. executeExternalMcpCall is the one way
 * a held call runs, after the person accepted it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mcp = vi.hoisted(() => ({
  callTool: vi.fn(async () => ({ isError: false, content: [{ type: 'text', text: 'ok' }] })),
  callToolByServerId: vi.fn(async () => ({ isError: false, content: [{ type: 'text', text: 'created' }] })),
  listTools: vi.fn(async (): Promise<unknown[]> => { throw new Error('offline') }),
}))
vi.mock('../index', () => ({
  callTool: mcp.callTool,
  callToolByServerId: mcp.callToolByServerId,
  listTools: mcp.listTools,
  McpTokenExpiredError: class extends Error {},
}))

import { _resetLegacyRelistForTests, CONFIRM_TOOL_NAME, createExternalMcpTools, executeExternalMcpCall, isLegacyToolsCache } from '../adapter'

const server = {
  id: 'srv-1', user_id: 'user-1', display_name: 'Linear', is_enabled: true, disabled_tools: [],
  require_approval_tools: ['create_issue'],
  tools_cache: [{ name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: {} } }, { name: 'list_issues', inputSchema: {} }],
}
const db = {
  from: () => {
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = async () => ({ data: [server], error: null })
    return chain
  },
} as never
type Exec = (input: unknown, opts?: unknown) => Promise<Record<string, unknown>>
const exec = (tool: unknown) => (tool as { execute: Exec }).execute

beforeEach(() => {
  mcp.callTool.mockClear()
  mcp.callToolByServerId.mockClear()
  mcp.listTools.mockClear()
  _resetLegacyRelistForTests()
})

describe('mcp_confirm_call', () => {
  it('without a requester nothing runs', async () => {
    const { tools } = await createExternalMcpTools('user-1', db)
    const out = await exec(tools[CONFIRM_TOOL_NAME])({ tool: 'mcp__linear__create_issue', args: { title: 'Bug' }, confirmed: true }, {})
    expect(out).toMatchObject({ success: false, code: 'APPROVAL_UNAVAILABLE' })
    expect(mcp.callToolByServerId).not.toHaveBeenCalled()
  })

  it('with a requester it holds the exact call for the person and never runs it', async () => {
    const requestApproval = vi.fn(async () => ({ ok: true as const, approvalId: 'appr-1' }))
    const { tools } = await createExternalMcpTools('user-1', db, { requestApproval })
    const out = await exec(tools[CONFIRM_TOOL_NAME])({ tool: 'mcp__linear__create_issue', args: { title: 'Bug' }, confirmed: true }, {})
    expect(out).toMatchObject({ status: 'approval_requested', approval_id: 'appr-1', tool: 'mcp__linear__create_issue' })
    // With the server and the tool's own name, for the card's Always allow; this tool may take it.
    expect(requestApproval).toHaveBeenCalledWith({
      toolName: 'mcp__linear__create_issue',
      serverName: 'Linear',
      args: { title: 'Bug' },
      serverId: 'srv-1',
      remoteTool: 'create_issue',
      alwaysAsks: false,
      runAgain: false,
    })
    expect(mcp.callToolByServerId).not.toHaveBeenCalled()
    // It says where the result comes back, so the agent never asks again (GEN-1172).
    expect(String(out.message)).toMatch(/get_tool_approval_result/)
    expect(String(out.message)).toMatch(/never ask them to approve it again/)
  })

  it('the same call already approved here makes no second card: it answers with that run’s result (GEN-1172)', async () => {
    const ran = {
      id: '0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d',
      tool: 'mcp__linear__create_issue',
      status: 'approved',
      input: { title: 'Bug' },
      executed_at: '2026-10-27T10:00:01Z',
      decided_at: '2026-10-27T10:00:00Z',
      result: { success: true, isError: false, content: [{ type: 'text', text: 'Created ENG-42' }] },
    }
    const requestApproval = vi.fn(async () => ({ ok: true as const, approvalId: ran.id, alreadyRan: ran }))
    const { tools } = await createExternalMcpTools('user-1', db, { requestApproval })
    const out = await exec(tools[CONFIRM_TOOL_NAME])({ tool: 'mcp__linear__create_issue', args: { title: 'Bug' }, confirmed: true }, {})
    expect(out).toMatchObject({ status: 'already_ran', approval_id: ran.id, outcome: 'ran', server: 'Linear' })
    expect(String(out.result)).toContain('Created ENG-42')
    expect(String(out.result)).toMatch(/^\[UNTRUSTED TOOL CONTENT/)
    expect(String(out.message)).toMatch(/no new card was made/)
    expect(String(out.message)).toMatch(/run_again: true/)
    expect(mcp.callToolByServerId).not.toHaveBeenCalled()
  })

  it('run_again: true tells the requester the person asked to run it again', async () => {
    const requestApproval = vi.fn(async () => ({ ok: true as const, approvalId: 'appr-3' }))
    const { tools } = await createExternalMcpTools('user-1', db, { requestApproval })
    const out = await exec(tools[CONFIRM_TOOL_NAME])({ tool: 'mcp__linear__create_issue', args: { title: 'Bug' }, confirmed: true, run_again: true }, {})
    expect(out).toMatchObject({ status: 'approval_requested', approval_id: 'appr-3' })
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ runAgain: true }))
  })

  it('a catalog app’s always-ask tool tells the requester so (its card offers no Always allow)', async () => {
    const typefully = {
      ...server,
      id: 'srv-t',
      display_name: 'Typefully',
      server_url: 'https://mcp.typefully.com/mcp',
      require_approval_tools: [],
      tools_cache: [{ name: 'create_draft', inputSchema: { type: 'object', properties: {} } }],
    }
    const tdb = { from: () => { const chain: Record<string, unknown> = {}; chain.select = () => chain; chain.eq = async () => ({ data: [typefully], error: null }); return chain } }
    const requestApproval = vi.fn(async () => ({ ok: true as const, approvalId: 'appr-2' }))
    const { tools } = await createExternalMcpTools('user-1', tdb as never, { requestApproval })
    await exec(tools[CONFIRM_TOOL_NAME])({ tool: 'mcp__typefully__create_draft', args: {}, confirmed: true }, {})
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'srv-t', remoteTool: 'create_draft', alwaysAsks: true }))
  })

  it('says nothing ran when the approval could not be created', async () => {
    const { tools } = await createExternalMcpTools('user-1', db, { requestApproval: async () => ({ ok: false as const, error: 'The inputs are too large to show on an approval card.' }) })
    const out = await exec(tools[CONFIRM_TOOL_NAME])({ tool: 'mcp__linear__create_issue', args: {}, confirmed: true }, {})
    expect(out).toMatchObject({ success: false, code: 'APPROVAL_NOT_CREATED', error: expect.stringMatching(/too large to show/) })
    expect(mcp.callToolByServerId).not.toHaveBeenCalled()
  })

  it('an unknown tool is refused', async () => {
    const { tools } = await createExternalMcpTools('user-1', db, { requestApproval: async () => ({ ok: true as const, approvalId: 'x' }) })
    expect(await exec(tools[CONFIRM_TOOL_NAME])({ tool: 'mcp__evil__drop', args: {}, confirmed: true }, {})).toMatchObject({ success: false })
  })

  it('the gated tool itself still runs nothing', async () => {
    const { tools } = await createExternalMcpTools('user-1', db, { requestApproval: async () => ({ ok: true as const, approvalId: 'x' }) })
    expect(await exec(tools.mcp__linear__create_issue)({ title: 'Bug' }, {})).toMatchObject({ status: 'awaiting_user_approval' })
    expect(mcp.callTool).not.toHaveBeenCalled()
  })
})

describe('executeExternalMcpCall', () => {
  it('runs a still-connected tool through its server, bypassing the gate (the person approved it)', async () => {
    expect(await executeExternalMcpCall(db, 'user-1', 'mcp__linear__create_issue', { title: 'Bug' })).toMatchObject({ success: true })
    expect(mcp.callToolByServerId).toHaveBeenCalledWith(db, 'srv-1', 'create_issue', { title: 'Bug' }, 'user-1')
  })

  it('refuses a tool that is no longer connected', async () => {
    expect(await executeExternalMcpCall(db, 'user-1', 'mcp__linear__gone', {})).toMatchObject({ success: false })
    expect(mcp.callToolByServerId).not.toHaveBeenCalled()
  })

  it('cuts a long result before fencing, so the row keeps it whole and the fence closes (GEN-1172)', async () => {
    mcp.callToolByServerId.mockResolvedValueOnce({
      isError: false,
      content: [{ type: 'text', text: 'x'.repeat(50_000) }, { type: 'image', data: 'AAAA', mimeType: 'image/png' } as never],
    })
    const out = await executeExternalMcpCall(db, 'user-1', 'mcp__linear__create_issue', {})
    const parts = out.content as Array<{ type: string; text?: string }>
    expect(JSON.stringify(out).length).toBeLessThan(8_000)
    expect(parts[0].text).toMatch(/\[truncated\]\n\[END UNTRUSTED CONTENT\]$/)
    expect(JSON.stringify(parts)).not.toContain('AAAA')
  })
})

describe('approval by default (always-on safety fixes, approval-policy.ts)', () => {
  const dbWith = (row: Record<string, unknown>) => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = async () => ({ data: [row], error: null })
      return chain
    },
  }) as never
  const github = {
    id: 'srv-2', user_id: 'user-1', display_name: 'GitHub', is_enabled: true, disabled_tools: [],
    require_approval_tools: [],
    tools_cache: [
      { name: 'create_pull_request', inputSchema: {} },
      { name: 'list_pull_requests', inputSchema: {} },
      { name: 'repo_info', inputSchema: {}, annotations: { readOnlyHint: true } },
      { name: 'merge_pull_request', inputSchema: {} },
    ],
  }

  it('a write nobody listed needs approval: its meta says so, its description routes to mcp_confirm_call, and calling it runs nothing', async () => {
    const { tools, meta } = await createExternalMcpTools('user-1', dbWith(github), { requestApproval: async () => ({ ok: true as const, approvalId: 'x' }) })
    expect(meta.get('mcp__github__create_pull_request')?.requiresApproval).toBe(true)
    expect((tools.mcp__github__create_pull_request as { description?: string }).description).toMatch(/Approval required/)
    expect(tools[CONFIRM_TOOL_NAME]).toBeDefined()
    expect(await exec(tools.mcp__github__create_pull_request)({ title: 'x' }, {})).toMatchObject({ status: 'awaiting_user_approval' })
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('a read-shaped name runs without approval; on a server we don\'t know, its readOnlyHint alone never does', async () => {
    const { tools, meta } = await createExternalMcpTools('user-1', dbWith(github))
    expect(meta.get('mcp__github__list_pull_requests')?.requiresApproval).toBe(false)
    // repo_info says readOnlyHint, but the name isn't read-shaped and the server isn't in the catalog (F2 review B1).
    expect(meta.get('mcp__github__repo_info')?.requiresApproval).toBe(true)
    expect(await exec(tools.mcp__github__list_pull_requests)({}, {})).toMatchObject({ success: true })
    expect(mcp.callTool).toHaveBeenCalledTimes(1)
    // The same hint on a catalog server is trusted, as before.
    const catalog = await createExternalMcpTools('user-1', dbWith({ ...github, server_url: 'https://mcp.linear.app/mcp' }))
    expect(catalog.meta.get('mcp__github__repo_info')?.requiresApproval).toBe(false)
  })

  it('the person\'s approval-free choice is respected', async () => {
    const { tools, meta } = await createExternalMcpTools('user-1', dbWith({ ...github, approval_free_tools: ['merge_pull_request'] }))
    expect(meta.get('mcp__github__merge_pull_request')?.requiresApproval).toBe(false)
    expect(meta.get('mcp__github__create_pull_request')?.requiresApproval).toBe(true)
    expect(await exec(tools.mcp__github__merge_pull_request)({ number: 1 }, {})).toMatchObject({ success: true })
  })
})

describe('a tools cache from before annotations were kept is re-listed once, on first use', () => {
  const atlassian = () => ({
    id: 'srv-3', user_id: 'user-1', display_name: 'Atlassian', is_enabled: true, disabled_tools: [], require_approval_tools: [],
    // A catalog server: its hints are trusted (approval-policy.ts isReadOnlyForServer).
    server_url: 'https://mcp.atlassian.com/v1/sse',
    // Saved before 2026-10-15: no tool carries an `annotations` key.
    tools_cache: [{ name: 'jira_issue', inputSchema: {} }, { name: 'createJiraIssue', inputSchema: {} }],
  })
  const recording = (row: Record<string, unknown>, updates: Array<Record<string, unknown>>) => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = (col: string) => (col === 'user_id' && !('patched' in chain) ? Promise.resolve({ data: [row], error: null }) : chain)
      chain.update = (patch: Record<string, unknown>) => {
        updates.push(patch)
        const done: Record<string, unknown> = { patched: true }
        done.eq = () => done
        done.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve)
        return done
      }
      return chain
    },
  }) as never

  it('knows a legacy cache: no annotations key on any tool', () => {
    expect(isLegacyToolsCache(atlassian().tools_cache)).toBe(true)
    expect(isLegacyToolsCache([{ name: 'x', annotations: {} }])).toBe(false)
    expect(isLegacyToolsCache([])).toBe(false)
  })

  it('re-lists it, saves the annotated cache, and decides approval from the fresh hints', async () => {
    mcp.listTools.mockResolvedValueOnce([
      { name: 'jira_issue', inputSchema: {}, annotations: { readOnlyHint: true } },
      { name: 'createJiraIssue', inputSchema: {}, annotations: {} },
    ])
    const updates: Array<Record<string, unknown>> = []
    const { meta } = await createExternalMcpTools('user-1', recording(atlassian(), updates))
    expect(mcp.listTools).toHaveBeenCalledTimes(1)
    expect(updates[0]).toMatchObject({ tools_cache: [expect.objectContaining({ name: 'jira_issue', annotations: { readOnlyHint: true } }), expect.anything()] })
    expect(meta.get('mcp__atlassian__jira_issue')?.requiresApproval).toBe(false)
    expect(meta.get('mcp__atlassian__createJiraIssue')?.requiresApproval).toBe(true)
  })

  it('a failed re-list keeps the old cache (fail closed) and is not retried on the next call', async () => {
    const updates: Array<Record<string, unknown>> = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = await createExternalMcpTools('user-1', recording(atlassian(), updates))
    expect(first.meta.get('mcp__atlassian__jira_issue')?.requiresApproval).toBe(true)
    await createExternalMcpTools('user-1', recording(atlassian(), updates))
    expect(mcp.listTools).toHaveBeenCalledTimes(1)
    expect(updates).toHaveLength(0)
  })
})
