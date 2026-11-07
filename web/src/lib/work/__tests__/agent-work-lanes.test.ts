/**
 * The Agents page's reading of the feed (agent-work-lanes.ts): owners (a
 * teammate, or the lane named for itself, never "You"), the filters, Stop's
 * route, the attempt marks, the roster's numbers, and the lanes under a
 * roster filter (Needs you lists only the entry's own waiting rows, so it
 * always counts what the entry's "N waiting" counts).
 */
import { describe, it, expect } from 'vitest'
import type { WorkItem } from '../types'
import {
  beckoningFor,
  cardLookupRows,
  cardMentions,
  cardOwnerKeys,
  countByOwner,
  filtersOwners,
  hasDot,
  mayBeckon,
  notOpenedYet,
  isAttempt,
  keepCard,
  keepItem,
  lanesIn,
  ownerOf,
  partitionForOwner,
  reviewOutcome,
  stopRouteOf,
  WORK_LANE_LABELS,
} from '../agent-work-lanes'
import { ROUTED_WORK_ROLES } from '../system-teammates'

function item(over: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'flow_run',
    title: 't',
    status: 'running',
    actor: 'agent',
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
    created_at: '2026-09-27T10:00:00.000Z',
    started_at: null,
    finished_at: null,
    reviewed_at: null,
    last_beat_at: '2026-09-27T10:00:00.000Z',
    deadline_at: null,
    ...over,
  }
}

/** An owner filter naming these roster entries. */
const keys = (...k: string[]): ReadonlySet<string> => new Set(k)

describe('ownerOf', () => {
  it('is the stamped teammate when there is one', () => {
    expect(
      ownerOf(item({ id: 'a', ai_team_member_id: 'tm1', teammate: { id: 'tm1', name: 'Writer', is_system: false, system_key: null } })),
    ).toEqual({ type: 'teammate', key: 'tm:tm1', id: 'tm1', name: 'Writer' })
  })

  it('is the lane, named for itself, when there is none (never "You")', () => {
    expect(ownerOf(item({ id: 's', kind: 'sequence_enrolment' }))).toMatchObject({ type: 'lane', key: 'lane:sequence_enrolment', label: 'Sequences' })
    expect(ownerOf(item({ id: 'c', kind: 'crm_import' }))).toMatchObject({ label: 'CRM import' })
    expect(ownerOf(item({ id: 'm', kind: 'email_import' }))).toMatchObject({ label: 'Email import' })
    // An older AI row with no teammate (from before its bot) is named by its kind.
    expect(ownerOf(item({ id: 'p', kind: 'prospecting' }))).toMatchObject({ type: 'lane', key: 'lane:prospecting', label: 'Prospecting' })
    expect(ownerOf(item({ id: 'e', kind: 'eval' }))).toMatchObject({ label: 'Eval run' })
    expect(ownerOf(item({ id: 'l', kind: 'flow_run' }))).toMatchObject({ type: 'lane', label: 'Loop' })
    for (const kind of ['prospecting', 'eval', 'onboarding_research', 'flow_run', 'skill_run', 'sequence_enrolment', 'crm_import', 'email_import']) {
      expect(JSON.stringify(ownerOf(item({ id: kind, kind })))).not.toMatch(/\bYou\b/)
    }
  })

  it('names lanes for the non-AI kinds alone: every AI run comes from a bot (bots-v4 Phase 5)', () => {
    expect(Object.keys(WORK_LANE_LABELS).sort()).toEqual(['crm_import', 'email_import', 'sequence_enrolment'])
    for (const kind of Object.keys(ROUTED_WORK_ROLES)) expect(WORK_LANE_LABELS).not.toHaveProperty(kind)
  })

  it('names a teammate the list cannot name yet generically, keyed by id', () => {
    expect(ownerOf(item({ id: 'a', ai_team_member_id: 'tm9' }))).toMatchObject({ key: 'tm:tm9', name: 'Teammate' })
  })
})

