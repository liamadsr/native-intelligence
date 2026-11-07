/**
 * What a work item actually produced (ACTIVITY-AND-REVIEW-DESIGN §4.2).
 *
 * Two halves: the pure folds that turn one kind's execution rows into the
 * panel's blocks (narrative, cards, decisions, drafts, run), and
 * `loadWorkOutput`, which reads those rows for ONE item and folds them into the
 * single shape every kind fills a subset of. The loader is best-effort by
 * contract, so a read that throws must degrade to an empty block and never to a
 * failed panel — that is asserted, not assumed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ActionResult, VerdictLedgerEntry } from '@/lib/flows/types'
import { makeFakeSupabase, type FakeSupabase } from './fake-supabase'
import {
  PASS_WINDOW_MS,
  cardFrom,
  decisionsFrom,
  draftFrom,
  emptyOutput,
  labelKey,
  loadDraftRows,
  loadWorkOutput,
  orderCards,
  pickPass,
  runFrom,
  verdictBlocks,
  type AgentRunRow,
  type DraftRow,
  type WorkOutputCard,
} from '../output'
import type { WorkItem } from '../types'

// ─── Fixtures ────────────────────────────────────────────────────────────

function result(over: Partial<ActionResult>): ActionResult {
  return {
    action_id: 'a1',
    condition_met: true,
    disabled: false,
    incomplete: false,
    skipped: false,
    status: 'success',
    request_summary: null,
    response_status_code: null,
    response_body_preview: null,
    error_message: null,
    duration_ms: null,
    ...over,
  }
}

function entry(over: Partial<VerdictLedgerEntry> & { proposal_id: string }): VerdictLedgerEntry {
  return { decision: 'accept', outcome: 'applied', reason: '', ...over }
}

function proposal(over: { id: string } & Partial<Record<'display_text' | 'title' | 'entity_type' | 'change_type' | 'status', string | null>>) {
  return {
    display_text: null,
    title: null,
    entity_type: null,
    change_type: null,
    status: null,
    ...over,
  }
}

function cardRow(over: Partial<Parameters<typeof cardFrom>[0]> & { id: string }) {
  return {
    kind: 'action_card',
    title: 'A card',
    why: null,
    payload: {},
    proposal_id: null,
    status: 'pending',
    expires_at: null,
    created_at: '2026-09-17T10:00:00.000Z',
    resolved_at: null,
    ...over,
  }
}

/** The same row as the table stores it: the run that surfaced it is the filter. */
function seededCard(runId: string, over: Partial<Parameters<typeof cardFrom>[0]> & { id: string }) {
  return { ...cardRow(over), source_flow_run_id: runId }
}

function agentRunRow(over: Partial<AgentRunRow> & { id: string }): AgentRunRow {
  return {
    status: 'succeeded',
    kind: 'workspace',
    action_id: null,
    pr_url: null,
    branch: null,
    repo_full_name: null,
    sandbox_id: null,
    error_message: null,
    log_tail: null,
    task_prompt: null,
    result_summary: null,
    resources: [],
    pending_input: null,
    started_at: null,
    finished_at: null,
    ...over,
  }
}

function workItem(over: Partial<WorkItem>): WorkItem {
  return {
    id: 'job-1',
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'flow_run',
    title: 'Work',
    status: 'done',
    actor: 'loop',
    current_step: null,
    progress: {},
    result_summary: null,
    error_message: null,
    skip_reason: null,
    deliverables: [],
    needs: null,
    source: {},
    run_key: null,
    agent_run_id: null,
    flow_run_id: null,
    created_at: '2026-09-17T10:00:00.000Z',
    started_at: '2026-09-17T10:00:00.000Z',
    finished_at: '2026-09-17T10:00:30.000Z',
    reviewed_at: null,
    last_beat_at: '2026-09-17T10:00:30.000Z',
    deadline_at: null,
    ...over,
  }
}

