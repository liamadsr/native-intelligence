/**
 * A riding lens flow's other steps (F4 + F3): they run once after its row,
 * with what the lens kept from this call as the lens step's output; a lens
 * that kept nothing passes nothing on; a lens flow with one step costs nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { runLensChildren } from '../lens-children'
import { lensFindingsText } from '../lens-runs'
import type { CallToolExecutor } from '../runner'
import type { ActionResult, FlowAction, TriggerContext } from '../types'

const RUN = '33333333-3333-4333-8333-333333333333'
const CONN = '22222222-2222-4222-8222-222222222222'
const trigger: TriggerContext = { type: 'capture_processed', entity_type: null, from_status_id: null, to_status_id: null, fired_at: '2026-10-20T10:00:00Z' }
const node = (id: string, type: FlowAction['type'], parent: string | null, config: Record<string, unknown>): FlowAction =>
  ({ id, type, config, condition: null, parent_id: parent, enabled: true, bearer_token_encrypted: null }) as FlowAction
const lensRow: ActionResult = {
  action_id: 'lens', condition_met: true, disabled: false, incomplete: false, skipped: false, status: 'success',
  request_summary: null, response_status_code: 200, response_body_preview: 'Kept 2 findings', error_message: null, duration_ms: 0,
}
const flow = {
  id: 'flow-1', created_by: 'owner',
  actions: [node('lens', 'run_skill', null, { skill_id: 's', mode: 'report' }), node('log', 'call_tool', 'lens', { connection: CONN, tool: 'append_block', input: { page_id: 'p', text: '{{steps.lens.output}}' } })],
}

let db: FakeSupabase
const seen: unknown[] = []
const callTool: CallToolExecutor = async (_a, ctx) => {
  seen.push(ctx.steps)
  return { status: 'pending', request_summary: { method: 'TOOL', url: 't', header_names: [], body_byte_length: 0 }, response_status_code: null, response_body_preview: 'Waiting', error_message: null, duration_ms: 0, parked: { approval_id: 'a1', card_id: 'c1', title: 'Run append_block on Notion?' } }
}
const args = () => ({ flow, flowRunId: RUN, lensRow, captureId: 'cap-1', workspaceId: 'ws-1', trigger, extras: { workspaceId: 'ws-1' }, fireId: 'fire-1', appBaseUrl: 'https://dial8.ai', executors: { call_tool: callTool }, readOutsideText: false })

beforeEach(() => {
  db = makeFakeSupabase()
  seen.length = 0
  db.seed('flow_run', [{ id: RUN, flow_id: 'flow-1', status: 'success', action_results: [lensRow] }])
})

describe('runLensChildren', () => {
  it('runs the steps after the lens with what it kept; a parked step parks the lens flow\'s own run', async () => {
    db.seed('lens_finding', [
      { flow_id: 'flow-1', capture_id: 'cap-1', kind: 'objection', body: { text: 'Price is too high for a 5-seat team', quote: 'we cannot justify that' } },
      { flow_id: 'flow-1', capture_id: 'cap-1', kind: 'competitor', body: { text: 'They trialled Granola' } },
      { flow_id: 'flow-1', capture_id: 'cap-other', kind: 'objection', body: { text: 'not this call' } },
    ])
    const out = await runLensChildren(db as never, args())
    expect(out).toEqual({ ran: true, status: 'pending' })
    expect(seen).toEqual([{ lens: { output: '- objection: Price is too high for a 5-seat team ("we cannot justify that")\n- competitor: They trialled Granola' } }])
    expect(db.rows('flow_run')[0]).toMatchObject({ status: 'pending' })
    expect(db.rows('flow_run_state')[0]).toMatchObject({ status: 'parked', approval_id: 'a1', parked_action_id: 'log' })
  })

  it('a lens that kept nothing passes nothing on: the step after it is skipped, nothing is called', async () => {
    const out = await runLensChildren(db as never, args())
    expect(out).toEqual({ ran: true, status: 'success' })
    expect(seen).toEqual([])
    const results = db.rows('flow_run')[0].action_results as ActionResult[]
    expect(results[1]).toMatchObject({ action_id: 'log', skipped: true, response_body_preview: 'Skipped: step "lens" passed nothing on' })
  })

  it('a lens flow with no other step does nothing more', async () => {
    expect(await runLensChildren(db as never, { ...args(), flow: { ...flow, actions: [flow.actions[0]] } })).toEqual({ ran: false })
    expect(db.rows('flow_run_state')).toEqual([])
  })

  it('lensFindingsText reads only this flow and this call', async () => {
    db.seed('lens_finding', [{ flow_id: 'flow-2', capture_id: 'cap-1', kind: 'objection', body: { text: 'other loop' } }])
    expect(await lensFindingsText(db as never, { flowId: 'flow-1', captureId: 'cap-1' })).toBe('')
    expect(await lensFindingsText(db as never, { flowId: 'flow-2', captureId: null })).toBe('')
  })
})

describe('S7: the host read\'s provenance reaches the lens\'s steps', () => {
  it('a host run that read outside text marks the lens flow\'s run, and its steps see it', async () => {
    db.seed('lens_finding', [{ flow_id: 'flow-1', capture_id: 'cap-1', kind: 'objection', body: { text: 'Too pricey' } }])
    let saw: unknown = null
    const tool: CallToolExecutor = async (_a, ctx) => {
      saw = ctx.readOutsideText
      return { status: 'success', request_summary: { method: 'TOOL', url: 't', header_names: [], body_byte_length: 0 }, response_status_code: null, response_body_preview: null, error_message: null, duration_ms: 0 }
    }
    await runLensChildren(db as never, { ...args(), executors: { call_tool: tool }, readOutsideText: true })
    expect(saw).toBe(true)
    expect(db.rows('flow_run_state')[0]).toMatchObject({ read_outside_text: true })
  })
})