describe('keepItem / keepCard', () => {
  const rows = [
    item({ id: 'triage-run', flow_run_id: 'fr1', ai_team_member_id: 'triage', status: 'done' }),
    item({ id: 'prosp', kind: 'prospecting', workspace_id: 'w2' }),
  ]

  it('filters rows by workspace and by owner', () => {
    expect(rows.filter((r) => keepItem(r, { workspaceId: null, ownerKeys: null })).map((r) => r.id)).toEqual(['triage-run', 'prosp'])
    expect(rows.filter((r) => keepItem(r, { workspaceId: 'w1', ownerKeys: null })).map((r) => r.id)).toEqual(['triage-run'])
    expect(rows.filter((r) => keepItem(r, { workspaceId: null, ownerKeys: keys('lane:prospecting') })).map((r) => r.id)).toEqual(['prosp'])
    expect(rows.filter((r) => keepItem(r, { workspaceId: 'w1', ownerKeys: keys('lane:prospecting') }))).toEqual([])
  })

  // bots-v4.md decision 9: a card is the raiser's only; the teammate it
  // proposes for the work is only mentioned (its page shows it read-only).
  it('gives a card to the run that wrote it, never to the teammate it proposes (that one is only mentioned)', () => {
    const card = { workspace_id: 'w1', source_flow_run_id: 'fr1', payload: { assignee_ai_member_id: 'writer' } }
    expect(cardOwnerKeys(card, rows)).toEqual(['tm:triage'])
    expect(cardMentions(card, rows)).toEqual(['writer'])
    expect(keepCard(card, rows, { workspaceId: null, ownerKeys: keys('tm:triage') })).toBe(true)
    expect(keepCard(card, rows, { workspaceId: null, ownerKeys: keys('tm:writer') })).toBe(false)
    expect(keepCard(card, rows, { workspaceId: null, ownerKeys: keys('tm:researcher') })).toBe(false)
    expect(keepCard(card, rows, { workspaceId: 'w2', ownerKeys: null })).toBe(false)
    expect(cardOwnerKeys({ source_flow_run_id: 'unknown', payload: null }, rows)).toEqual([])
  })

  // Bots v3 1a: the card names who raised it at insert, so it is that bot's
  // before the run back-link lands (and on a local run, which had none).
  it('gives a card to the teammate it names as raising it, with source_flow_run_id still null', () => {
    const fresh = { workspace_id: 'w1', source_flow_run_id: null, payload: { raised_by_ai_member_id: 'triage' } }
    expect(cardOwnerKeys(fresh, rows)).toEqual(['tm:triage'])
    expect(keepCard(fresh, rows, { workspaceId: null, ownerKeys: keys('tm:triage') })).toBe(true)
    expect(keepCard(fresh, rows, { workspaceId: null, ownerKeys: keys('lane:flow_run') })).toBe(false)
    // It counts for that teammate's bot, as its pending card.
    const counts = countByOwner([], [{ id: 'card-1', ...fresh }])
    expect(counts.get('tm:triage')).toEqual({ running: 0, needsYou: 1, beckoning: ['card-1'] })
    // The teammate a work proposal names is mentioned, never an owner.
    const proposal = { source_flow_run_id: null, payload: { raised_by_ai_member_id: 'triage', assignee_ai_member_id: 'writer' } }
    expect(cardOwnerKeys(proposal, rows)).toEqual(['tm:triage'])
    expect(cardMentions(proposal, rows)).toEqual(['writer'])
  })

  it('reads the raised-by key first, over the run the card was back-linked to', () => {
    const laneRun = [item({ id: 'my-loop', flow_run_id: 'fr9', ai_team_member_id: null, status: 'done' })]
    const card = { source_flow_run_id: 'fr9', payload: { raised_by_ai_member_id: 'triage' } }
    expect(cardOwnerKeys(card, laneRun)).toEqual(['tm:triage'])
    // Without the key, the back-linked run's owner (here its lane) is the card's, as before.
    expect(cardOwnerKeys({ source_flow_run_id: 'fr9', payload: {} }, laneRun)).toEqual(['lane:flow_run'])
  })

  it('a set filter keeps what any of its entries owns (one bot, every teammate wearing it); empty is everyone', () => {
    const more = [
      ...rows,
      item({ id: 'writer-w1', ai_team_member_id: 'writer-w1', status: 'needs_review' }),
      item({ id: 'writer-w2', workspace_id: 'w2', ai_team_member_id: 'writer-w2', status: 'needs_review' }),
    ]
    const both = keys('tm:writer-w1', 'tm:writer-w2')
    expect(more.filter((r) => keepItem(r, { workspaceId: null, ownerKeys: both })).map((r) => r.id)).toEqual(['writer-w1', 'writer-w2'])
    expect(more.filter((r) => keepItem(r, { workspaceId: 'w2', ownerKeys: both })).map((r) => r.id)).toEqual(['writer-w2'])
    expect(more.filter((r) => keepItem(r, { workspaceId: null, ownerKeys: keys() })).length).toBe(more.length)
    expect(filtersOwners(null)).toBe(false)
    expect(filtersOwners(keys())).toBe(false)
    expect(filtersOwners(both)).toBe(true)
    const proposal = { workspace_id: 'w2', source_flow_run_id: null, payload: { raised_by_ai_member_id: 'writer-w2', assignee_ai_member_id: 'triage' } }
    expect(keepCard(proposal, more, { workspaceId: null, ownerKeys: both })).toBe(true)
    expect(keepCard(proposal, more, { workspaceId: null, ownerKeys: keys('tm:writer-w1', 'tm:triage') })).toBe(false)
  })
})

