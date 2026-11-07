// Row 4 (docs/plans/agent-orchestration-product.md §1.4): a loop's ledger row
// names WHO ran it. The seeded Triage loop runs as the workspace's Triage
// system teammate; the seeded Commitment reconciler as the Reconciler; a
// user-built loop running a verdict skill is Triage's (bots v3 1a stopgap);
// any other user-built loop has no system teammate and stays its run-as member's.
// Bots v3 Phase 3: a loop names its own bot (flow.ai_team_member_id), which
// comes after the seed and before the verdict stopgap. The precedence itself is
// pinned against a fake database in system-teammates.test.ts (flowTeammateId);
// here the mock mirrors it so the dispatcher's wiring (the flow's column and the
// run-as member reach it) is observable.
//
// Drives the real capture_processed dispatcher body (the createFunction-capture
// pattern flow-functions.test.ts uses) with the recorder mocked, so the
// startWork input — the only place attribution is decided — is observable.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FlowAction } from '@/lib/flows/types'
import { createStepMock } from '@/test/inngest-step-mock'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (arg: unknown) => Promise<unknown>>(),
  flows: { value: [] as unknown[] },
  startWork: vi.fn(),
  teammateLookups: [] as Array<{ workspaceId: string; key: string }>,
  /** The `recipe` rows a skill read answers with (the verdict check). */
  recipes: [] as Array<{ agent_config: unknown }>,
  /** The bots the run-as member can reach (the column's re-check). */
  reachable: new Set<string>(),
  columnReads: [] as Array<{ column: string | null; runAsMemberId: string | null }>,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: { id: string }, handler: (arg: unknown) => Promise<unknown>) => {
      h.handlers.set(config.id, handler)
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => permissiveClient() }))
vi.mock('@/lib/flows/runner', () => ({
  runFlow: async () => ({ status: 'success', action_results: [] }),
  RESPONSE_BODY_PREVIEW_BYTES: 2000,
}))
vi.mock('@/lib/flows/run-skill', () => ({
  createRunSkillExecutor: () => async () => ({}),
  flowRunDeadlineMs: (startedAt: number) => startedAt + 255_000,
}))
vi.mock('@/lib/flows/run-agent', () => ({ createRunAgentExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/archive-capture', () => ({ createArchiveCaptureExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/queries', () => ({
  findMatchingFlowsForStatusChange: async () => [],
  findMatchingFlowsForCaptureProcessed: async () => h.flows.value,
  loadFlowForDispatch: async () => null,
  loadRunnerEntityData: async () => null,
}))
vi.mock('@/lib/notifications', () => ({ createNotification: async () => {} }))
vi.mock('@/lib/flows/run-as-member', () => ({ resolveRunAsMemberId: async () => 'member-owner' }))
vi.mock('@/lib/work/flow-results', () => ({ settleFlowWork: async () => {} }))
vi.mock('@/lib/work/recorder', () => ({
  startWork: (...args: unknown[]) => h.startWork(...args),
  inertWork: () => ({ inert: true, id: null, link: async () => {} }),
}))
vi.mock('@/lib/work/system-teammates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/work/system-teammates')>()
  return {
    ...actual,
    systemTeammateId: async (_client: unknown, workspaceId: string, key: string) => {
      h.teammateLookups.push({ workspaceId, key })
      return `tm-${key}-${workspaceId}`
    },
    // The real order (seed, column, verdict, none) over the mocked lookups, with
    // the area a seeded or verdict loop records (Captures', migration 318).
    flowAttribution: async (
      client: never,
      workspaceId: string,
      flow: { seed_key?: string | null; ai_team_member_id?: string | null; actions?: never },
      runAsMemberId: string | null,
    ) => {
      h.columnReads.push({ column: flow.ai_team_member_id ?? null, runAsMemberId })
      const lookup = (key: string) => {
        h.teammateLookups.push({ workspaceId, key })
        return `tm-${key}-${workspaceId}`
      }
      const seeded = actual.systemKeyForFlow(flow)
      if (seeded) return { teammateId: lookup(seeded), area: actual.areaOfKey(seeded) }
      const key = await actual.flowTeammateKey(client, workspaceId, { seed_key: null, actions: flow.actions })
      const area = key ? actual.areaOfKey(key) : null
      if (flow.ai_team_member_id && h.reachable.has(flow.ai_team_member_id)) return { teammateId: flow.ai_team_member_id, area }
      return { teammateId: key ? lookup(key) : null, area }
    },
  }
})

/** Every chain method returns the chain; maybeSingle is a visible capture; any
 *  await settles benignly. */
function permissiveClient() {
  const chain = (table: string) => {
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      in: () => b,
      or: () => b,
      is: () => b,
      update: () => b,
      insert: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: { visibility: 'workspace', title: 'Sync' }, error: null }),
      then: (resolve: (r: unknown) => unknown) =>
        Promise.resolve({ data: table === 'recipe' ? h.recipes : [], error: null }).then(resolve),
    })
    return b
  }
  return { from: (table: string) => chain(table) }
}

await import('../flow-functions')

