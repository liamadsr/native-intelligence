/**
 * The work_touch backfill planner (Sequence step 2, plan §2.3): what durable
 * history proves for one settled work item, per source, deduped, never invented.
 */
import { describe, it, expect } from 'vitest'
import {
  BACKFILL_TOOL_NAME,
  DECLARED_TOOL_NAME,
  flowRunLedgerEntries,
  planJobTouches,
  proposalIdsNeedingKind,
  type BackfillJobRow,
} from '../touch-backfill'

const WS = '11111111-1111-4111-8111-111111111111'
const JOB = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'
const DOC = '44444444-4444-4444-8444-444444444444'
const CAP = '55555555-5555-4555-8555-555555555555'
const ACT = '66666666-6666-4666-8666-666666666666'
const PROP = '77777777-7777-4777-8777-777777777777'
const PROP2 = '88888888-8888-4888-8888-888888888888'
const CONTACT = '99999999-9999-4999-8999-999999999999'
const AT = '2026-09-01T10:00:00.000Z'

function job(over: Partial<BackfillJobRow> = {}): BackfillJobRow {
  return {
    id: JOB,
    workspace_id: WS,
    kind: 'work_run',
    agent_run_id: null,
    flow_run_id: null,
    deliverables: [],
    source: {},
    created_at: AT,
    ...over,
  }
}

const keys = (touches: ReturnType<typeof planJobTouches>) => touches.map((t) => `${t.verb}:${t.entityType}:${t.entityId}`)

describe('planJobTouches — deliverables', () => {
  it('one delivered per typed deliverable; a pr URL is skipped; attention_cards lands on the subject capture', () => {
    const touches = planJobTouches(
      job({
        deliverables: [
          { type: 'document', id: DOC, label: 'Brief' },
          { type: 'pr', id: 'https://github.com/x/y/pull/1', label: 'PR' },
          { type: 'attention_cards', id: 'flow-run-id', label: '3 cards', count: 3 },
          { type: 'url', id: 'https://example.com', label: 'link' },
        ],
        source: { entity_type: 'capture', entity_id: CAP },
      }),
    )
    expect(keys(touches)).toEqual([`delivered:document:${DOC}`, `delivered:capture:${CAP}`, `read:capture:${CAP}`])
    for (const t of touches) {
      expect(t.workItemId).toBe(JOB)
      expect(t.workspaceId).toBe(WS)
      expect(t.at).toBe(AT)
      expect(t.toolName).toBe(BACKFILL_TOOL_NAME)
    }
    expect(touches[0].source).toBe('deliverables')
    expect(touches[2].source).toBe('source_entity')
  })

  it('attention_cards with no capture subject records nothing per card', () => {
    const touches = planJobTouches(
      job({ deliverables: [{ type: 'attention_cards', id: 'flow-run-id', label: '3 cards', count: 3 }] }),
    )
    expect(touches).toEqual([])
  })

  it('malformed deliverables and non-uuid ids are dropped, never thrown on', () => {
    const touches = planJobTouches(
      job({ deliverables: [null, 'x', { type: 'document' }, { type: 'document', id: 'not-a-uuid', label: '' }, 7] }),
    )
    expect(touches).toEqual([])
    expect(planJobTouches(job({ deliverables: 'nope', source: 'nope' }))).toEqual([])
  })
})

describe('planJobTouches — flow runs', () => {
  it('verdict entries: applied → created (kind from the entry, else the proposal lookup), carded → proposed, folded → wrote', () => {
    const touches = planJobTouches(job({ flow_run_id: RUN }), {
      flowRun: {
        action_results: [
          { action_id: 'a1', condition_met: true },
          {
            action_id: 'a2',
            verdict: {
              summary: 's',
              entries: [
                { proposal_id: PROP, decision: 'accept', outcome: 'applied', reason: 'r', entity_id: CONTACT, entity_type: 'contact' },
                { proposal_id: PROP2, decision: 'accept', outcome: 'applied', reason: 'r', entity_id: ACT },
                { proposal_id: DOC, decision: 'accept', outcome: 'carded', reason: 'r' },
                { proposal_id: CAP, decision: 'fold_into', outcome: 'folded', reason: 'r', entity_id: ACT },
                { proposal_id: 'x', decision: 'dismiss', outcome: 'dismissed', reason: 'r' },
              ],
            },
            output_document_id: DOC,
            archived_capture_id: CAP,
          },
        ],
      },
      proposalKinds: new Map([[PROP2, 'decision']]),
    })
    expect(keys(touches)).toEqual([
      `created:contact:${CONTACT}`,
      `created:decision:${ACT}`,
      `proposed:proposal:${DOC}`,
      `wrote:action:${ACT}`,
      `delivered:document:${DOC}`,
      `delivered:capture:${CAP}`,
    ])
    expect(touches.map((t) => t.source)).toEqual([
      'flow_verdict',
      'flow_verdict',
      'flow_verdict',
      'flow_verdict',
      'flow_output',
      'flow_output',
    ])
  })

  it('an applied entry with no entity_type and no lookup defaults to action, like the live writer', () => {
    const touches = planJobTouches(job({ flow_run_id: RUN }), {
      flowRun: {
        action_results: [{ verdict: { entries: [{ proposal_id: PROP, outcome: 'applied', entity_id: ACT }] } }],
      },
    })
    expect(keys(touches)).toEqual([`created:action:${ACT}`])
  })

  it('proposalIdsNeedingKind names only applied entries missing entity_type; flowRunLedgerEntries flattens', () => {
    const results = [
      { verdict: { entries: [{ proposal_id: PROP, outcome: 'applied', entity_id: ACT }] } },
      { verdict: { entries: [{ proposal_id: PROP2, outcome: 'applied', entity_id: ACT, entity_type: 'action' }] } },
      { verdict: { entries: [{ proposal_id: DOC, outcome: 'carded' }] } },
      { verdict: null },
      null,
    ]
    expect(flowRunLedgerEntries(results)).toHaveLength(3)
    expect(proposalIdsNeedingKind(flowRunLedgerEntries(results))).toEqual([PROP])
  })
})

