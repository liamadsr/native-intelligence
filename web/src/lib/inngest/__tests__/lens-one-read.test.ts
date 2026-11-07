/**
 * The deterministic case for lens flows (F3, eve-alignment.md §6 decision 6's
 * amendment): Triage is on, a content lens and a marketing lens flow are on,
 * an external call the owner was on is processed. The dispatcher, the runner,
 * the skill executor, the assembly and the lens delivery are the real code;
 * only the model (runViaEve), the verdict's own apply walk and the doc edit
 * are stubbed. It checks:
 *   - ONE skill run reads the call (three flows on, one read);
 *   - that run's message carries both lens sections, in their stable order,
 *     after the triage task, and its schema asks for their sections;
 *   - each lens's section is routed by code: the content moment kept for the
 *     post pass, the marketing findings kept and the product doc batch sent
 *     as the lens flow's owner;
 *   - each lens flow gets its own run row, linked to the read it rode.
 * And when Triage is off, the lens flows fall back to their own runs, and a
 * lens whose condition fails is a skipped row with no model call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'
import { lensFakeDb } from '@/lib/flows/__tests__/lens-fake-db'
import type { FlowAction } from '@/lib/flows/types'

const TRIAGE_SKILL = '11111111-1111-4111-8111-111111111111'
const CONTENT_SKILL = '8ef0cb7e-6c81-4da5-9deb-a967dc16aa30'
const MARKETING_SKILL = 'b0a0af26-be52-493a-a2e4-ea0cb5b6cbbb'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (arg: unknown) => Promise<unknown>>(),
  db: null as unknown as { client: never; tables: Record<string, Array<Record<string, unknown>>> },
  flows: [] as unknown[],
  runViaEve: vi.fn(),
  applyVerdict: vi.fn(),
  deliverConnectorItems: vi.fn(),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: { id: string }, handler: (arg: unknown) => Promise<unknown>) => {
      h.handlers.set(config.id, handler)
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.db.client }))
vi.mock('@/lib/flows/queries', async (orig) => ({
  ...(await orig<typeof import('@/lib/flows/queries')>()),
  findMatchingFlowsForCaptureProcessed: async () => h.flows,
}))
vi.mock('@/lib/work/agent-paused', async (orig) => ({ ...(await orig<typeof import('@/lib/work/agent-paused')>()), checkAgentPaused: async () => false }))
vi.mock('@/lib/flows/run-as-member', () => ({ resolveRunAsMemberId: async () => null }))
vi.mock('@/lib/flows/run-skill-eve', async (orig) => ({ ...(await orig<typeof import('@/lib/flows/run-skill-eve')>()), runViaEve: h.runViaEve }))
vi.mock('@/lib/ai/system-prompt', () => ({ buildSystemPrompt: async () => 'BASE PROMPT' }))
vi.mock('@/lib/packs/background', () => ({ areasForSkillRun: () => [], backgroundExpertiseSection: async () => '' }))
vi.mock('@/lib/flows/context-pack', () => ({ buildContextPack: async () => '' }))
vi.mock('@/lib/proposed-changes/trust-policy', () => ({ resolveTrustPolicy: async () => ({ explicit: false }) }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: async () => {} }))
vi.mock('@/lib/flows/verdict-apply', async (orig) => ({ ...(await orig<typeof import('@/lib/flows/verdict-apply')>()), applyVerdict: h.applyVerdict }))
vi.mock('@/lib/flows/deliver-connector', () => ({ deliverConnectorItems: h.deliverConnectorItems }))
vi.mock('@/lib/documents/canon-doc', () => ({ resolveCanonDocument: async () => ({ ok: true, doc: { id: 'doc-1', content: '## Messaging\n' } }) }))
vi.mock('@/lib/work/touch', () => ({ recordVerdictTouches: async () => {} }))
vi.mock('@/lib/notifications', () => ({ createNotification: async () => {} }))

await import('../flow-functions')
const { runOutputSchema } = await import('@/lib/flows/run-skill-eve')
const { verdictOutputSchema } = await import('@/lib/flows/verdict-schema')

const step = createStepMock()

const skillStep = (id: string, skill: string): FlowAction => ({
  id,
  type: 'run_skill',
  config: { skill_id: skill, mode: 'act', deliver: { document: false } } as FlowAction['config'],
  condition: null,
  parent_id: null,
  enabled: true,
  bearer_token_encrypted: null,
})

const TRIAGE = { id: 'f-triage', name: 'Triage after every capture', created_by: 'u-liam', seed_key: 'seed:triage', actions: [skillStep('a-triage', TRIAGE_SKILL)] }
const CONTENT = { id: 'f-content', name: 'Post ideas from my calls', created_by: 'u-liam', seed_key: null, actions: [skillStep('a-content', CONTENT_SKILL)] }
const MARKETING = { id: 'f-mkt', name: 'Product doc from customer calls', created_by: 'u-liam', seed_key: null, actions: [skillStep('a-mkt', MARKETING_SKILL)] }

function seedDb(opts: { external?: boolean } = {}) {
  h.db = lensFakeDb({
    recipe: [
      { id: TRIAGE_SKILL, name: 'Proposal Triage', category: 'skill', system_prompt: 'Triage.', agent_config: { output_contract: 'verdict', enabled_tools: ['actions', 'captures'] } },
      { id: CONTENT_SKILL, name: 'Content lens', category: 'skill', system_prompt: 'Content lens.', agent_config: { lens: 'content', output_contract: 'prose', enabled_tools: ['captures'] } },
      { id: MARKETING_SKILL, name: 'Marketing lens', category: 'skill', system_prompt: 'Marketing lens.', agent_config: { lens: 'marketing', output_contract: 'prose', enabled_tools: ['captures'] } },
    ],
    captures: [
      {
        id: 'cap-1',
        workspace_id: 'ws-1',
        title: 'Acme sync',
        user_id: 'u-liam',
        visibility: 'workspace',
        transcript: '[local_0] We cut onboarding to one step and activation doubled.\n[remote_1] We have no time to set things up.',
      },
    ],
    capture_participant: opts.external === false
      ? []
      : [{ capture_id: 'cap-1', member_id: null, external_name: 'Dana Whitfield', external_email: 'dana@acme.com', contact_id: null, company: 'Acme', is_self: false }],
    member: [{ id: 'm-liam', workspace_id: 'ws-1', user_id: 'u-liam', display_name: 'Liam', role: 'owner' }],
  }) as never
}

const VERDICT = { decisions: [], needs_user: [], summary: 'Nothing new to file.' }
const LENSES = {
  content: { moments: [{ member_id: 'm-liam', text: 'We cut onboarding to one step and activation doubled.', theme: 'onboarding' }] },
  marketing: { items: [{ kind: 'objection', text: 'Worried about setup time', quote: 'we have no time to set things up' }] },
}

function eveResult(over: Record<string, unknown> = {}) {
  return {
    text: '',
    usage: { inputTokens: 1000, outputTokens: 200 },
    costUsd: null,
    webSearchCostUsd: null,
    toolCalls: 2,
    steps: 3,
    verdict: VERDICT,
    empty: false,
    lensOutput: LENSES,
    toolReads: [
      { tool: 'get_action_suggestions', outside: false },
      { tool: 'get_capture_content', outside: false },
      { tool: 'get_capture_transcript', outside: false },
    ],
    ...over,
  }
}

async function processCall() {
  const handler = h.handlers.get('flow-dispatch-on-capture-processed')!
  return handler({ event: { id: 'evt-1', data: { workspace_id: 'ws-1', capture_id: 'cap-1', processed_at: '2026-10-20T09:00:00Z', flow_eligible: true } }, step })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.RUN_SKILL_INTERNAL_SECRET = 'test-secret'
  h.applyVerdict.mockResolvedValue({ summary: 'Nothing new to file.', entries: [], cards_surfaced: 0, cards_overflow: 0, revoked_count: 0 })
  h.deliverConnectorItems.mockResolvedValue({ to: 'doc_proposals', delivered: 1, refused: [], summary: 'Updated Messaging in Product' })
})

describe('lens flows ride the ONE Triage read of a call', () => {
  it('three call flows on, one skill run: both lens sections ride it and are routed by code', async () => {
    seedDb()
    h.flows = [CONTENT, TRIAGE, MARKETING]
    h.runViaEve.mockResolvedValue(eveResult())

    const out = await processCall()

    // ONE read of the call.
    expect(h.runViaEve).toHaveBeenCalledTimes(1)
    const spec = h.runViaEve.mock.calls[0][0].spec
    expect(spec.skillId).toBe(TRIAGE_SKILL)
    expect(spec.lenses.map((r: { flowId: string }) => r.flowId)).toEqual(['f-content', 'f-mkt'])
    // The sections come after the triage task, content before marketing; the system prompt is the base.
    const msg: string = spec.userMessage
    expect(msg.indexOf('Run your skill now and carry the triage through')).toBeLessThan(msg.indexOf('## Lenses'))
    expect(msg.indexOf('### Lens: content')).toBeLessThan(msg.indexOf('### Lens: marketing'))
    expect(spec.systemPrompt).not.toContain('Lens')
    // Its schema asks for the verdict plus the two lens sections.
    const schema = runOutputSchema(spec)
    expect(schema).not.toBe(verdictOutputSchema)
    expect(schema!.safeParse({ decisions: [], summary: 'x', lenses: LENSES }).success).toBe(true)

    // Routed by code, as the lens flows' owner.
    const kept = h.db.tables.lens_finding
    expect(kept.map((r) => [r.lens, r.kind, r.member_id, r.flow_id])).toEqual([
      ['content', 'post_moment', 'm-liam', 'f-content'],
      ['marketing', 'objection', 'm-liam', 'f-mkt'],
    ])
    expect(h.deliverConnectorItems).toHaveBeenCalledTimes(1)
    expect(h.deliverConnectorItems.mock.calls[0][0]).toBe('doc_proposals')
    expect(h.deliverConnectorItems.mock.calls[0][2]).toMatchObject({ docKey: 'product', runAsUserId: 'u-liam', readOutside: false })

    // Each flow has its run row; the lens rows link to the read they rode.
    const runs = h.db.tables.flow_run
    const triageRun = runs.find((r) => r.flow_id === 'f-triage')!
    const lensRuns = runs.filter((r) => r.flow_id !== 'f-triage')
    expect(lensRuns.map((r) => [r.flow_id, r.status])).toEqual([
      ['f-content', 'success'],
      ['f-mkt', 'success'],
    ])
    for (const r of lensRuns) {
      expect((r.action_results as Array<{ rode_flow_run_id?: string }>)[0].rode_flow_run_id).toBe(triageRun.id)
    }
    expect(out).toMatchObject({ dispatched: 1, lenses_rode: 2 })
  })

  it('the triage itself is unchanged by the lenses: the same verdict is applied', async () => {
    seedDb()
    h.flows = [TRIAGE, CONTENT]
    h.runViaEve.mockResolvedValue(eveResult())
    await processCall()
    expect(h.applyVerdict).toHaveBeenCalledTimes(1)
    expect(h.applyVerdict.mock.calls[0][0]).toEqual(VERDICT)
  })

  it('an internal call: the marketing lens is a skipped row, the content lens still rides', async () => {
    seedDb({ external: false })
    h.flows = [TRIAGE, CONTENT, MARKETING]
    h.runViaEve.mockResolvedValue(eveResult({ lensOutput: { content: LENSES.content } }))
    await processCall()
    expect(h.runViaEve).toHaveBeenCalledTimes(1)
    expect(h.runViaEve.mock.calls[0][0].spec.lenses.map((r: { lens: string }) => r.lens)).toEqual(['content'])
    const mkt = h.db.tables.flow_run.find((r) => r.flow_id === 'f-mkt')!
    expect(mkt.response_body_preview).toBe('Skipped: not an external call')
  })

  it("Triage off: each lens flow runs its own read (the fallback), with its own section and schema", async () => {
    seedDb()
    h.flows = [CONTENT]
    h.runViaEve.mockResolvedValue(eveResult({ verdict: null, lensOutput: undefined, structured: LENSES.content }))
    await processCall()
    expect(h.runViaEve).toHaveBeenCalledTimes(1)
    const spec = h.runViaEve.mock.calls[0][0].spec
    expect(spec.lensRun.ride.flowId).toBe('f-content')
    expect(spec.userMessage).toContain('### Lens: content')
    expect(h.db.tables.lens_finding).toHaveLength(1)
  })

  it('Triage on with no lens flow: the run is exactly as before (no lens block, the plain verdict schema)', async () => {
    seedDb()
    h.flows = [TRIAGE]
    h.runViaEve.mockResolvedValue(eveResult({ lensOutput: undefined }))
    await processCall()
    const spec = h.runViaEve.mock.calls[0][0].spec
    expect(spec.lenses).toBeUndefined()
    // No plan step at all when only Triage is on (review N1).
    expect((step.run as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0])).not.toContain('plan-lenses')
    expect(spec.userMessage).not.toContain('## Lenses')
    expect(runOutputSchema(spec)).toBe(verdictOutputSchema)
  })

  it('a lens run nobody planned (Run now, any other door) is gated the same way (review S1)', async () => {
    const { createRunSkillExecutor } = await import('@/lib/flows/run-skill')
    const trigger = { type: 'capture_processed' as const, entity_type: null, from_status_id: null, to_status_id: null, fired_at: '2026-10-20T09:00:00Z' }
    const exec = createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'u-liam', flowId: 'f-mkt' })
    // No call: refused, no model call.
    seedDb()
    const noCall = await exec(MARKETING.actions[0], { entity: null, trigger, appBaseUrl: 'http://x', capture: null })
    expect(noCall).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/only runs after a call/) })
    // An internal call: the marketing lens's condition fails, no model call.
    seedDb({ external: false })
    const internal = await exec(MARKETING.actions[0], { entity: null, trigger, appBaseUrl: 'http://x', capture: { id: 'cap-1', title: 'Acme sync' } })
    expect(internal).toMatchObject({ status: 'success', response_body_preview: 'Skipped: not an external call' })
    expect(h.runViaEve).not.toHaveBeenCalled()
  })

  it("a Triage run that commits nothing: each lens flow's run says the lens got nothing", async () => {
    seedDb()
    h.flows = [TRIAGE, CONTENT]
    h.runViaEve.mockResolvedValue(eveResult({ verdict: null, lensOutput: undefined, empty: true }))
    await processCall()
    const lensRun = h.db.tables.flow_run.find((r) => r.flow_id === 'f-content')!
    expect(lensRun.status).toBe('failed')
    expect(lensRun.error_message).toMatch(/Triage committed no result/)
    expect(h.db.tables.lens_finding).toHaveLength(0)
  })
})