describe('stopRouteOf', () => {
  it('routes an agent run through its action, or the run itself', () => {
    expect(stopRouteOf(item({ id: 'a', agent_run_id: 'r1', source: { action_id: 'act1' } }))).toBe(
      '/api/account/actions/act1/agent-runs/r1/cancel',
    )
    expect(stopRouteOf(item({ id: 'b', agent_run_id: 'r2' }))).toBe('/api/account/agent-runs/r2/cancel')
  })

  it('routes prospecting and eval runs to their own cancel paths', () => {
    expect(stopRouteOf(item({ id: 'p', kind: 'prospecting', source: { prospecting_run_id: 'pr1' } }))).toBe(
      '/api/account/prospecting/runs/pr1/cancel',
    )
    expect(stopRouteOf(item({ id: 'e', kind: 'eval', status: 'queued', source: { eval_run_id: 'er1' } }))).toBe(
      '/api/account/evals/runs/er1/cancel',
    )
  })

  it('offers nothing for a settled row, or a live row nothing can stop', () => {
    expect(stopRouteOf(item({ id: 'd', kind: 'prospecting', status: 'done', source: { prospecting_run_id: 'pr1' } }))).toBeNull()
    expect(stopRouteOf(item({ id: 'c', status: 'canceled', agent_run_id: 'r1' }))).toBeNull()
    expect(stopRouteOf(item({ id: 'l', kind: 'flow_run' }))).toBeNull()
    expect(stopRouteOf(item({ id: 'o', kind: 'onboarding_research' }))).toBeNull()
    expect(stopRouteOf(item({ id: 'x', kind: 'eval', source: { prospecting_run_id: 'pr1' } }))).toBeNull()
  })

  it('stops a local agent’s turn through its session (live, its question included)', () => {
    const sid = '11111111-2222-4333-8444-555555555555'
    const local = (over: Partial<WorkItem> = {}) => item({ id: 'la', kind: 'local_agent', source: { local_agent_session_id: sid }, ...over })
    expect(stopRouteOf(local())).toBe(`/api/local-agent/sessions/${sid}/stop`)
    expect(stopRouteOf(local({ status: 'queued' }))).toBe(`/api/local-agent/sessions/${sid}/stop`)
    expect(stopRouteOf(local({ status: 'needs_input' }))).toBe(`/api/local-agent/sessions/${sid}/stop`)
    expect(stopRouteOf(local({ status: 'needs_review' }))).toBeNull()
    expect(stopRouteOf(local({ source: {} }))).toBeNull()
  })
})

describe('attempt marks', () => {
  it('reads origin and the review outcome', () => {
    expect(isAttempt(item({ id: 'a', origin: 'attempt' }))).toBe(true)
    expect(isAttempt(item({ id: 'u', origin: 'user' }))).toBe(false)
    expect(isAttempt(item({ id: 'n' }))).toBe(false)
    expect(reviewOutcome(item({ id: 'a', progress: { review: 'dismissed' } }))).toBe('dismissed')
    expect(reviewOutcome(item({ id: 'b', progress: {} }))).toBeNull()
  })
})

