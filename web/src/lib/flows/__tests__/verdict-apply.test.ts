/**
 * Verdict apply engine tests (Phase 2, Workstream B).
 *
 * These exercise the CONSEQUENTIAL path — the code that mutates the board from a
 * model verdict. A purpose-built stateful fake Supabase models the real CAS
 * semantics (an UPDATE guarded on status='pending' only "wins" once) so the
 * idempotency + guardrail assertions are meaningful, not rubber-stamped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyVerdict, resolveTrust, type ApplyVerdictContext, type RunVerdict } from '../verdict-apply'
import type { ResolvedTrustPolicy } from '@/lib/proposed-changes/trust-policy'
import { relationNames } from '@/test/table-schema'
import {
  WORK_TASK_MAX_CHARS,
  WORK_TITLE_MAX_CHARS,
  WORK_RESOURCES_MAX,
  WORK_RESOURCE_LABEL_MAX_CHARS,
} from '@/lib/agent-run/types'

// ── applyChange / deleteAppliedEntity are mocked; the engine's JOB is the walk,
//    not re-testing the apply-engine (covered by its own tests). ────────────────
const applyChangeMock = vi.fn()
const deleteAppliedEntityMock = vi.fn()
vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  applyChange: (...a: unknown[]) => applyChangeMock(...a),
  deleteAppliedEntity: (...a: unknown[]) => deleteAppliedEntityMock(...a),
}))

// ── A stateful fake Supabase for proposed_change / actions / comment /
//    attention_item that honors the CAS `.eq('status', X)` guards. ──────────────
interface Row {
  [k: string]: unknown
}
function makeFake(seed: {
  proposals?: Row[]
  actions?: Row[]
  agent_run?: Row[]
  action_github_pr?: Row[]
  comment?: Row[]
  contacts?: Row[]
  participants?: Row[]
  attention_items?: Row[]
}) {
  const tables: Record<string, Row[]> = {
    proposed_change: seed.proposals ?? [],
    actions: seed.actions ?? [],
    agent_run: seed.agent_run ?? [],
    action_github_pr: seed.action_github_pr ?? [],
    comment: seed.comment ?? [],
    contact: seed.contacts ?? [],
    capture_participant: seed.participants ?? [],
    attention_item: seed.attention_items ?? [],
  }

  function builder(table: string) {
    const filters: Array<[string, unknown]> = []
    const gtFilters: Array<[string, unknown]> = []
    const ilikeFilters: Array<[string, string]> = []
    const inFilters: Array<[string, unknown[]]> = []
    let pendingInsert: Row | null = null
    let pendingUpdate: Row | null = null
    let op: 'select' | 'insert' | 'update' = 'select'
    let headCount = false
    let isSingle = false
    let limitN: number | null = null

    const match = (r: Row) =>
      filters.every(([k, v]) => r[k] === v) &&
      inFilters.every(([k, vs]) => vs.includes(r[k])) &&
      ilikeFilters.every(([k, pat]) => {
        const needle = pat.replace(/%/g, '').toLowerCase()
        const hay = typeof r[k] === 'string' ? (r[k] as string).toLowerCase() : ''
        return hay.includes(needle)
      }) &&
      gtFilters.every(([k, v]) => {
        const rv = r[k]
        return typeof rv === 'string' && typeof v === 'string' && rv > v
      })

    const api: Record<string, unknown> = {
      select: (_cols?: unknown, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head || opts?.count) headCount = true
        return api
      },
      eq: (k: string, v: unknown) => {
        filters.push([k, v])
        return api
      },
      gt: (k: string, v: unknown) => {
        gtFilters.push([k, v])
        return api
      },
      in: (k: string, vs: unknown[]) => {
        inFilters.push([k, vs])
        return api
      },
      ilike: (k: string, pattern: unknown) => {
        ilikeFilters.push([k, String(pattern)])
        return api
      },
      limit: (n: number) => {
        limitN = n
        return api
      },
      insert: (row: Row) => {
        op = 'insert'
        // Preserve a caller-supplied id (a deterministic attention_item id); only
        // the terminal defaults a synthetic one when none was given, so the
        // PRIMARY-KEY conflict check can see the real supplied id.
        pendingInsert = { ...row }
        return api
      },
      update: (row: Row) => {
        op = 'update'
        pendingUpdate = row
        return api
      },
      maybeSingle: async () => {
        isSingle = true
        return runTerminal()
      },
      single: async () => {
        isSingle = true
        return runTerminal()
      },
      then: (resolve: (r: unknown) => unknown) => Promise.resolve(runTerminal()).then(resolve),
    }

    function runTerminal(): {
      data?: Row | Row[] | null
      count?: number
      error: { code?: string; message: string } | null
    } {
      // Postgres refuses a table it doesn't have; the fake serves only real
      // tables (checked against the schema below), so it refuses the rest.
      if (!Object.hasOwn(tables, table)) {
        return { data: null, error: { code: '42P01', message: `relation "public.${table}" does not exist` } }
      }
      if (headCount) {
        // .select(cols, { count, head }) → a count of matching rows, no data.
        return { count: tables[table].filter(match).length, error: null }
      }
      if (op === 'insert') {
        if (table === 'attention_item' && pendingInsert) {
          // Enforce attention_item unique (proposal_id, run_key) — the partial
          // uidx that only bites when proposal_id IS NOT NULL.
          const uidxDup = tables.attention_item.find(
            (r) =>
              r.proposal_id != null &&
              r.proposal_id === pendingInsert!.proposal_id &&
              r.run_key === pendingInsert!.run_key,
          )
          if (uidxDup) return { data: null, error: { code: '23505', message: 'duplicate' } }
          // Enforce the PRIMARY KEY on `id` — this is what catches a step-retry
          // re-insert of a proposal_id-less card that supplied a DETERMINISTIC id
          // (the partial uidx above never fires for it). A collision raises the
          // SAME 23505 SQLSTATE, which insertAttentionCard dedups.
          if (pendingInsert.id != null) {
            const pkDup = tables.attention_item.find((r) => r.id === pendingInsert!.id)
            if (pkDup) return { data: null, error: { code: '23505', message: 'duplicate pkey' } }
          }
        }
        // Only default a synthetic id when the caller didn't supply one — a
        // supplied deterministic id must survive so the PK check above can bite.
        if (pendingInsert && pendingInsert.id == null) {
          pendingInsert.id = `${table}_${tables[table].length + 1}`
        }
        tables[table].push(pendingInsert as Row)
        return { data: pendingInsert, error: null }
      }
      if (op === 'update') {
        const target = tables[table].find(match)
        if (!target) return { data: null, error: null } // CAS lost / no match
        Object.assign(target, pendingUpdate)
        return { data: { id: target.id }, error: null }
      }
      // A plain awaited select (no maybeSingle/single) returns an ARRAY, matching
      // supabase-js; single-row terminals return the first match or null.
      const rows = tables[table].filter(match)
      if (isSingle) return { data: rows[0] ?? null, error: null }
      return { data: limitN != null ? rows.slice(0, limitN) : rows, error: null }
    }

    return api
  }

  return {
    from: (table: string) => builder(table),
    _tables: tables,
  }
}

function ctxFor(fake: ReturnType<typeof makeFake>, over: Partial<ApplyVerdictContext> = {}): ApplyVerdictContext {
  return {
    supabase: fake as never,
    workspaceId: 'ws1',
    memberId: 'm1',
    userId: 'u1',
    mode: 'act',
    trust: resolveTrust({ auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 3 }),
    runKey: 'fire1',
    flowRunId: null,
    // P13: a run that carded something asks for ONE batched home-thread message (home-asks.ts).
    requestHomeAsks: homeAsks,
    ...over,
  }
}
const homeAsks = vi.fn(async (_args: { workspaceId: string; userId: string }) => {})

const nowIso = () => new Date().toISOString()
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

beforeEach(() => {
  applyChangeMock.mockReset()
  deleteAppliedEntityMock.mockReset()
  homeAsks.mockClear()
})

describe('P13: a run’s suggestions ask in the home thread, batched', () => {
  it('a run that carded anything asks for one home-thread message; one that carded nothing asks for none', async () => {
    const fake = makeFake({})
    await applyVerdict(
      {
        decisions: [],
        needs_user: [
          { kind: 'question', title: 'Is Northwind a customer or a partner?', why: 'Two calls disagree.', confidence: 0.9 },
          { kind: 'work_proposal', title: 'Draft the Acme recap', why: 'Asked for on the call.', payload: { task: 'Draft the recap for Acme' }, confidence: 0.9 },
        ],
        summary: 's',
      } as never,
      ctxFor(fake),
    )
    expect(homeAsks).toHaveBeenCalledTimes(1)
    expect(homeAsks).toHaveBeenCalledWith({ workspaceId: 'ws1', userId: 'u1' })
    homeAsks.mockClear()
    await applyVerdict({ decisions: [], needs_user: [], summary: 's' } as never, ctxFor(makeFake({})))
    expect(homeAsks).not.toHaveBeenCalled()
  })
})

describe('accept — the trust gate', () => {
  const pendingProposal = (over: Row = {}): Row => ({
    id: 'p1',
    workspace_id: 'ws1',
    status: 'pending',
    change_type: 'create',
    entity_type: 'action',
    title: 'Do the thing',
    display_text: 'Do the thing',
    confidence: 0.9,
    ...over,
  })

  it('auto-applies when act + auto_apply + confident + explicit + not-external', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({ proposals: [pendingProposal()] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'real', confidence: 0.9, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(applyChangeMock).toHaveBeenCalledOnce()
    expect(ledger.entries[0].outcome).toBe('applied')
    expect(ledger.entries[0].entity_id).toBe('act_new')
    expect(fake._tables.proposed_change[0].status).toBe('applied')
    expect(fake._tables.proposed_change[0].auto_accepted).toBe(true)
    expect(ledger.cards_surfaced).toBe(0)
  })

  // P13 (Liam: "Add them itself when it's confident, with undo; only ask in chat when it isn't sure"):
  // the gate is unchanged; only what the home thread hears moves.
  it('P13: a confident, explicitly-mine create is added and reported to the home thread with what Undo needs', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({ proposals: [pendingProposal()] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'real', confidence: 0.9, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake, { captureId: 'cap-1', provenance: { skillName: 'Triage', captureTitle: 'Acme sync' } }),
    )
    expect(ledger.entries[0]).toMatchObject({ outcome: 'applied', entity_id: 'act_new', created: true })
    expect(fake._tables.attention_item).toHaveLength(0)
    expect(homeAsks).toHaveBeenCalledTimes(1)
    expect(homeAsks).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      userId: 'u1',
      added: [{ change_id: 'p1', entity_id: 'act_new', entity_type: 'action', capture_id: 'cap-1', source: 'your call “Acme sync”' }],
    })
  })

  it('P13: someone else’s commitment is never added: their update asks in the chat (a card), nothing reported as added', async () => {
    const fake = makeFake({ proposals: [pendingProposal({ change_type: 'update', entity_id: 'act9' })] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'Dana said she would', confidence: 0.99, is_mine_explicit: false }], needs_user: [], summary: 's' },
      ctxFor(fake, { captureId: 'cap-1' }),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('carded')
    expect(fake._tables.attention_item).toHaveLength(1)
    expect(homeAsks).toHaveBeenCalledWith({ workspaceId: 'ws1', userId: 'u1' })
  })

  it('P13: low confidence is never added: it asks in the chat (a card)', async () => {
    const fake = makeFake({ proposals: [pendingProposal({ change_type: 'update', entity_id: 'act9' })] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'maybe', confidence: 0.5, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('carded')
    expect(homeAsks).toHaveBeenCalledWith({ workspaceId: 'ws1', userId: 'u1' })
  })

  it('P13: an applied update is not reported as added (no Undo can reverse it); nothing carded, so no message', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act9' })
    const fake = makeFake({ proposals: [pendingProposal({ change_type: 'update', entity_id: 'act9' })] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'I finished it', confidence: 0.95, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.entries[0].outcome).toBe('applied')
    expect(ledger.entries[0].created).toBeUndefined()
    expect(homeAsks).not.toHaveBeenCalled()
  })

  it('does not crash on a sparse verdict missing needs_user/decisions (the Jul-13 "not iterable" prod crash)', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({ proposals: [pendingProposal()] })
    // An eve outputSchema result may validly omit needs_user (it is optional in
    // the schema); a bare cast used to let this reach the apply walk.
    const sparse = {
      decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'real', confidence: 0.9, is_mine_explicit: true }],
      summary: 's',
    } as unknown as Parameters<typeof applyVerdict>[0]
    const ledger = await applyVerdict(sparse, ctxFor(fake))
    expect(ledger.entries[0].outcome).toBe('applied')
    expect(ledger.cards_surfaced).toBe(0)

    const decisionless = { needs_user: [], summary: 's' } as unknown as Parameters<typeof applyVerdict>[0]
    const emptyLedger = await applyVerdict(decisionless, ctxFor(fake))
    expect(emptyLedger.entries).toHaveLength(0)
  })

  it('STAGES instead of applying in report mode (Liam: report never writes the board)', async () => {
    const fake = makeFake({ proposals: [pendingProposal()] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'real', confidence: 0.99, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake, { mode: 'report' }),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('staged')
    expect(ledger.entries[0].detail).toContain('report mode')
    expect(ledger.cards_surfaced).toBe(0)
    expect(fake._tables.attention_item).toHaveLength(0)
    expect(fake._tables.proposed_change[0].status).toBe('pending') // untouched
  })

  it('CARDS a non-create in report mode', async () => {
    const fake = makeFake({ proposals: [pendingProposal({ change_type: 'update', entity_id: 'act9' })] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'real', confidence: 0.99, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake, { mode: 'report' }),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('carded')
    expect(ledger.entries[0].detail).toBe('report mode — surfaced as card')
    expect(ledger.cards_surfaced).toBe(1)
    expect(fake._tables.proposed_change[0].status).toBe('pending') // untouched
  })

  it('leaves a new to-do in its capture when not explicitly mine, even at high confidence (the F3 fix)', async () => {
    const fake = makeFake({ proposals: [pendingProposal()] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'someone else said it', confidence: 0.99, is_mine_explicit: false }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('staged')
    expect(ledger.entries[0].detail).toBe('not explicitly the user’s; a new to-do stays in its capture')
    expect(fake._tables.attention_item).toHaveLength(0)
    expect(fake._tables.proposed_change[0].status).toBe('pending')
  })

  it('a staged to-do takes no card slot: the cap goes to cards that need the person', async () => {
    const fake = makeFake({
      proposals: [
        pendingProposal({ id: 'todo1' }),
        pendingProposal({ id: 'todo2' }),
        pendingProposal({ id: 'upd1', change_type: 'update', entity_id: 'act1' }),
      ],
    })
    const ledger = await applyVerdict(
      {
        decisions: [
          { proposal_id: 'todo1', verdict: 'accept', reason: 'r', confidence: 0.99, is_mine_explicit: false },
          { proposal_id: 'todo2', verdict: 'accept', reason: 'r', confidence: 0.98, is_mine_explicit: false },
          { proposal_id: 'upd1', verdict: 'accept', reason: 'r', confidence: 0.5, is_mine_explicit: false },
        ],
        needs_user: [],
        summary: 's',
      },
      ctxFor(fake, { trust: resolveTrust({ auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 1 }) }),
    )
    expect(ledger.entries.map((e) => e.outcome)).toEqual(['staged', 'staged', 'carded'])
    expect(ledger.cards_overflow).toBe(0)
    expect(fake._tables.attention_item.map((c) => c.proposal_id)).toEqual(['upd1'])
  })

  it('stamps skill/capture provenance into the card payload for the footer', async () => {
    const fake = makeFake({ proposals: [pendingProposal({ change_type: 'update', entity_id: 'act9' })] })
    await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'r', confidence: 0.99, is_mine_explicit: false }], needs_user: [], summary: 's' },
      ctxFor(fake, {
        flowRunId: 'run-42',
        provenance: { skillName: 'Proposal Triage', captureTitle: 'Weekly sync' },
      }),
    )
    const card = fake._tables.attention_item[0]
    // source_flow_run_id is NULL at insert — the FK forbids referencing the
    // not-yet-written flow_run row; the dispatcher back-fills it afterward.
    expect(card.source_flow_run_id ?? null).toBeNull()
    expect((card.payload as Row).skill_name).toBe('Proposal Triage')
    expect((card.payload as Row).capture_title).toBe('Weekly sync')
  })

  it('omits provenance keys cleanly when there is none (no footer noise)', async () => {
    const fake = makeFake({ proposals: [pendingProposal({ change_type: 'update', entity_id: 'act9' })] })
    await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'r', confidence: 0.99, is_mine_explicit: false }], needs_user: [], summary: 's' },
      ctxFor(fake), // no provenance
    )
    const card = fake._tables.attention_item[0]
    expect(card.source_flow_run_id ?? null).toBeNull()
    expect((card.payload as Row).skill_name).toBeUndefined()
    expect((card.payload as Row).capture_title).toBeUndefined()
  })

  // Bots v3 1a: a card names its teammate and its run's ledger row the moment
  // it lands, so it is its bot's before (or without) the run back-link.
  it('stamps raised_by_ai_member_id, work_item_id and flow_id into the card payload at insert', async () => {
    const fake = makeFake({ proposals: [pendingProposal({ change_type: 'update', entity_id: 'act9' })] })
    await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'r', confidence: 0.99, is_mine_explicit: false }], needs_user: [], summary: 's' },
      ctxFor(fake, { teammateId: 'tm-triage', workItemId: 'job-7', flowId: 'flow-3' }),
    )
    const card = fake._tables.attention_item[0]
    expect(card.source_flow_run_id ?? null).toBeNull()
    expect(card.payload).toMatchObject({ raised_by_ai_member_id: 'tm-triage', work_item_id: 'job-7', flow_id: 'flow-3' })
  })

  it('leaves the attribution keys off a card whose run names no one', async () => {
    const fake = makeFake({ proposals: [pendingProposal({ change_type: 'update', entity_id: 'act9' })] })
    await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'r', confidence: 0.99, is_mine_explicit: false }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    const payload = fake._tables.attention_item[0].payload as Row
    expect(payload.raised_by_ai_member_id).toBeUndefined()
    expect(payload.work_item_id).toBeUndefined()
    expect(payload.flow_id).toBeUndefined()
  })

  it('never lets the model name who raised a card (the attribution keys are the server’s)', async () => {
    const fake = makeFake({ proposals: [] })
    const spoof = { raised_by_ai_member_id: 'tm-spoof', work_item_id: 'job-spoof', flow_id: 'flow-spoof', note: 'kept' }
    await applyVerdict(
      { decisions: [], needs_user: [{ kind: 'question', title: 'Which Acme contact?', why: 'two match', confidence: 0.8, payload: spoof }], summary: 's' },
      ctxFor(fake, { teammateId: 'tm-triage', workItemId: 'job-7' }),
    )
    const spoofless = makeFake({ proposals: [] })
    await applyVerdict(
      { decisions: [], needs_user: [{ kind: 'question', title: 'Which Acme contact?', why: 'two match', confidence: 0.8, payload: spoof }], summary: 's' },
      ctxFor(spoofless),
    )
    expect(fake._tables.attention_item[0].payload).toMatchObject({
      raised_by_ai_member_id: 'tm-triage',
      work_item_id: 'job-7',
      note: 'kept',
    })
    expect((fake._tables.attention_item[0].payload as Row).flow_id).toBeUndefined()
    const bare = spoofless._tables.attention_item[0].payload as Row
    expect([bare.raised_by_ai_member_id, bare.work_item_id, bare.flow_id]).toEqual([undefined, undefined, undefined])
    expect(bare.note).toBe('kept')
  })

  it('CARDS an update below the confidence threshold', async () => {
    const fake = makeFake({ proposals: [pendingProposal({ confidence: 0.6, change_type: 'update', entity_id: 'act9' })] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'weak', confidence: 0.6, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('carded')
    expect(ledger.entries[0].detail).toBe('below confidence threshold — surfaced as card')
  })

  it('STAGES a new to-do below the confidence threshold, with no card', async () => {
    const fake = makeFake({ proposals: [pendingProposal({ confidence: 0.6 })] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'weak', confidence: 0.6, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('staged')
    expect(ledger.cards_surfaced).toBe(0)
    expect(fake._tables.attention_item).toHaveLength(0)
  })

  it('NEVER auto-applies an external send_email — cards as draft_email', async () => {
    const fake = makeFake({ proposals: [pendingProposal({ change_type: 'send_email' })] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'send it', confidence: 0.99, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('carded')
    expect(fake._tables.attention_item[0].kind).toBe('draft_email')
  })

  it('folds corrections into the applied change (kills the F2 two-step)', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({ proposals: [pendingProposal({ priority: 'high', due_date: '2020-01-01' })] })
    await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'real', confidence: 0.9, is_mine_explicit: true, corrections: { priority: 'medium', due_date: null } }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    const applied = applyChangeMock.mock.calls[0][1] as Row
    expect(applied.priority).toBe('medium')
    expect(applied.due_date).toBe(null)
    expect(applied.auto_accepted).toBe(true)
  })
})

// ── Standup Sync v2: status moves on EXISTING cards via update:action accepts.
//    Standup's verdict skill (migration 194) accepts the update:action status-move
//    proposals a standup capture staged; this exercises that exact engine path,
//    which the create:action trust-gate tests above do NOT cover. No engine change
//    backs Standup v2 — these assert the existing gate already carries it. ────────
describe('standup — update:action status moves (Standup Sync v2)', () => {
  const statusMove = (over: Row = {}): Row => ({
    id: 'p1',
    workspace_id: 'ws1',
    status: 'pending',
    change_type: 'update',
    entity_type: 'action',
    entity_id: 'act42',
    team_id: 't1',
    title: 'Checkout retry work',
    display_text: 'Move checkout retry to Done',
    confidence: 0.92,
    ...over,
  })

  it('auto-applies a self-reported status move (update:action, explicit-mine, act)', async () => {
    // The run-as user reported their OWN card done → is_mine_explicit:true → the
    // engine applies the update through applyChange (updateAction resolves status).
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act42' })
    const fake = makeFake({ proposals: [statusMove()] })
    const ledger = await applyVerdict(
      {
        decisions: [
          {
            proposal_id: 'p1',
            verdict: 'accept',
            reason: "'I merged the retry fix this morning' → Done",
            confidence: 0.92,
            is_mine_explicit: true,
            corrections: { status: 'Done' },
          },
        ],
        needs_user: [],
        summary: 's',
      },
      ctxFor(fake),
    )
    expect(applyChangeMock).toHaveBeenCalledOnce()
    // The status correction is folded onto the change as status_to (what
    // updateAction reads), not left as corrections.status.
    const applied = applyChangeMock.mock.calls[0][1] as Row
    expect(applied.status_to).toBe('Done')
    expect(applied.change_type).toBe('update') // still an update — NOT re-typed
    expect(applied.auto_accepted).toBe(true)
    expect(ledger.entries[0].outcome).toBe('applied')
    expect(fake._tables.proposed_change[0].status).toBe('applied')
    expect(ledger.cards_surfaced).toBe(0)
  })

  it('CARDS a teammate-reported move — the C3 attribution gate (is_mine_explicit:false)', async () => {
    // "Austin: the checkout work is done" — a real, evidenced move, but NOT the
    // run-as user's own first-person statement. It must card, never auto-move
    // someone else's card. This is Standup v2's conservative attribution rule.
    const fake = makeFake({ proposals: [statusMove()] })
    const ledger = await applyVerdict(
      {
        decisions: [
          {
            proposal_id: 'p1',
            verdict: 'accept',
            reason: "Austin said 'checkout retry is done' → Done",
            confidence: 0.95,
            is_mine_explicit: false,
            corrections: { status: 'Done' },
          },
        ],
        needs_user: [],
        summary: 's',
      },
      ctxFor(fake), // act + auto_apply — only attribution differs
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('carded')
    // The card carries the corrected status so its accept moves to the right column.
    expect((fake._tables.attention_item[0].payload as Row).due_date ?? null).toBeNull()
    expect(ledger.entries[0].detail).toContain('not explicitly the user')
    // The backing update proposal stays pending so the card's accept applies it.
    expect(fake._tables.proposed_change[0].status).toBe('pending')
  })

  it('CARDS a delete:action even at max confidence + explicit-mine — deletes never auto-apply', async () => {
    // "cancel that task, we're not doing it" — extraction can stage delete:action
    // alongside status moves. Destroying a board card stays human-approved no
    // matter how explicit the quote (the change-type gate).
    const fake = makeFake({ proposals: [statusMove({ change_type: 'delete' })] })
    const ledger = await applyVerdict(
      {
        decisions: [
          {
            proposal_id: 'p1',
            verdict: 'accept',
            reason: "'kill the checkout retry task' → delete",
            confidence: 1.0,
            is_mine_explicit: true,
          },
        ],
        needs_user: [],
        summary: 's',
      },
      ctxFor(fake), // act + auto_apply — only the change type differs
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('carded')
    expect(ledger.entries[0].detail).toContain('delete never auto-applies')
    expect(fake._tables.proposed_change[0].status).toBe('pending')
  })

  it('CARDS an assign:action even at max confidence + explicit-mine — assigns never auto-apply', async () => {
    const fake = makeFake({ proposals: [statusMove({ change_type: 'assign' })] })
    const ledger = await applyVerdict(
      {
        decisions: [
          {
            proposal_id: 'p1',
            verdict: 'accept',
            reason: "'Sarah is picking that up' → reassign",
            confidence: 1.0,
            is_mine_explicit: true,
          },
        ],
        needs_user: [],
        summary: 's',
      },
      ctxFor(fake),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('carded')
    expect(ledger.entries[0].detail).toContain('assign never auto-applies')
    expect(fake._tables.proposed_change[0].status).toBe('pending')
  })

  it('report mode CARDS a self-reported move — never writes the board (dry-run)', async () => {
    const fake = makeFake({ proposals: [statusMove()] })
    const ledger = await applyVerdict(
      {
        decisions: [
          {
            proposal_id: 'p1',
            verdict: 'accept',
            reason: "'I shipped it' → Done",
            confidence: 0.99,
            is_mine_explicit: true,
            corrections: { status: 'Done' },
          },
        ],
        needs_user: [],
        summary: 's',
      },
      ctxFor(fake, { mode: 'report' }),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('carded')
    expect(ledger.cards_surfaced).toBe(1)
    expect(fake._tables.proposed_change[0].status).toBe('pending')
  })

  it('dismisses a wrong-target / narration move without touching the board', async () => {
    const fake = makeFake({ proposals: [statusMove({ display_text: 'we closed a few stories' })] })
    const ledger = await applyVerdict(
      {
        decisions: [{ proposal_id: 'p1', verdict: 'dismiss', reason: 'anonymous aggregate — unmappable', confidence: 0.9 }],
        needs_user: [],
        summary: 's',
      },
      ctxFor(fake),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('dismissed')
    expect(fake._tables.proposed_change[0].status).toBe('dismissed')
  })
})

describe('dismiss + fold', () => {
  it('dismiss stores the reason in extra.dismiss_reason', async () => {
    const fake = makeFake({ proposals: [{ id: 'p1', workspace_id: 'ws1', status: 'pending', change_type: 'create', entity_type: 'action' }] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'dismiss', reason: 'duplicate of GEN-42', confidence: 0.9 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.entries[0].outcome).toBe('dismissed')
    expect(fake._tables.proposed_change[0].status).toBe('dismissed')
    expect((fake._tables.proposed_change[0].extra as Row).dismiss_reason).toBe('duplicate of GEN-42')
  })

  it('fold_into comments on the target then dismisses', async () => {
    const fake = makeFake({
      proposals: [{ id: 'p1', workspace_id: 'ws1', status: 'pending', change_type: 'update', entity_type: 'action', display_text: 'same thing' }],
      actions: [{ id: 'act42', workspace_id: 'ws1' }],
    })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'fold_into', fold_target_action_id: 'act42', reason: 'covered by GEN-42', confidence: 0.9 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.entries[0].outcome).toBe('folded')
    expect(ledger.entries[0].entity_id).toBe('act42')
    expect(fake._tables.comment.length).toBe(1)
    expect(fake._tables.proposed_change[0].status).toBe('dismissed')
  })

  it('fold_into skips (no board write) when the target is not in the workspace', async () => {
    const fake = makeFake({
      proposals: [{ id: 'p1', workspace_id: 'ws1', status: 'pending', change_type: 'update', entity_type: 'action', display_text: 'x' }],
      actions: [],
    })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'fold_into', fold_target_action_id: 'ghost', reason: 'x', confidence: 0.9 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.entries[0].outcome).toBe('skipped')
    expect(fake._tables.comment.length).toBe(0)
    expect(fake._tables.proposed_change[0].status).toBe('pending')
  })
})

describe('revoke — hard guardrails, fail-closed', () => {
  const appliedAuto = (over: Row = {}): Row => ({
    id: 'p1',
    workspace_id: 'ws1',
    status: 'applied',
    auto_accepted: true,
    change_type: 'create',
    entity_type: 'action',
    result_entity_id: 'act1',
    applied_at: hoursAgo(1),
    ...over,
  })

  it('revokes a fresh, untouched, auto-accepted create', async () => {
    deleteAppliedEntityMock.mockResolvedValue({ success: true })
    const fake = makeFake({
      // Model the REAL action row: agent_run_status is NOT NULL DEFAULT 'idle'.
      // (The original test omitted it and passed for the wrong reason.)
      proposals: [appliedAuto()],
      actions: [{ id: 'act1', workspace_id: 'ws1', updated_at: hoursAgo(1), status_id: 's1', agent_run_status: 'idle' }],
    })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'revoke', reason: 'dup slipped through', confidence: 0.95 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(deleteAppliedEntityMock).toHaveBeenCalledOnce()
    expect(ledger.entries[0].outcome).toBe('revoked')
    expect(ledger.revoked_count).toBe(1)
    expect(fake._tables.proposed_change[0].status).toBe('dismissed')
  })

  it('REFUSES to revoke a human accept (auto_accepted=false)', async () => {
    const fake = makeFake({ proposals: [appliedAuto({ auto_accepted: false })], actions: [{ id: 'act1', workspace_id: 'ws1', updated_at: hoursAgo(1) }] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'revoke', reason: 'x', confidence: 0.99 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(deleteAppliedEntityMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('skipped')
  })

  it('REFUSES to revoke an update/assign (not a create)', async () => {
    const fake = makeFake({ proposals: [appliedAuto({ change_type: 'update' })], actions: [{ id: 'act1', workspace_id: 'ws1', updated_at: hoursAgo(1) }] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'revoke', reason: 'x', confidence: 0.99 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(deleteAppliedEntityMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('skipped')
  })

  it('REFUSES to revoke something applied more than 72h ago', async () => {
    const fake = makeFake({ proposals: [appliedAuto({ applied_at: hoursAgo(100) })], actions: [{ id: 'act1', workspace_id: 'ws1', updated_at: hoursAgo(100) }] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'revoke', reason: 'x', confidence: 0.99 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(deleteAppliedEntityMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('skipped')
  })

  it('REFUSES to revoke an entity the user has touched since (updated_at moved)', async () => {
    const fake = makeFake({
      proposals: [appliedAuto({ applied_at: hoursAgo(2) })],
      actions: [{ id: 'act1', workspace_id: 'ws1', updated_at: hoursAgo(1) }], // touched AFTER applied
    })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'revoke', reason: 'x', confidence: 0.99 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(deleteAppliedEntityMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('skipped')
  })

  it('REFUSES (fail-closed) when the entity can no longer be found', async () => {
    const fake = makeFake({ proposals: [appliedAuto()], actions: [] }) // entity gone
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'revoke', reason: 'x', confidence: 0.99 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(deleteAppliedEntityMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('skipped')
  })

  it('REFUSES when the action has agent activity since', async () => {
    const fake = makeFake({
      proposals: [appliedAuto()],
      actions: [{ id: 'act1', workspace_id: 'ws1', updated_at: hoursAgo(1), agent_run_status: 'working' }],
    })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'revoke', reason: 'x', confidence: 0.99 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(deleteAppliedEntityMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('skipped')
  })

  it("treats agent_run_status='idle' as UNTOUCHED (the default-sentinel bug fix)", async () => {
    deleteAppliedEntityMock.mockResolvedValue({ success: true })
    // A never-run action carries the NOT-NULL DEFAULT 'idle'. It must revoke.
    const fake = makeFake({
      proposals: [appliedAuto()],
      actions: [{ id: 'act1', workspace_id: 'ws1', updated_at: hoursAgo(1), agent_run_status: 'idle' }],
    })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'revoke', reason: 'dup', confidence: 0.95 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(deleteAppliedEntityMock).toHaveBeenCalledOnce()
    expect(ledger.entries[0].outcome).toBe('revoked')
  })

  it('REFUSES to revoke an action that has a linked agent_run (cascade-delete guard)', async () => {
    const fake = makeFake({
      proposals: [appliedAuto()],
      actions: [{ id: 'act1', workspace_id: 'ws1', updated_at: hoursAgo(1), agent_run_status: 'idle' }],
      agent_run: [{ id: 'ar1', action_id: 'act1' }],
    })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'revoke', reason: 'x', confidence: 0.99 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(deleteAppliedEntityMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('skipped')
  })

  it('REFUSES to revoke an action with a linked GitHub PR (cascade-delete guard)', async () => {
    const fake = makeFake({
      proposals: [appliedAuto()],
      actions: [{ id: 'act1', workspace_id: 'ws1', updated_at: hoursAgo(1), agent_run_status: 'idle' }],
      action_github_pr: [{ id: 'pr1', action_id: 'act1' }],
    })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'revoke', reason: 'x', confidence: 0.99 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(deleteAppliedEntityMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('skipped')
  })

  it('the fake serves only tables the schema has, so a misnamed table fails here as it does in Postgres', () => {
    // The probe once counted `action_github_prs` (the table is action_github_pr,
    // migration 064) and this fake answered for that name, so the read that
    // failed on every real call passed here and every revoke was refused.
    const served = Object.keys(makeFake({})._tables)
    expect(served.filter((table) => !relationNames().has(table))).toEqual([])
    expect(relationNames().has('action_github_prs')).toBe(false)
  })
})

describe('report mode is a board dry-run (adversarial-review fix)', () => {
  it('does NOT dismiss in report mode — records the intent only', async () => {
    const fake = makeFake({ proposals: [{ id: 'p1', workspace_id: 'ws1', status: 'pending', change_type: 'create', entity_type: 'action' }] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'dismiss', reason: 'dup', confidence: 0.9 }], needs_user: [], summary: 's' },
      ctxFor(fake, { mode: 'report' }),
    )
    expect(ledger.entries[0].outcome).toBe('skipped')
    expect(fake._tables.proposed_change[0].status).toBe('pending') // untouched
  })

  it('does NOT fold (comment/dismiss) in report mode', async () => {
    const fake = makeFake({
      proposals: [{ id: 'p1', workspace_id: 'ws1', status: 'pending', change_type: 'update', entity_type: 'action', display_text: 'x' }],
      actions: [{ id: 'act42', workspace_id: 'ws1' }],
    })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'fold_into', fold_target_action_id: 'act42', reason: 'x', confidence: 0.9 }], needs_user: [], summary: 's' },
      ctxFor(fake, { mode: 'report' }),
    )
    expect(ledger.entries[0].outcome).toBe('skipped')
    expect(fake._tables.comment.length).toBe(0)
    expect(fake._tables.proposed_change[0].status).toBe('pending')
  })

  it('does NOT revoke (hard-delete) in report mode', async () => {
    const fake = makeFake({
      proposals: [{ id: 'p1', workspace_id: 'ws1', status: 'applied', auto_accepted: true, change_type: 'create', entity_type: 'action', result_entity_id: 'act1', applied_at: hoursAgo(1) }],
      actions: [{ id: 'act1', workspace_id: 'ws1', updated_at: hoursAgo(1), agent_run_status: 'idle' }],
    })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'revoke', reason: 'x', confidence: 0.99 }], needs_user: [], summary: 's' },
      ctxFor(fake, { mode: 'report' }),
    )
    expect(deleteAppliedEntityMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('skipped')
    expect(fake._tables.proposed_change[0].status).toBe('applied') // untouched
  })
})

describe('auto-apply is scoped to action entities (decision-orphan fix)', () => {
  it('leaves a decision in its capture, never applied or carded, even when the trust gate would otherwise pass', async () => {
    const fake = makeFake({ proposals: [{ id: 'p1', workspace_id: 'ws1', status: 'pending', change_type: 'create', entity_type: 'decision', title: 'We decided X', display_text: 'We decided X', confidence: 0.95 }] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'noted', confidence: 0.95, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('staged')
    expect(ledger.entries[0].detail).toMatch(/a decision stays in its capture$/)
    expect(fake._tables.attention_item).toHaveLength(0)
    expect(fake._tables.proposed_change[0].status).toBe('pending')
  })
})

describe('idempotency + cap + ledger faithfulness', () => {
  it('a second walk over the same verdict applies nothing new (CAS)', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({ proposals: [{ id: 'p1', workspace_id: 'ws1', status: 'pending', change_type: 'create', entity_type: 'action', title: 't', display_text: 't', confidence: 0.9 }] })
    const verdict: RunVerdict = { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'r', confidence: 0.9, is_mine_explicit: true }], needs_user: [], summary: 's' }
    await applyVerdict(verdict, ctxFor(fake))
    applyChangeMock.mockClear()
    const ledger2 = await applyVerdict(verdict, ctxFor(fake))
    // Second walk: proposal is already 'applied' → skipped, applyChange NOT called again.
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger2.entries[0].outcome).toBe('skipped')
  })

  it('caps cards at max_cards_per_run, counts overflow, keeps top-by-confidence', async () => {
    const proposals = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`, workspace_id: 'ws1', status: 'pending', change_type: 'update', entity_type: 'action', entity_id: `act${i}`,
      title: `t${i}`, display_text: `t${i}`, confidence: 0.5 + i * 0.05,
    }))
    const fake = makeFake({ proposals })
    // All accepts but report mode → all become cards; cap is 2.
    const decisions = proposals.map((p, i) => ({ proposal_id: p.id, verdict: 'accept' as const, reason: 'r', confidence: 0.5 + i * 0.05, is_mine_explicit: true }))
    const ledger = await applyVerdict(
      { decisions, needs_user: [], summary: 's' },
      ctxFor(fake, { mode: 'report', trust: resolveTrust({ auto_apply: false, min_confidence: 0.85, allow_external: false, max_cards_per_run: 2 }) }),
    )
    expect(ledger.cards_surfaced).toBe(2)
    expect(ledger.cards_overflow).toBe(3)
    // The two highest-confidence proposals (p4=0.7, p3=0.65) were surfaced.
    const surfacedIds = fake._tables.attention_item.map((c) => c.proposal_id).sort()
    expect(surfacedIds).toEqual(['p3', 'p4'])
  })

  it('records outcome:failed (not applied) when applyChange fails', async () => {
    applyChangeMock.mockResolvedValue({ success: false, error: 'boom' })
    const fake = makeFake({ proposals: [{ id: 'p1', workspace_id: 'ws1', status: 'pending', change_type: 'create', entity_type: 'action', title: 't', display_text: 't', confidence: 0.9 }] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'r', confidence: 0.9, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.entries[0].outcome).toBe('failed')
    expect(ledger.entries[0].detail).toContain('boom')
    expect(fake._tables.proposed_change[0].status).toBe('pending') // not marked applied
  })

  it('a missing proposal is skipped, not fatal', async () => {
    const fake = makeFake({ proposals: [] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'ghost', verdict: 'accept', reason: 'r', confidence: 0.9, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.entries[0].outcome).toBe('skipped')
  })
})

// ── WS-2c: send_email is a hard NEVER-auto-apply ──────────────────────────────
describe('send_email never auto-applies (WS-2c)', () => {
  it('cards a send_email accept as draft_email even at conf 1.0 + explicit + act + auto_apply', async () => {
    const fake = makeFake({
      proposals: [
        {
          id: 'p1', workspace_id: 'ws1', capture_id: 'cap1', status: 'pending',
          change_type: 'send_email', entity_type: 'external',
          title: 'Email Sam', display_text: 'Email Sam', email_to_address: 'sam@x.com',
          confidence: 1,
        },
      ],
    })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'send it', confidence: 1, is_mine_explicit: true }], needs_user: [], summary: 's' },
      ctxFor(fake), // act + auto_apply + min_confidence 0.85 (the maximal-trust context)
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('carded')
    expect(fake._tables.attention_item[0].kind).toBe('draft_email')
    // The backing proposal is untouched (its card's accept will draft, never send).
    expect(fake._tables.proposed_change[0].status).toBe('pending')
  })
})

// ── WS-2b: outreach return path ───────────────────────────────────────────────
describe('outreach return path (WS-2b)', () => {
  const outreachAction = (over: Row = {}): Row => ({
    id: 'p1', workspace_id: 'ws1', capture_id: 'cap1', status: 'pending',
    change_type: 'create', entity_type: 'action',
    title: 'Reach out to Vijay', display_text: 'Reach out to Vijay',
    trigger_quote: "I'll reach out to Vijay today", description: 'follow up on the ORCA deal',
    confidence: 0.95, ...over,
  })
  const outreachDecision = (over: Partial<RunVerdict['decisions'][number]> = {}) => ({
    proposal_id: 'p1', verdict: 'accept' as const, reason: 'you committed to reach out',
    confidence: 0.95, is_mine_explicit: true, is_outreach: true, outreach_contact_name: 'Vijay',
    ...over,
  })

  it('applied outreach accept + resolvable contact → NEW send_email proposal + draft_email card', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({
      proposals: [outreachAction()],
      contacts: [{ id: 'c1', workspace_id: 'ws1', full_name: 'Vijay Kumar', email: 'vijay@example.com' }],
    })
    const ledger = await applyVerdict(
      { decisions: [outreachDecision()], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    // The action itself auto-applied.
    expect(ledger.entries[0].outcome).toBe('applied')
    expect(fake._tables.proposed_change.find((p) => p.id === 'p1')!.status).toBe('applied')
    // A NEW send_email proposal was synthesized — pending, externally addressed
    // from server resolution (NOT model narration).
    const synth = fake._tables.proposed_change.find((p) => p.change_type === 'send_email')
    expect(synth).toBeTruthy()
    expect(synth!.entity_type).toBe('external')
    expect(synth!.status).toBe('pending')
    expect(synth!.email_to_address).toBe('vijay@example.com')
    expect(synth!.email_subject).toBe('Reach out to Vijay')
    expect(synth!.capture_id).toBe('cap1')
    // Exactly one draft_email card, backed by the synthesized proposal.
    expect(fake._tables.attention_item.length).toBe(1)
    const card = fake._tables.attention_item[0]
    expect(card.kind).toBe('draft_email')
    expect(card.proposal_id).toBe(synth!.id)
    expect(ledger.cards_surfaced).toBe(1)
  })

  it('resolves via capture participant when no contact matches (unique name match)', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({
      proposals: [outreachAction()],
      participants: [
        { id: 'pp1', capture_id: 'cap1', external_name: 'Michelle Pinet', external_email: 'michelle@example.com' },
        { id: 'pp2', capture_id: 'cap1', external_name: 'Fabian', external_email: 'fabian@example.com' },
      ],
    })
    const ledger = await applyVerdict(
      { decisions: [outreachDecision({ outreach_contact_name: 'Michelle' })], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    const synth = fake._tables.proposed_change.find((p) => p.change_type === 'send_email')
    expect(synth!.email_to_address).toBe('michelle@example.com')
    expect(ledger.entries[0].outcome).toBe('applied')
    expect(ledger.entries[0].detail).toContain('michelle@example.com')
  })

  it('unresolvable outreach → action applies, NO card, NO synthesized proposal', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({ proposals: [outreachAction()] }) // no contacts, no participants
    const ledger = await applyVerdict(
      { decisions: [outreachDecision({ outreach_contact_name: 'Nobody Here' })], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.entries[0].outcome).toBe('applied')
    expect(ledger.entries[0].detail).toBe('outreach: no address resolved')
    expect(fake._tables.proposed_change.some((p) => p.change_type === 'send_email')).toBe(false)
    expect(fake._tables.attention_item.length).toBe(0)
    expect(ledger.cards_surfaced).toBe(0)
  })

  it('ambiguous contact match (>1 with email) does not resolve → no card', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({
      proposals: [outreachAction()],
      contacts: [
        { id: 'c1', workspace_id: 'ws1', full_name: 'Vijay Kumar', email: 'vijay.k@example.com' },
        { id: 'c2', workspace_id: 'ws1', full_name: 'Vijay Rao', email: 'vijay.r@example.com' },
      ],
    })
    const ledger = await applyVerdict(
      { decisions: [outreachDecision()], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.entries[0].detail).toBe('outreach: no address resolved')
    expect(fake._tables.attention_item.length).toBe(0)
  })

  it('trust.outreach_draft_cards=false suppresses the card (still applies the action)', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({
      proposals: [outreachAction()],
      contacts: [{ id: 'c1', workspace_id: 'ws1', full_name: 'Vijay Kumar', email: 'vijay@example.com' }],
    })
    const ledger = await applyVerdict(
      { decisions: [outreachDecision()], needs_user: [], summary: 's' },
      ctxFor(fake, {
        trust: resolveTrust({ auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 3, outreach_draft_cards: false }),
      }),
    )
    expect(ledger.entries[0].outcome).toBe('applied')
    expect(fake._tables.proposed_change.some((p) => p.change_type === 'send_email')).toBe(false)
    expect(fake._tables.attention_item.length).toBe(0)
  })
})

// ── WS-1e: accounting honesty ─────────────────────────────────────────────────
describe('accounting honesty (WS-1e)', () => {
  it('a 23505 dedup increments cards_deduped, NOT cards_surfaced (the Jul-6 3-vs-2 bug)', async () => {
    // Two needs_user entries name the SAME proposal (no backing decision). Both
    // survive to insert; the second collides on (proposal_id, run_key) → deduped.
    const fake = makeFake({
      proposals: [{ id: 'dup1', workspace_id: 'ws1', status: 'pending', change_type: 'update', entity_type: 'action', entity_id: 'act1', title: 'A', display_text: 'A' }],
    })
    const ledger = await applyVerdict(
      {
        decisions: [],
        needs_user: [
          { kind: 'action_card', proposal_id: 'dup1', title: 'A', why: 'w', confidence: 0.9 },
          { kind: 'action_card', proposal_id: 'dup1', title: 'A again', why: 'w', confidence: 0.8 },
        ],
        summary: 's',
      },
      ctxFor(fake), // stable runKey 'fire1'
    )
    expect(fake._tables.attention_item.length).toBe(1)
    expect(ledger.cards_surfaced).toBe(1)
    expect(ledger.cards_deduped).toBe(1)
    expect(ledger.cards_failed).toBe(0)
  })

  it('drops a needs_user duplicate of a carded decision BEFORE the cap (1e-iii)', async () => {
    // Report mode → the accept CARDS (proposal p1). needs_user ALSO names p1 (higher
    // confidence) plus a DISTINCT p2. Without dedup the p1 duplicate would win a
    // slot and 23505, leaving p2 to overflow; with dedup, p1 (decision) + p2 both
    // surface — the cap is never spent on a duplicate.
    const fake = makeFake({
      proposals: [
        { id: 'p1', workspace_id: 'ws1', status: 'pending', change_type: 'update', entity_type: 'action', entity_id: 'act1', title: 't1', display_text: 't1', confidence: 0.9 },
        { id: 'p2', workspace_id: 'ws1', status: 'pending', change_type: 'create', entity_type: 'action', title: 't2', display_text: 't2', confidence: 0.7 },
      ],
    })
    const ledger = await applyVerdict(
      {
        decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'card me', confidence: 0.9, is_mine_explicit: true }],
        needs_user: [
          { kind: 'action_card', proposal_id: 'p1', title: 'dup of p1', why: 'w', confidence: 0.95 },
          { kind: 'question', proposal_id: 'p2', title: 'distinct', why: 'w', confidence: 0.7 },
        ],
        summary: 's',
      },
      ctxFor(fake, { mode: 'report', trust: resolveTrust({ auto_apply: false, min_confidence: 0.85, allow_external: false, max_cards_per_run: 2 }) }),
    )
    const surfaced = fake._tables.attention_item.map((c) => c.proposal_id).sort()
    expect(surfaced).toEqual(['p1', 'p2'])
    expect(ledger.cards_surfaced).toBe(2)
    expect(ledger.cards_deduped).toBe(0) // the duplicate was dropped pre-insert, never collided
    expect(ledger.cards_overflow).toBe(0)
  })

  it('persists the exact submitted verdict on the ledger (1e-ii)', async () => {
    const fake = makeFake({ proposals: [{ id: 'p1', workspace_id: 'ws1', status: 'pending', change_type: 'create', entity_type: 'action', title: 't', display_text: 't', confidence: 0.9 }] })
    const verdict: RunVerdict = {
      decisions: [{ proposal_id: 'p1', verdict: 'dismiss', reason: 'dup', confidence: 0.9 }],
      needs_user: [{ kind: 'question', proposal_id: 'p2', title: 'q', why: 'w' }],
      summary: 'did the thing',
    }
    const ledger = await applyVerdict(verdict, ctxFor(fake))
    expect(ledger.submitted).toEqual(verdict)
  })
})

// ── W2: work_proposal cards (Loops v3 — WORK-PROPOSALS-DESIGN.md) ─────────────
//    work_proposal is a needs_user-only kind: it is NEVER a decision/accept, so
//    it never touches the trust gate — it rides the ranking/cap/dedup machinery
//    like every other card. These assert it always cards, server-clamps its
//    payload, and degrades to a question when the task is unstartable. ──────────
describe('work_proposal cards (W2)', () => {
  const workItem = (payload: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    kind: 'work_proposal' as const,
    title: 'Draft a follow-up email to Randy about GA access',
    why: 'you committed to send it',
    confidence: 0.8,
    payload,
    ...over,
  })

  it('cards a work_proposal — never auto-applied, kind survives to the row', async () => {
    // No backing proposal: work_proposal is needs_user-only, so there is nothing
    // to apply. It must card regardless of act/auto_apply/confidence.
    const fake = makeFake({ proposals: [] })
    const ledger = await applyVerdict(
      {
        decisions: [],
        needs_user: [workItem({ task: 'Draft an email to Randy about the GA access he asked for.' })],
        summary: 's',
      },
      ctxFor(fake), // maximal trust — proves it still cards
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(fake._tables.attention_item.length).toBe(1)
    const card = fake._tables.attention_item[0]
    expect(card.kind).toBe('work_proposal')
    expect((card.payload as Row).task).toBe('Draft an email to Randy about the GA access he asked for.')
    expect(ledger.cards_surfaced).toBe(1)
  })

  it('carries the work-flavored payload fields through the clamp', async () => {
    const fake = makeFake({ proposals: [] })
    await applyVerdict(
      {
        decisions: [],
        needs_user: [
          workItem({
            task: 'Draft a follow-up email to Randy.',
            deliverable_hint: 'email_draft',
            email_to_name: 'Randy Chen',
            email_to_address: 'randy@example.com',
            resources: [{ type: 'contact', id: 'c1', label: 'Randy Chen' }],
          }),
        ],
        summary: 's',
      },
      ctxFor(fake),
    )
    const p = fake._tables.attention_item[0].payload as Row
    expect(p.deliverable_hint).toBe('email_draft')
    expect(p.email_to_name).toBe('Randy Chen')
    expect(p.email_to_address).toBe('randy@example.com')
    expect(p.resources).toEqual([{ type: 'contact', id: 'c1', label: 'Randy Chen' }])
  })

  it('clamps task to WORK_TASK_MAX_CHARS and title to WORK_TITLE_MAX_CHARS', async () => {
    const fake = makeFake({ proposals: [] })
    await applyVerdict(
      {
        decisions: [],
        needs_user: [
          workItem(
            { task: 'x'.repeat(WORK_TASK_MAX_CHARS + 500) },
            { title: 'T'.repeat(WORK_TITLE_MAX_CHARS + 100) },
          ),
        ],
        summary: 's',
      },
      ctxFor(fake),
    )
    const card = fake._tables.attention_item[0]
    expect((card.payload as Row).task).toHaveLength(WORK_TASK_MAX_CHARS)
    expect((card.title as string).length).toBe(WORK_TITLE_MAX_CHARS)
  })

  it('clamps resources: caps count, truncates labels, drops malformed entries', async () => {
    const fake = makeFake({ proposals: [] })
    const resources = [
      // WORK_RESOURCES_MAX + a few valid ones …
      ...Array.from({ length: WORK_RESOURCES_MAX + 3 }, (_, i) => ({ type: 'action', label: `res ${i}` })),
      // … interleaved malformed entries that must be dropped, not fatal.
      { type: 'contact' }, // no label
      { label: 'no type' }, // no type
      'not an object',
      null,
      { type: 'document', label: 'L'.repeat(WORK_RESOURCE_LABEL_MAX_CHARS + 50) }, // over-long label
    ]
    await applyVerdict(
      { decisions: [], needs_user: [workItem({ task: 'do a thing', resources })], summary: 's' },
      ctxFor(fake),
    )
    const clamped = (fake._tables.attention_item[0].payload as Row).resources as Array<Record<string, unknown>>
    // Never more than the cap; every surviving entry has a label ≤ the max.
    expect(clamped.length).toBeLessThanOrEqual(WORK_RESOURCES_MAX)
    for (const r of clamped) {
      expect(typeof r.label).toBe('string')
      expect((r.label as string).length).toBeLessThanOrEqual(WORK_RESOURCE_LABEL_MAX_CHARS)
      expect(typeof r.type).toBe('string')
    }
  })

  it('drops an unrecognized deliverable_hint rather than storing garbage', async () => {
    const fake = makeFake({ proposals: [] })
    await applyVerdict(
      { decisions: [], needs_user: [workItem({ task: 'do a thing', deliverable_hint: 'nonsense' })], summary: 's' },
      ctxFor(fake),
    )
    expect((fake._tables.attention_item[0].payload as Row).deliverable_hint).toBeUndefined()
  })

  it('DEGRADES a work_proposal with no task to a question card (never an unstartable work card)', async () => {
    const fake = makeFake({ proposals: [] })
    const ledger = await applyVerdict(
      { decisions: [], needs_user: [workItem({ deliverable_hint: 'document' })], summary: 's' }, // no task
      ctxFor(fake),
    )
    const card = fake._tables.attention_item[0]
    expect(card.kind).toBe('question') // NOT work_proposal
    expect((card.payload as Row).degraded_from).toBe('work_proposal')
    expect(ledger.cards_surfaced).toBe(1)
  })

  it('DEGRADES a work_proposal whose task is only whitespace', async () => {
    const fake = makeFake({ proposals: [] })
    await applyVerdict(
      { decisions: [], needs_user: [workItem({ task: '   \n  ' })], summary: 's' },
      ctxFor(fake),
    )
    expect(fake._tables.attention_item[0].kind).toBe('question')
  })

  it('rides the cap + ranking like other cards (work_proposal is not privileged)', async () => {
    const fake = makeFake({ proposals: [] })
    const ledger = await applyVerdict(
      {
        decisions: [],
        needs_user: [
          workItem({ task: 'high one' }, { confidence: 0.9, title: 'high' }),
          workItem({ task: 'low one' }, { confidence: 0.2, title: 'low' }),
        ],
        summary: 's',
      },
      ctxFor(fake, {
        trust: resolveTrust({ auto_apply: false, min_confidence: 0.85, allow_external: false, max_cards_per_run: 1 }),
      }),
    )
    // Cap of 1 → only the higher-confidence work item surfaces; the other overflows.
    expect(ledger.cards_surfaced).toBe(1)
    expect(ledger.cards_overflow).toBe(1)
    expect(fake._tables.attention_item[0].title).toBe('high')
  })

  it('dedup on (proposal_id, run_key) is unchanged for work_proposal', async () => {
    // Two work items naming the SAME backing proposal id → the second collides on
    // the unique index and is counted deduped, never surfaced twice. A work card
    // over a new to-do still lands: only the Create action CARD is retired.
    const fake = makeFake({
      proposals: [{ id: 'wp1', workspace_id: 'ws1', status: 'pending', change_type: 'create', entity_type: 'action', title: 'draft it', display_text: 'draft it' }],
    })
    const ledger = await applyVerdict(
      {
        decisions: [],
        needs_user: [
          workItem({ task: 'draft it' }, { proposal_id: 'wp1' }),
          workItem({ task: 'draft it again' }, { proposal_id: 'wp1', confidence: 0.7 }),
        ],
        summary: 's',
      },
      ctxFor(fake), // stable runKey 'fire1'
    )
    expect(fake._tables.attention_item.length).toBe(1)
    expect(ledger.cards_surfaced).toBe(1)
    expect(ledger.cards_deduped).toBe(1)
  })

  // ── FIX 4: a proposal_id-LESS work card escapes BOTH partial dedup indexes
  //    (both are `where proposal_id is not null`), so a step-retry re-insert would
  //    mint a fresh random id and double-card → two Start buttons → duplicate
  //    agent runs. The deterministic (run_key, kind, title) id makes the retry
  //    collide on the PRIMARY KEY, which the 23505 handler swallows as 'deduped'. ─
  it('an Inngest step retry of the SAME (run_key, kind, title) work card is deduped (FIX 4)', async () => {
    // Same fake (persistent tables) across two walks = the retry. The work item
    // carries NO proposal_id, so the uidx never bites — only the deterministic
    // PRIMARY KEY does.
    const fake = makeFake({ proposals: [] })
    const verdict: RunVerdict = {
      decisions: [],
      needs_user: [workItem({ task: 'Draft the follow-up email to Randy.' })], // no proposal_id
      summary: 's',
    }
    const ledger1 = await applyVerdict(verdict, ctxFor(fake)) // runKey 'fire1'
    expect(ledger1.cards_surfaced).toBe(1)
    expect(fake._tables.attention_item.length).toBe(1)
    const firstId = fake._tables.attention_item[0].id

    // Retry the exact same fire (same runKey) → same deterministic id → 23505 PK
    // conflict → deduped, NOT a second card.
    const ledger2 = await applyVerdict(verdict, ctxFor(fake)) // runKey 'fire1'
    expect(fake._tables.attention_item.length).toBe(1) // still ONE card
    expect(fake._tables.attention_item[0].id).toBe(firstId)
    expect(ledger2.cards_surfaced).toBe(0)
    expect(ledger2.cards_deduped).toBe(1)
  })

  it('a work card in a DIFFERENT fire (new run_key) is a DISTINCT card (FIX 4)', async () => {
    // A genuinely new fire has a fresh run_key → a different deterministic id → no
    // collision, so the work card surfaces again (not wrongly deduped).
    const fake = makeFake({ proposals: [] })
    const verdict: RunVerdict = {
      decisions: [],
      needs_user: [workItem({ task: 'Draft the follow-up email to Randy.' })],
      summary: 's',
    }
    await applyVerdict(verdict, ctxFor(fake, { runKey: 'fire1' }))
    const ledger2 = await applyVerdict(verdict, ctxFor(fake, { runKey: 'fire2' }))
    expect(fake._tables.attention_item.length).toBe(2) // two distinct cards
    expect(ledger2.cards_surfaced).toBe(1)
    expect(ledger2.cards_deduped).toBe(0)
    const ids = fake._tables.attention_item.map((c) => c.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('two DIFFERENT proposal_id-less work cards in one fire get distinct ids (title-keyed)', async () => {
    // The deterministic id is keyed on (run_key, kind, title), so two different
    // work items in the same fire do NOT collide with each other.
    const fake = makeFake({ proposals: [] })
    const ledger = await applyVerdict(
      {
        decisions: [],
        needs_user: [
          workItem({ task: 'draft A' }, { title: 'Draft email to Randy' }),
          workItem({ task: 'draft B' }, { title: 'Draft doc for the launch' }),
        ],
        summary: 's',
      },
      ctxFor(fake, { trust: resolveTrust({ auto_apply: false, min_confidence: 0.85, allow_external: false, max_cards_per_run: 5 }) }),
    )
    expect(fake._tables.attention_item.length).toBe(2)
    expect(ledger.cards_surfaced).toBe(2)
    expect(ledger.cards_deduped).toBe(0)
    const ids = fake._tables.attention_item.map((c) => c.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('when runKey is null, a proposal_id-less card falls back to a random id (no anchor)', async () => {
    // No stable retry key → can't anchor a deterministic id → the DB default
    // random id is used. Two walks then produce two rows (no retry-dedup possible
    // without a run_key — the pre-existing behavior for keyless fires).
    const fake = makeFake({ proposals: [] })
    const verdict: RunVerdict = {
      decisions: [],
      needs_user: [workItem({ task: 'Draft the follow-up.' })],
      summary: 's',
    }
    await applyVerdict(verdict, ctxFor(fake, { runKey: null }))
    await applyVerdict(verdict, ctxFor(fake, { runKey: null }))
    expect(fake._tables.attention_item.length).toBe(2)
  })
})

// ── W-A: resource id-gating on WORK_RESOURCE_TYPES ───────────────────────────
//    The clamp keeps a resource entry's `id` ONLY when its `type` is in the known
//    set (LINKABLE_ENTITY_TYPES ∪ 'package'). An unknown type keeps its label chip
//    but loses the id, so a garbage type can't smuggle an unresolvable id through
//    to the executor's brief (matches Start's snapshot behavior). ────────────────
describe('work_proposal resource id-gating (W-A)', () => {
  const workItem = (payload: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    kind: 'work_proposal' as const,
    title: 'Draft a follow-up email',
    why: 'you committed to it',
    confidence: 0.8,
    payload,
    ...over,
  })

  const resourcesOf = (fake: ReturnType<typeof makeFake>) =>
    (fake._tables.attention_item[0].payload as Row).resources as Array<Record<string, unknown>>

  it("keeps the id for a KNOWN LINKABLE type (e.g. 'contact')", async () => {
    const fake = makeFake({ proposals: [] })
    await applyVerdict(
      {
        decisions: [],
        needs_user: [workItem({ task: 'do it', resources: [{ type: 'contact', id: 'c1', label: 'Randy' }] })],
        summary: 's',
      },
      ctxFor(fake),
    )
    expect(resourcesOf(fake)).toEqual([{ type: 'contact', id: 'c1', label: 'Randy' }])
  })

  it("keeps the id for type 'package' (the newly-known type)", async () => {
    const fake = makeFake({ proposals: [] })
    await applyVerdict(
      {
        decisions: [],
        needs_user: [workItem({ task: 'do it', resources: [{ type: 'package', id: 'pkg-1', label: 'Acme Account' }] })],
        summary: 's',
      },
      ctxFor(fake),
    )
    expect(resourcesOf(fake)).toEqual([{ type: 'package', id: 'pkg-1', label: 'Acme Account' }])
  })

  it('DROPS the id for an unknown type, keeping the label chip', async () => {
    const fake = makeFake({ proposals: [] })
    await applyVerdict(
      {
        decisions: [],
        needs_user: [
          workItem({ task: 'do it', resources: [{ type: 'wormhole', id: 'smuggled-id', label: 'Sketchy ref' }] }),
        ],
        summary: 's',
      },
      ctxFor(fake),
    )
    const [ref] = resourcesOf(fake)
    // The label chip survives; the id is stripped so it can't reach the brief.
    expect(ref.type).toBe('wormhole')
    expect(ref.label).toBe('Sketchy ref')
    expect(ref.id).toBeUndefined()
  })

  it('gates each entry independently (known keeps id, unknown loses it, in one payload)', async () => {
    const fake = makeFake({ proposals: [] })
    await applyVerdict(
      {
        decisions: [],
        needs_user: [
          workItem({
            task: 'do it',
            resources: [
              { type: 'package', id: 'pkg-1', label: 'Acme' },
              { type: 'nonsense', id: 'x', label: 'Bad' },
              { type: 'document', id: 'd1', label: 'Spec' },
            ],
          }),
        ],
        summary: 's',
      },
      ctxFor(fake),
    )
    const refs = resourcesOf(fake)
    expect(refs.find((r) => r.label === 'Acme')?.id).toBe('pkg-1')
    expect(refs.find((r) => r.label === 'Spec')?.id).toBe('d1')
    expect(refs.find((r) => r.label === 'Bad')?.id).toBeUndefined()
  })
})

// ── resolveTrust workspace-policy inheritance (One Accept Authority W-2) ──────
// EXPLICIT-policy-only: a flow's own trust field overrides where set; where
// unset it inherits the workspace trust policy ONLY when that policy is
// explicit (the workspace tuned trust_policy or the legacy key). A pure-default
// (non-explicit) workspace keeps this channel's historic 0.85 hard default —
// inheriting extraction's 0.8 there would loosen the verdict gate fleet-wide.
describe('resolveTrust — workspace-policy inheritance (W-2, explicit-only)', () => {
  const wsPolicy = (over: Partial<ResolvedTrustPolicy> = {}): ResolvedTrustPolicy => ({
    enabled: true,
    actions: { enabled: true, min_confidence: 0.8, require_explicit: false },
    decisions: { enabled: true, min_confidence: 0.85, require_explicit: true },
    milestones: { enabled: true, min_confidence: 0.85, require_explicit: true },
    claims: { enabled: true, min_confidence: 0.85, require_explicit: false },
    allow_external: false,
    explicit: true,
    ...over,
  })

  it('with no workspace policy, behaves exactly as before (flow decides alone)', () => {
    expect(resolveTrust({ auto_apply: true, min_confidence: 0.7, allow_external: false, max_cards_per_run: 3 })).toEqual({
      auto_apply: true,
      min_confidence: 0.7,
      allow_external: false,
      max_cards_per_run: 3,
      outreach_draft_cards: true,
    })
  })

  it('an UNTUNED workspace (non-explicit defaults) + bare flow trust keeps the 0.85 verdict floor', () => {
    // THE F1/F2 invariant: pure-default policies carry actions 0.8 (extraction's
    // default) but must NOT loosen the verdict channel for fleets that never
    // expressed intent — the unset flow min_confidence stays at the historic 0.85.
    const trust = resolveTrust(
      { auto_apply: true, allow_external: false, max_cards_per_run: 3 } as never,
      wsPolicy({ explicit: false }),
    )
    expect(trust.min_confidence).toBe(0.85)
    expect(trust.auto_apply).toBe(true) // non-explicit policy never suppresses either
  })

  it('inherits min_confidence from an EXPLICIT workspace actions floor when the flow omits it', () => {
    const trust = resolveTrust(
      { auto_apply: true, allow_external: false, max_cards_per_run: 3 } as never,
      wsPolicy({ actions: { enabled: true, min_confidence: 0.6, require_explicit: false } }),
    )
    expect(trust.min_confidence).toBe(0.6)
  })

  it('flow min_confidence OVERRIDES the workspace value where set', () => {
    const trust = resolveTrust(
      { auto_apply: true, min_confidence: 0.95, allow_external: false, max_cards_per_run: 3 },
      wsPolicy({ actions: { enabled: true, min_confidence: 0.6, require_explicit: false } }),
    )
    expect(trust.min_confidence).toBe(0.95)
  })

  it('an EXPLICIT workspace kill-switch suppresses auto_apply even when the flow armed it', () => {
    const trust = resolveTrust(
      { auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 3 },
      wsPolicy({ enabled: false }),
    )
    expect(trust.auto_apply).toBe(false)
  })

  it('an EXPLICIT policy with the actions class disabled suppresses auto_apply', () => {
    const trust = resolveTrust(
      { auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 3 },
      wsPolicy({ actions: { enabled: false, min_confidence: 0.8, require_explicit: false } }),
    )
    expect(trust.auto_apply).toBe(false)
  })

  it('an enabled workspace policy does NOT arm a flow that left auto_apply off', () => {
    const trust = resolveTrust(
      { auto_apply: false, min_confidence: 0.85, allow_external: false, max_cards_per_run: 3 },
      wsPolicy(),
    )
    expect(trust.auto_apply).toBe(false)
  })
})

// ── Sequence step 3: role / expects reach the card, and the auto-attempt gate ──
describe('work_proposal role / expects (the step-2 fold, fixed in step 3)', () => {
  it('item-level role and expects — where the schema and the triage prompt put them — reach the card payload', async () => {
    const fake = makeFake({ proposals: [] })
    await applyVerdict(
      {
        decisions: [],
        needs_user: [
          {
            kind: 'work_proposal',
            title: 'Research the token exchange',
            why: 'w',
            confidence: 0.9,
            payload: { task: 'Research it and write a brief.' },
            role: 'researcher',
            expects: [{ type: 'document', min: 1 }],
          },
        ],
        summary: 's',
      },
      ctxFor(fake),
    )
    const p = fake._tables.attention_item[0].payload as Row
    expect(p.role).toBe('researcher')
    expect(p.expects).toEqual([{ type: 'document', min: 1 }])
  })

  it('the item-level value wins over a payload-level one; a bad item-level role is dropped, not fatal', async () => {
    const fake = makeFake({ proposals: [] })
    await applyVerdict(
      {
        decisions: [],
        needs_user: [
          { kind: 'work_proposal', title: 'A', why: 'w', confidence: 0.9, payload: { task: 't', role: 'writer' }, role: 'researcher' },
          { kind: 'work_proposal', title: 'B', why: 'w', confidence: 0.8, payload: { task: 't', role: 'writer' }, role: 'clerk' },
        ],
        summary: 's',
      },
      ctxFor(fake),
    )
    const byTitle = Object.fromEntries(fake._tables.attention_item.map((c) => [c.title, c.payload as Row]))
    expect(byTitle.A.role).toBe('researcher')
    expect(byTitle.B.role).toBeUndefined()
  })
})

describe('the auto-attempt gate in the walk (Sequence step 3)', () => {
  const work = (title: string, confidence: number, over: Record<string, unknown> = {}) => ({
    kind: 'work_proposal' as const,
    title,
    why: 'w',
    confidence,
    payload: { task: `Do ${title}.` },
    role: 'researcher',
    expects: [{ type: 'document', min: 1 }],
    ...over,
  })

  it('a started attempt replaces the card: no attention_item, an attempts entry, cards_surfaced 0', async () => {
    const fake = makeFake({ proposals: [] })
    const attempter = vi.fn(async () => ({ attempted: true as const, reused: false, agentRunId: 'run-9', fireKey: 'attempt:x', teammateId: 'tm' }))
    const ledger = await applyVerdict(
      { decisions: [], needs_user: [work('Research X', 0.9)], summary: 's' },
      ctxFor(fake, { attemptWorkProposal: attempter }),
    )
    expect(fake._tables.attention_item).toHaveLength(0)
    expect(ledger.cards_surfaced).toBe(0)
    expect(ledger.attempts).toEqual([{ title: 'Research X', proposal_id: null, outcome: 'started', agent_run_id: 'run-9' }])
    // The gate sees the clamped payload (role / expects folded in) and the would-be card id.
    const [candidate] = attempter.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(candidate).toMatchObject({ proposalId: null, title: 'Research X', confidence: 0.9 })
    expect((candidate.payload as Row).role).toBe('researcher')
    expect(candidate.cardId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a refusal cards the item exactly as before and records why', async () => {
    const fake = makeFake({ proposals: [] })
    const attempter = vi.fn(async () => ({ attempted: false as const, reason: 'breaker_open' as const, detail: 'last 3 researcher attempts dismissed' }))
    const ledger = await applyVerdict(
      { decisions: [], needs_user: [work('Research X', 0.9)], summary: 's' },
      ctxFor(fake, { attemptWorkProposal: attempter }),
    )
    expect(fake._tables.attention_item).toHaveLength(1)
    expect(fake._tables.attention_item[0].kind).toBe('work_proposal')
    expect(ledger.cards_surfaced).toBe(1)
    expect(ledger.attempts).toEqual([
      { title: 'Research X', proposal_id: null, outcome: 'carded', reason: 'breaker_open', detail: 'last 3 researcher attempts dismissed' },
    ])
  })

  it('only work_proposal cards reach the gate; attempts spend card slots (the rail cap bounds cards + attempts)', async () => {
    const fake = makeFake({ proposals: [] })
    const attempter = vi.fn(async () => ({ attempted: true as const, reused: false, agentRunId: 'run-1', fireKey: 'k', teammateId: 'tm' }))
    const ledger = await applyVerdict(
      {
        decisions: [],
        needs_user: [
          work('Top work', 0.95),
          { kind: 'question', title: 'A question', why: 'w', confidence: 0.9 },
          { kind: 'question', title: 'Overflowed', why: 'w', confidence: 0.1 },
        ],
        summary: 's',
      },
      ctxFor(fake, {
        attemptWorkProposal: attempter,
        trust: resolveTrust({ auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 2 }),
      }),
    )
    expect(attempter).toHaveBeenCalledTimes(1)
    expect(fake._tables.attention_item.map((c) => c.title)).toEqual(['A question'])
    expect(ledger.cards_overflow).toBe(1)
  })

  it('no run key → the gate is asked with no card id (it refuses: no idempotency key)', async () => {
    const fake = makeFake({ proposals: [] })
    const attempter = vi.fn(async () => ({ attempted: false as const, reason: 'no_idempotency_key' as const }))
    await applyVerdict({ decisions: [], needs_user: [work('Research X', 0.9)], summary: 's' }, ctxFor(fake, { runKey: null, attemptWorkProposal: attempter }))
    expect((attempter.mock.calls[0] as unknown as [Record<string, unknown>])[0].cardId).toBeNull()
  })

  it('the env kill switch thrown ("false"): no gate, no attempts key, the walk is card-only', async () => {
    const prev = process.env.AGENT_AUTO_ATTEMPT_ENABLED
    process.env.AGENT_AUTO_ATTEMPT_ENABLED = 'false'
    try {
      const fake = makeFake({ proposals: [] })
      const ledger = await applyVerdict({ decisions: [], needs_user: [work('Research X', 0.9)], summary: 's' }, ctxFor(fake))
      expect(ledger).not.toHaveProperty('attempts')
      expect(fake._tables.attention_item).toHaveLength(1)
    } finally {
      if (prev === undefined) delete process.env.AGENT_AUTO_ATTEMPT_ENABLED
      else process.env.AGENT_AUTO_ATTEMPT_ENABLED = prev
    }
  })
})

describe('cards already on the rail (followups issues 12 and 13)', () => {
  const proposal = (id: string, over: Row = {}): Row => ({
    id,
    workspace_id: 'ws1',
    status: 'pending',
    change_type: 'update',
    entity_type: 'action',
    entity_id: `act-${id}`,
    title: `t-${id}`,
    display_text: `t-${id}`,
    confidence: 0.9,
    ...over,
  })
  const card = (proposalId: string, status: string, over: Row = {}): Row => ({
    id: `card-${proposalId}-${status}`,
    workspace_id: 'ws1',
    member_id: 'm1',
    kind: 'action_card',
    title: 'earlier card',
    proposal_id: proposalId,
    run_key: 'an-earlier-fire',
    status,
    ...over,
  })
  const accept = (id: string, over: Partial<RunVerdict['decisions'][number]> = {}) => ({
    proposal_id: id,
    verdict: 'accept' as const,
    reason: 'r',
    confidence: 0.9,
    is_mine_explicit: false,
    ...over,
  })

  it('does not re-card a proposal whose card the member dismissed (issue 12)', async () => {
    const fake = makeFake({ proposals: [proposal('p1')], attention_items: [card('p1', 'dismissed')] })
    const ledger = await applyVerdict({ decisions: [accept('p1')], needs_user: [], summary: 's' }, ctxFor(fake))
    expect(ledger.entries[0]).toMatchObject({ outcome: 'skipped', detail: 'the user dismissed its card' })
    expect(ledger.cards_surfaced).toBe(0)
    expect(fake._tables.attention_item).toHaveLength(1)
    expect(fake._tables.proposed_change[0].status).toBe('pending') // still visible in the capture
  })

  it('does not auto-apply a proposal whose card the member dismissed', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({ proposals: [proposal('p1')], attention_items: [card('p1', 'dismissed')] })
    const ledger = await applyVerdict(
      { decisions: [accept('p1', { confidence: 0.95, is_mine_explicit: true })], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(ledger.entries[0].outcome).toBe('skipped')
    expect(fake._tables.proposed_change[0].status).toBe('pending')
  })

  it("still dismisses a proposal whose card the member dismissed (the pass agrees with them)", async () => {
    const fake = makeFake({ proposals: [proposal('p1')], attention_items: [card('p1', 'dismissed')] })
    const ledger = await applyVerdict(
      { decisions: [{ proposal_id: 'p1', verdict: 'dismiss', reason: 'not yours', confidence: 0.9 }], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.entries[0].outcome).toBe('dismissed')
    expect(fake._tables.proposed_change[0].status).toBe('dismissed')
  })

  it("carded once: an expired card, an accepted one or another member's dismissed one leaves the proposal staged, not re-carded", async () => {
    const fake = makeFake({
      proposals: [proposal('p1'), proposal('p2'), proposal('p3'), proposal('p4')],
      attention_items: [
        card('p1', 'dismissed', { member_id: 'm2' }),
        card('p2', 'expired'),
        card('p3', 'accepted'),
        card('p4', 'pending', { workspace_id: 'ws2', run_key: 'elsewhere' }),
      ],
    })
    const ledger = await applyVerdict(
      { decisions: [accept('p1'), accept('p2'), accept('p3'), accept('p4')], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.entries.map((e) => e.outcome)).toEqual(['staged', 'staged', 'staged', 'carded'])
    expect(ledger.entries[1].detail).toBe('not explicitly the user’s; it already had a card')
    // Only another workspace's card is invisible to the check.
    expect(ledger.cards_surfaced).toBe(1)
    expect(fake._tables.proposed_change.map((p) => p.status)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  it('an expired card does not stop an auto-apply that clears the gate', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act-p1' })
    const fake = makeFake({ proposals: [proposal('p1')], attention_items: [card('p1', 'expired')] })
    const ledger = await applyVerdict(
      { decisions: [accept('p1', { confidence: 0.95, is_mine_explicit: true })], needs_user: [], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.entries[0].outcome).toBe('applied')
  })

  it('suppresses a needs_user item whose proposal had an expired card', async () => {
    const fake = makeFake({ proposals: [proposal('p1')], attention_items: [card('p1', 'expired')] })
    const ledger = await applyVerdict(
      { decisions: [], needs_user: [{ kind: 'action_card', proposal_id: 'p1', title: 'again', why: 'w', confidence: 0.9 }], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.cards_suppressed).toBe(1)
    expect(ledger.cards_surfaced).toBe(0)
    expect(fake._tables.attention_item).toHaveLength(1)
  })

  it('leaves a proposal alone while its card is pending: no dismiss, no fold, no accept (issue 13)', async () => {
    applyChangeMock.mockResolvedValue({ success: true, entity_id: 'act_new' })
    const fake = makeFake({
      proposals: [proposal('p1'), proposal('p2'), proposal('p3')],
      actions: [{ id: 'a1', workspace_id: 'ws1', title: 'existing' }],
      // p3's card is someone else's: one live card per proposal holds for everyone.
      attention_items: [card('p1', 'pending'), card('p2', 'pending'), card('p3', 'pending', { member_id: 'm2' })],
    })
    const ledger = await applyVerdict(
      {
        decisions: [
          { proposal_id: 'p1', verdict: 'dismiss', reason: 'not yours', confidence: 0.9 },
          { proposal_id: 'p2', verdict: 'fold_into', reason: 'dup', confidence: 0.9, fold_target_action_id: 'a1' },
          accept('p3', { confidence: 0.95, is_mine_explicit: true }),
        ],
        needs_user: [],
        summary: 's',
      },
      ctxFor(fake),
    )
    for (const e of ledger.entries) expect(e).toMatchObject({ outcome: 'skipped', detail: 'its card is waiting on the user' })
    expect(applyChangeMock).not.toHaveBeenCalled()
    expect(fake._tables.proposed_change.map((p) => p.status)).toEqual(['pending', 'pending', 'pending'])
    expect(fake._tables.attention_item.map((c) => c.status)).toEqual(['pending', 'pending', 'pending'])
    expect(fake._tables.comment).toHaveLength(0)
  })

  it('suppresses needs_user items for those proposals before ranking, so they spend no slot', async () => {
    const fake = makeFake({
      proposals: [proposal('p1'), proposal('p2'), proposal('p3')],
      attention_items: [card('p1', 'pending'), card('p2', 'dismissed')],
    })
    const ledger = await applyVerdict(
      {
        decisions: [],
        needs_user: [
          { kind: 'question', proposal_id: 'p1', title: 'already asked', why: 'w', confidence: 0.99 },
          { kind: 'question', proposal_id: 'p2', title: 'already dismissed', why: 'w', confidence: 0.98 },
          { kind: 'question', proposal_id: 'p3', title: 'new', why: 'w', confidence: 0.5 },
        ],
        summary: 's',
      },
      ctxFor(fake, { trust: resolveTrust({ auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 1 }) }),
    )
    expect(ledger.cards_suppressed).toBe(2)
    expect(ledger.cards_surfaced).toBe(1)
    expect(ledger.cards_overflow).toBe(0)
    expect(fake._tables.attention_item.filter((c) => c.run_key === 'fire1').map((c) => c.proposal_id)).toEqual(['p3'])
  })

  it('omits cards_suppressed when nothing was held back', async () => {
    const fake = makeFake({ proposals: [proposal('p1')] })
    const ledger = await applyVerdict({ decisions: [accept('p1')], needs_user: [], summary: 's' }, ctxFor(fake))
    expect('cards_suppressed' in ledger).toBe(false)
  })

  it('fails open when the cards cannot be read: the walk runs as before', async () => {
    const fake = makeFake({ proposals: [proposal('p1')], attention_items: [card('p1', 'dismissed')] })
    const from = fake.from
    const broken = {
      ...fake,
      from: (table: string) => {
        const b = from(table) as Record<string, unknown>
        if (table === 'attention_item') b.in = async () => ({ data: null, error: { message: 'boom' } })
        return b
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ledger = await applyVerdict({ decisions: [accept('p1')], needs_user: [], summary: 's' }, ctxFor(broken as never))
      expect(ledger.entries[0].outcome).toBe('carded')
      expect(warn).toHaveBeenCalledWith('[flows] verdict card state unreadable; applying without it', expect.objectContaining({ error: 'boom' }))
    } finally {
      warn.mockRestore()
    }
  })
})

describe('only a pending proposal is carded; a new to-do is never carded', () => {
  const proposal = (id: string, over: Row = {}): Row => ({
    id,
    workspace_id: 'ws1',
    status: 'pending',
    change_type: 'update',
    entity_type: 'action',
    entity_id: `act-${id}`,
    title: `t-${id}`,
    display_text: `t-${id}`,
    confidence: 0.9,
    ...over,
  })

  it('drops a needs_user card whose proposal was applied, dismissed or expired, or is not in the workspace', async () => {
    const fake = makeFake({
      proposals: [
        proposal('applied1', { status: 'applied' }),
        proposal('dismissed1', { status: 'dismissed' }),
        proposal('expired1', { status: 'expired' }),
        proposal('elsewhere1', { workspace_id: 'ws2' }),
        proposal('live1'),
      ],
    })
    const ledger = await applyVerdict(
      {
        decisions: [],
        needs_user: ['applied1', 'dismissed1', 'expired1', 'elsewhere1', 'ghost1', 'live1'].map((id) => ({
          kind: 'question' as const,
          proposal_id: id,
          title: `about ${id}`,
          why: 'w',
          confidence: 0.9,
        })),
        summary: 's',
      },
      ctxFor(fake, { trust: resolveTrust({ auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 10 }) }),
    )
    expect(fake._tables.attention_item.map((c) => c.proposal_id)).toEqual(['live1'])
    expect(ledger.cards_suppressed).toBe(5)
    expect(ledger.cards_surfaced).toBe(1)
  })

  it('does not card a proposal a decision earlier in the same walk dismissed', async () => {
    const fake = makeFake({ proposals: [proposal('p1')] })
    const ledger = await applyVerdict(
      {
        decisions: [{ proposal_id: 'p1', verdict: 'dismiss', reason: 'not yours', confidence: 0.9 }],
        needs_user: [{ kind: 'question', proposal_id: 'p1', title: 'is this yours?', why: 'w', confidence: 0.9 }],
        summary: 's',
      },
      ctxFor(fake),
    )
    expect(ledger.entries[0].outcome).toBe('dismissed')
    expect(fake._tables.attention_item).toHaveLength(0)
    expect(ledger.cards_suppressed).toBe(1)
  })

  it('never makes a needs_user Create action card, by its proposal or by its payload', async () => {
    const fake = makeFake({ proposals: [proposal('todo1', { change_type: 'create', entity_id: null })] })
    const ledger = await applyVerdict(
      {
        decisions: [],
        needs_user: [
          { kind: 'action_card', proposal_id: 'todo1', title: 'Add it', why: 'w', confidence: 0.9 },
          { kind: 'action_card', proposal_id: 'todo2', title: 'Add this too', why: 'w', confidence: 0.8, payload: { change_type: 'create', entity_type: 'action' } },
        ],
        summary: 's',
      },
      ctxFor(fake),
    )
    expect(fake._tables.attention_item).toHaveLength(0)
    expect(ledger.cards_suppressed).toBe(2)
    expect(fake._tables.proposed_change[0].status).toBe('pending') // still in its capture
  })

  it('never makes a needs_user card to add a decision, by its proposal or by its payload', async () => {
    const fake = makeFake({ proposals: [proposal('dec1', { change_type: 'create', entity_type: 'decision', entity_id: null })] })
    const ledger = await applyVerdict(
      {
        decisions: [],
        needs_user: [
          { kind: 'action_card', proposal_id: 'dec1', title: 'Add the decision', why: 'w', confidence: 0.9 },
          { kind: 'action_card', proposal_id: 'dec2', title: 'Add this decision too', why: 'w', confidence: 0.8, payload: { change_type: 'create', entity_type: 'decision' } },
        ],
        summary: 's',
      },
      ctxFor(fake),
    )
    expect(fake._tables.attention_item).toHaveLength(0)
    expect(ledger.cards_suppressed).toBe(2)
    expect(fake._tables.proposed_change[0].status).toBe('pending') // still in its capture
  })

  // PROD 2026-10-27 (call "Catch up", run 0221d348): Triage accepted two of the
  // call's to-dos (auto_apply off: they stay in the capture) and ALSO listed them
  // as needs_user action cards with no proposal_id and no payload. Both landed
  // as cards whose only button read "Unsupported: undefined undefined".
  it('never makes a needs_user action or email card that names no proposal', async () => {
    const fake = makeFake({
      proposals: [proposal('spec1', { change_type: 'create', entity_id: null }), proposal('ping1', { change_type: 'create', entity_id: null })],
    })
    const ledger = await applyVerdict(
      {
        decisions: [
          { proposal_id: 'spec1', verdict: 'accept', reason: 'Liam committed', confidence: 0.85, is_mine_explicit: false },
          { proposal_id: 'ping1', verdict: 'accept', reason: 'Liam committed', confidence: 0.85, is_mine_explicit: false },
        ],
        needs_user: [
          { kind: 'action_card', title: 'Prepare the full CDP data spec', why: 'only Liam can author it', confidence: 0.85 },
          { kind: 'action_card', title: 'Ping Adrian re access', why: 'access is the live blocker', confidence: 0.85 },
          { kind: 'draft_email', title: 'Email Adrian', why: 'w', confidence: 0.85 },
        ],
        summary: 's',
      },
      ctxFor(fake, { trust: resolveTrust({ auto_apply: false, min_confidence: 0.85, allow_external: false, max_cards_per_run: 3 }) }),
    )
    expect(ledger.entries.map((e) => e.outcome)).toEqual(['staged', 'staged'])
    expect(fake._tables.attention_item).toHaveLength(0)
    expect(ledger.cards_suppressed).toBe(3)
    expect(ledger.cards_surfaced).toBe(0)
    expect(fake._tables.proposed_change.map((p) => p.status)).toEqual(['pending', 'pending']) // still in their capture
    expect(homeAsks).not.toHaveBeenCalled()
  })

  it('a needs_user action card over a proposal carries the proposal, so its button applies it', async () => {
    const fake = makeFake({ proposals: [proposal('upd1', { title: 'Move ENG-40 to Done', priority: 'high' })] })
    const ledger = await applyVerdict(
      { decisions: [], needs_user: [{ kind: 'action_card', proposal_id: 'upd1', title: 'Close ENG-40?', why: 'w', confidence: 0.8 }], summary: 's' },
      ctxFor(fake),
    )
    expect(ledger.cards_surfaced).toBe(1)
    const card = fake._tables.attention_item[0]
    expect(card).toMatchObject({ kind: 'action_card', proposal_id: 'upd1', title: 'Close ENG-40?' })
    expect(card.payload).toMatchObject({
      change_type: 'update',
      entity_type: 'action',
      entity_id: 'act-upd1',
      title: 'Move ENG-40 to Done',
      priority: 'high',
      confidence: 0.8,
    })
  })

  it('a decision’s card keeps its corrections (its payload is not read again from the proposal)', async () => {
    const fake = makeFake({ proposals: [proposal('upd1', { priority: 'low' })] })
    await applyVerdict(
      {
        decisions: [{ proposal_id: 'upd1', verdict: 'accept', reason: 'not explicit', confidence: 0.9, is_mine_explicit: false, corrections: { priority: 'urgent' } }],
        needs_user: [],
        summary: 's',
      },
      ctxFor(fake),
    )
    expect(fake._tables.attention_item[0].payload).toMatchObject({ change_type: 'update', priority: 'urgent' })
  })

  it('still asks a question about a new to-do', async () => {
    const fake = makeFake({ proposals: [proposal('todo1', { change_type: 'create', entity_id: null })] })
    await applyVerdict(
      { decisions: [], needs_user: [{ kind: 'question', proposal_id: 'todo1', title: 'Whose is this?', why: 'w', confidence: 0.9 }], summary: 's' },
      ctxFor(fake),
    )
    expect(fake._tables.attention_item.map((c) => c.kind)).toEqual(['question'])
  })

  it('when the proposals cannot be read, a needs_user action card with no payload is held back (its button would be dead)', async () => {
    const fake = makeFake({ proposals: [proposal('p1'), proposal('p2')] })
    const from = fake.from
    const broken = {
      ...fake,
      from: (table: string) => {
        const b = from(table) as Record<string, unknown>
        if (table === 'proposed_change') b.in = async () => ({ data: null, error: { message: 'boom' } })
        return b
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ledger = await applyVerdict(
        {
          decisions: [],
          needs_user: [
            { kind: 'action_card', proposal_id: 'p1', title: 'Close ENG-40?', why: 'w', confidence: 0.9 },
            { kind: 'question', proposal_id: 'p2', title: 'q', why: 'w', confidence: 0.9 },
          ],
          summary: 's',
        },
        ctxFor(broken as never),
      )
      expect(fake._tables.attention_item.map((c) => c.kind)).toEqual(['question'])
      expect(ledger.cards_suppressed).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('fails open when the proposals cannot be read: the cards land as before', async () => {
    const fake = makeFake({ proposals: [proposal('p1')] })
    const from = fake.from
    const broken = {
      ...fake,
      from: (table: string) => {
        const b = from(table) as Record<string, unknown>
        // Only the batch status read uses .in() on proposed_change.
        if (table === 'proposed_change') b.in = async () => ({ data: null, error: { message: 'boom' } })
        return b
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ledger = await applyVerdict(
        { decisions: [], needs_user: [{ kind: 'question', proposal_id: 'p1', title: 'q', why: 'w', confidence: 0.9 }], summary: 's' },
        ctxFor(broken as never),
      )
      expect(ledger.cards_surfaced).toBe(1)
      expect(warn).toHaveBeenCalledWith(
        '[flows] verdict card proposals unreadable; carding without the pending check',
        expect.objectContaining({ error: 'boom' }),
      )
    } finally {
      warn.mockRestore()
    }
  })
})
