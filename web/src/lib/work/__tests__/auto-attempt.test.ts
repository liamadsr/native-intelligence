/**
 * The auto-attempt gate (Sequence step 3, B PR 3): its decision table — every
 * condition passing and failing in order — the reuse-before-budgets rule, the
 * budgets and the breaker, the fail-closed plan meter, the launch it performs
 * on a pass, the role teammates it creates on first need, and the attempter
 * factory: on by default, inert while either kill switch is thrown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase, type FakeSupabase, type Row } from './fake-supabase'
import {
  attemptFireKey,
  attemptWorkProposal,
  createWorkProposalAttempter,
  decideAutoAttempt,
  locateQuote,
  matchPiecesInOrder,
  normalizeForQuote,
  quotePieces,
  quotedSpans,
  transcriptForQuote,
  type AttemptCandidate,
  type AutoAttemptContext,
} from '../auto-attempt'
import { DEFAULT_AGENT_AUTONOMY_POLICY, type AgentAutonomyPolicy } from '../agent-autonomy-policy'
import { resetAgentRunMirrorCaches } from '../agent-run-mirror'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

const NOW = new Date('2026-09-26T15:00:00.000Z')
const TRANSCRIPT =
  'Okay so next steps. Can someone research how the Okta token exchange works with Salesforce before Thursday? ' +
  'I think we need a short brief on it.'

const ATTEMPT_POLICY: AgentAutonomyPolicy = {
  ...DEFAULT_AGENT_AUTONOMY_POLICY,
  mode: 'attempt',
  max_attempts_per_capture: 1,
  max_attempts_per_day: 5,
  role_breaker_window: 3,
}

function world(
  over: {
    teammates?: Row[]
    capture?: Partial<Row>
    limit?: { allowed: boolean; reason?: string } | 'error'
    /** What seed_role_teammates creates (default: nothing, as for a workspace with no team), or 'error'. */
    seedRoles?: Row[] | 'error'
  } = {},
) {
  // The seed stub writes into the fake it belongs to, like the RPC writes its rows.
  let self: FakeSupabase | null = null
  const fake = makeFakeSupabase({
    defaults: { actions: { identifier: 'GEN-9' }, agent_run: { origin: 'user', origin_depth: 0 } },
    unique: { agent_run: ['fire_key'] },
    rpc: {
      check_ai_usage_limit: () =>
        over.limit === 'error'
          ? { data: null, error: { message: 'rpc down' } }
          : { data: [over.limit ?? { allowed: true }], error: null },
      seed_role_teammates: () => {
        if (over.seedRoles === 'error') return { data: null, error: { message: 'seed failed' } }
        const rows = over.seedRoles ?? []
        if (rows.length > 0) self!.seed('ai_team_member', rows)
        return { data: rows.length, error: null }
      },
    },
  })
  self = fake
  fake.seed('ai_team_member', over.teammates ?? [
    { id: 'tm-res', workspace_id: 'ws-1', role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-01-01' },
  ])
  fake.seed('captures', [{ id: 'cap-1', workspace_id: 'ws-1', visibility: 'workspace', transcript: TRANSCRIPT, ...over.capture }])
  fake.seed('proposed_change', [
    { id: 'p-1', workspace_id: 'ws-1', capture_id: 'cap-1', trigger_quote: 'research how the Okta token exchange works', status: 'pending' },
  ])
  fake.seed('member', [{ id: 'mem-1', workspace_id: 'ws-1', user_id: 'user-1' }])
  fake.seed('team', [{ id: 'team-1', workspace_id: 'ws-1', created_at: '2026-01-01' }])
  fake.seed('workflow_state', [{ id: 'state-todo', team_id: 'team-1', is_default: true }])
  return fake
}

function ctx(fake: FakeSupabase, over: Partial<AutoAttemptContext> = {}): AutoAttemptContext {
  return {
    supabase: fake as unknown as SupabaseClient,
    workspaceId: 'ws-1',
    userId: 'user-1',
    mode: 'act',
    fireDepth: 1,
    captureId: 'cap-1',
    flowId: 'flow-triage',
    minConfidence: 0.85,
    policy: ATTEMPT_POLICY,
    env: { AGENT_AUTO_ATTEMPT_ENABLED: 'true' },
    now: NOW,
    ...over,
  }
}

/** A proposal-less item grounded by a transcript quote in its `why`. */
function looseItem(over: Partial<AttemptCandidate> = {}, payload: Record<string, unknown> = {}): AttemptCandidate {
  return {
    proposalId: null,
    cardId: '11111111-1111-5111-8111-111111111111',
    title: 'Research the Okta token exchange',
    why: 'Liam asked: "Can someone research how the Okta token exchange works with Salesforce" — a brief is the ask.',
    payload: {
      task: 'Research how the Okta-to-Salesforce token exchange works and write a one-page brief.',
      role: 'researcher',
      expects: [{ type: 'document', min: 1 }],
      ...payload,
    },
    confidence: 0.9,
    ...over,
  }
}

/** A proposal-backed item. */
function proposalItem(payload: Record<string, unknown> = {}): AttemptCandidate {
  return looseItem({ proposalId: 'p-1', cardId: null, why: 'It is explicitly yours.' }, payload)
}

beforeEach(() => resetAgentRunMirrorCaches())

describe('decideAutoAttempt — the decision table, in order', () => {
  it('PASSES a grounded, draftable item with a teammate, budget and plan (proposal-less and proposal-backed)', async () => {
    const loose = await decideAutoAttempt(looseItem(), ctx(world()))
    expect(loose).toEqual({
      attempt: true,
      reused: false,
      fireKey: 'attempt:11111111-1111-5111-8111-111111111111',
      teammate: { id: 'tm-res', role: 'researcher' },
      captureId: 'cap-1',
      // B PR 4: the quote that grounded it rides to the run's brief, as written.
      quote: 'Can someone research how the Okta token exchange works with Salesforce',
    })
    const backed = await decideAutoAttempt(proposalItem(), ctx(world()))
    expect(backed).toMatchObject({ attempt: true, fireKey: 'attempt:p-1', captureId: 'cap-1', quote: 'research how the Okta token exchange works' })
  })

  it('env kill switch exactly "false" → env_off, and NOTHING is read', async () => {
    const fake = world()
    expect(await decideAutoAttempt(looseItem(), ctx(fake, { env: { AGENT_AUTO_ATTEMPT_ENABLED: 'false' } }))).toMatchObject({ attempt: false, reason: 'env_off' })
    expect(fake.calls).toHaveLength(0)
    expect(fake.rpcCalls).toHaveLength(0)
  })

  it('the env switch is ON by default: unset, or anything but "false", attempts', async () => {
    for (const env of [{}, { AGENT_AUTO_ATTEMPT_ENABLED: '' }, { AGENT_AUTO_ATTEMPT_ENABLED: 'true' }, { AGENT_AUTO_ATTEMPT_ENABLED: '1' }]) {
      expect(await decideAutoAttempt(looseItem(), ctx(world(), { env }))).toMatchObject({ attempt: true })
    }
  })

  it('workspace not in attempt mode → mode_not_attempt (propose and off), nothing read', async () => {
    const fake = world()
    for (const mode of ['propose', 'off'] as const) {
      const d = await decideAutoAttempt(looseItem(), ctx(fake, { policy: { ...ATTEMPT_POLICY, mode } }))
      expect(d).toMatchObject({ reason: 'mode_not_attempt' })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('a report-mode verdict never attempts', async () => {
    expect(await decideAutoAttempt(looseItem(), ctx(world(), { mode: 'report' }))).toMatchObject({ reason: 'report_mode' })
  })

  it.each([
    [{ role: undefined }, 'no_role'],
    [{ role: 'clerk' }, 'no_role'],
    [{ role: 'developer', expects: [{ type: 'entity', entity_type: 'pr', min: 1 }] }, 'role_not_attemptable'],
    [{ expects: undefined }, 'no_expects'],
    [{ expects: [{ type: 'nonsense' }] }, 'no_expects'],
    [{ expects: [{ type: 'action', min: 1 }] }, 'expects_not_draftable'],
    [{ expects: [{ type: 'document' }, { type: 'entity', entity_type: 'contact' }] }, 'expects_not_draftable'],
    [{ deliverable_hint: 'board_update' }, 'hint_not_draftable'],
    [{ deliverable_hint: 'mixed' }, 'hint_not_draftable'],
  ])('shape %j → %s', async (payload, reason) => {
    const d = await decideAutoAttempt(looseItem({}, payload as Record<string, unknown>), ctx(world()))
    expect(d).toMatchObject({ attempt: false, reason })
  })

  it('draftable hints and email work pass the shape check', async () => {
    const fake = world({
      teammates: [{ id: 'tm-corr', workspace_id: 'ws-1', role: 'correspondent', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-01-01' }],
    })
    const d = await decideAutoAttempt(
      looseItem({}, { role: 'correspondent', expects: [{ type: 'email_draft', min: 1 }], deliverable_hint: 'email_draft' }),
      ctx(fake),
    )
    expect(d).toMatchObject({ attempt: true, teammate: { id: 'tm-corr', role: 'correspondent' } })
  })

  it('no idempotency key (no proposal, no run key) → no_idempotency_key', async () => {
    expect(await decideAutoAttempt(looseItem({ cardId: null }), ctx(world()))).toMatchObject({ reason: 'no_idempotency_key' })
  })

  it('an existing run for the key is REUSED before depth, confidence, budgets and breaker (a retry never falls back to a card)', async () => {
    const fake = world()
    fake.seed('agent_run', [{ id: 'run-prev', workspace_id: 'ws-1', fire_key: 'attempt:p-1', origin: 'attempt', resources: [{ type: 'capture', id: 'cap-1', label: 'x' }] }])
    // Budget spent (by that very run), depth and confidence would all refuse:
    const d = await decideAutoAttempt(proposalItem(), ctx(fake, { fireDepth: 2, minConfidence: 0.99 }))
    expect(d).toEqual({ attempt: true, reused: true, fireKey: 'attempt:p-1', agentRunId: 'run-prev' })
  })

  it('no flow on the verdict → no_flow (an attempted run records its flow as origin; agent_run_has_origin)', async () => {
    expect(await decideAutoAttempt(looseItem(), ctx(world(), { flowId: null }))).toMatchObject({ reason: 'no_flow' })
  })

  it('a verdict that is not first-hop (depth ≠ 1) → fire_depth', async () => {
    for (const fireDepth of [0, 2, 3]) {
      expect(await decideAutoAttempt(looseItem(), ctx(world(), { fireDepth }))).toMatchObject({ reason: 'fire_depth' })
    }
  })

  it('below the trust floor → below_confidence (the floor itself passes)', async () => {
    expect(await decideAutoAttempt(looseItem({ confidence: 0.84 }), ctx(world()))).toMatchObject({ reason: 'below_confidence' })
    expect(await decideAutoAttempt(looseItem({ confidence: 0.85 }), ctx(world()))).toMatchObject({ attempt: true })
  })

  it('the workspace’s attempt bar replaces the trust floor for attempts', async () => {
    const lowered = { ...ATTEMPT_POLICY, attempt_min_confidence: 0.6 }
    expect(await decideAutoAttempt(looseItem({ confidence: 0.6 }), ctx(world(), { policy: lowered }))).toMatchObject({ attempt: true })
    expect(await decideAutoAttempt(looseItem({ confidence: 0.59 }), ctx(world(), { policy: lowered }))).toMatchObject({
      reason: 'below_confidence',
      detail: '0.59 < 0.6',
    })
    // A raised bar refuses what the flow's floor would pass.
    const raised = { ...ATTEMPT_POLICY, attempt_min_confidence: 0.95 }
    expect(await decideAutoAttempt(looseItem({ confidence: 0.9 }), ctx(world(), { policy: raised }))).toMatchObject({ reason: 'below_confidence' })
  })

  it('teammates: none for the role / none attempting / none allowed to draft', async () => {
    // No team to seed into (the RPC creates nothing) → still no teammate.
    expect(await decideAutoAttempt(looseItem(), ctx(world({ teammates: [] })))).toMatchObject({ reason: 'no_teammate' })
    const proposeOnly = world({ teammates: [{ id: 't', workspace_id: 'ws-1', role: 'researcher', autonomy: 'propose', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-01-01' }] })
    expect(await decideAutoAttempt(looseItem(), ctx(proposeOnly))).toMatchObject({ reason: 'teammate_not_attempt' })
    const readOnly = world({ teammates: [{ id: 't', workspace_id: 'ws-1', role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read'], created_at: '2026-01-01' }] })
    expect(await decideAutoAttempt(looseItem(), ctx(readOnly))).toMatchObject({ reason: 'teammate_cannot_draft' })
    const otherWorkspace = world({ teammates: [{ id: 't', workspace_id: 'ws-OTHER', role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-01-01' }] })
    expect(await decideAutoAttempt(looseItem(), ctx(otherWorkspace))).toMatchObject({ reason: 'no_teammate' })
  })

  it('a workspace with no role teammates gets them on first need, as the verdict\'s user, and the role is routed again', async () => {
    const fake = world({
      teammates: [],
      seedRoles: [
        { id: 'tm-seeded-res', workspace_id: 'ws-1', role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-09-26' },
        { id: 'tm-seeded-dev', workspace_id: 'ws-1', role: 'developer', autonomy: 'propose', allowed_side_effects: ['read'], created_at: '2026-09-26' },
      ],
    })
    expect(await decideAutoAttempt(looseItem(), ctx(fake))).toMatchObject({ attempt: true, teammate: { id: 'tm-seeded-res', role: 'researcher' } })
    expect(fake.rpcCalls.filter((c) => c.fn === 'seed_role_teammates')).toEqual([
      { fn: 'seed_role_teammates', args: { p_workspace_id: 'ws-1', p_created_by: 'user-1' } },
    ])
    // Now they exist: the next decision seeds nothing.
    await decideAutoAttempt(looseItem({ cardId: '22222222-2222-5222-8222-222222222222' }), ctx(fake))
    expect(fake.rpcCalls.filter((c) => c.fn === 'seed_role_teammates')).toHaveLength(1)
  })

  it('a workspace that has role teammates but none for this role is NOT seeded (a removed role stays removed)', async () => {
    const fake = world({
      teammates: [{ id: 'tm-writer', workspace_id: 'ws-1', role: 'writer', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-01-01' }],
      seedRoles: [{ id: 'tm-would-be', workspace_id: 'ws-1', role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-09-26' }],
    })
    expect(await decideAutoAttempt(looseItem(), ctx(fake))).toMatchObject({ attempt: false, reason: 'no_teammate' })
    expect(fake.rpcCalls.filter((c) => c.fn === 'seed_role_teammates')).toHaveLength(0)
  })

  it('a failed seed refuses (read_failed) and starts nothing', async () => {
    expect(await decideAutoAttempt(looseItem(), ctx(world({ teammates: [], seedRoles: 'error' })))).toMatchObject({ attempt: false, reason: 'read_failed', detail: 'seed failed' })
  })

  it('the oldest attempting, drafting teammate of the role is chosen', async () => {
    const fake = world({
      teammates: [
        { id: 'tm-old-propose', workspace_id: 'ws-1', role: 'researcher', autonomy: 'propose', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-01-01' },
        { id: 'tm-new', workspace_id: 'ws-1', role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-03-01' },
        { id: 'tm-mid', workspace_id: 'ws-1', role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-02-01' },
      ],
    })
    expect(await decideAutoAttempt(looseItem(), ctx(fake))).toMatchObject({ teammate: { id: 'tm-mid' } })
  })

  describe('grounded provenance', () => {
    it('proposal-less: no capture on the fire, no quote, a short quote, a quote not in the transcript → ungrounded', async () => {
      expect(await decideAutoAttempt(looseItem(), ctx(world(), { captureId: null }))).toMatchObject({ reason: 'ungrounded' })
      expect(await decideAutoAttempt(looseItem({ why: 'No quote at all.' }), ctx(world()))).toMatchObject({ reason: 'ungrounded' })
      expect(await decideAutoAttempt(looseItem({ why: 'He said "next steps".' }), ctx(world()))).toMatchObject({ reason: 'ungrounded' })
      expect(await decideAutoAttempt(looseItem({ why: 'She said "please book the offsite venue for March".' }), ctx(world()))).toMatchObject({
        reason: 'ungrounded',
        detail: 'quote not found in the transcript',
      })
    })

    it('proposal-less: a curly-quoted span with different case and punctuation still matches', async () => {
      const why = 'Asked in the call: “CAN SOMEONE research how the Okta token-exchange works…”'
      expect(await decideAutoAttempt(looseItem({ why }), ctx(world()))).toMatchObject({ attempt: true })
    })

    it('a private capture is never attempted from (either path)', async () => {
      const fake = world({ capture: { visibility: 'private' } })
      expect(await decideAutoAttempt(looseItem(), ctx(fake))).toMatchObject({ reason: 'private_capture' })
      expect(await decideAutoAttempt(proposalItem(), ctx(fake))).toMatchObject({ reason: 'private_capture' })
    })

    it('a capture in another workspace does not ground', async () => {
      expect(await decideAutoAttempt(looseItem(), ctx(world({ capture: { workspace_id: 'ws-OTHER' } })))).toMatchObject({ reason: 'ungrounded' })
    })

    it('proposal-backed: missing or dismissed → ungrounded; no quote anywhere, or a trigger quote the transcript does not contain → ungrounded', async () => {
      const missing = world()
      missing.rows('proposed_change').splice(0)
      expect(await decideAutoAttempt(proposalItem(), ctx(missing))).toMatchObject({ reason: 'ungrounded' })
      const dismissed = world()
      dismissed.rows('proposed_change')[0].status = 'dismissed'
      expect(await decideAutoAttempt(proposalItem(), ctx(dismissed))).toMatchObject({ reason: 'ungrounded' })
      const noQuote = world()
      noQuote.rows('proposed_change')[0].trigger_quote = '  '
      expect(await decideAutoAttempt(proposalItem(), ctx(noQuote))).toMatchObject({ reason: 'ungrounded', detail: 'no transcript quote' })
      const invented = world()
      invented.rows('proposed_change')[0].trigger_quote = 'we agreed to book the offsite venue for March'
      expect(await decideAutoAttempt(proposalItem(), ctx(invented))).toMatchObject({ reason: 'ungrounded', detail: 'quote not found in the transcript' })
    })

    it('proposal-backed: transcript-quote grounding ONLY — its trigger quote in the transcript passes with no is_mine_explicit signal at all', async () => {
      expect(await decideAutoAttempt(proposalItem(), ctx(world()))).toMatchObject({ attempt: true, fireKey: 'attempt:p-1' })
    })

    it('proposal-backed: a quote in the item\'s why grounds it when the proposal has none', async () => {
      const fake = world()
      fake.rows('proposed_change')[0].trigger_quote = null
      const item = { ...proposalItem(), why: 'Said: "I think we need a short brief on it"' }
      expect(await decideAutoAttempt(item, ctx(fake))).toMatchObject({ attempt: true })
    })

    it('proposal-backed grounds on the PROPOSAL\'s capture, even on a fire with none', async () => {
      expect(await decideAutoAttempt(proposalItem(), ctx(world(), { captureId: null }))).toMatchObject({ attempt: true, captureId: 'cap-1' })
    })

    // A recorded capture's transcript opens every turn with a speaker label.
    const LABELLED =
      '[remote_2] except if you can give me some heads up about the next meeting\n' +
      "[local_1] I can I can provide you agent so it's basically the\n" +
      '[local_1]: um middleware team that is working on the integration\n' +
      '[Me] into the US iPaaS for UserCube\n' +
      '[remote_2] great, send it over before Thursday'
    const labelled = (triggerQuote: string) => {
      const fake = world({ capture: { transcript: LABELLED } })
      fake.rows('proposed_change')[0].trigger_quote = triggerQuote
      return fake
    }

    it('a quote that runs across a change of speaker grounds: the speaker labels are not speech ([local_1], [remote_2], [Me], with or without a colon)', async () => {
      const quote = "provide you agent so it's basically the um middleware team that is working on the integration into the US iPaaS"
      expect(await decideAutoAttempt(proposalItem(), ctx(labelled(quote)))).toMatchObject({ attempt: true, quote })
      // …and a label's own text is not something anyone said.
      expect(await decideAutoAttempt(proposalItem(), ctx(labelled('basically the local 1 um middleware team')))).toMatchObject({
        reason: 'ungrounded',
        detail: 'quote not found in the transcript',
      })
    })

    it('an elided quote grounds when its pieces appear in order; out of order or with a piece missing it does not', async () => {
      const inOrder = 'give me some heads up about the next meeting... I can I can provide you agent … the US iPaaS for UserCube'
      expect(await decideAutoAttempt(proposalItem(), ctx(labelled(inOrder)))).toMatchObject({ attempt: true, quote: inOrder })
      expect(await decideAutoAttempt(proposalItem(), ctx(labelled('I can I can provide you agent. . . heads up about the next meeting')))).toMatchObject({
        reason: 'ungrounded',
        detail: 'quote not found in the transcript',
      })
      expect(await decideAutoAttempt(proposalItem(), ctx(labelled('I can I can provide you agent... we will book the offsite venue')))).toMatchObject({
        reason: 'ungrounded',
        detail: 'quote not found in the transcript',
      })
    })

    it('a piece under 12 characters is not matched, and the pieces kept must still reach 16', async () => {
      // "so yes" and "by Friday" were never said; they are too short to count either way.
      expect(await decideAutoAttempt(proposalItem(), ctx(labelled('so yes... send it over before Thursday... by Friday')))).toMatchObject({ attempt: true })
      // Kept pieces of 12 and 13 characters would reach 16 together, but "send it over" alone (12) does not.
      expect(await decideAutoAttempt(proposalItem(), ctx(labelled('okay... send it over... sure')))).toMatchObject({ reason: 'ungrounded', detail: 'no transcript quote' })
    })

    it('a paraphrase still does not ground (no fuzzy matching): the transcript heard "agent", the quote says "agenda"', async () => {
      expect(await decideAutoAttempt(proposalItem(), ctx(labelled('I can I can provide you agenda')))).toMatchObject({
        reason: 'ungrounded',
        detail: 'quote not found in the transcript',
      })
    })

    it('an elided quote in the item\'s why grounds a proposal-less item the same way', async () => {
      const why = 'Asked for it: "some heads up about the next meeting ... provide you agent so it\'s basically the"'
      const fake = world({ capture: { transcript: LABELLED } })
      expect(await decideAutoAttempt(looseItem({ why }), ctx(fake))).toMatchObject({ attempt: true })
    })
  })

  describe('budgets', () => {
    it('per capture: an attempt already started from this capture spends the budget (1)', async () => {
      const fake = world()
      fake.seed('agent_run', [{ id: 'r0', workspace_id: 'ws-1', origin: 'attempt', created_at: '2026-09-20T00:00:00Z', resources: [{ type: 'capture', id: 'cap-1', label: 'x' }] }])
      expect(await decideAutoAttempt(looseItem(), ctx(fake))).toMatchObject({ reason: 'capture_budget', detail: '1/1' })
    })

    it('per capture counts only attempted runs of this workspace from this capture', async () => {
      const fake = world()
      fake.seed('agent_run', [
        { id: 'r-user', workspace_id: 'ws-1', origin: 'user', resources: [{ type: 'capture', id: 'cap-1', label: 'x' }] },
        { id: 'r-other-cap', workspace_id: 'ws-1', origin: 'attempt', created_at: '2026-09-20T00:00:00Z', resources: [{ type: 'capture', id: 'cap-2', label: 'x' }] },
        { id: 'r-other-ws', workspace_id: 'ws-OTHER', origin: 'attempt', resources: [{ type: 'capture', id: 'cap-1', label: 'x' }] },
      ])
      expect(await decideAutoAttempt(looseItem(), ctx(fake))).toMatchObject({ attempt: true })
    })

    it('per day: today\'s attempted runs (UTC) spend the daily budget; yesterday\'s do not', async () => {
      const fake = world()
      const today = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, workspace_id: 'ws-1', origin: 'attempt', created_at: `2026-09-26T0${i}:00:00.000Z`, resources: [] }))
      fake.seed('agent_run', today)
      expect(await decideAutoAttempt(looseItem(), ctx(fake))).toMatchObject({ reason: 'day_budget', detail: '5/5' })
      const yesterday = world()
      yesterday.seed('agent_run', today.map((r) => ({ ...r, created_at: r.created_at.replace('09-26', '09-25') })))
      expect(await decideAutoAttempt(looseItem(), ctx(yesterday))).toMatchObject({ attempt: true })
    })

    it('a zero budget means never', async () => {
      expect(await decideAutoAttempt(looseItem(), ctx(world(), { policy: { ...ATTEMPT_POLICY, max_attempts_per_capture: 0 } }))).toMatchObject({ reason: 'capture_budget' })
      expect(await decideAutoAttempt(looseItem(), ctx(world(), { policy: { ...ATTEMPT_POLICY, max_attempts_per_day: 0 } }))).toMatchObject({ reason: 'day_budget' })
    })
  })

  describe('the role breaker', () => {
    const job = (i: number, review: string | undefined, over: Row = {}) => ({
      id: `j${i}`,
      workspace_id: 'ws-1',
      origin: 'attempt',
      ai_team_member_id: 'tm-res',
      created_at: `2026-09-2${i}T10:00:00.000Z`,
      progress: review ? { review } : {},
      ...over,
    })

    it('opens when the last N attempted items of the role (this week) were ALL dismissed', async () => {
      const fake = world()
      fake.seed('tracked_job', [job(3, 'dismissed'), job(4, 'dismissed'), job(5, 'dismissed')])
      expect(await decideAutoAttempt(looseItem(), ctx(fake))).toMatchObject({ reason: 'breaker_open' })
    })

    it('stays closed with one reviewed or still-pending item among the last N, with fewer than N, or when older than the quiet period', async () => {
      const mixed = world()
      mixed.seed('tracked_job', [job(2, 'dismissed'), job(3, 'dismissed'), job(4, 'reviewed'), job(5, 'dismissed')])
      expect(await decideAutoAttempt(looseItem(), ctx(mixed))).toMatchObject({ attempt: true })
      const pending = world()
      pending.seed('tracked_job', [job(3, 'dismissed'), job(4, 'dismissed'), job(5, undefined)])
      expect(await decideAutoAttempt(looseItem(), ctx(pending))).toMatchObject({ attempt: true })
      const few = world()
      few.seed('tracked_job', [job(4, 'dismissed'), job(5, 'dismissed')])
      expect(await decideAutoAttempt(looseItem(), ctx(few))).toMatchObject({ attempt: true })
      const stale = world()
      stale.seed('tracked_job', [1, 2, 3].map((i) => job(i, 'dismissed', { created_at: `2026-09-1${i}T10:00:00.000Z` })))
      expect(await decideAutoAttempt(looseItem(), ctx(stale))).toMatchObject({ attempt: true })
    })

    it('the quiet period comes from the policy blob (a 1-day period ignores last week)', async () => {
      const fake = world()
      fake.seed('tracked_job', [job(3, 'dismissed'), job(4, 'dismissed'), job(5, 'dismissed')])
      expect(await decideAutoAttempt(looseItem(), ctx(fake, { policy: { ...ATTEMPT_POLICY, role_breaker_quiet_days: 1 } }))).toMatchObject({ attempt: true })
    })

    it('a manual resume for the role (policy blob) resets it at once; another role\'s resume does not', async () => {
      const open = () => {
        const fake = world()
        fake.seed('tracked_job', [job(3, 'dismissed'), job(4, 'dismissed'), job(5, 'dismissed')])
        return fake
      }
      const resumed = { ...ATTEMPT_POLICY, role_breaker_resumed_at: { researcher: '2026-09-26T00:00:00.000Z' } }
      expect(await decideAutoAttempt(looseItem(), ctx(open(), { policy: resumed }))).toMatchObject({ attempt: true })
      const otherRole = { ...ATTEMPT_POLICY, role_breaker_resumed_at: { writer: '2026-09-26T00:00:00.000Z' } }
      expect(await decideAutoAttempt(looseItem(), ctx(open(), { policy: otherRole }))).toMatchObject({ reason: 'breaker_open' })
    })

    it('counts only the role\'s teammates and only attempted rows; window 0 disables it', async () => {
      const fake = world()
      fake.seed('tracked_job', [
        job(3, 'dismissed', { ai_team_member_id: 'tm-writer' }),
        job(4, 'dismissed', { origin: 'user' }),
        job(5, 'dismissed'),
      ])
      expect(await decideAutoAttempt(looseItem(), ctx(fake))).toMatchObject({ attempt: true })
      const open = world()
      open.seed('tracked_job', [job(3, 'dismissed'), job(4, 'dismissed'), job(5, 'dismissed')])
      expect(await decideAutoAttempt(looseItem(), ctx(open, { policy: { ...ATTEMPT_POLICY, role_breaker_window: 0 } }))).toMatchObject({ attempt: true })
    })
  })

  it('the plan meter: over the limit → usage_limit; an RPC error or no row → usage_check_failed (fail closed)', async () => {
    expect(await decideAutoAttempt(looseItem(), ctx(world({ limit: { allowed: false, reason: 'subscription_required' } })))).toMatchObject({
      reason: 'usage_limit',
      detail: 'subscription_required',
    })
    expect(await decideAutoAttempt(looseItem(), ctx(world({ limit: 'error' })))).toMatchObject({ reason: 'usage_check_failed' })
    const fake = world()
    expect(await decideAutoAttempt(looseItem(), ctx(fake))).toMatchObject({ attempt: true })
    // Opted in to the ChatGPT free tier: an attempt is a work run, which runs a free user on their plan.
    expect(fake.rpcCalls).toEqual([{ fn: 'check_ai_usage_limit', args: { p_user_id: 'user-1', p_chatgpt_plan: true } }])
    const onPlan = world({ limit: { allowed: true, reason: 'chatgpt_plan' } })
    expect(await decideAutoAttempt(looseItem(), ctx(onPlan))).toMatchObject({ attempt: true })
  })

  it('a thrown read is a refusal, never an exception', async () => {
    const broken = { from: () => { throw new Error('db down') }, rpc: async () => ({ data: null, error: null }) }
    expect(await decideAutoAttempt(looseItem(), ctx(world(), { supabase: broken as unknown as SupabaseClient }))).toMatchObject({
      attempt: false,
      reason: 'read_failed',
    })
  })
})

describe('attemptWorkProposal — a pass starts the work through the Start body', () => {
  it('starts an attempted run with NO board action: origin, teammate, fire_key, the source capture first among resources and as the ledger anchor', async () => {
    const fake = world()
    const send = vi.fn(async () => undefined)
    const out = await attemptWorkProposal(
      looseItem({}, { resources: [{ type: 'capture', id: 'cap-1', label: 'dup' }, { type: 'nonsense', label: 'Keep me' }] }),
      { ...ctx(fake), memberId: 'mem-1', captureTitle: 'Weekly sync' },
      { send },
    )
    expect(out).toMatchObject({ attempted: true, reused: false, teammateId: 'tm-res', fireKey: 'attempt:11111111-1111-5111-8111-111111111111' })
    const run = fake.rows('agent_run')[0]
    expect(run).toMatchObject({ origin: 'attempt', ai_team_member_id: 'tm-res', fire_key: 'attempt:11111111-1111-5111-8111-111111111111', triggered_by: 'user-1', attention_item_id: null })
    expect(run.resources).toEqual([{ type: 'capture', id: 'cap-1', label: 'Weekly sync' }, { type: 'nonsense', label: 'Keep me' }])
    expect(run.action_id).toBeNull()
    expect(run.flow_id).toBe('flow-triage')
    expect(fake.rows('actions')).toHaveLength(0)
    expect(fake.rows('tracked_job')[0]).toMatchObject({
      origin: 'attempt',
      ai_team_member_id: 'tm-res',
      source: {
        agent_run_id: run.id,
        capture_id: 'cap-1',
        entity_type: 'capture',
        entity_id: 'cap-1',
        // B PR 4: where it came from, for the brief.
        provenance: { captureId: 'cap-1', quote: 'Can someone research how the Okta token exchange works with Salesforce' },
      },
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('the SAME item decided twice (a retried verdict step) starts ONE run; the second is reused', async () => {
    const fake = world()
    const send = vi.fn(async () => undefined)
    const c = { ...ctx(fake), memberId: 'mem-1' }
    const first = await attemptWorkProposal(proposalItem(), c, { send })
    const second = await attemptWorkProposal(proposalItem(), c, { send })
    expect(first).toMatchObject({ attempted: true, reused: false })
    expect(second).toMatchObject({ attempted: true, reused: true })
    expect(fake.rows('agent_run')).toHaveLength(1)
    expect(fake.rows('actions')).toHaveLength(0)
    // No board action was filed from the proposal, so it stays pending in the capture.
    expect(fake.rows('proposed_change')[0]).toMatchObject({ status: 'pending' })
  })

  it('a refusal starts nothing; a launch failure is reported as launch_failed', async () => {
    const fake = world()
    expect(await attemptWorkProposal(looseItem({ confidence: 0.1 }), { ...ctx(fake), memberId: 'mem-1' })).toMatchObject({
      attempted: false,
      reason: 'below_confidence',
    })
    expect(fake.rows('agent_run')).toHaveLength(0)
    fake.failNextInsert('agent_run', { message: 'boom' })
    expect(await attemptWorkProposal(looseItem(), { ...ctx(fake), memberId: 'mem-1' })).toMatchObject({
      attempted: false,
      reason: 'launch_failed',
      detail: 'run: boom',
    })
  })
})

describe('createWorkProposalAttempter — on by default, inert while either kill switch is thrown', () => {
  const base = (fake: FakeSupabase, env: Record<string, string | undefined>) => ({
    supabase: fake as unknown as SupabaseClient,
    workspaceId: 'ws-1',
    userId: 'user-1',
    memberId: 'mem-1',
    mode: 'act' as const,
    fireDepth: 1,
    captureId: 'cap-1',
    minConfidence: 0.85,
    env,
  })

  it('env kill switch "false" → null with ZERO reads (no settings read at all)', async () => {
    const fake = world()
    expect(await createWorkProposalAttempter(base(fake, { AGENT_AUTO_ATTEMPT_ENABLED: 'false' }), { hasWorkProposal: true })).toBeNull()
    expect(fake.calls).toHaveLength(0)
  })

  it('a report-mode verdict → null, nothing read', async () => {
    const fake = world()
    expect(await createWorkProposalAttempter({ ...base(fake, { AGENT_AUTO_ATTEMPT_ENABLED: 'true' }), mode: 'report' }, { hasWorkProposal: true })).toBeNull()
    expect(fake.calls).toHaveLength(0)
  })

  it('no work_proposal in the verdict → null, nothing read', async () => {
    const fake = world()
    expect(await createWorkProposalAttempter(base(fake, { AGENT_AUTO_ATTEMPT_ENABLED: 'true' }), { hasWorkProposal: false })).toBeNull()
    expect(fake.calls).toHaveLength(0)
  })

  it('the workspace switched off, a stored propose, or a malformed policy (fail closed) → null after ONE settings read', async () => {
    for (const settings of [{ agent_autonomy: { mode: 'off' } }, { agent_autonomy: { mode: 'propose' } }, { agent_autonomy: { mode: 'attempt', max_attempts_per_day: -1 } }, { agent_autonomy: { max_attempts_per_day: -1 } }]) {
      const fake = world()
      fake.seed('workspace', [{ id: 'ws-1', settings }])
      expect(await createWorkProposalAttempter(base(fake, { AGENT_AUTO_ATTEMPT_ENABLED: 'true' }), { hasWorkProposal: true })).toBeNull()
      expect(fake.calls.map((c) => c.table)).toEqual(['workspace'])
    }
  })

  it('by default (env unset, no stored policy) → an attempter; a stored attempt too', async () => {
    for (const settings of [{}, null, { agent_autonomy: { mode: 'attempt' } }]) {
      const fake = world()
      fake.seed('workspace', [{ id: 'ws-1', settings }])
      const attempter = await createWorkProposalAttempter(base(fake, {}), { hasWorkProposal: true })
      expect(typeof attempter).toBe('function')
    }
  })
})

describe('helpers', () => {
  it('attemptFireKey: the proposal wins, then the would-be card id, else none', () => {
    expect(attemptFireKey({ proposalId: 'p', cardId: 'c' })).toBe('attempt:p')
    expect(attemptFireKey({ proposalId: null, cardId: 'c' })).toBe('attempt:c')
    expect(attemptFireKey({ proposalId: null, cardId: null })).toBeNull()
  })

  it('quotedSpans reads straight and curly quotes; normalizeForQuote folds case, punctuation and whitespace', () => {
    expect(quotedSpans('a "one" b “two” c')).toEqual(['one', 'two'])
    expect(normalizeForQuote('  Okta’s TOKEN-exchange,\n works…  ')).toBe("okta's token exchange works")
  })

  it('transcriptForQuote drops the speaker label that opens each line, and only that', () => {
    expect(transcriptForQuote('[local_1] Hello there\n  [remote_12]: we [inaudible] agree\n[Me] ok')).toBe('hello there we inaudible agree ok')
  })

  it('quotePieces splits where words were elided ("...", ". . .", "....", "…") and drops pieces under 12 characters', () => {
    expect(quotePieces('Send Cori the SOW by Friday')).toEqual(['send cori the sow by friday'])
    expect(quotePieces('so... send Cori the SOW. . . and the budget sheet….okay…. by Friday too')).toEqual([
      'send cori the sow',
      'and the budget sheet',
      'by friday too',
    ])
    expect(quotePieces('ok... sure')).toEqual([])
  })

  it('matchPiecesInOrder: each piece after the one before it, spanning first start to last end', () => {
    expect(matchPiecesInOrder('a b c d e', ['b c', 'e'])).toEqual({ start: 2, end: 9 })
    expect(matchPiecesInOrder('a b c d e', ['e', 'b c'])).toBeNull()
    // A repeated phrase: the second piece is looked for after the first.
    expect(matchPiecesInOrder('go now then go now', ['go now', 'go now'])).toEqual({ start: 0, end: 18 })
    expect(matchPiecesInOrder('go now', ['go now', 'go now'])).toBeNull()
    expect(matchPiecesInOrder('anything', [])).toBeNull()
  })

  it('locateQuote returns offsets into the ORIGINAL transcript, across labels, punctuation and elision', () => {
    const transcript = '[remote_1] Right.\n[local_1] I’ll send Cori the SOW,\n[local_1] um, by FRIDAY — promise.\n[remote_1] Thanks'
    const at = locateQuote(transcript, "I'll send Cori the SOW, um, by Friday")
    expect(at && transcript.slice(at.start, at.end)).toBe('I’ll send Cori the SOW,\n[local_1] um, by FRIDAY')
    const elided = locateQuote(transcript, 'Right... send Cori the SOW … by Friday promise')
    expect(elided && transcript.slice(elided.start, elided.end)).toBe('send Cori the SOW,\n[local_1] um, by FRIDAY — promise')
    // Skipping the "um" is an elision the quote did not mark.
    expect(locateQuote(transcript, "I'll send Cori the SOW by Friday")).toBeNull()
    expect(locateQuote(transcript, 'send Dana the SOW by Friday')).toBeNull()
  })
})
