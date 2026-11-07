/**
 * runFlow with F4 data passing and parking: each step's output reaches the
 * steps after it; a missing reference fails loudly; a parked step parks the
 * run ('pending') and every later step waits; a resume keeps what settled
 * and runs the waiting steps with the outputs so far; outside text marks the
 * run once a step brings it in.
 */
import { describe, expect, it, vi } from 'vitest'
import { runFlow, type CallToolExecutor, type RunSkillExecutor } from '../runner'
import type { FlowAction, TriggerContext } from '../types'

const trigger: TriggerContext = { type: 'capture_processed', entity_type: null, from_status_id: null, to_status_id: null, fired_at: '2026-10-20T10:00:00Z' }
const node = (id: string, type: FlowAction['type'], parent: string | null, config: Record<string, unknown>, extra: Partial<FlowAction> = {}): FlowAction =>
  ({ id, type, config, condition: null, parent_id: parent, enabled: true, bearer_token_encrypted: null, ...extra }) as FlowAction

const SKILL = '11111111-1111-4111-8111-111111111111'
const CONN = '22222222-2222-4222-8222-222222222222'
const ok = { request_summary: { method: 'X', url: 'x', header_names: [], body_byte_length: 0 }, response_status_code: 200, response_body_preview: null, error_message: null, duration_ms: 1 }

const actions = [
  node('summarise', 'run_skill', null, { skill_id: SKILL, mode: 'report' }),
  node('queue', 'call_tool', 'summarise', { connection: CONN, tool: 'create_draft', input: { content: '{{steps.summarise.output}}' } }),
  node('note', 'run_skill', 'queue', { skill_id: SKILL, mode: 'report', instructions: 'Saved as {{steps.queue.output}}' }),
]

describe('data passing', () => {
  it('each step sees the outputs of the steps before it, and outside text marks the run', async () => {
    const seen: Array<{ id: string; steps: unknown; readOutside: unknown }> = []
    const runSkill = vi.fn<RunSkillExecutor>(async (action, ctx) => {
      seen.push({ id: action.id, steps: ctx.steps, readOutside: ctx.readOutsideText })
      return { status: 'success', ...ok, step_output: `${action.id} out` }
    })
    const callTool = vi.fn<CallToolExecutor>(async (_action, ctx) => {
      seen.push({ id: 'queue', steps: ctx.steps, readOutside: ctx.readOutsideText })
      return { status: 'success', ...ok, step_output: 'd_1', read_outside_text: true }
    })
    const out = await runFlow({ actions }, null, trigger, 'https://dial8.ai', { executors: { run_skill: runSkill, call_tool: callTool }, extras: { workspaceId: 'ws' } })
    expect(out.status).toBe('success')
    expect(seen).toEqual([
      { id: 'summarise', steps: {}, readOutside: false },
      { id: 'queue', steps: { summarise: { output: 'summarise out' } }, readOutside: false },
      { id: 'note', steps: { summarise: { output: 'summarise out' }, queue: { output: 'd_1' } }, readOutside: true },
    ])
    expect(out.step_outputs).toEqual({ summarise: { output: 'summarise out' }, queue: { output: 'd_1' }, note: { output: 'note out' } })
    expect(out.read_outside_text).toBe(true)
    // Outputs never ride action_results (flow_run is readable by the whole workspace).
    expect(JSON.stringify(out.action_results)).not.toContain('summarise out')
  })

  it('a step whose referenced step was skipped fails loudly, saying which', async () => {
    const skipped = [
      node('summarise', 'run_skill', null, { skill_id: SKILL, mode: 'report' }, { condition: { match: 'all', rules: [{ field: 'label', op: 'is_set', value: null }] } }),
      node('note', 'run_skill', 'summarise', { skill_id: SKILL, mode: 'report', instructions: 'Use {{steps.summarise.output}}' }),
    ]
    const runSkill = vi.fn(async () => ({ status: 'success' as const, ...ok }))
    const out = await runFlow({ actions: skipped }, null, trigger, 'https://dial8.ai', { executors: { run_skill: runSkill } })
    expect(runSkill).not.toHaveBeenCalled()
    expect(out.status).toBe('failed')
    const note = out.action_results.find((r) => r.action_id === 'note')!
    expect(note.error_message).toContain('step "summarise" did not run before this one')
  })
})

