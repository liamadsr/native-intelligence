/**
 * runDryTestFire (F1 test_flow): skill steps run as the caller in report mode
 * with nothing delivered and no cards; HTTP calls are rendered, never sent;
 * coding agents and archiving are described, not done; the sample is a real
 * entity / capture of the loop's workspace or a synthetic one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlowAction } from '../types'

const h = vi.hoisted(() => ({
  executorDeps: [] as Array<Record<string, unknown>>,
  skillCalls: [] as Array<{ action: FlowAction; ctx: Record<string, unknown> }>,
  entity: null as unknown,
  fetched: [] as string[],
}))

vi.mock('../run-skill', () => ({
  flowRunDeadlineMs: (startedAt: number, budget: number) => startedAt + budget - 30_000,
  createRunSkillExecutor: (deps: Record<string, unknown>) => {
    h.executorDeps.push(deps)
    return async (action: FlowAction, ctx: Record<string, unknown>) => {
      h.skillCalls.push({ action, ctx })
      return { status: 'success', request_summary: { method: 'SKILL', url: 'skill://x', header_names: [], body_byte_length: 0 }, response_status_code: 200, response_body_preview: 'the report', error_message: null, duration_ms: 5, output_document_id: null }
    }
  },
}))
vi.mock('@/lib/crypto/credentials', () => ({
  decryptCredentialOrNull: (v: string | null) => (v ? v.replace(/^enc:/, '') : null),
}))
vi.mock('../queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queries')>()),
  loadRunnerEntityData: async () => h.entity,
}))

import { dryRunFetch, dryRunSkillAction, runDryTestFire, SYNTH_ID } from '../test-fire'

const WS = 'ws-1'
const step = (over: Partial<FlowAction>): FlowAction =>
  ({ id: 'a', type: 'http_post', config: {}, condition: null, parent_id: null, enabled: true, bearer_token_encrypted: null, ...over }) as FlowAction
const skill = step({ id: 's', type: 'run_skill', config: { skill_id: '11111111-1111-4111-8111-111111111111', mode: 'act', deliver: { document: true, document_title: 'T' }, trust: { auto_apply: true, min_confidence: 0.5, allow_external: false, max_cards_per_run: 5 } } as never })
const http = step({ id: 'h', type: 'http_post', config: { method: 'POST', url: 'https://example.com/hook', headers: {}, body_template: '{"t":"{{entity.name}}"}' } as never, bearer_token_encrypted: 'enc:secret' })
const agent = step({ id: 'g', type: 'run_agent', config: { agent_id: '33333333-3333-4333-8333-333333333333', repo: 'acme/web', instructions: 'fix' } as never })
const archive = step({ id: 'x', type: 'archive_capture', config: {} as never })

function db(capture: Record<string, unknown> | null = null) {
  const chain: Record<string, unknown> = {}
  Object.assign(chain, { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: capture, error: null }) })
  return { from: () => chain } as never
}

beforeEach(() => {
  h.executorDeps.length = 0
  h.skillCalls.length = 0
  h.entity = null
  vi.stubGlobal('fetch', async (url: string) => {
    h.fetched.push(url)
    return new Response('real fetch!')
  })
})

describe('dryRunSkillAction', () => {
  it('report mode, nothing delivered, no auto-apply and no cards; the rest kept', () => {
    expect(dryRunSkillAction(skill).config).toEqual({
      skill_id: '11111111-1111-4111-8111-111111111111',
      mode: 'report',
      deliver: { document: false, notification: false, document_title: 'T' },
      trust: { auto_apply: false, min_confidence: 1, allow_external: false, max_cards_per_run: 0, outreach_draft_cards: false },
    })
  })
})

describe('dryRunFetch', () => {
  it('returns the request it would send (body only, never headers) and sends nothing', async () => {
    const res = await dryRunFetch('https://example.com/hook', { method: 'PUT', headers: { Authorization: 'Bearer s3cret' }, body: '{"a":1}' })
    const text = await res.text()
    expect(text).toContain('Test: not sent. It would PUT https://example.com/hook')
    expect(text).toContain('{"a":1}')
    expect(text).not.toContain('s3cret')
  })
})

describe('runDryTestFire', () => {
  it('a schedule loop: the skill runs as the CALLER, dry; the HTTP call is rendered not sent; agents and archives are described', async () => {
    const res = await runDryTestFire({
      supabase: db(),
      flow: { id: 'flow-1', workspace_id: WS, trigger_type: 'schedule', trigger_config: { kind: 'schedule' }, actions: [skill, http, agent, archive] },
      userId: 'caller',
      appBaseUrl: 'https://dial8.test',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // dryRun rides the run token: the skill-run tool route then runs no write at all.
    expect(h.executorDeps[0]).toMatchObject({ workspaceId: WS, runAsUserId: 'caller', flowId: 'flow-1', flowRunId: null, dryRun: true })
    expect((h.skillCalls[0].action.config as { mode: string }).mode).toBe('report')
    expect(h.fetched).toEqual([])
    const byId = Object.fromEntries(res.action_results.map((r) => [r.action_id, r]))
    expect(byId.s.response_body_preview).toBe('the report')
    expect(byId.h.response_body_preview).toContain('Test: not sent. It would POST https://example.com/hook')
    expect(byId.g).toMatchObject({ status: 'success', dispatched: false })
    expect(byId.g.response_body_preview).toContain('acme/web')
    expect(byId.x.response_body_preview).toContain('nothing archived')
    expect(res.sample).toBe('synthetic')
  })

  it('a Mac job is described, never started (a test starts nothing on anyone’s Mac)', async () => {
    const mac = step({ id: 'm', type: 'run_local_agent', config: { folder_id: '66666666-6666-4666-8666-666666666666', request: 'Check the build', mode: 'edit' } as never })
    const res = await runDryTestFire({
      supabase: db(),
      flow: { id: 'flow-1', workspace_id: WS, trigger_type: 'schedule', trigger_config: { kind: 'schedule' }, actions: [mac] },
      userId: 'caller',
      appBaseUrl: 'https://dial8.test',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.action_results[0]).toMatchObject({ status: 'success', dispatched: false, local_agent_session_id: null })
    expect(res.action_results[0].response_body_preview).toContain('Test: not started.')
    expect(res.action_results[0].response_body_preview).toContain('may edit')
  })

  it("the skill walls count from the request's start, not from here", async () => {
    await runDryTestFire({
      supabase: db(),
      flow: { id: 'flow-1', workspace_id: WS, trigger_type: 'schedule', trigger_config: {}, actions: [skill] },
      userId: 'caller',
      appBaseUrl: 'x',
      budgetMs: 300_000,
      startedAt: 1_000_000,
    })
    expect(h.executorDeps[0].deadlineMs).toBe(1_000_000 + 300_000 - 30_000)
  })

  it('a status loop with a sample entity of another workspace is refused', async () => {
    h.entity = { kind: 'action', id: 'act-9', workspace_id: 'ws-other' }
    const res = await runDryTestFire({
      supabase: db(),
      flow: { id: 'flow-1', workspace_id: WS, trigger_type: 'entity_status_change', trigger_config: { entity_type: 'action', to_status_id: 's2' }, actions: [http] },
      userId: 'caller',
      sample: { entity_id: 'act-9' },
      appBaseUrl: 'https://dial8.test',
    })
    expect(res).toMatchObject({ ok: false, field: 'sample.entity_id' })
  })

  it('a PR loop fires against the action with the state it waits for', async () => {
    h.entity = { kind: 'action', id: 'act-1', workspace_id: WS, title: 'Ship', status_id: 's', labels: [], assignees: [], label_ids: [], assignee_ids: [] }
    const res = await runDryTestFire({
      supabase: db(),
      flow: { id: 'flow-1', workspace_id: WS, trigger_type: 'pr_status_changed', trigger_config: { kind: 'pr_status_changed', repo_full_name: 'acme/web', to_state: 'closed' }, actions: [http] },
      userId: 'caller',
      sample: { entity_id: 'act-1' },
      appBaseUrl: 'https://dial8.test',
    })
    expect(res).toMatchObject({ ok: true, sample: 'real', trigger: { type: 'pr_status_changed', entity_type: 'action', to_status_id: 'closed' } })
  })

  it('a capture loop: a private sample capture is refused; none gives the synthetic capture', async () => {
    const flow = { id: 'flow-1', workspace_id: WS, trigger_type: 'capture_processed', trigger_config: { kind: 'capture_processed' }, actions: [skill] }
    const refused = await runDryTestFire({ supabase: db({ id: 'cap-1', title: 'Secret', visibility: 'private' }), flow, userId: 'caller', sample: { capture_id: 'cap-1' }, appBaseUrl: 'x' })
    expect(refused).toMatchObject({ ok: false, field: 'sample.capture_id' })
    await runDryTestFire({ supabase: db(), flow, userId: 'caller', appBaseUrl: 'x' })
    expect((h.skillCalls[0].ctx.capture as { id: string }).id).toBe(SYNTH_ID)
  })
})