describe('roster numbers and lanes', () => {
  it('counts running and waiting rows per owner, and lists the lanes present', () => {
    const rows = [
      item({ id: '1', ai_team_member_id: 'w', status: 'running' }),
      item({ id: '2', ai_team_member_id: 'w', status: 'needs_review' }),
      item({ id: '3', ai_team_member_id: 'w', status: 'needs_input' }),
      item({ id: '4', ai_team_member_id: 'w', status: 'done' }),
      item({ id: '5', kind: 'prospecting', status: 'queued' }),
      item({ id: '6', kind: 'skill_run', status: 'done' }),
      item({ id: '7', kind: 'sequence_enrolment', status: 'done' }),
    ]
    const counts = countByOwner(rows)
    // A parked question still beckons (the bubble lists it) but asks in the chat, not with the dot (P13).
    expect(counts.get('tm:w')).toEqual({ running: 1, needsYou: 2, beckoning: ['2', '3'], asking: ['3'] })
    expect(counts.get('lane:prospecting')).toEqual({ running: 1, needsYou: 0, beckoning: [] })
    // Named lanes first (the non-AI kinds), then older rows' lanes by their kind's name.
    expect(lanesIn(rows).map((l) => l.label)).toEqual(['Sequences', 'Prospecting', 'Skill run'])
  })

  it('a handoff reviewed with its root does not count as waiting for its teammate (row 14)', () => {
    const rows = [
      item({ id: 'r', ai_team_member_id: 'c', status: 'needs_review' }),
      item({ id: 'k', ai_team_member_id: 'res', status: 'needs_review', parent_id: 'r', root_id: 'r' }),
      item({ id: 'f', ai_team_member_id: 'w', status: 'failed' }),
      item({ id: 'k2', ai_team_member_id: 'res', status: 'needs_review', parent_id: 'f', root_id: 'f' }),
    ]
    const counts = countByOwner(rows)
    expect(counts.get('tm:c')).toEqual({ running: 0, needsYou: 1, beckoning: ['r'] })
    // The first handoff folds into its root's review; the second's root failed, so it waits on its own.
    expect(counts.get('tm:res')).toEqual({ running: 0, needsYou: 1, beckoning: ['k2'] })
  })
})