describe('planJobTouches — extraction passes', () => {
  it('reads the capture, creates the applied, proposes the staged', () => {
    const touches = planJobTouches(
      job({ kind: 'extraction', source: { capture_id: CAP, mode: 'batch', extraction_pass_id: RUN } }),
      {
        extractionPass: {
          capture_id: CAP,
          ledger: {
            applied_count: 1,
            staged_count: 1,
            entries: [
              { proposal_id: PROP, decision: 'accept', outcome: 'applied', reason: '', entity_id: ACT },
              { proposal_id: PROP2, decision: 'accept', outcome: 'carded', reason: '' },
            ],
          },
        },
        proposalKinds: new Map([[PROP, 'decision']]),
      },
    )
    expect(keys(touches)).toEqual([`read:capture:${CAP}`, `created:decision:${ACT}`, `proposed:proposal:${PROP2}`])
    expect(touches.every((t) => t.source === 'extraction')).toBe(true)
  })

  it('a pass row that is gone still yields the capture read from the item source', () => {
    const touches = planJobTouches(job({ kind: 'extraction', source: { capture_id: CAP, extraction_pass_id: RUN } }))
    expect(keys(touches)).toEqual([`read:capture:${CAP}`])
  })
})

describe('planJobTouches — agent runs', () => {
  it('a coding run wrote its action; declared resources with ids were read (tool_name declared; packages and label-only skipped)', () => {
    const touches = planJobTouches(job({ agent_run_id: RUN }), {
      agentRun: {
        action_id: ACT,
        pr_url: 'https://github.com/x/y/pull/2',
        resources: [
          { type: 'capture', id: CAP, label: 'The call' },
          { type: 'package', id: DOC, label: 'Pkg' },
          { type: 'contact', label: 'Dana' },
          { type: 'document', id: 'nope', label: 'x' },
          'junk',
        ],
      },
    })
    expect(keys(touches)).toEqual([`wrote:action:${ACT}`, `read:capture:${CAP}`])
    expect(touches[0].toolName).toBe(BACKFILL_TOOL_NAME)
    expect(touches[0].source).toBe('agent_action')
    expect(touches[1].toolName).toBe(DECLARED_TOOL_NAME)
    expect(touches[1].source).toBe('declared_resources')
    expect(touches.every((t) => t.agentRunId === RUN)).toBe(true)
  })

  it('a work run (no action) with declared resources records only the reads', () => {
    const touches = planJobTouches(job({ agent_run_id: RUN }), {
      agentRun: { action_id: null, pr_url: null, resources: [{ type: 'document', id: DOC, label: 'd' }] },
    })
    expect(keys(touches)).toEqual([`read:document:${DOC}`])
  })
})

describe('planJobTouches — dedupe', () => {
  it('the same (entity, verb) from two sources is one row; the first source wins', () => {
    const touches = planJobTouches(
      job({ agent_run_id: RUN, source: { entity_type: 'capture', entity_id: CAP.toUpperCase() } }),
      { agentRun: { action_id: null, pr_url: null, resources: [{ type: 'capture', id: CAP, label: 'c' }] } },
    )
    expect(keys(touches)).toEqual([`read:capture:${CAP}`])
    expect(touches[0].source).toBe('source_entity')
    expect(touches[0].toolName).toBe(BACKFILL_TOOL_NAME)
  })
})
