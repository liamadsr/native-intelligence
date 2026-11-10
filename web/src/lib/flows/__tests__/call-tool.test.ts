/**
 * The call_tool step (F4): the owner's connection and a tool they let the
 * agent see; the input rendered strictly from earlier steps; the app's
 * schema at run time; then the input-aware rule: a read runs, an inert
 * write runs and is reported, anything else PARKS the run on the owner's
 * verified approval card (door flow_step, its run named). Posts always park.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('use the injected client') } }))

import { createCallToolExecutor, findCallToolProblems } from '../call-tool'
import type { FlowAction, TriggerContext } from '../types'

const OWNER = 'user-owner'
const WS = 'ws-1'
const TYPEFULLY = 'aaaaaaaa-0000-4000-8000-000000000001'
const NOTION = 'aaaaaaaa-0000-4000-8000-000000000002'
const draftSchema = { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }

let db: FakeSupabase
const trigger: TriggerContext = { type: 'capture_processed', entity_type: null, from_status_id: null, to_status_id: null, fired_at: '2026-10-20T10:00:00Z' }
const ctx = { entity: null, trigger, appBaseUrl: 'https://nativeintelligence.dev', capture: { id: 'cap-1', title: 'Acme call' }, steps: { draft: { output: 'We shipped SSO' } } }
const step = (config: Record<string, unknown>): FlowAction =>
  ({ id: 'queue', type: 'call_tool', config, condition: null, parent_id: 'draft', enabled: true, bearer_token_encrypted: null }) as FlowAction

function seedServers() {
  db.seed('connected_mcp_server', [
    {
      id: TYPEFULLY, user_id: OWNER, display_name: 'Typefully', server_url: 'https://mcp.typefully.com/mcp', is_enabled: true,
      disabled_tools: [], require_approval_tools: [], approval_free_tools: [], allowed_tools: ['create_draft', 'list_drafts', 'publish_draft'],
      tools_cache: [{ name: 'create_draft', inputSchema: draftSchema }, { name: 'list_drafts' }, { name: 'publish_draft', inputSchema: { type: 'object' } }, { name: 'brand_new' }],
    },
    {
      // A server OUTSIDE the catalog (mcp-client/suggested.ts): Notion's own host joined it on 2026-10-22.
      id: NOTION, user_id: OWNER, display_name: 'Notion', server_url: 'https://mcp.notes.internal.example/mcp', is_enabled: true,
      disabled_tools: ['delete_page'], require_approval_tools: [], approval_free_tools: [], allowed_tools: null,
      tools_cache: [{ name: 'append_block', inputSchema: { type: 'object', properties: { page_id: { type: 'string' }, text: { type: 'string' } }, required: ['page_id', 'text'] } }, { name: 'delete_page' }],
    },
  ])
}

const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'draft d_123 saved' }], isError: false }))
const hold = vi.fn(async () => ({ ok: true as const, approvalId: 'appr-1', cardId: 'card-1' }))

function executor(over: Partial<Parameters<typeof createCallToolExecutor>[0]> = {}) {
  return createCallToolExecutor({
    workspaceId: WS, runAsUserId: OWNER, flowId: 'flow-1', flowName: 'Weekly posts', flowRunId: 'run-1',
    supabase: db as never, callTool: callTool as never, holdForPerson: hold as never, paused: async () => false, ...over,
  })
}

beforeEach(() => {
  db = makeFakeSupabase()
  seedServers()
  callTool.mockClear()
  hold.mockClear()
})

describe('a read and an inert write run', () => {
  it('a Typefully draft with no publish time runs, is reported, and leaves its output', async () => {
    const r = await executor()(step({ connection: TYPEFULLY, tool: 'create_draft', input: { content: '{{steps.draft.output}}' } }), ctx)
    expect(callTool).toHaveBeenCalledWith(db, TYPEFULLY, 'create_draft', { content: 'We shipped SSO' }, OWNER)
    expect(hold).not.toHaveBeenCalled()
    expect(r).toMatchObject({ status: 'success', step_output: 'draft d_123 saved', read_outside_text: true, called: { policy: 'inert', tool: 'create_draft', server: 'Typefully' } })
    expect(r.delivered?.summary).toMatch(/Typefully draft with no publish time/)
  })

  it('a read runs and is not reported as a write', async () => {
    const r = await executor()(step({ connection: TYPEFULLY, tool: 'list_drafts', input: {} }), ctx)
    expect(r).toMatchObject({ status: 'success', called: { policy: 'read' } })
    expect(r.delivered).toBeUndefined()
  })
})

describe('an outward write parks the run on the owner\'s card', () => {
  it('a post (publish_at) ALWAYS parks, held as the exact rendered call, door flow_step, its run named', async () => {
    const r = await executor()(step({ connection: TYPEFULLY, tool: 'create_draft', input: { content: '{{steps.draft.output}}', publish_at: 'next-free-slot' } }), ctx)
    expect(callTool).not.toHaveBeenCalled()
    expect(hold).toHaveBeenCalledOnce()
    const [, approval] = hold.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    expect(approval).toMatchObject({
      door: 'flow_step', userId: OWNER, workspaceId: WS, toolName: 'mcp__typefully__create_draft', flowRunId: 'run-1',
      input: { content: 'We shipped SSO', publish_at: 'next-free-slot' },
      context: { flowStep: { flow_id: 'flow-1', action_id: 'queue', flow_run_id: 'run-1', connection: TYPEFULLY, tool: 'create_draft', rule: 'public_content', public_content: true } },
      card: { title: "Add to Typefully queue: next free slot: 'We shipped SSO'" },
    })
    expect(r).toMatchObject({ status: 'pending', parked: { approval_id: 'appr-1', card_id: 'card-1' }, called: { policy: 'ask' } })
  })

  it('a write on a connector with no rule parks (P5 says it asks)', async () => {
    const r = await executor()(step({ connection: NOTION, tool: 'append_block', input: { page_id: 'p1', text: 'Objection: price' } }), ctx)
    expect(r.status).toBe('pending')
    expect(hold).toHaveBeenCalledOnce()
  })

  it('no card could be made (the caps): the step fails and says why, nothing runs', async () => {
    const r = await executor({ holdForPerson: (async () => ({ ok: false, code: 'TOO_MANY_PENDING', error: 'This loop run already has several approvals waiting.' })) as never })(
      step({ connection: NOTION, tool: 'append_block', input: { page_id: 'p1', text: 'x' } }), ctx)
    expect(r).toMatchObject({ status: 'failed' })
    expect(r.error_message).toContain('several approvals waiting')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('a run that cannot wait (no run id) holds nothing and fails', async () => {
    const r = await executor({ flowRunId: null })(step({ connection: NOTION, tool: 'append_block', input: { page_id: 'p1', text: 'x' } }), ctx)
    expect(r.status).toBe('failed')
    expect(hold).not.toHaveBeenCalled()
  })
})

describe('what fails loudly', () => {
  it('a missing reference fails the step, naming it; nothing is called or held', async () => {
    const r = await executor()(step({ connection: TYPEFULLY, tool: 'create_draft', input: { content: '{{steps.summary.output}}' } }), ctx)
    expect(r).toMatchObject({ status: 'failed' })
    expect(r.error_message).toContain('{{steps.summary.output}}')
    expect(callTool).not.toHaveBeenCalled()
    expect(hold).not.toHaveBeenCalled()
  })

  it('the rendered input must match the tool\'s schema', async () => {
    const r = await executor()(step({ connection: NOTION, tool: 'append_block', input: { text: 'no page' } }), ctx)
    expect(r.status).toBe('failed')
    expect(r.error_message).toMatch(/doesn't match append_block/)
  })

  it('a hidden tool (switched off, or new and not added) is never called', async () => {
    for (const [connection, tool] of [[NOTION, 'delete_page'], [TYPEFULLY, 'brand_new']]) {
      const r = await executor()(step({ connection, tool, input: {} }), ctx)
      expect(r.status, tool).toBe('failed')
    }
    expect(callTool).not.toHaveBeenCalled()
  })

  it('another person\'s connection, or the kill switch, refuses the step', async () => {
    expect((await executor({ runAsUserId: 'someone-else' })(step({ connection: TYPEFULLY, tool: 'list_drafts', input: {} }), ctx)).status).toBe('failed')
    const paused = await executor({ paused: async () => true })(step({ connection: TYPEFULLY, tool: 'list_drafts', input: {} }), ctx)
    expect(paused.error_message).toMatch(/switched off/)
    expect(callTool).not.toHaveBeenCalled()
  })

  it('a dry run (test_flow) calls nothing and holds nothing', async () => {
    const r = await executor({ dryRun: true, flowRunId: null })(step({ connection: TYPEFULLY, tool: 'create_draft', input: { content: 'x', publish: true } }), ctx)
    expect(r).toMatchObject({ status: 'success', called: { policy: 'ask' } })
    expect(r.response_body_preview).toMatch(/would wait for your approval card/)
    expect(callTool).not.toHaveBeenCalled()
    expect(hold).not.toHaveBeenCalled()
  })
})

describe('review fixes (B1, B3, S6)', () => {
  it('B1: flow_run (readable by every member) gets a generic line, never the app\'s text or the call\'s input', async () => {
    callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Acme: $48k renewal, CFO unhappy' }], isError: false } as never)
    const read = await executor()(step({ connection: TYPEFULLY, tool: 'list_drafts', input: {} }), ctx)
    expect(read.step_output).toBe('Acme: $48k renewal, CFO unhappy')
    expect(read.response_body_preview).toBe('Read 31 chars from Typefully (list_drafts)')
    const parked = await executor()(step({ connection: TYPEFULLY, tool: 'create_draft', input: { content: '{{steps.draft.output}}', publish_at: 'next-free-slot' } }), ctx)
    const onRun = JSON.stringify({ preview: parked.response_body_preview, parked: parked.parked, error: parked.error_message })
    expect(onRun).not.toContain('We shipped SSO')
    expect(parked.parked?.title).toBe('a post via Typefully (create_draft)')
  })

  it('B1: an app\'s own error text stays off the run', async () => {
    callTool.mockRejectedValueOnce(new Error('upstream said: Acme renewal notes are private'))
    const r = await executor()(step({ connection: TYPEFULLY, tool: 'list_drafts', input: {} }), ctx)
    expect(r.error_message).toBe('The call to list_drafts on Typefully failed')
  })

  it('B3: the person\'s own "ask first" on the tool parks even a proven draft', async () => {
    db.rows('connected_mcp_server')[0].require_approval_tools = ['create_draft']
    const r = await executor()(step({ connection: TYPEFULLY, tool: 'create_draft', input: { content: 'x' } }), ctx)
    expect(r.status).toBe('pending')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('S6: once the run read outside text, a read on a server outside the catalog parks', async () => {
    db.rows('connected_mcp_server')[1].tools_cache = [{ name: 'search', inputSchema: { type: 'object' } }]
    db.rows('connected_mcp_server')[1].allowed_tools = ['search']
    const before = await executor()(step({ connection: NOTION, tool: 'search', input: { q: 'x' } }), ctx)
    expect(before.status).toBe('success')
    const after = await executor()(step({ connection: NOTION, tool: 'search', input: { q: 'x' } }), { ...ctx, readOutsideText: true })
    expect(after.status).toBe('pending')
  })
})

describe('findCallToolProblems (save time)', () => {
  const action = (config: Record<string, unknown>, enabled = true) => ({ type: 'call_tool' as const, config: config as never, enabled })

  it('passes the owner\'s visible tool with a matching templated input', async () => {
    expect(await findCallToolProblems(db as never, OWNER, [action({ connection: NOTION, tool: 'append_block', input: { page_id: 'p', text: '{{steps.lens.output}}' } })])).toBeNull()
  })

  it('names the problem: not the owner\'s, a hidden tool, a bad input; a disabled step is a draft', async () => {
    expect((await findCallToolProblems(db as never, 'other', [action({ connection: NOTION, tool: 'append_block', input: {} })]))?.field).toBe('connection')
    expect((await findCallToolProblems(db as never, OWNER, [action({ connection: NOTION, tool: 'delete_page', input: {} })]))?.message).toMatch(/off or not added/)
    expect((await findCallToolProblems(db as never, OWNER, [action({ connection: NOTION, tool: 'append_block', input: { text: 'x' } })]))?.field).toBe('input')
    expect(await findCallToolProblems(db as never, OWNER, [action({ connection: NOTION, tool: 'append_block', input: { text: 'x' } }, false)])).toBeNull()
  })

  it('a skill step\'s connections must be the owner\'s', async () => {
    const skill = { type: 'run_skill' as const, config: { skill_id: 's', mode: 'act', connections: [NOTION] } as never, enabled: true }
    expect(await findCallToolProblems(db as never, OWNER, [skill])).toBeNull()
    expect((await findCallToolProblems(db as never, 'other', [skill]))?.field).toBe('connections')
  })
})