describe('roster numbers with the attention cards (bot-characters.md Step 3)', () => {
  function card(id: string, over: { source_flow_run_id?: string | null; assignee?: string | null; workspace_id?: string } = {}) {
    return {
      id,
      workspace_id: over.workspace_id ?? 'w1',
      source_flow_run_id: over.source_flow_run_id ?? null,
      payload: over.assignee ? { assignee_ai_member_id: over.assignee } : {},
    }
  }
  const triage = { id: 'triage', name: 'Triage', is_system: true, system_key: 'triage' }

  it('counts a loop card for the run’s owner once the run back-fills it, and for no one before', () => {
    const rows = [item({ id: 'loop', kind: 'flow_run', flow_run_id: 'fr1', ai_team_member_id: 'triage', teammate: triage, status: 'running' })]
    // A fresh loop card: no source_flow_run_id yet, no proposed teammate.
    const fresh = card('c1')
    expect(countByOwner(rows, [fresh]).get('tm:triage')).toEqual({ running: 1, needsYou: 0, beckoning: [] })
    // The run back-fills it (the attention hook applies the UPDATE).
    const backFilled = { ...fresh, source_flow_run_id: 'fr1' }
    expect(countByOwner(rows, [backFilled]).get('tm:triage')).toEqual({ running: 1, needsYou: 1, beckoning: ['c1'] })
  })

  // bots-v4.md decision 9: only the raiser counts it, wears the dot and peeks.
  it('counts a work proposal for the run that wrote it only, never for the teammate it proposes', () => {
    const rows = [item({ id: 'loop', flow_run_id: 'fr1', ai_team_member_id: 'triage', teammate: triage, status: 'done' })]
    const proposal = card('p1', { source_flow_run_id: 'fr1', assignee: 'writer' })
    const counts = countByOwner(rows, [proposal])
    expect(counts.get('tm:writer')).toBeUndefined()
    expect(counts.get('tm:triage')).toEqual({ running: 0, needsYou: 1, beckoning: ['p1'] })
    expect(cardMentions(proposal, rows)).toEqual(['writer'])
    // A proposal that names the run's own teammate is counted once for it, and mentions no one.
    const ownCard = card('p2', { source_flow_run_id: 'fr1', assignee: 'triage' })
    const own = countByOwner(rows, [ownCard])
    expect(own.get('tm:triage')).toEqual({ running: 0, needsYou: 1, beckoning: ['p2'] })
    expect(cardMentions(ownCard, rows)).toEqual([])
    // A card with no raiser known yet (no key, run not back-filled) has no owner, and still mentions its teammate.
    const early = card('p3', { assignee: 'writer' })
    expect(countByOwner([], [early]).size).toBe(0)
    expect(cardMentions(early, [])).toEqual(['writer'])
  })

  it('a loop run and its cards are its cards: the settled run adds nothing, as in the deck', () => {
    // A verdict run settles done with "2 cards for you" (flow-results.ts reviewFor).
    const rows = [
      item({
        id: 'loop',
        flow_run_id: 'fr1',
        ai_team_member_id: 'triage',
        teammate: triage,
        status: 'done',
        deliverables: [{ type: 'attention_cards', id: 'fr1', label: '2 cards for you', count: 2 }],
      }),
    ]
    const counts = countByOwner(rows, [card('c1', { source_flow_run_id: 'fr1' }), card('c2', { source_flow_run_id: 'fr1' })])
    expect(counts.get('tm:triage')).toEqual({ running: 0, needsYou: 2, beckoning: ['c1', 'c2'] })
  })

  // bots-v4.md Phase 3: the drafting pass finishes done (its drafts in Mail),
  // so it waits on no one and never beckons; there is no quiet flag any more.
  it('a finished email drafting pass waits on no one and never beckons; every waiting row not opened may', () => {
    const rows = [
      item({
        id: 'pass',
        kind: 'email_drafts',
        ai_team_member_id: 'corr',
        status: 'done',
        deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: pricing' }],
      }),
      item({ id: 'work', kind: 'work_run', ai_team_member_id: 'corr', status: 'needs_review' }),
      item({ id: 'ask', kind: 'work_run', ai_team_member_id: 'corr', status: 'needs_input' }),
    ]
    expect(countByOwner(rows).get('tm:corr')).toEqual({ running: 0, needsYou: 2, beckoning: ['work', 'ask'], asking: ['ask'] })
    // The dot (P13): something new that isn't a parked question; a question alone asks in the chat.
    expect(hasDot(countByOwner(rows).get('tm:corr'))).toBe(true)
    expect(hasDot(countByOwner([rows[2]]).get('tm:corr'))).toBe(false)
    expect(hasDot(undefined)).toBe(false)
    expect(mayBeckon({ opened_at: null })).toBe(true)
    expect(mayBeckon({ opened_at: '2026-10-07T10:00:00.000Z' })).toBe(false)
  })

  it('keys the same role’s teammates in two workspaces apart', () => {
    const rows = [
      item({ id: 'a', workspace_id: 'w1', ai_team_member_id: 'writer-w1', status: 'needs_review' }),
      item({ id: 'b', workspace_id: 'w2', ai_team_member_id: 'writer-w2', status: 'running', flow_run_id: 'fr2' }),
    ]
    const counts = countByOwner(rows, [card('c', { workspace_id: 'w2', source_flow_run_id: 'fr2' })])
    expect(counts.get('tm:writer-w1')).toEqual({ running: 0, needsYou: 1, beckoning: ['a'] })
    expect(counts.get('tm:writer-w2')).toEqual({ running: 1, needsYou: 1, beckoning: ['c'] })
  })

  it('finds a card’s run in the lookup rows when it is outside the counted rows', () => {
    const outside = item({ id: 'old-loop', flow_run_id: 'fr9', ai_team_member_id: 'triage', teammate: triage, status: 'done' })
    const open = [item({ id: 'x', ai_team_member_id: 'writer', status: 'running' })]
    const cards = [card('c9', { source_flow_run_id: 'fr9' })]
    expect(countByOwner(open, cards).get('tm:triage')).toBeUndefined()
    expect(countByOwner(open, cards, cardLookupRows(open, [outside])).get('tm:triage')).toEqual({ running: 0, needsYou: 1, beckoning: ['c9'] })
    // Each row once.
    expect(cardLookupRows(open, [open[0], outside]).map((r) => r.id)).toEqual(['x', 'old-loop'])
  })

  it('an opened row (migration 295) stops beckoning, still waiting; a question too; cards are never "opened"', () => {
    expect(notOpenedYet({})).toBe(true)
    expect(notOpenedYet({ opened_at: null })).toBe(true)
    expect(notOpenedYet({ opened_at: '2026-09-30T10:00:00.000Z' })).toBe(false)
    const rows = [
      item({ id: 'seen-review', ai_team_member_id: 'w', status: 'needs_review', opened_at: '2026-09-30T10:00:00.000Z' }),
      item({ id: 'seen-ask', ai_team_member_id: 'w', status: 'needs_input', opened_at: '2026-09-30T10:01:00.000Z' }),
      item({ id: 'new-review', ai_team_member_id: 'w', status: 'needs_review', opened_at: null }),
      item({ id: 'new-ask', ai_team_member_id: 'w', status: 'needs_input' }),
      item({ id: 'loop', flow_run_id: 'fr1', ai_team_member_id: 'w', status: 'done', opened_at: '2026-09-30T10:02:00.000Z' }),
    ]
    // The loop's row was opened, but its pending card is still new.
    expect(countByOwner(rows, [card('c1', { source_flow_run_id: 'fr1' })]).get('tm:w')).toEqual({
      running: 0,
      needsYou: 5,
      beckoning: ['new-review', 'new-ask', 'c1'],
      asking: ['new-ask'],
    })
  })
})