const skillAction: FlowAction = {
  id: 'a1',
  type: 'run_skill',
  config: { skill_id: 's1', mode: 'act' } as unknown as FlowAction['config'],
  condition: null,
  parent_id: null,
  enabled: true,
  bearer_token_encrypted: null,
}
const loop = (id: string, seed_key: string | null, ai_team_member_id: string | null = null) => ({
  id,
  name: id,
  created_by: 'user-1',
  actions: [skillAction],
  seed_key,
  ai_team_member_id,
})

async function fire() {
  const handler = h.handlers.get('flow-dispatch-on-capture-processed')!
  return handler({
    event: { id: 'evt-1', data: { workspace_id: 'ws-1', capture_id: 'cap-1', processed_at: '2026-09-26T00:00:00Z' } },
    step: createStepMock(),
  })
}

beforeEach(() => {
  h.teammateLookups.length = 0
  h.columnReads.length = 0
  h.reachable = new Set()
  h.recipes = [{ agent_config: { output_contract: 'prose' } }]
  h.startWork.mockReset().mockImplementation(async () => ({ inert: false, id: 'job-1', link: async () => {} }))
})

describe('startFlowWork attribution', () => {
  it('stamps the seeded Triage and Commitment reconciler loops with Captures, and its area (migration 318)', async () => {
    h.flows.value = [loop('triage-flow', 'seed:triage'), loop('reconcile-flow', 'seed:reconcile')]
    expect(await fire()).toEqual({ dispatched: 2 })

    const inputs = h.startWork.mock.calls.map((c) => c[1] as Record<string, unknown>)
    expect(inputs.map((i) => [i.title, i.aiTeamMemberId, i.memberId, i.area])).toEqual([
      ['triage-flow', 'tm-captures-ws-1', 'member-owner', 'captures'],
      ['reconcile-flow', 'tm-captures-ws-1', 'member-owner', 'captures'],
    ])
    expect(h.teammateLookups).toEqual([
      { workspaceId: 'ws-1', key: 'captures' },
      { workspaceId: 'ws-1', key: 'captures' },
    ])
  })

  it('gives a user-built verdict loop (a triage you built) to Captures: the incident (bots v3 1a stopgap)', async () => {
    h.recipes = [{ agent_config: { output_contract: 'verdict' } }]
    h.flows.value = [loop('proposal-triage', null)]
    expect(await fire()).toEqual({ dispatched: 1 })

    const input = h.startWork.mock.calls[0][1] as Record<string, unknown>
    expect([input.title, input.aiTeamMemberId, input.memberId]).toEqual(['proposal-triage', 'tm-captures-ws-1', 'member-owner'])
    expect(h.teammateLookups).toEqual([{ workspaceId: 'ws-1', key: 'captures' }])
  })

  it('leaves a user-built prose loop (and Groom / Brief) unattributed, without a lookup', async () => {
    h.flows.value = [loop('my-flow', null), loop('groom-flow', 'seed:groom'), loop('brief-flow', 'seed:brief')]
    expect(await fire()).toEqual({ dispatched: 3 })

    const inputs = h.startWork.mock.calls.map((c) => c[1] as Record<string, unknown>)
    expect(inputs.map((i) => i.aiTeamMemberId)).toEqual([null, null, null])
    // Still owned by the run-as member — the ledger row exists either way.
    expect(inputs.every((i) => i.memberId === 'member-owner')).toBe(true)
    expect(h.teammateLookups).toEqual([])
  })

  it('names the loop\'s own bot (flow.ai_team_member_id), passing the run-as member for the reach check', async () => {
    h.recipes = [{ agent_config: { output_contract: 'verdict' } }]
    h.reachable = new Set(['ember-bot'])
    h.flows.value = [loop('weekly-brief', null, 'ember-bot')]
    expect(await fire()).toEqual({ dispatched: 1 })

    const input = h.startWork.mock.calls[0][1] as Record<string, unknown>
    expect([input.title, input.aiTeamMemberId, input.memberId]).toEqual(['weekly-brief', 'ember-bot', 'member-owner'])
    expect(h.columnReads).toEqual([{ column: 'ember-bot', runAsMemberId: 'member-owner' }])
    // The column wins over the verdict stopgap: no Triage lookup.
    expect(h.teammateLookups).toEqual([])
  })

  it('keeps a seeded loop on its system teammate whatever its column says', async () => {
    h.reachable = new Set(['ember-bot'])
    h.flows.value = [loop('triage-flow', 'seed:triage', 'ember-bot')]
    await fire()
    expect((h.startWork.mock.calls[0][1] as Record<string, unknown>).aiTeamMemberId).toBe('tm-captures-ws-1')
  })

  it('falls back to Triage for a verdict loop whose bot the run-as member can no longer reach', async () => {
    h.recipes = [{ agent_config: { output_contract: 'verdict' } }]
    h.flows.value = [loop('proposal-triage', null, 'private-bot')]
    await fire()
    expect((h.startWork.mock.calls[0][1] as Record<string, unknown>).aiTeamMemberId).toBe('tm-captures-ws-1')
  })
})