/** Records which tables a load touched, so "no query needed" is provable. */
function tracking(fake: FakeSupabase) {
  const tables: string[] = []
  return {
    tables,
    client: {
      from: (table: string) => {
        tables.push(table)
        return fake.from(table)
      },
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Pure folds ──────────────────────────────────────────────────────────

describe('verdictBlocks', () => {
  it('takes the narrative, the entries and the overflow from the verdict', () => {
    const v = verdictBlocks([
      result({}),
      result({
        verdict: {
          summary: '  One real commitment came out of the sync.  ',
          entries: [entry({ proposal_id: 'p1' }), entry({ proposal_id: 'p2', outcome: 'carded' })],
          cards_surfaced: 2,
          cards_overflow: 3,
          revoked_count: 0,
        },
      }),
    ])
    expect(v.narrative).toBe('One real commitment came out of the sync.')
    expect(v.entries.map((e) => e.proposal_id)).toEqual(['p1', 'p2'])
    expect(v.cards_overflow).toBe(3)
    expect(v.verdict_missing).toBe(false)
    expect(v.error).toBeNull()
  })

  it('reports a verdict that was never submitted, with no narrative', () => {
    const v = verdictBlocks([
      result({
        verdict: {
          summary: 'half a thought',
          entries: [],
          cards_surfaced: 0,
          cards_overflow: 0,
          revoked_count: 0,
          verdict_missing: true,
        },
      }),
    ])
    expect(v.narrative).toBeNull()
    expect(v.verdict_missing).toBe(true)
  })

  it('takes the error from the first non-skipped failed action, else the fallback', () => {
    expect(
      verdictBlocks(
        [
          result({ skipped: true, status: 'failed', error_message: 'a skipped action never ran' }),
          result({ status: 'failed', error_message: 'HTTP 500 from the skill' }),
          result({ status: 'failed', error_message: 'the second failure' }),
        ],
        '1 action fired',
      ).error,
    ).toBe('HTTP 500 from the skill')
    // Only skipped failures: nothing action-level to say, so the ledger's line.
    expect(
      verdictBlocks([result({ skipped: true, status: 'failed', error_message: 'never ran' })], '1 action fired').error,
    ).toBe('1 action fired')
    // A failure with no message of its own also falls back.
    expect(verdictBlocks([result({ status: 'failed', error_message: null })], '1 action fired').error).toBe('1 action fired')
    expect(verdictBlocks([result({})]).error).toBeNull()
  })
})

describe('decisionsFrom', () => {
  it('names each proposal, preferring its display text, and carries what it decided', () => {
    const proposals = new Map([
      ['p1', proposal({ id: 'p1', display_text: 'Book a follow-up with Dana', title: 'Follow-up', entity_type: 'action', change_type: 'create', status: 'applied' })],
      ['p2', proposal({ id: 'p2', title: 'Draft the pricing recap', entity_type: 'email', change_type: 'send_email', status: 'pending' })],
      ['p3', proposal({ id: 'p3', display_text: '   ' })],
    ])
    const decisions = decisionsFrom(
      [
        entry({ proposal_id: 'p1', reason: 'Dana asked for it on the call', entity_id: 'act-1' }),
        entry({ proposal_id: 'p2', decision: 'accept', outcome: 'carded', reason: 'Needs your wording' }),
        entry({ proposal_id: 'p3', decision: 'dismiss', outcome: 'skipped', reason: '', detail: 'Already tracked' }),
        entry({ proposal_id: 'unknown', decision: 'dismiss', outcome: 'dismissed', reason: 'Not a commitment' }),
      ],
      proposals,
    )
    expect(decisions.map((d) => d.title)).toEqual([
      'Book a follow-up with Dana',
      'Draft the pricing recap',
      // Blank display text falls through to the title, then to the generic name.
      'Proposal',
      'Proposal',
    ])
    expect(decisions[0]).toMatchObject({
      proposal_id: 'p1',
      decision: 'accept',
      outcome: 'applied',
      reason: 'Dana asked for it on the call',
      detail: null,
      entity_id: 'act-1',
      entity_type: 'action',
      change_type: 'create',
      proposal_status: 'applied',
    })
    expect(decisions[2]).toMatchObject({ reason: '', detail: 'Already tracked', entity_id: null })
    expect(decisions[3]).toMatchObject({ entity_type: null, change_type: null, proposal_status: null })
  })
})

describe('cardFrom', () => {
  it('takes the detail from the description, then the task, then the email context', () => {
    expect(cardFrom(cardRow({ id: 'c', payload: { description: 'Book 30 min', task: 'Write it', email_context: 'ctx' } })).detail).toBe('Book 30 min')
    expect(cardFrom(cardRow({ id: 'c', payload: { task: 'Write it', email_context: 'ctx' } })).detail).toBe('Write it')
    expect(cardFrom(cardRow({ id: 'c', payload: { email_context: 'ctx' } })).detail).toBe('ctx')
  })

  it('only uses the display text as detail when it says more than the title', () => {
    expect(cardFrom(cardRow({ id: 'c', title: 'Send the recap', payload: { display_text: 'Send the recap' } })).detail).toBeNull()
    expect(cardFrom(cardRow({ id: 'c', title: 'Send the recap', payload: { display_text: 'Send the recap to Dana by Friday' } })).detail).toBe(
      'Send the recap to Dana by Friday',
    )
    expect(cardFrom(cardRow({ id: 'c', payload: {} })).detail).toBeNull()
  })

  it('carries the facts the row shows as chips, preferring a name over an address', () => {
    const card = cardFrom(
      cardRow({
        id: 'c1',
        kind: 'draft_email',
        title: 'Reply to Dana',
        why: '  She asked twice  ',
        proposal_id: 'p9',
        status: 'accepted',
        created_at: '2026-09-17T10:00:00.000Z',
        resolved_at: '2026-09-17T10:05:00.000Z',
        expires_at: '2026-09-24T10:00:00.000Z',
        payload: {
          priority: 'high',
          due_date: '2026-09-20',
          entity_type: 'email',
          change_type: 'send_email',
          email_to_name: 'Dana Reed',
          email_to_address: 'dana@acme.com',
          email_subject: 'Re: Pricing',
        },
      }),
    )
    expect(card).toMatchObject({
      id: 'c1',
      kind: 'draft_email',
      title: 'Reply to Dana',
      why: 'She asked twice',
      status: 'accepted',
      resolved_at: '2026-09-17T10:05:00.000Z',
      expires_at: '2026-09-24T10:00:00.000Z',
      proposal_id: 'p9',
      priority: 'high',
      due_date: '2026-09-20',
      entity_type: 'email',
      change_type: 'send_email',
      email_to: 'Dana Reed',
      email_subject: 'Re: Pricing',
    })
    expect(cardFrom(cardRow({ id: 'c2', payload: { email_to_address: 'dana@acme.com' } })).email_to).toBe('dana@acme.com')
  })
})

describe('orderCards', () => {
  it('puts what still needs the user first, then the order they were surfaced in', () => {
    const cards = [
      { id: 'settled-late', status: 'accepted', created_at: '2026-09-17T10:00:30.000Z' },
      { id: 'pending-late', status: 'pending', created_at: '2026-09-17T10:00:20.000Z' },
      { id: 'settled-early', status: 'dismissed', created_at: '2026-09-17T10:00:00.000Z' },
      { id: 'pending-early', status: 'pending', created_at: '2026-09-17T10:00:10.000Z' },
    ] as WorkOutputCard[]
    expect(orderCards(cards).map((c) => c.id)).toEqual(['pending-early', 'pending-late', 'settled-early', 'settled-late'])
    // Pure: the input is not reordered in place.
    expect(cards[0].id).toBe('settled-late')
  })
})

describe('draftFrom', () => {
  const base: DraftRow = {
    id: 'd1',
    provider_thread_id: 'thr-1',
    status: 'pending_review',
    subject: 'Re: Pricing',
    to_emails: ['dana@acme.com', 'sam@acme.com'],
    body_text: 'Hi Dana,\n\n  Thanks for the note —\twe can do that.  ',
    email_thread: { folder: 'inbox' },
  }

  it('keeps only string recipients and collapses the body into a snippet', () => {
    expect(draftFrom({ ...base, to_emails: ['dana@acme.com', null, 42, '', 'sam@acme.com'] })).toEqual({
      id: 'd1',
      subject: 'Re: Pricing',
      to: ['dana@acme.com', 'sam@acme.com'],
      snippet: 'Hi Dana, Thanks for the note — we can do that.',
      status: 'pending_review',
    })
    expect(draftFrom({ ...base, to_emails: null, body_text: null, subject: null, status: null })).toMatchObject({
      to: [],
      snippet: null,
      subject: null,
      status: null,
    })
  })

  it('cuts a long body to 280 characters, ending with an ellipsis', () => {
    const snippet = draftFrom({ ...base, body_text: 'x'.repeat(600) }).snippet ?? ''
    expect(snippet).toHaveLength(280)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.slice(0, -1)).toBe('x'.repeat(279))
  })
})

describe('pickPass', () => {
  const at = '2026-09-17T10:00:00.000Z'
  const ms = Date.parse(at)
  const passes = [
    { id: 'named', mode: 'batch', fired_at: new Date(ms + 3 * 60_000).toISOString(), ledger: null },
    { id: 'near-live', mode: 'live', fired_at: new Date(ms + 30_000).toISOString(), ledger: null },
    { id: 'near-batch', mode: 'batch', fired_at: new Date(ms - 10_000).toISOString(), ledger: null },
  ]

  it('takes the pass the row names, whatever else is nearer', () => {
    expect(pickPass(passes, { created_at: at, source: { extraction_pass_id: 'named', mode: 'live' } })?.id).toBe('named')
    // Named but gone: nothing, rather than the nearest stranger.
    expect(pickPass(passes, { created_at: at, source: { extraction_pass_id: 'vanished' } })).toBeNull()
  })

  it('otherwise takes the nearest pass in the window, in the same mode', () => {
    expect(pickPass(passes, { created_at: at, source: { mode: 'batch' } })?.id).toBe('near-batch')
    expect(pickPass(passes, { created_at: at, source: { mode: 'live' } })?.id).toBe('near-live')
    // No mode on the row: the nearest pass of any mode.
    expect(pickPass(passes, { created_at: at, source: {} })?.id).toBe('near-batch')
  })

  it('takes nothing when every pass is outside the window', () => {
    const far = [
      { id: 'before', mode: 'live', fired_at: new Date(ms - PASS_WINDOW_MS - 1000).toISOString(), ledger: null },
      { id: 'after', mode: 'live', fired_at: new Date(ms + PASS_WINDOW_MS + 1000).toISOString(), ledger: null },
    ]
    expect(pickPass(far, { created_at: at, source: { mode: 'live' } })).toBeNull()
    expect(pickPass(passes, { created_at: 'not a date', source: {} })).toBeNull()
  })
})

describe('runFrom', () => {
  it('keeps only resources that are objects with a label', () => {
    const run = runFrom(
      agentRunRow({
        id: 'run-1',
        status: 'running',
        task_prompt: '  Draft the recap  ',
        log_tail: '$ npm test',
        sandbox_id: 'sb-1',
        resources: [{ type: 'capture', id: 'cap-1', label: 'Pricing sync' }, { type: 'action', id: 'a1' }, 'capture', null, 7],
      }),
    )
    expect(run.resources).toEqual([{ type: 'capture', id: 'cap-1', label: 'Pricing sync' }])
    expect(run).toMatchObject({ id: 'run-1', status: 'running', kind: 'workspace', task: 'Draft the recap', log_tail: '$ npm test', sandbox_id: 'sb-1' })
    expect(runFrom(agentRunRow({ id: 'run-2', resources: null, task_prompt: '   ' }))).toMatchObject({ resources: [], task: null })
  })
})

describe('emptyOutput', () => {
  it('is every block empty', () => {
    expect(emptyOutput()).toEqual({
      narrative: null,
      error: null,
      cards: [],
      decisions: [],
      drafts: [],
      run: null,
      context: [],
      labels: {},
      cards_overflow: 0,
      verdict_missing: false,
    })
  })
})

// ─── loadWorkOutput ──────────────────────────────────────────────────────

const FLOW_ITEM = workItem({
  id: 'job-flow',
  kind: 'flow_run',
  title: 'Meeting triage',
  result_summary: 'Filed 1, 2 for you',
  flow_run_id: 'fr-1',
  source: { capture_id: 'cap-1', flow_id: 'flow-1' },
  deliverables: [
    { type: 'attention_cards', id: 'fr-1', label: '2 cards for you', count: 2 },
    { type: 'document', id: 'doc-1', label: 'Output document' },
    { type: 'action', id: 'act-1', label: 'Filed action' },
  ],
})

function seedFlowRun(fake: FakeSupabase) {
  fake.seed('flow_run', [
    {
      id: 'fr-1',
      status: 'success',
      error_message: null,
      action_results: [
        result({
          verdict: {
            summary: 'One real commitment came out of the pricing sync.',
            entries: [
              entry({ proposal_id: 'p1', outcome: 'applied', reason: 'Dana asked for it on the call', entity_id: 'act-1' }),
              entry({ proposal_id: 'p2', outcome: 'carded', reason: 'Needs your wording' }),
              entry({ proposal_id: 'p3', decision: 'dismiss', outcome: 'dismissed', reason: 'Already tracked as ENG-12' }),
            ],
            cards_surfaced: 2,
            cards_overflow: 1,
            revoked_count: 0,
          },
        }),
      ],
    },
  ])
  fake.seed('proposed_change', [
    proposal({ id: 'p1', display_text: 'Book a follow-up with Dana', title: 'Follow-up', entity_type: 'action', change_type: 'create', status: 'applied' }),
    proposal({ id: 'p2', title: 'Draft the pricing recap', entity_type: 'email', change_type: 'send_email', status: 'pending' }),
    proposal({ id: 'p3', display_text: 'Chase the security review', status: 'dismissed' }),
  ])
  fake.seed('attention_item', [
    seededCard('fr-1', {
      id: 'card-accepted',
      kind: 'action_card',
      title: 'Book the follow-up',
      why: 'Dana asked on the call',
      payload: { description: 'Book 30 minutes with Dana next week', priority: 'high', due_date: '2026-09-20' },
      proposal_id: 'p1',
      status: 'accepted',
      created_at: '2026-09-17T10:00:10.000Z',
      resolved_at: '2026-09-17T10:05:00.000Z',
    }),
    seededCard('fr-1', {
      id: 'card-pending',
      kind: 'work_proposal',
      title: 'Draft the pricing recap',
      payload: { task: 'Write the recap and send it to Dana' },
      proposal_id: 'p2',
      status: 'pending',
      created_at: '2026-09-17T10:00:11.000Z',
    }),
    seededCard('fr-2', { id: 'card-other-run', title: 'From another run', status: 'pending' }),
  ])
  fake.seed('flow', [{ id: 'flow-1', name: 'Meeting triage loop' }])
  fake.seed('captures', [{ id: 'cap-1', title: 'Pricing sync with Dana' }])
  fake.seed('document', [{ id: 'doc-1', title: 'Q3 pricing recap' }])
  fake.seed('actions', [{ id: 'act-1', identifier: 'ENG-42', title: 'Send the recap' }])
}

describe('loadWorkOutput — a loop run', () => {
  it('folds the verdict, its cards, what it looked at, what it acted on and the deliverable titles', async () => {
    const fake = makeFakeSupabase()
    seedFlowRun(fake)
    const out = await loadWorkOutput(fake as never, FLOW_ITEM)

    expect(out.narrative).toBe('One real commitment came out of the pricing sync.')
    expect(out.error).toBeNull()
    expect(out.cards_overflow).toBe(1)
    expect(out.verdict_missing).toBe(false)

    // Everything it looked at, by name and outcome.
    expect(out.decisions.map((d) => [d.title, d.outcome])).toEqual([
      ['Book a follow-up with Dana', 'applied'],
      ['Draft the pricing recap', 'carded'],
      ['Chase the security review', 'dismissed'],
    ])
    expect(out.decisions[0]).toMatchObject({ entity_id: 'act-1', entity_type: 'action', change_type: 'create', proposal_status: 'applied' })

    // What it put in front of the user: pending first, another run's card is not ours.
    expect(out.cards.map((c) => [c.id, c.status])).toEqual([
      ['card-pending', 'pending'],
      ['card-accepted', 'accepted'],
    ])
    expect(out.cards.some((c) => c.id === 'card-other-run')).toBe(false)
    expect(out.cards[0]).toMatchObject({ kind: 'work_proposal', title: 'Draft the pricing recap', detail: 'Write the recap and send it to Dana' })
    expect(out.cards[1]).toMatchObject({
      why: 'Dana asked on the call',
      detail: 'Book 30 minutes with Dana next week',
      priority: 'high',
      due_date: '2026-09-20',
      resolved_at: '2026-09-17T10:05:00.000Z',
    })

    // What it acted on, with the titles those rows carry now.
    expect(out.context).toEqual([
      { type: 'capture', id: 'cap-1', label: 'Pricing sync with Dana' },
      { type: 'flow', id: 'flow-1', label: 'Meeting triage loop' },
    ])
    expect(out.labels).toEqual({
      [labelKey({ type: 'document', id: 'doc-1' })]: 'Q3 pricing recap',
      [labelKey({ type: 'action', id: 'act-1' })]: 'ENG-42 · Send the recap',
    })

    // Nothing an email or agent kind would fill.
    expect(out.drafts).toEqual([])
    expect(out.run).toBeNull()
  })

  it('names the run that failed with the action-level error, and says nothing on a run that did not', async () => {
    const fake = makeFakeSupabase()
    fake.seed('flow_run', [
      {
        id: 'fr-fail',
        status: 'failed',
        error_message: '1 action failed',
        action_results: [result({ status: 'failed', error_message: 'Anthropic API: overloaded_error' })],
      },
    ])
    const failed = workItem({ id: 'job-failed', status: 'failed', flow_run_id: 'fr-fail', error_message: '1 action failed' })
    expect((await loadWorkOutput(fake as never, failed)).error).toBe('Anthropic API: overloaded_error')

    const done = workItem({ id: 'job-done', status: 'done', flow_run_id: 'fr-fail' })
    expect((await loadWorkOutput(fake as never, done)).error).toBeNull()
  })

  it('degrades to an empty block when a read throws, and still loads the rest', async () => {
    const fake = makeFakeSupabase()
    seedFlowRun(fake)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = {
      from: (table: string) => {
        if (table === 'attention_item') throw new Error('permission denied for table attention_item')
        return fake.from(table)
      },
    }
    const out = await loadWorkOutput(broken as never, FLOW_ITEM)
    expect(out.cards).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[work] output cards failed:'), expect.anything())
    // Every other block still loaded.
    expect(out.narrative).toBe('One real commitment came out of the pricing sync.')
    expect(out.decisions).toHaveLength(3)
    expect(out.context).toHaveLength(2)
    expect(out.labels[labelKey({ type: 'document', id: 'doc-1' })]).toBe('Q3 pricing recap')
  })
})

describe('loadWorkOutput — an extraction pass', () => {
  const at = '2026-09-17T10:00:00.000Z'
  const ms = Date.parse(at)

  function seedPasses(fake: FakeSupabase) {
    fake.seed('extraction_pass', [
      {
        id: 'pass-in',
        capture_id: 'cap-2',
        mode: 'live',
        fired_at: new Date(ms + 20_000).toISOString(),
        ledger: { entries: [entry({ proposal_id: 'p1', outcome: 'applied', reason: 'auto-applied create:action' })] },
      },
      {
        id: 'pass-out',
        capture_id: 'cap-2',
        mode: 'live',
        fired_at: new Date(ms + PASS_WINDOW_MS + 60_000).toISOString(),
        ledger: { entries: [entry({ proposal_id: 'p2', outcome: 'carded', reason: 'a later pass' })] },
      },
    ])
    fake.seed('proposed_change', [
      proposal({ id: 'p1', display_text: 'File "ship the pricing page"' }),
      proposal({ id: 'p2', display_text: 'Something from the later pass' }),
    ])
    fake.seed('captures', [{ id: 'cap-2', title: 'Pricing sync with Dana' }])
  }

  it('matches an older row without a pass id by capture and time', async () => {
    const fake = makeFakeSupabase()
    seedPasses(fake)
    const item = workItem({ id: 'job-x', kind: 'extraction', created_at: at, source: { capture_id: 'cap-2', mode: 'live' } })
    const out = await loadWorkOutput(fake as never, item)
    expect(out.decisions.map((d) => d.title)).toEqual(['File "ship the pricing page"'])
    expect(out.context).toEqual([{ type: 'capture', id: 'cap-2', label: 'Pricing sync with Dana' }])
  })

  it('reads the pass the row names', async () => {
    const fake = makeFakeSupabase()
    seedPasses(fake)
    const item = workItem({
      id: 'job-y',
      kind: 'extraction',
      created_at: at,
      source: { capture_id: 'cap-2', mode: 'live', extraction_pass_id: 'pass-out' },
    })
    const out = await loadWorkOutput(fake as never, item)
    expect(out.decisions.map((d) => d.title)).toEqual(['Something from the later pass'])
  })

  it('has no decisions when nothing matches', async () => {
    const fake = makeFakeSupabase()
    seedPasses(fake)
    const item = workItem({ id: 'job-z', kind: 'extraction', created_at: at, source: { capture_id: 'cap-nope', mode: 'live' } })
    expect((await loadWorkOutput(fake as never, item)).decisions).toEqual([])
  })
})

describe('loadWorkOutput — an agent run', () => {
  const RUN = agentRunRow({
    id: 'run-1',
    status: 'failed',
    kind: 'workspace',
    action_id: 'act-1',
    error_message: 'The sandbox ran out of time',
    log_tail: '$ npm test\nFAIL',
    task_prompt: 'Draft the pricing recap and open a PR',
    result_summary: 'Opened a PR with the recap',
    resources: [{ type: 'capture', id: 'cap-1', label: 'Pricing sync' }],
    started_at: '2026-09-17T10:00:00.000Z',
    finished_at: '2026-09-17T10:04:00.000Z',
  })

  it('uses the run row the caller already read, without asking for it again', async () => {
    const fake = makeFakeSupabase()
    const { client, tables } = tracking(fake)
    const item = workItem({ id: 'job-run', kind: 'work_run', status: 'failed', agent_run_id: 'run-1', source: { action_id: 'act-1' } })
    fake.seed('actions', [{ id: 'act-1', identifier: 'ENG-7', title: 'Ship the pricing page' }])

    const out = await loadWorkOutput(client as never, item, { agentRun: RUN })
    expect(tables).not.toContain('agent_run')
    expect(out.narrative).toBe('Opened a PR with the recap')
    expect(out.error).toBe('The sandbox ran out of time')
    expect(out.run).toMatchObject({
      id: 'run-1',
      status: 'failed',
      task: 'Draft the pricing recap and open a PR',
      log_tail: '$ npm test\nFAIL',
      resources: [{ type: 'capture', id: 'cap-1', label: 'Pricing sync' }],
    })
    // The action it ran for is context, with its identifier.
    expect(out.context).toEqual([{ type: 'action', id: 'act-1', label: 'Ship the pricing page', identifier: 'ENG-7' }])
  })

  it('reads the run row itself when the caller did not', async () => {
    const fake = makeFakeSupabase()
    const { client, tables } = tracking(fake)
    fake.seed('agent_run', [RUN as unknown as Record<string, unknown>])
    const item = workItem({ id: 'job-run', kind: 'work_run', status: 'failed', agent_run_id: 'run-1' })

    const out = await loadWorkOutput(client as never, item)
    expect(tables).toContain('agent_run')
    expect(out.run).toMatchObject({ id: 'run-1', task: 'Draft the pricing recap and open a PR' })
    expect(out.narrative).toBe('Opened a PR with the recap')
  })
})

describe('loadWorkOutput — email drafts', () => {
  it('returns the drafts in the order the pass wrote them, with what each says', async () => {
    const fake = makeFakeSupabase()
    fake.seed('email_draft', [
      { id: 'd1000000-0000-4000-8000-000000000001', provider_thread_id: 'thr-1', status: 'pending_review', subject: 'Re: Pricing', to_emails: ['dana@acme.com'], body_text: 'Hi Dana,\n\nThat works.', email_thread: { folder: 'inbox' } },
      { id: 'd2000000-0000-4000-8000-000000000002', provider_thread_id: 'thr-2', status: 'sent', subject: 'Re: Renewal', to_emails: ['sam@acme.com'], body_text: 'Sending the renewal doc.', email_thread: { folder: 'inbox' } },
    ])
    const item = workItem({
      id: 'job-mail',
      kind: 'email_drafts',
      status: 'needs_review',
      deliverables: [
        { type: 'email_draft', id: 'd2000000-0000-4000-8000-000000000002', label: 'Re: Renewal' },
        { type: 'email_draft', id: 'd1000000-0000-4000-8000-000000000001', label: 'Re: Pricing' },
        // A draft that has since been deleted simply drops out.
        { type: 'email_draft', id: 'gone', label: 'Re: Gone' },
      ],
    })

    const out = await loadWorkOutput(fake as never, item)
    expect(out.drafts).toEqual([
      { id: 'd2000000-0000-4000-8000-000000000002', subject: 'Re: Renewal', to: ['sam@acme.com'], snippet: 'Sending the renewal doc.', status: 'sent' },
      { id: 'd1000000-0000-4000-8000-000000000001', subject: 'Re: Pricing', to: ['dana@acme.com'], snippet: 'Hi Dana, That works.', status: 'pending_review' },
    ])
    expect(out.cards).toEqual([])
    expect(out.narrative).toBeNull()
  })

  it('a draft the email tools made is delivered by its provider id: read from its review row (provider_draft_id; the item’s workspace wins)', async () => {
    const fake = makeFakeSupabase()
    const ROW = 'd1000000-0000-4000-8000-000000000001'
    fake.seed('email_draft', [
      { id: ROW, provider_thread_id: 'thr-1', status: 'pending_review', subject: 'Re: Pricing', to_emails: ['dana@acme.com'], body_text: 'That works.', email_thread: { folder: 'inbox' } },
      { id: 'd1000000-0000-4000-8000-000000000009', workspace_id: 'ws-other', provider_draft_id: '1a0e8b6b5baa5eb0', provider_thread_id: 'thr-g', status: 'pending_review', subject: 'Heads-up (elsewhere)', to_emails: ['etienne@corvanne.com'], body_text: 'x', email_thread: { folder: 'drafts' } },
      { id: 'd1000000-0000-4000-8000-000000000002', workspace_id: 'ws-1', provider_draft_id: '1a0e8b6b5baa5eb0', provider_thread_id: 'thr-g', status: 'pending_review', subject: 'Heads-up', to_emails: ['etienne@corvanne.com'], body_text: 'Hi Etienne,\n\nContext.', email_thread: { folder: 'drafts' } },
    ])
    fake.seed('email_thread_index', [
      // The sync indexed it under another workspace that lists the same mailbox…
      { workspace_id: 'ws-other', provider_thread_id: 'thr-g', provider_message_id: '1a0e8b6b5baa5eb0', subject: 'Heads-up (elsewhere)', to_emails: ['etienne@corvanne.com'], snippet: 'x', folder: 'drafts' },
      // …and the tool indexed it in the item's.
      { workspace_id: 'ws-1', provider_thread_id: 'thr-g', provider_message_id: '1a0e8b6b5baa5eb0', subject: 'Heads-up', to_emails: ['etienne@corvanne.com'], snippet: 'Hi Etienne,\n\nContext.', folder: 'drafts' },
    ])
    const item = workItem({
      id: 'job-work',
      kind: 'work_run',
      status: 'needs_review',
      workspace_id: 'ws-1',
      deliverables: [
        { type: 'email_draft', id: '1a0e8b6b5baa5eb0', label: 'Heads-up' },
        { type: 'email_draft', id: ROW, label: 'Re: Pricing' },
      ],
    })

    const out = await loadWorkOutput(fake as never, item)
    expect(out.drafts).toEqual([
      { id: '1a0e8b6b5baa5eb0', subject: 'Heads-up', to: ['etienne@corvanne.com'], snippet: 'Hi Etienne, Context.', status: 'pending_review' },
      { id: ROW, subject: 'Re: Pricing', to: ['dana@acme.com'], snippet: 'That works.', status: 'pending_review' },
    ])
    // The uuid column only ever sees uuids (a provider id there is a query error on Postgres).
    const idFilters = fake.calls.filter((c) => c.table === 'email_draft').flatMap((c) => c.filters.filter(([col]) => col === 'id').map(([, v]) => v)).flat()
    expect(idFilters).toEqual([ROW])
  })

  it('an older tool draft with no review row falls back to its index row: thread and folder only, no subject or preview', async () => {
    const fake = makeFakeSupabase()
    fake.seed('email_thread_index', [
      { workspace_id: 'ws-other', provider_thread_id: 'thr-g', provider_message_id: '1a0e8b6b5baa5eb0', subject: 'Heads-up', to_emails: ['etienne@corvanne.com'], snippet: 'Hi', folder: 'drafts' },
    ])
    const rows = await loadDraftRows(fake as never, { workspace_id: 'ws-1', deliverables: [{ type: 'email_draft', id: '1a0e8b6b5baa5eb0', label: 'Heads-up' }] })
    expect(rows).toEqual([
      { id: '1a0e8b6b5baa5eb0', provider_thread_id: 'thr-g', provider_draft_id: '1a0e8b6b5baa5eb0', status: null, subject: null, to_emails: [], body_text: null, email_thread: { folder: 'drafts' } },
    ])
  })
})

describe('loadWorkOutput — a mirrored run (Sequence row 6)', () => {
  it('reads a prospecting run’s progress and spend into What happened; a budget stop says why', async () => {
    const fake = makeFakeSupabase()
    fake.seed('prospecting_run', [
      {
        id: 'pr-1',
        kind: 'discover',
        status: 'budget_exhausted',
        error: 'run_cap',
        progress: { found: 40, round: 2, new: 12, suppressed: 28 },
        spent_dollars: 1.5,
        exa_calls: 6,
      },
    ])
    const item = workItem({ id: 'job-p', kind: 'prospecting', source: { prospecting_run_id: 'pr-1', list_id: 'l1' } })
    const out = await loadWorkOutput(fake as never, item)
    expect(out.narrative).toBe('Found 40 companies over 2 rounds: 12 new, 28 already known. Spent $1.50 on 6 searches.')
    expect(out.error).toBe('The run stopped at its own budget; what it found is kept.')
  })

  it('reads an eval run’s trials, verdict and cost; a user cancel is not an error', async () => {
    const fake = makeFakeSupabase()
    fake.seed('eval_run', [
      { id: 'er-1', status: 'completed', outcome: 'failed', progress: { trials_done: 4, trials_total: 4 }, cost_usd: 0.4 },
      { id: 'er-2', status: 'cancelled', outcome: null, error_code: 'cancelled', error_message: 'Cancelled by user', progress: { trials_done: 1, trials_total: 4 } },
    ])
    const done = await loadWorkOutput(fake as never, workItem({ id: 'job-e1', kind: 'eval', source: { eval_run_id: 'er-1' } }))
    expect(done.narrative).toBe('Ran 4 of 4 trials: some trials failed. Cost $0.40.')
    expect(done.error).toBeNull()
    const cancelled = await loadWorkOutput(fake as never, workItem({ id: 'job-e2', kind: 'eval', source: { eval_run_id: 'er-2' } }))
    expect(cancelled.narrative).toBe('Ran 1 of 4 trials.')
    expect(cancelled.error).toBeNull()
  })

  it('says nothing about a run stopped before its first unit of work', async () => {
    const fake = makeFakeSupabase()
    fake.seed('prospecting_run', [{ id: 'pr-q', kind: 'discover', status: 'canceled', error: null, progress: { round: 0, found: 0 }, spent_dollars: 0, exa_calls: 0 }])
    fake.seed('eval_run', [{ id: 'er-q', status: 'cancelled', outcome: null, error_code: 'cancelled', progress: { trials_done: 0, trials_total: 1 } }])
    const p = await loadWorkOutput(fake as never, workItem({ id: 'job-pq', kind: 'prospecting', source: { prospecting_run_id: 'pr-q' } }))
    expect(p.narrative).toBeNull()
    const e = await loadWorkOutput(fake as never, workItem({ id: 'job-eq', kind: 'eval', source: { eval_run_id: 'er-q' } }))
    expect(e.narrative).toBeNull()
  })

  it('shows the research brief only for the session the row mirrors', async () => {
    const fake = makeFakeSupabase()
    fake.seed('member', [
      { id: 'm1', onboarding_progress: { research: { sessionId: 'sess-1', brief: 'You sell to ops teams.' } } },
    ])
    const mine = workItem({ id: 'job-o', kind: 'onboarding_research', member_id: 'm1', source: { eve_session_id: 'sess-1' } })
    expect((await loadWorkOutput(fake as never, mine)).narrative).toBe('You sell to ops teams.')
    const stale = workItem({ id: 'job-o2', kind: 'onboarding_research', member_id: 'm1', source: { eve_session_id: 'sess-0' } })
    expect((await loadWorkOutput(fake as never, stale)).narrative).toBeNull()
  })
})

describe('loadWorkOutput — a mirrored run, wave 2 (Sequence row 11)', () => {
  it('reads an enrolment’s sends and next due date; a failed drip says which send failed', async () => {
    const fake = makeFakeSupabase()
    fake.seed('sequence_enrollment', [
      { id: 'en-1', status: 'active', exit_reason: null, contact_email: 'dana@acme.com', next_send_at: '2026-10-03T14:00:00Z' },
      { id: 'en-2', status: 'exited', exit_reason: 'failed', contact_email: 'lee@acme.com', next_send_at: null },
    ])
    fake.seed('sequence_send', [
      { enrollment_id: 'en-1', status: 'sent', error: null, sent_at: '2026-09-26T14:00:00Z', updated_at: '2026-09-26T14:00:00Z' },
      { enrollment_id: 'en-1', status: 'sent', error: null, sent_at: '2026-09-29T14:00:00Z', updated_at: '2026-09-29T14:00:00Z' },
      { enrollment_id: 'en-2', status: 'failed', error: 'Mailbox not found (550)', sent_at: null, updated_at: '2026-09-29T14:00:00Z' },
    ])
    const active = await loadWorkOutput(fake as never, workItem({ id: 'job-s1', kind: 'sequence_enrolment', status: 'running', source: { enrollment_id: 'en-1' } }))
    expect(active.narrative).toBe('Sent 2 emails to dana@acme.com, the last on Sep 29, 2026. The next is due Oct 3, 2026.')
    expect(active.error).toBeNull()
    const failed = await loadWorkOutput(fake as never, workItem({ id: 'job-s2', kind: 'sequence_enrolment', status: 'failed', source: { enrollment_id: 'en-2' } }))
    expect(failed.narrative).toBe('Sent 0 emails to lee@acme.com.')
    expect(failed.error).toBe('Mailbox not found (550)')
  })

  it('describes a sweep from its own record lists, and a manual Enrich from the record it ran on', async () => {
    const fake = makeFakeSupabase()
    fake.seed('contact', [{ id: 'c1', enrichment_status: 'failed', metadata: { enrichment: { error: 'Search returned nothing usable' } } }])
    const sweep = await loadWorkOutput(fake as never, workItem({ id: 'job-sw', kind: 'crm_enrichment', source: { sweep: true, contact_ids: ['a', 'b'], company_ids: ['c'] } }))
    expect(sweep.narrative).toBe('The background sweep searched the web for 2 contacts and 1 company, one paid search each, and filled only empty fields.')
    const manual = await loadWorkOutput(fake as never, workItem({ id: 'job-m', kind: 'crm_enrichment', source: { table: 'contact', record_id: 'c1' } }))
    expect(manual.error).toBe('Search returned nothing usable')
    const gone = await loadWorkOutput(fake as never, workItem({ id: 'job-g', kind: 'crm_enrichment', source: { table: 'contact', record_id: 'deleted' } }))
    expect(gone.narrative).toBeNull()
  })

  it('reads an import’s totals only while its run is the latest, since the sync state holds only that one', async () => {
    const fake = makeFakeSupabase()
    fake.seed('crm_sync_state', [
      {
        account_id: 'acct-hub',
        initial_import_status: 'failed',
        initial_import_started_at: '2026-09-28T09:00:00+00:00',
        total_companies_synced: 1200,
        total_contacts_synced: 1,
        last_sync_error: 'HubSpot 429',
      },
    ])
    fake.seed('email_sync_state', [
      { account_id: null, user_id: 'u-1', provider: 'microsoft', initial_import_started_at: '2026-09-28T09:00:00Z', total_messages_synced: 3400, oldest_message_synced_at: '2025-09-28T00:00:00Z' },
    ])
    const hub = (runKey: string) => workItem({ id: 'job-h', kind: 'crm_import', run_key: runKey, source: { provider: 'hubspot', account_id: 'acct-hub' } })
    const latest = await loadWorkOutput(fake as never, hub('hubspot:acct-hub:2026-09-28T09:00:00.000Z'))
    expect(latest.narrative).toBe('Imported 1,200 companies and 1 contact from HubSpot before it stopped.')
    expect(latest.error).toBe('HubSpot 429')
    // Finished: the row's own summary says it all.
    fake.rows('crm_sync_state')[0].initial_import_status = 'complete'
    expect((await loadWorkOutput(fake as never, hub('hubspot:acct-hub:2026-09-28T09:00:00.000Z'))).narrative).toBeNull()
    fake.rows('crm_sync_state')[0].initial_import_status = 'importing_contacts'
    expect((await loadWorkOutput(fake as never, hub('hubspot:acct-hub:2026-09-28T09:00:00.000Z'))).narrative).toBe('Imported 1,200 companies and 1 contact from HubSpot so far.')
    const older = await loadWorkOutput(fake as never, hub('hubspot:acct-hub:2026-09-20T09:00:00.000Z'))
    expect(older).toMatchObject({ narrative: null, error: null })

    const mail = await loadWorkOutput(
      fake as never,
      workItem({ id: 'job-em', kind: 'email_import', run_key: 'email:u-1:microsoft:2026-09-28T09:00:00.000Z', source: { provider: 'microsoft', account_id: null, account_key: 'u-1:microsoft' } }),
    )
    expect(mail.narrative).toBe('Imported 3,400 messages, back to Sep 28, 2025.')
  })
})