describe('beckoningFor (what is new for a set of teammates: one bot, every teammate wearing it)', () => {
  it('is the union of their beckoning, each id once, in the order the owners are named', () => {
    const rows = [
      item({ id: 'a1', ai_team_member_id: 'writer-w1', status: 'needs_review' }),
      item({ id: 'b1', workspace_id: 'w2', ai_team_member_id: 'writer-w2', status: 'needs_input' }),
      item({ id: 'b-seen', workspace_id: 'w2', ai_team_member_id: 'writer-w2', status: 'needs_review', opened_at: '2026-09-30T10:00:00.000Z' }),
      item({ id: 'loop', flow_run_id: 'fr1', ai_team_member_id: 'writer-w1', status: 'done' }),
    ]
    // A card written by writer-w1's run, raised by writer-w2 too (its key): one card, counted for its raiser once.
    const raised = { id: 'p1', source_flow_run_id: 'fr1', payload: { raised_by_ai_member_id: 'writer-w1' } }
    const counts = countByOwner(rows, [raised])
    expect(beckoningFor(counts, ['tm:writer-w1', 'tm:writer-w2'])).toEqual(['a1', 'p1', 'b1'])
    expect(beckoningFor(counts, ['tm:writer-w2', 'tm:writer-w1'])).toEqual(['b1', 'a1', 'p1'])
    expect(beckoningFor(counts, ['tm:writer-w2'])).toEqual(['b1'])
    // An id two owners both hold is one thing waiting.
    const twice = new Map([
      ['tm:a', { running: 0, needsYou: 1, beckoning: ['x'] }],
      ['tm:b', { running: 0, needsYou: 2, beckoning: ['x', 'y'] }],
    ])
    expect(beckoningFor(twice, ['tm:a', 'tm:b'])).toEqual(['x', 'y'])
    expect(beckoningFor(counts, ['tm:nobody'])).toEqual([])
    expect(beckoningFor(counts, [])).toEqual([])
  })
})

