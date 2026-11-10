/**
 * The three F4 cases, end to end through the real pieces (runFlow, the
 * call_tool executor, the input-aware rule, the trust authority and the real
 * approval writer), over a fake database. Deterministic: no model, no network.
 *
 *   1. An unattended outward step PARKS as the owner's verified card.
 *   2. A post ALWAYS gets a card, even when the person made the tool
 *      approval-free (decision 2, whatever trust a flow earns).
 *   3. An inert draft (Typefully, no publish time) RUNS, and the run says so.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('use the injected client') } }))
vi.mock('@/lib/ai/tools', () => ({ createTools: () => ({}) }))
vi.mock('@/lib/flows/run-skill', () => ({ computeSkillCeiling: () => null }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: async () => ({ written: true }) }))
vi.mock('@/lib/agent-events/record', () => ({ recordAgentEvents: async () => 0 }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { createCallToolExecutor } from '../call-tool'
import { runFlow } from '../runner'
import type { FlowAction, TriggerContext } from '../types'

const OWNER = 'owner-1'
const WS = 'ws-1'
const TYPEFULLY = 'aaaaaaaa-0000-4000-8000-000000000001'
const NOTION = 'aaaaaaaa-0000-4000-8000-000000000002'
const RUN = '33333333-3333-4333-8333-333333333333'
const trigger: TriggerContext = { type: 'capture_processed', entity_type: null, from_status_id: null, to_status_id: null, fired_at: '2026-10-20T10:00:00Z' }
const step = (id: string, config: Record<string, unknown>): FlowAction =>
  ({ id, type: 'call_tool', config, condition: null, parent_id: null, enabled: true, bearer_token_encrypted: null }) as FlowAction

let db: FakeSupabase
const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'saved' }], isError: false }))

function run(actions: FlowAction[]) {
  return runFlow({ actions }, null, trigger, 'https://nativeintelligence.dev', {
    extras: { workspaceId: WS, capture: { id: 'cap-1', title: 'Acme call' } },
    executors: {
      call_tool: createCallToolExecutor({
        workspaceId: WS, runAsUserId: OWNER, flowId: 'flow-1', flowName: 'Posts', flowRunId: RUN,
        supabase: db as never, callTool: callTool as never, paused: async () => false,
      }),
    },
  })
}

beforeEach(() => {
  db = makeFakeSupabase()
  db.seed('member', [{ id: 'member-1', user_id: OWNER, workspace_id: WS }])
  db.seed('connected_mcp_server', [
    {
      id: TYPEFULLY, user_id: OWNER, display_name: 'Typefully', server_url: 'https://mcp.typefully.com/mcp', is_enabled: true,
      disabled_tools: [], allowed_tools: ['create_draft'], require_approval_tools: [],
      // The person made it approval-free: a post still asks (case 2).
      approval_free_tools: ['create_draft'],
      tools_cache: [{ name: 'create_draft', inputSchema: { type: 'object', properties: { content: { type: 'string' }, publish_at: { type: 'string' } }, required: ['content'] } }],
    },
    {
      id: NOTION, user_id: OWNER, display_name: 'Notion', server_url: 'https://mcp.notion.com/mcp', is_enabled: true,
      disabled_tools: [], allowed_tools: ['append_block'], require_approval_tools: [], approval_free_tools: [],
      tools_cache: [{ name: 'append_block', inputSchema: { type: 'object', properties: { page_id: { type: 'string' }, text: { type: 'string' } }, required: ['page_id', 'text'] } }],
    },
  ])
  callTool.mockClear()
})

describe('F4 cases', () => {
  it('1. an unattended outward step parks the run as the owner\'s verified card', async () => {
    const out = await run([step('log', { connection: NOTION, tool: 'append_block', input: { page_id: 'p1', text: 'Objections from {{trigger.capture.title}}' } })])
    expect(callTool).not.toHaveBeenCalled()
    expect(out.status).toBe('pending')
    const [approval] = db.rows('tool_approval')
    expect(approval).toMatchObject({ door: 'flow_step', user_id: OWNER, flow_run_id: RUN, status: 'pending', input: { page_id: 'p1', text: 'Objections from Acme call' } })
    const [card] = db.rows('attention_item')
    expect(card).toMatchObject({ kind: 'approval', member_id: 'member-1', status: 'pending', title: 'Run append_block on Notion?' })
    expect(out.parked).toMatchObject({ action_id: 'log', approval_id: approval.id, card_id: card.id })
  })

  it('2. a post always gets a card, even on a tool the person made approval-free', async () => {
    const out = await run([step('post', { connection: TYPEFULLY, tool: 'create_draft', input: { content: 'We shipped SSO', publish_at: 'next-free-slot' } })])
    expect(callTool).not.toHaveBeenCalled()
    expect(out.status).toBe('pending')
    expect(db.rows('attention_item')[0]).toMatchObject({ kind: 'approval', title: "Add to Typefully queue: next free slot: 'We shipped SSO'", payload: { public_content: true, editable: true } })
  })

  it('3. an inert draft runs, with no card, and the run says what it did', async () => {
    const out = await run([step('save', { connection: TYPEFULLY, tool: 'create_draft', input: { content: 'A draft from {{trigger.capture.title}}' } })])
    expect(callTool).toHaveBeenCalledExactlyOnceWith(db, TYPEFULLY, 'create_draft', { content: 'A draft from Acme call' }, OWNER)
    expect(db.rows('tool_approval')).toEqual([])
    expect(out.status).toBe('success')
    expect(out.action_results[0].delivered?.summary).toMatch(/Typefully draft with no publish time/)
  })
})