describe('an empty output passes nothing on', () => {
  it('the step that uses it is skipped (not failed), and so is the step after it', async () => {
    const chain = [
      node('lens', 'run_skill', null, { skill_id: SKILL, mode: 'report' }),
      node('log', 'call_tool', 'lens', { connection: CONN, tool: 'append_block', input: { text: '{{steps.lens.output}}' } }),
      node('tell', 'run_skill', 'log', { skill_id: SKILL, mode: 'report', instructions: 'Logged: {{steps.log.output}}' }),
    ]
    const runSkill = vi.fn(async () => ({ status: 'success' as const, ...ok, step_output: '  ' }))
    const callTool = vi.fn()
    const out = await runFlow({ actions: chain }, null, trigger, 'https://dial8.ai', { executors: { run_skill: runSkill, call_tool: callTool as never } })
    expect(callTool).not.toHaveBeenCalled()
    expect(runSkill).toHaveBeenCalledTimes(1)
    expect(out.status).toBe('success')
    expect(out.action_results.slice(1).map((r) => [r.action_id, r.skipped, r.response_body_preview])).toEqual([
      ['log', true, 'Skipped: step "lens" passed nothing on'],
      ['tell', true, 'Skipped: step "log" passed nothing on'],
    ])
  })
})

describe('parking', () => {
  const parkedTool: CallToolExecutor = async () => ({
    status: 'pending', ...ok, response_body_preview: 'Waiting for your approval: Add to queue', parked: { approval_id: 'a1', card_id: 'c1', title: 'Add to queue' },
  })

  it('a parked step parks the run: status pending, later steps wait, nothing after it runs', async () => {
    const runSkill = vi.fn(async () => ({ status: 'success' as const, ...ok, step_output: 'summary' }))
    const out = await runFlow({ actions }, null, trigger, 'https://dial8.ai', { executors: { run_skill: runSkill, call_tool: parkedTool } })
    expect(out.status).toBe('pending')
    expect(out.parked).toEqual({ action_id: 'queue', approval_id: 'a1', card_id: 'c1', title: 'Add to queue' })
    expect(runSkill).toHaveBeenCalledTimes(1)
    expect(out.action_results.map((r) => [r.action_id, r.status, r.waiting === true])).toEqual([
      ['summarise', 'success', false],
      ['queue', 'pending', false],
      ['note', 'pending', true],
    ])
  })

  it('a resume keeps what settled, runs the waiting steps with the outputs so far', async () => {
    const runSkill = vi.fn(async (action: FlowAction, ctx: Parameters<RunSkillExecutor>[1]) => ({ status: 'success' as const, ...ok, step_output: `${action.id}:${JSON.stringify(ctx.steps)}` }))
    const first = await runFlow({ actions }, null, trigger, 'https://dial8.ai', { executors: { run_skill: runSkill as never, call_tool: parkedTool } })
    // The card was accepted: the parked step settled with the app's output.
    const settled = first.action_results.map((r) => (r.action_id === 'queue' ? { ...r, status: 'success' as const, parked: null } : r))
    const callTool = vi.fn()
    const out = await runFlow({ actions }, null, trigger, 'https://dial8.ai', {
      executors: { run_skill: runSkill as never, call_tool: callTool as never },
      resume: { results: settled, stepOutputs: { ...first.step_outputs, queue: { output: 'd_9' } }, readOutsideText: true },
    })
    expect(callTool).not.toHaveBeenCalled()
    expect(runSkill).toHaveBeenCalledTimes(2) // summarise (first run) + note (resume)
    expect(out.status).toBe('success')
    expect(out.parked).toBeNull()
    expect(out.step_outputs.note.output).toContain('"queue":{"output":"d_9"}')
    expect(out.read_outside_text).toBe(true)
    expect(out.action_results.find((r) => r.action_id === 'note')).toMatchObject({ status: 'success', skipped: false })
  })
})