describe('partitionForOwner (the lanes under a roster filter)', () => {
  const A = 'tm:a'
  const B = 'tm:b'
  const by = (id: 'a' | 'b') => ({ ai_team_member_id: id, teammate: { id, name: id.toUpperCase(), is_system: false, system_key: null } })
  const ids = (trees: Array<{ item: WorkItem }>) => trees.map((t) => t.item.id)
  const waitingCount = (items: WorkItem[], key: string) => countByOwner(items).get(key)?.needsYou ?? 0

  it('with no filter, is partitionWorkTrees', () => {
    const items = [item({ id: 'q', status: 'needs_input', ...by('a') }), item({ id: 'r', status: 'running', ...by('b') })]
    const out = partitionForOwner(items, null)
    expect(ids(out.needsYou)).toEqual(['q'])
    expect(ids(out.running)).toEqual(['r'])
  })

  it('another owner’s waiting root leaves Needs you, and moves with its tree to Running now or Recent', () => {
    const running = [
      item({ id: 'root', status: 'needs_input', ...by('b') }),
      item({ id: 'child', status: 'running', parent_id: 'root', root_id: 'root', ...by('a') }),
    ]
    const underA = partitionForOwner(running, keys(A))
    expect(ids(underA.needsYou)).toEqual([])
    expect(ids(underA.running)).toEqual(['root'])
    expect(underA.running[0].children.map((c) => c.item.id)).toEqual(['child'])
    expect(underA.needsYou.length).toBe(waitingCount(running, A))
    expect(ids(partitionForOwner(running, keys(B)).needsYou)).toEqual(['root'])

    const settled = [
      item({ id: 'root', status: 'needs_review', ...by('b') }),
      item({ id: 'child', status: 'done', parent_id: 'root', root_id: 'root', ...by('a') }),
    ]
    expect(ids(partitionForOwner(settled, keys(A)).recent)).toEqual(['root'])
  })

  it('another owner’s waiting handoff under this owner’s settled root is not in this owner’s Needs you', () => {
    const items = [
      item({ id: 'root', status: 'done', finished_at: '2026-09-27T11:00:00.000Z', ...by('a') }),
      item({ id: 'child', status: 'needs_review', parent_id: 'root', root_id: 'root', ...by('b') }),
    ]
    const underA = partitionForOwner(items, keys(A))
    expect(ids(underA.needsYou)).toEqual([])
    expect(ids(underA.recent)).toEqual(['root'])
    expect(waitingCount(items, A)).toBe(0)
    const underB = partitionForOwner(items, keys(B))
    expect(ids(underB.needsYou)).toEqual(['child'])
    expect(waitingCount(items, B)).toBe(1)
    // The handoff listed on its own is not also moved: its tree is already in Recent.
    expect(ids(underB.recent)).toEqual(['root'])
  })

  it('keeps Running now and Recent sorted after a move', () => {
    const items = [
      item({ id: 'r1', status: 'running', started_at: '2026-09-27T09:00:00.000Z', ...by('a') }),
      item({ id: 'root', status: 'needs_input', started_at: '2026-09-27T12:00:00.000Z', ...by('b') }),
      item({ id: 'child', status: 'running', parent_id: 'root', root_id: 'root', started_at: '2026-09-27T12:01:00.000Z', ...by('a') }),
      item({ id: 'r2', status: 'running', started_at: '2026-09-27T10:00:00.000Z', ...by('a') }),
    ]
    expect(ids(partitionForOwner(items, keys(A)).running)).toEqual(['root', 'r2', 'r1'])
  })

  it('under a set, Needs you lists every selected owner’s own waiting rows, and their counts add up to it', () => {
    const items = [
      item({ id: 'qa', status: 'needs_input', ...by('a') }),
      item({ id: 'qb', status: 'needs_review', ...by('b') }),
      item({ id: 'lane', kind: 'prospecting', status: 'needs_review' }),
    ]
    const both = partitionForOwner(items, keys(A, B))
    expect(ids(both.needsYou).sort()).toEqual(['qa', 'qb'])
    expect(both.needsYou.length).toBe(waitingCount(items, A) + waitingCount(items, B))
    expect(ids(partitionForOwner(items, keys()).needsYou).sort()).toEqual(['lane', 'qa', 'qb'])
  })
})

describe('lanesIn with the counts’ keys', () => {
  it('adds a lane named only by a key (a card whose run is outside the feed), once, named lanes first', () => {
    const lanes = lanesIn([item({ id: 'l', kind: 'flow_run' })], ['lane:prospecting', 'lane:flow_run', 'lane:crm_import', 'tm:writer'])
    expect(lanes).toEqual([
      { key: 'lane:crm_import', kind: 'crm_import', label: 'CRM import' },
      { key: 'lane:flow_run', kind: 'flow_run', label: 'Loop' },
      { key: 'lane:prospecting', kind: 'prospecting', label: 'Prospecting' },
    ])
  })
})
