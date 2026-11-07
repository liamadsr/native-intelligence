import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for GET/PATCH /api/account/attention-items (loop-closure Phase 2, D).
 *
 * A stateful fake models the three tables the route touches (attention_item,
 * member, proposed_change) so we can assert the real control flow: the accept
 * DELEGATES to applyChange (single source of truth), then CAS-flips both the
 * proposal and the card; dismiss flips only the card and leaves the proposal,
 * except behind a work card, where it dismisses the proposal too; and the
 * guardrails — 409 on already-resolved / expired, 404 on
 * missing, 403 on a card whose workspace the caller isn't a member of.
 */

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  applyChange: vi.fn(),
  deleteAppliedEntity: vi.fn(),
  generateOutreachDraft: vi.fn(),
  inngestSend: vi.fn(),
  // The fake DB.
  db: {
    attention_item: [] as Record<string, unknown>[],
    member: [] as Record<string, unknown>[],
    proposed_change: [] as Record<string, unknown>[],
    projects: [] as Record<string, unknown>[],
    ai_team_member: [] as Record<string, unknown>[],
    actions: [] as Record<string, unknown>[],
    team: [] as Record<string, unknown>[],
    workflow_state: [] as Record<string, unknown>[],
    agent_run: [] as Record<string, unknown>[],
    // Resource-validation tables (snapshotResources fences each id to the card's
    // workspace). A card resource id must resolve in one of these to keep its id.
    // Most delegate to entityInWorkspace (claims.ts) which selects the row on its
    // own workspace_id column; `cycle`/`package` keep the route's special cases.
    contact: [] as Record<string, unknown>[],
    document: [] as Record<string, unknown>[],
    captures: [] as Record<string, unknown>[],
    initiative: [] as Record<string, unknown>[],
    cycle: [] as Record<string, unknown>[],
    knowledge_package: [] as Record<string, unknown>[],
    // Widened coverage (W-C): entityInWorkspace fences these five via their own
    // workspace_id columns (claim / email_thread_index / attachments / member /
    // chat_conversations). `member` is declared above; the rest are new here.
    claim: [] as Record<string, unknown>[],
    email_thread_index: [] as Record<string, unknown>[],
    attachments: [] as Record<string, unknown>[],
    chat_conversations: [] as Record<string, unknown>[],
    // The entity registry added two more linkable types: `company` (own
    // workspace_id → entityInWorkspace) and `milestone` (no workspace_id →
    // project-fenced by the route, like cycle's team fence).
    company: [] as Record<string, unknown>[],
    milestone: [] as Record<string, unknown>[],
    // The work ledger: Start records the run here (ensureWorkForAgentRun).
    tracked_job: [] as Record<string, unknown>[],
    // A settled-failed ledger row notifies its owner (notifyWorkFailed).
    notification: [] as Record<string, unknown>[],
  },
  // Sequential ids for inserts (deterministic per test).
  seq: { action: 0, run: 0 },
  // Tables whose next INSERT should fail (error, no row) — drives the Start
  // compensation branches (action-insert fail, run-insert fail).
  failInsert: new Set<string>(),
  // When true, getServiceClient() throws — drives the best-effort branches.
  serviceDown: false,
  // When true, inngest.send throws — drives the dispatch-failure compensation.
}))

vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  applyChange: hoisted.applyChange,
  deleteAppliedEntity: hoisted.deleteAppliedEntity,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.inngestSend },
}))

// The draft-email accept path fills the shell via this generator; the route test
// stubs it and asserts the route's success/failure contract around it (the
// generator's own DB writes are covered by its unit tests).
vi.mock('@/lib/email/outreach-draft-generator', () => ({
  generateOutreachDraft: hoisted.generateOutreachDraft,
}))

// A tiny query builder over the in-memory db. Supports the exact chain the route
// uses: select().eq().eq()...maybeSingle(), select().eq().or().order().limit(),
// update().eq()...select().maybeSingle().
function makeClient() {
  function table(name: keyof typeof hoisted.db) {
    let rows = () => hoisted.db[name]
    const filters: Array<(r: Record<string, unknown>) => boolean> = []
    let pendingUpdate: Record<string, unknown> | null = null
    let pendingInsert: Record<string, unknown> | null = null
    let pendingDelete = false
    let orFilter: ((r: Record<string, unknown>) => boolean) | null = null

    // Assign a deterministic id to an inserted row, push it into the fake db, and
    // return it (so .select().single() sees it). Auto-stamps identifier for
    // actions (mirrors the DB trigger) so the Start receipt can echo it.
    function commitInsert(row: Record<string, unknown>): Record<string, unknown> {
      const stored = { ...row }
      if (name === 'actions') {
        stored.id = `act-${++hoisted.seq.action}`
        if (stored.identifier == null) stored.identifier = `GEN-${hoisted.seq.action}`
      } else if (name === 'agent_run') {
        stored.id = `run-${++hoisted.seq.run}`
      } else if (stored.id == null) {
        stored.id = `${String(name)}-${(hoisted.db[name] as unknown[]).length + 1}`
      }
      ;(hoisted.db[name] as Record<string, unknown>[]).push(stored)
      return stored
    }

    const api: Record<string, unknown> = {
      select: () => api,
      insert: (row: Record<string, unknown>) => {
        pendingInsert = row
        return api
      },
      eq: (k: string, v: unknown) => {
        // `payload->>work_item_id`: a key inside a jsonb column (bots v3 1b).
        const [col, inner] = k.split('->>')
        filters.push((r) => (inner ? (r[col] as Record<string, unknown> | null)?.[inner] : r[k]) === v)
        return api
      },
      // The ledger's settle writes CAS on a status set (work.fail).
      in: (k: string, vs: unknown[]) => {
        filters.push((r) => vs.includes(r[k]))
        return api
      },
      or: (expr: string) => {
        // Only the expires_at.is.null,expires_at.gt.<iso> form is used.
        orFilter = (r) => {
          const exp = r.expires_at as string | null
          if (exp == null) return true
          const m = expr.match(/expires_at\.gt\.(.+)$/)
          if (!m) return true
          return Date.parse(exp) > Date.parse(m[1])
        }
        return api
      },
      order: () => api,
      // Chainable so both `.limit(50)` (awaited directly, via the thenable `api`)
      // and `.order().limit(1).maybeSingle()` work.
      limit: () => api,
      update: (patch: Record<string, unknown>) => {
        pendingUpdate = patch
        return api
      },
      delete: () => {
        pendingDelete = true
        return api
      },
      maybeSingle: () => resolveSingle(),
      single: () => resolveSingle(),
      // A bare `await update().eq()...` / `await delete().eq()...` (no .select()) —
      // the real Supabase mutation query is a thenable that runs on await.
      // markCardAccepted / revertClaimedCard / the run-fail cleanup use this form.
      then: (resolve: (v: unknown) => unknown) => {
        const out = applyAll()
        if (pendingDelete) {
          const keep = rows().filter((r) => !out.includes(r))
          hoisted.db[name] = keep
        } else if (pendingUpdate) {
          for (const row of out) Object.assign(row, pendingUpdate)
        }
        return Promise.resolve({ data: out, error: null }).then(resolve)
      },
    }

    function applyAll() {
      let out = rows().filter((r) => filters.every((f) => f(r)))
      if (orFilter) out = out.filter(orFilter)
      return out
    }

    // Shared terminal for maybeSingle()/single(): resolve a pending insert
    // (commit + return the stored row), a pending update (CAS: mutate the first
    // match, return it — null when nothing matched), or a plain select.
    function resolveSingle() {
      if (pendingInsert) {
        // Injected failure: this table's insert returns an error and NO row (the
        // row is never committed), as a real DB error would.
        if (hoisted.failInsert.has(String(name))) {
          pendingInsert = null
          return Promise.resolve({ data: null, error: { message: `insert into ${String(name)} failed` } })
        }
        const stored = commitInsert(pendingInsert)
        pendingInsert = null
        return Promise.resolve({ data: stored, error: null })
      }
      const out = applyAll()
      if (pendingUpdate) {
        if (out.length === 0) return Promise.resolve({ data: null, error: null })
        Object.assign(out[0], pendingUpdate)
        return Promise.resolve({ data: out[0], error: null })
      }
      return Promise.resolve({ data: out[0] ?? null, error: null })
    }

    // rows is a getter so a fresh table() always sees current db state.
    rows = () => hoisted.db[name]
    return api
  }
  return { auth: { getUser: hoisted.getUser }, from: (t: string) => table(t as keyof typeof hoisted.db) }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeClient(),
}))

// The dispatch-failure compensation writes agent_run via the SERVICE client
// (migration 200 dropped the member UPDATE policy on agent_run). Back it with
// the same in-memory db so the run→failed assertion still observes the write.
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => {
    if (hoisted.serviceDown) throw new Error('service client unavailable')
    return makeClient()
  },
}))

const { GET, PATCH } = await import('@/app/api/account/attention-items/route')
const { resetAgentRunMirrorCaches } = await import('@/lib/work/agent-run-mirror')

function patchReq(body: unknown) {
  return new Request('https://dial8.ai/api/account/attention-items', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

const FUTURE = new Date(Date.now() + 60_000).toISOString()
const PAST = new Date(Date.now() - 60_000).toISOString()

beforeEach(() => {
  hoisted.getUser.mockReset()
  hoisted.applyChange.mockReset()
  hoisted.deleteAppliedEntity.mockReset()
  hoisted.generateOutreachDraft.mockReset()
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  hoisted.deleteAppliedEntity.mockResolvedValue({ success: true })
  hoisted.generateOutreachDraft.mockResolvedValue({ success: true })
  hoisted.db.attention_item = []
  hoisted.db.member = [{ id: 'mem-1', user_id: 'user-1', workspace_id: 'ws-1' }]
  hoisted.db.proposed_change = []
  hoisted.db.projects = [{ id: 'proj-2', workspace_id: 'ws-1' }]
  hoisted.db.ai_team_member = [{ id: 'ai-7', workspace_id: 'ws-1' }]
  hoisted.db.actions = []
  hoisted.db.team = [{ id: 'team-1', workspace_id: 'ws-1', created_at: '2026-01-01' }]
  hoisted.db.workflow_state = [{ id: 'ws-todo', team_id: 'team-1', is_default: true, category: 'unstarted' }]
  hoisted.db.agent_run = []
  hoisted.db.contact = []
  hoisted.db.document = []
  hoisted.db.captures = []
  hoisted.db.initiative = []
  hoisted.db.cycle = []
  hoisted.db.knowledge_package = []
  hoisted.db.claim = []
  hoisted.db.email_thread_index = []
  hoisted.db.attachments = []
  hoisted.db.chat_conversations = []
  hoisted.db.company = []
  hoisted.db.milestone = []
  hoisted.db.tracked_job = []
  hoisted.db.notification = []
  hoisted.inngestSend.mockReset()
  hoisted.inngestSend.mockResolvedValue(undefined)
  hoisted.seq.action = 0
  hoisted.seq.run = 0
  hoisted.failInsert.clear()
  hoisted.serviceDown = false
  // Run ids restart at run-1 per case; the mirror's per-run handle cache must too.
  resetAgentRunMirrorCaches()
})

describe('GET /api/account/attention-items', () => {
  it('401s when unauthenticated', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns pending, unexpired cards', async () => {
    hoisted.db.attention_item = [
      { id: 'c1', workspace_id: 'ws-1', member_id: 'mem-1', kind: 'action_card', title: 'A', proposal_id: 'p1', status: 'pending', expires_at: FUTURE, created_at: '2026-07-03' },
      { id: 'c2', workspace_id: 'ws-1', member_id: 'mem-1', kind: 'action_card', title: 'B', proposal_id: 'p2', status: 'pending', expires_at: PAST, created_at: '2026-07-02' },
    ]
    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    // A suggested action asks in the chat (P13): the `asks` half.
    const ids = body.asks.map((i: { id: string }) => i.id)
    expect(ids).toContain('c1')
    expect(ids).not.toContain('c2') // expired filtered out
    expect(body.items).toEqual([])
  })

  it('splits by place, each its own read: For you holds only post drafts, every other card asks in the chat (P13)', async () => {
    hoisted.db.attention_item = [
      { id: 'post', workspace_id: 'ws-1', member_id: 'mem-1', kind: 'question', title: 'Post', status: 'pending', expires_at: FUTURE, created_at: '2026-07-04', payload: { post_draft: { text: 'We shipped SSO.', surface: 'x' } } },
      { id: 'q', workspace_id: 'ws-1', member_id: 'mem-1', kind: 'question', title: 'Which plan?', status: 'pending', expires_at: FUTURE, created_at: '2026-07-03', payload: {} },
      { id: 'ap', workspace_id: 'ws-1', member_id: 'mem-1', kind: 'approval', title: 'Approve publish_post?', status: 'pending', expires_at: FUTURE, created_at: '2026-07-02', payload: {} },
      { id: 'work', workspace_id: 'ws-1', member_id: 'mem-1', kind: 'work_proposal', title: 'Draft it', status: 'pending', expires_at: FUTURE, created_at: '2026-07-01', payload: { task: 'x' } },
    ]
    const body = await (await GET()).json()
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['post'])
    expect(body.asks.map((i: { id: string }) => i.id).sort()).toEqual(['ap', 'q', 'work'])
  })
})

describe('PATCH — validation & guardrails', () => {
  it('400s without id/action', async () => {
    const res = await PATCH(patchReq({}))
    expect(res.status).toBe(400)
  })

  it('400s on the retired draft action (Draft this is gone)', async () => {
    const res = await PATCH(patchReq({ id: 'c1', action: 'draft' }))
    expect(res.status).toBe(400)
  })

  it('404s when the card is not found (or not owned)', async () => {
    const res = await PATCH(patchReq({ id: 'nope', action: 'accept' }))
    expect(res.status).toBe(404)
  })

  it('409s on an already-resolved card', async () => {
    hoisted.db.attention_item = [{ id: 'c1', workspace_id: 'ws-1', member_id: 'mem-1', status: 'accepted', proposal_id: 'p1', expires_at: FUTURE }]
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('ALREADY_RESOLVED')
  })

  it('409s on an expired card', async () => {
    hoisted.db.attention_item = [{ id: 'c1', workspace_id: 'ws-1', member_id: 'mem-1', status: 'pending', proposal_id: 'p1', expires_at: PAST }]
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('EXPIRED')
  })

  it('403s when caller is not a member of the card’s workspace', async () => {
    hoisted.db.attention_item = [{ id: 'c1', workspace_id: 'ws-OTHER', member_id: 'mem-1', status: 'pending', proposal_id: 'p1', expires_at: FUTURE, payload: {} }]
    // member row only exists for ws-1, not ws-OTHER.
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    expect(res.status).toBe(403)
    expect(hoisted.applyChange).not.toHaveBeenCalled()
  })
})

describe('PATCH accept — delegates to applyChange', () => {
  beforeEach(() => {
    hoisted.db.attention_item = [{ id: 'c1', workspace_id: 'ws-1', member_id: 'mem-1', status: 'pending', proposal_id: 'p1', expires_at: FUTURE, payload: {} }]
    hoisted.db.proposed_change = [{ id: 'p1', workspace_id: 'ws-1', status: 'pending', change_type: 'create', entity_type: 'action', title: 'Do the thing', extra: {} }]
  })

  it('applies the proposal, flips proposal→applied and card→accepted', async () => {
    hoisted.applyChange.mockResolvedValue({ success: true, entity_id: 'act-9' })
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.status).toBe('accepted')
    expect(body.entity_id).toBe('act-9')
    expect(hoisted.applyChange).toHaveBeenCalledTimes(1)
    expect(hoisted.db.proposed_change[0].status).toBe('applied')
    expect(hoisted.db.attention_item[0].status).toBe('accepted')
  })

  it('folds card corrections onto the change before applying', async () => {
    hoisted.applyChange.mockResolvedValue({ success: true, entity_id: 'act-9' })
    await PATCH(patchReq({
      id: 'c1',
      action: 'accept',
      corrections: { priority: 'high', project_id: 'proj-2', due_date: null, assignee_ai_member_id: 'ai-7' },
    }))
    const applied = hoisted.applyChange.mock.calls[0][1] as Record<string, unknown>
    expect(applied.priority).toBe('high')
    expect(applied.project_id).toBe('proj-2')
    expect((applied.extra as Record<string, unknown>).assignee_ai_member_id).toBe('ai-7')
    // agent + human assignee mutually exclusive
    expect(applied.assignee_member_id).toBeNull()
  })

  it('claims the proposal BEFORE applying (claim-first, no TOCTOU double-create)', async () => {
    // applyChange asserts the proposal was already flipped to 'applied' when it
    // runs — proving the claim happened first, so a concurrent accept that lost
    // the claim can never also reach applyChange.
    hoisted.applyChange.mockImplementation(async () => {
      expect(hoisted.db.proposed_change[0].status).toBe('applied')
      return { success: true, entity_id: 'act-9' }
    })
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    expect(res.status).toBe(200)
    expect(hoisted.applyChange).toHaveBeenCalledTimes(1)
  })

  it('reverts the claim to pending when applyChange fails (item not stuck applied)', async () => {
    hoisted.applyChange.mockResolvedValue({ success: false, error: 'no team' })
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    expect(res.status).toBe(500)
    expect(hoisted.db.attention_item[0].status).toBe('pending')
    // The claim was reverted — the proposal is pending again, retryable.
    expect(hoisted.db.proposed_change[0].status).toBe('pending')
    expect(hoisted.db.proposed_change[0].error_message).toBe('no team')
  })

  it('drops corrections that reference another workspace (tenancy fence)', async () => {
    hoisted.applyChange.mockResolvedValue({ success: true, entity_id: 'act-9' })
    await PATCH(patchReq({
      id: 'c1',
      action: 'accept',
      corrections: { project_id: 'proj-FOREIGN', assignee_ai_member_id: 'ai-FOREIGN' },
    }))
    const applied = hoisted.applyChange.mock.calls[0][1] as Record<string, unknown>
    // Neither foreign id was folded on (they don't resolve in ws-1).
    expect(applied.project_id).not.toBe('proj-FOREIGN')
    expect((applied.extra as Record<string, unknown>)?.assignee_ai_member_id).not.toBe('ai-FOREIGN')
  })

  it('is a no-op resolve when the backing proposal is already applied (no double apply)', async () => {
    hoisted.db.proposed_change[0].status = 'applied'
    hoisted.db.proposed_change[0].result_entity_id = 'act-existing'
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(hoisted.applyChange).not.toHaveBeenCalled()
    expect(body.entity_id).toBe('act-existing')
    expect(hoisted.db.attention_item[0].status).toBe('accepted')
  })

  it('reports honest "dismissed" (not "accepted") when the backing proposal was already dismissed', async () => {
    hoisted.db.proposed_change[0].status = 'dismissed'
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(hoisted.applyChange).not.toHaveBeenCalled()
    expect(body.status).toBe('dismissed') // not a false "accepted"
    expect(body.entity_id).toBeNull()
    expect(hoisted.db.attention_item[0].status).toBe('dismissed')
  })

  it('accepts a question card (no proposal) as an acknowledge', async () => {
    hoisted.db.attention_item = [{ id: 'cq', workspace_id: 'ws-1', member_id: 'mem-1', status: 'pending', proposal_id: null, kind: 'question', expires_at: FUTURE, payload: {} }]
    const res = await PATCH(patchReq({ id: 'cq', action: 'accept' }))
    expect(res.status).toBe(200)
    expect(hoisted.applyChange).not.toHaveBeenCalled()
    expect(hoisted.db.attention_item[0].status).toBe('accepted')
  })
})

describe('PATCH accept — the receipt (WS-1c)', () => {
  beforeEach(() => {
    hoisted.db.attention_item = [{ id: 'c1', workspace_id: 'ws-1', member_id: 'mem-1', status: 'pending', proposal_id: 'p1', kind: 'action_card', expires_at: FUTURE, payload: {} }]
    hoisted.db.proposed_change = [{ id: 'p1', workspace_id: 'ws-1', status: 'pending', change_type: 'create', entity_type: 'action', title: 'Do the thing', extra: {} }]
  })

  it('returns entity_kind + the created action human identifier', async () => {
    hoisted.applyChange.mockResolvedValue({ success: true, entity_id: 'act-9' })
    hoisted.db.actions = [{ id: 'act-9', workspace_id: 'ws-1', identifier: 'GEN-9' }]
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.status).toBe('accepted')
    expect(body.entity_id).toBe('act-9')
    expect(body.entity_kind).toBe('action')
    expect(body.identifier).toBe('GEN-9')
  })

  it('returns entity_kind but omits identifier when the action has none yet', async () => {
    hoisted.applyChange.mockResolvedValue({ success: true, entity_id: 'act-9' }) // actions table empty
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    const body = await res.json()
    expect(body.entity_kind).toBe('action')
    expect(body.identifier).toBeUndefined()
  })
})

describe('PATCH accept — draft_email fills a real draft (WS-2a)', () => {
  const draftEmailCard = () => ({
    id: 'c1', workspace_id: 'ws-1', member_id: 'mem-1', status: 'pending',
    proposal_id: 'p1', kind: 'draft_email', expires_at: FUTURE, payload: {},
  })
  const sendEmailProposal = (over: Record<string, unknown> = {}) => ({
    id: 'p1', workspace_id: 'ws-1', status: 'pending', change_type: 'send_email',
    entity_type: 'external', title: 'Reach out to Sam', email_to_address: 'sam@x.com',
    email_to_name: 'Sam', email_subject: 'Reach out to Sam', email_context: 'follow up on the deal',
    trigger_quote: "I'll email Sam", capture_id: 'cap1', extra: {}, ...over,
  })

  it('claims + applies the shell, fills it, resolves the card to draft_ready', async () => {
    hoisted.db.attention_item = [draftEmailCard()]
    hoisted.db.proposed_change = [sendEmailProposal()]
    hoisted.applyChange.mockResolvedValue({ success: true, entity_id: 'draft-1' })
    hoisted.generateOutreachDraft.mockResolvedValue({ success: true })
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.status).toBe('draft_ready')
    expect(body.entity_id).toBe('draft-1')
    expect(body.entity_kind).toBe('email_draft')
    expect(body.draft_id).toBe('draft-1')
    // Shell created (proposal applied) and the generator ran against that draft id.
    expect(hoisted.db.proposed_change[0].status).toBe('applied')
    expect(hoisted.generateOutreachDraft).toHaveBeenCalledTimes(1)
    const call = hoisted.generateOutreachDraft.mock.calls[0]
    expect(call[1]).toBe('ws-1')
    expect(call[2]).toBe('draft-1')
    expect((call[3] as Record<string, unknown>).to_address).toBe('sam@x.com')
    expect((call[3] as Record<string, unknown>).capture_id).toBe('cap1')
    expect(hoisted.db.attention_item[0].status).toBe('accepted')
  })

  it('generation failure: card stays pending, draft_id stamped, 502 for retry', async () => {
    hoisted.db.attention_item = [draftEmailCard()]
    hoisted.db.proposed_change = [sendEmailProposal()]
    hoisted.applyChange.mockResolvedValue({ success: true, entity_id: 'draft-1' })
    hoisted.generateOutreachDraft.mockResolvedValue({ success: false, error: 'model down' })
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    const body = await res.json()
    expect(res.status).toBe(502)
    expect(body.code).toBe('DRAFT_GENERATION_FAILED')
    expect(body.draft_id).toBe('draft-1')
    // Applied shell survives; the card stays pending with draft_id stamped so a
    // retry re-enters the SAME shell.
    expect(hoisted.db.proposed_change[0].status).toBe('applied')
    expect(hoisted.db.attention_item[0].status).toBe('pending')
    expect((hoisted.db.attention_item[0].payload as Record<string, unknown>).draft_id).toBe('draft-1')
  })

  it('retry: an applied send_email card with a stamped draft_id re-fills that shell, no new apply', async () => {
    hoisted.db.attention_item = [{ ...draftEmailCard(), payload: { draft_id: 'draft-1' } }]
    hoisted.db.proposed_change = [sendEmailProposal({ status: 'applied', result_entity_id: 'draft-1' })]
    hoisted.generateOutreachDraft.mockResolvedValue({ success: true })
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.status).toBe('draft_ready')
    expect(body.draft_id).toBe('draft-1')
    expect(hoisted.applyChange).not.toHaveBeenCalled()
    expect(hoisted.generateOutreachDraft).toHaveBeenCalledTimes(1)
    expect(hoisted.generateOutreachDraft.mock.calls[0][2]).toBe('draft-1')
    expect(hoisted.db.attention_item[0].status).toBe('accepted')
  })

  it('applied send_email card with NO stamped draft_id → honest already-applied resolve', async () => {
    hoisted.db.attention_item = [{ ...draftEmailCard(), payload: {} }]
    hoisted.db.proposed_change = [sendEmailProposal({ status: 'applied', result_entity_id: 'draft-1' })]
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.status).toBe('accepted')
    expect(body.entity_kind).toBe('email_draft')
    expect(hoisted.generateOutreachDraft).not.toHaveBeenCalled()
    expect(hoisted.db.attention_item[0].status).toBe('accepted')
  })
})

describe('PATCH accept — update-target hygiene (W-4c)', () => {
  const targetlessUpdateCard = () => ({
    id: 'c1', workspace_id: 'ws-1', member_id: 'mem-1', status: 'pending',
    proposal_id: 'p1', kind: 'action_card', expires_at: FUTURE, payload: {},
  })
  const targetlessUpdateProposal = (over: Record<string, unknown> = {}) => ({
    id: 'p1', workspace_id: 'ws-1', status: 'pending', change_type: 'update',
    entity_type: 'action', entity_id: null, title: 'Bump the API docs task', extra: {}, ...over,
  })

  it('a target-less update whose apply UNRESOLVES returns 409 UPDATE_TARGET_UNRESOLVED and reverts the claim', async () => {
    hoisted.db.attention_item = [targetlessUpdateCard()]
    hoisted.db.proposed_change = [targetlessUpdateProposal()]
    hoisted.applyChange.mockResolvedValue({
      success: false,
      error: 'Could not determine which action this update targets.',
      code: 'UPDATE_TARGET_UNRESOLVED',
    })
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept' }))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('UPDATE_TARGET_UNRESOLVED')
    // The claim was reverted so the card is pending + retryable (with a target).
    expect(hoisted.db.proposed_change[0].status).toBe('pending')
  })

  it('accepts a workspace-verified target_entity_id: stamps it on the change and applies', async () => {
    hoisted.db.attention_item = [targetlessUpdateCard()]
    hoisted.db.proposed_change = [targetlessUpdateProposal()]
    // The picked action IS in the card's workspace.
    hoisted.db.actions = [{ id: 'act-target', workspace_id: 'ws-1', identifier: 'GEN-7' }]
    hoisted.applyChange.mockResolvedValue({ success: true, entity_id: 'act-target' })
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept', target_entity_id: 'act-target' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.status).toBe('accepted')
    // The verified target was stamped onto the change before applyChange ran.
    const applied = hoisted.applyChange.mock.calls[0][1] as Record<string, unknown>
    expect(applied.entity_id).toBe('act-target')
    expect(hoisted.db.proposed_change[0].status).toBe('applied')
    expect(hoisted.db.attention_item[0].status).toBe('accepted')
  })

  it('REFUSES a target_entity_id for an action NOT in the card workspace (fence) — 400, no apply, card untouched', async () => {
    hoisted.db.attention_item = [targetlessUpdateCard()]
    hoisted.db.proposed_change = [targetlessUpdateProposal()]
    // The picked action exists but in a DIFFERENT workspace.
    hoisted.db.actions = [{ id: 'act-foreign', workspace_id: 'ws-OTHER', identifier: 'X-1' }]
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept', target_entity_id: 'act-foreign' }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.code).toBe('TARGET_NOT_IN_WORKSPACE')
    // Never applied, and the card + proposal are left completely untouched.
    expect(hoisted.applyChange).not.toHaveBeenCalled()
    expect(hoisted.db.attention_item[0].status).toBe('pending')
    expect(hoisted.db.proposed_change[0].status).toBe('pending')
  })

  it('REFUSES a nonexistent target_entity_id (400, no apply)', async () => {
    hoisted.db.attention_item = [targetlessUpdateCard()]
    hoisted.db.proposed_change = [targetlessUpdateProposal()]
    hoisted.db.actions = [] // the id resolves to nothing
    const res = await PATCH(patchReq({ id: 'c1', action: 'accept', target_entity_id: 'act-ghost' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('TARGET_NOT_IN_WORKSPACE')
    expect(hoisted.applyChange).not.toHaveBeenCalled()
  })
})

describe('PATCH — settling a run’s last card reads its digest (bots v3 1b)', () => {
  const runCard = (id: string, status = 'pending') => ({
    id,
    workspace_id: 'ws-1',
    member_id: 'mem-1',
    kind: 'action_card',
    status,
    proposal_id: null,
    expires_at: FUTURE,
    payload: { work_item_id: 'job-1', raised_by_ai_member_id: 'tm-triage' },
  })
  const digest = (over: Record<string, unknown> = {}) => ({
    id: 'n-digest',
    recipient_id: 'mem-1',
    target_type: 'work_item',
    target_id: 'job-1',
    is_read: false,
    ...over,
  })

  it('a card settled while another of the run’s waits leaves the digest unread', async () => {
    hoisted.db.attention_item = [runCard('c1'), runCard('c2')]
    hoisted.db.notification = [digest()]
    expect((await PATCH(patchReq({ id: 'c1', action: 'dismiss' }))).status).toBe(200)
    expect(hoisted.db.notification[0].is_read).toBe(false)
  })

  it('the last one settled reads the owner’s digest for the run, and nobody else’s', async () => {
    hoisted.db.attention_item = [runCard('c1'), runCard('c2', 'dismissed')]
    hoisted.db.notification = [digest(), digest({ id: 'n-other', target_id: 'job-2' }), digest({ id: 'n-theirs', recipient_id: 'mem-9' })]
    expect((await PATCH(patchReq({ id: 'c1', action: 'dismiss' }))).status).toBe(200)
    expect(hoisted.db.notification.map((n) => [n.id, n.is_read])).toEqual([
      ['n-digest', true],
      ['n-other', false],
      ['n-theirs', false],
    ])
  })

  it('a card that names no run reads nothing', async () => {
    hoisted.db.attention_item = [{ ...runCard('c1'), payload: {} }]
    hoisted.db.notification = [digest()]
    expect((await PATCH(patchReq({ id: 'c1', action: 'dismiss' }))).status).toBe(200)
    expect(hoisted.db.notification[0].is_read).toBe(false)
  })
})

describe('PATCH dismiss — the proposal stays, except behind a work card', () => {
  it('flips the card to dismissed and leaves the proposal pending', async () => {
    hoisted.db.attention_item = [{ id: 'c1', workspace_id: 'ws-1', member_id: 'mem-1', status: 'pending', proposal_id: 'p1', expires_at: FUTURE, payload: {} }]
    hoisted.db.proposed_change = [{ id: 'p1', workspace_id: 'ws-1', status: 'pending' }]
    const res = await PATCH(patchReq({ id: 'c1', action: 'dismiss' }))
    expect(res.status).toBe(200)
    expect(hoisted.db.attention_item[0].status).toBe('dismissed')
    expect(hoisted.db.proposed_change[0].status).toBe('pending') // untouched
    expect(hoisted.applyChange).not.toHaveBeenCalled()
  })

  it('every non-work card kind leaves its proposal pending', async () => {
    for (const kind of ['action_card', 'draft_email', 'question']) {
      hoisted.db.attention_item = [{ id: 'c1', workspace_id: 'ws-1', member_id: 'mem-1', kind, status: 'pending', proposal_id: 'p1', expires_at: FUTURE, payload: {} }]
      hoisted.db.proposed_change = [{ id: 'p1', workspace_id: 'ws-1', status: 'pending' }]
      expect((await PATCH(patchReq({ id: 'c1', action: 'dismiss' }))).status).toBe(200)
      expect(hoisted.db.proposed_change[0].status).toBe('pending')
    }
  })

  const workCard = (over: Record<string, unknown> = {}) => ({
    id: 'wc1',
    workspace_id: 'ws-1',
    member_id: 'mem-1',
    kind: 'work_proposal',
    title: 'Draft the stakeholder status email',
    status: 'pending',
    proposal_id: 'p1',
    expires_at: FUTURE,
    payload: { task: 'Draft the stakeholder status email.' },
    ...over,
  })

  it('a dismissed WORK card dismisses its pending proposal, so triage cannot propose it again', async () => {
    hoisted.db.attention_item = [workCard()]
    hoisted.db.proposed_change = [{ id: 'p1', workspace_id: 'ws-1', status: 'pending', extra: { source: 'extraction' } }]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'dismiss' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'dismissed' })
    expect(hoisted.db.attention_item[0].status).toBe('dismissed')
    // The way a triage dismiss writes it: status, and the reason beside what was there.
    expect(hoisted.db.proposed_change[0]).toMatchObject({
      status: 'dismissed',
      extra: { source: 'extraction', dismiss_reason: 'Work card dismissed' },
    })
    // Nothing started, nothing applied.
    expect(hoisted.applyChange).not.toHaveBeenCalled()
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
    expect(hoisted.db.agent_run).toHaveLength(0)
  })

  it('leaves a proposal that is already resolved, or in another workspace, alone', async () => {
    hoisted.db.attention_item = [workCard()]
    hoisted.db.proposed_change = [
      { id: 'p1', workspace_id: 'ws-1', status: 'applied' },
      { id: 'p1', workspace_id: 'ws-2', status: 'pending' },
    ]
    expect((await PATCH(patchReq({ id: 'wc1', action: 'dismiss' }))).status).toBe(200)
    expect(hoisted.db.proposed_change.map((p) => p.status)).toEqual(['applied', 'pending'])
  })

  it('a work card with no proposal dismisses cleanly', async () => {
    hoisted.db.attention_item = [workCard({ proposal_id: null })]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'dismiss' }))
    expect(res.status).toBe(200)
    expect(hoisted.db.attention_item[0].status).toBe('dismissed')
  })

  it('a card that lost the dismiss race touches no proposal', async () => {
    hoisted.db.attention_item = [workCard({ status: 'accepted' })]
    hoisted.db.proposed_change = [{ id: 'p1', workspace_id: 'ws-1', status: 'pending' }]
    expect((await PATCH(patchReq({ id: 'wc1', action: 'dismiss' }))).status).toBe(409)
    expect(hoisted.db.proposed_change[0].status).toBe('pending')
  })

  it('the proposal write is best-effort: the card is still dismissed when it fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.db.attention_item = [workCard()]
    hoisted.db.proposed_change = [{ id: 'p1', workspace_id: 'ws-1', status: 'pending' }]
    hoisted.serviceDown = true
    const res = await PATCH(patchReq({ id: 'wc1', action: 'dismiss' }))
    expect(res.status).toBe(200)
    expect(hoisted.db.attention_item[0].status).toBe('dismissed')
    expect(hoisted.db.proposed_change[0].status).toBe('pending')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not dismiss the proposal behind a work card'), 'p1', 'service client unavailable')
    logged.mockRestore()
  })
})

describe('PATCH start — work proposal → tracked action + work run', () => {
  const workCard = (over: Record<string, unknown> = {}) => ({
    id: 'wc1',
    workspace_id: 'ws-1',
    member_id: 'mem-1',
    kind: 'work_proposal',
    title: 'Draft a follow-up email to Randy',
    status: 'pending',
    proposal_id: 'p1',
    expires_at: FUTURE,
    payload: {
      task: 'Draft a follow-up email to Randy about GA access.',
      deliverable_hint: 'email_draft',
      resources: [{ type: 'contact', id: 'con-9', label: 'Randy' }],
    },
    ...over,
  })

  it('rejects start on a non-work card with 400 INVALID_ACTION', async () => {
    hoisted.db.attention_item = [{ id: 'c1', workspace_id: 'ws-1', member_id: 'mem-1', kind: 'action_card', status: 'pending', proposal_id: 'p1', expires_at: FUTURE, payload: {} }]
    const res = await PATCH(patchReq({ id: 'c1', action: 'start' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_ACTION')
  })

  it('rejects accept on a work card with 400 INVALID_ACTION', async () => {
    hoisted.db.attention_item = [workCard()]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'accept' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_ACTION')
    // Card untouched, no run dispatched.
    expect(hoisted.db.attention_item[0].status).toBe('pending')
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('starts: CAS card→accepted, files action (no source_type), inserts run, dispatches', async () => {
    hoisted.db.attention_item = [workCard()]
    hoisted.db.proposed_change = [{ id: 'p1', workspace_id: 'ws-1', status: 'pending' }]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.status).toBe('started')
    expect(body.entity_kind).toBe('action')
    expect(body.agent_run_id).toBe('run-1')
    expect(body.entity_id).toBe('act-1')
    expect(body.identifier).toBe('GEN-1')

    // Card resolved to accepted.
    expect(hoisted.db.attention_item[0].status).toBe('accepted')

    // Tracked action filed with the right shape — description = task, no
    // source_type key, agent_run_status='starting', default state.
    const action = hoisted.db.actions[0]
    expect(action.title).toBe('Draft a follow-up email to Randy')
    expect(action.description).toBe('Draft a follow-up email to Randy about GA access.')
    expect('source_type' in action).toBe(false)
    // A Start files only the work row: no board fields from the card.
    for (const key of ['priority', 'due_at', 'project_id', 'source_capture_id']) expect(key in action).toBe(false)
    expect(action.agent_run_status).toBe('starting')
    expect(action.status_id).toBe('ws-todo')
    expect((action.context_data as Record<string, unknown>).work_run).toBe(true)
    expect((action.context_data as Record<string, unknown>).attention_item_id).toBe('wc1')

    // Backing proposal CAS'd applied with result_entity_id = action id.
    expect(hoisted.db.proposed_change[0].status).toBe('applied')
    expect(hoisted.db.proposed_change[0].result_entity_id).toBe('act-1')

    // agent_run row: kind='workspace', queued, task_prompt, resources snapshot,
    // linkage back to card + proposal, triggered_by.
    const run = hoisted.db.agent_run[0]
    expect(run.kind).toBe('workspace')
    expect(run.status).toBe('queued')
    expect(run.action_id).toBe('act-1')
    expect(run.task_prompt).toBe('Draft a follow-up email to Randy about GA access.')
    expect(run.attention_item_id).toBe('wc1')
    expect(run.proposal_id).toBe('p1')
    expect(run.triggered_by).toBe('user-1')
    expect(Array.isArray(run.resources)).toBe(true)
    expect((run.resources as unknown[]).length).toBe(1)

    // Durable dispatch emitted with the run + workspace.
    expect(hoisted.inngestSend).toHaveBeenCalledTimes(1)
    const sent = hoisted.inngestSend.mock.calls[0][0] as { name: string; data: Record<string, unknown> }
    expect(sent.name).toBe('work/run.requested')
    expect(sent.data.agent_run_id).toBe('run-1')
    expect(sent.data.workspace_id).toBe('ws-1')

    // The run is in the work ledger from dispatch (queued, owned by the
    // starter, titled after the tracked action) — Activity shows it before the
    // first log beat.
    expect(hoisted.db.tracked_job).toHaveLength(1)
    expect(hoisted.db.tracked_job[0]).toMatchObject({
      workspace_id: 'ws-1',
      member_id: 'mem-1',
      kind: 'work_run',
      status: 'queued',
      actor: 'agent',
      title: 'Draft a follow-up email to Randy',
      run_key: 'run-1',
      agent_run_id: 'run-1',
    })
  })

  it('B PR 4: hands the run to the card role’s teammate and records where the work came from', async () => {
    const base = workCard()
    hoisted.db.attention_item = [
      workCard({ why: 'Randy asked "send me the GA access details"', payload: { ...(base.payload as object), role: 'correspondent', capture_id: 'cap-card' } }),
    ]
    hoisted.db.proposed_change = [
      { id: 'p1', workspace_id: 'ws-1', status: 'pending', capture_id: 'cap-1', trigger_quote: 'send me the GA access details by Friday' },
    ]
    hoisted.db.ai_team_member = [
      { id: 'tm-off', workspace_id: 'ws-1', name: 'Off', role: 'correspondent', autonomy: 'off', allowed_side_effects: ['read'], created_at: '2026-08-01T00:00:00.000Z' },
      { id: 'tm-cora', workspace_id: 'ws-1', name: 'Cora', role: 'correspondent', autonomy: 'propose', allowed_side_effects: ['read'], created_at: '2026-09-01T00:00:00.000Z' },
      { id: 'tm-writer', workspace_id: 'ws-1', name: 'Quill', role: 'writer', autonomy: 'attempt', allowed_side_effects: ['read'], created_at: '2026-07-01T00:00:00.000Z' },
    ]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(200)
    expect(hoisted.db.agent_run[0].ai_team_member_id).toBe('tm-cora')
    // The origin stays the person's: a Start is not unattended.
    expect('origin' in hoisted.db.agent_run[0]).toBe(false)
    expect(hoisted.db.tracked_job[0]).toMatchObject({
      ai_team_member_id: 'tm-cora',
      source: expect.objectContaining({
        action_id: 'act-1',
        provenance: { captureId: 'cap-1', quote: 'send me the GA access details by Friday' },
      }),
    })
  })

  it('B PR 4: a card that names its teammate keeps it; with neither a teammate nor a role, no one (as before)', async () => {
    hoisted.db.ai_team_member = [
      { id: 'tm-named', workspace_id: 'ws-1', name: 'Named', role: null, autonomy: 'propose', allowed_side_effects: ['read'], is_system: false },
    ]
    const base = workCard()
    hoisted.db.attention_item = [workCard({ payload: { ...(base.payload as object), assignee_ai_member_id: 'tm-named' } })]
    expect((await PATCH(patchReq({ id: 'wc1', action: 'start' }))).status).toBe(200)
    expect(hoisted.db.agent_run[0].ai_team_member_id).toBe('tm-named')

    hoisted.db.attention_item = [workCard({ id: 'wc2', proposal_id: null })]
    expect((await PATCH(patchReq({ id: 'wc2', action: 'start' }))).status).toBe(200)
    expect('ai_team_member_id' in hoisted.db.agent_run[1]).toBe(false)
    expect((hoisted.db.tracked_job[1].source as Record<string, unknown>).provenance).toBeUndefined()
  })

  it('proposed_change CAS is best-effort — start succeeds when there is no proposal', async () => {
    hoisted.db.attention_item = [workCard({ proposal_id: null })]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(200)
    expect(hoisted.db.agent_run[0].proposal_id).toBeNull()
    expect(hoisted.inngestSend).toHaveBeenCalledTimes(1)
  })

  it('409s when the card was already resolved (lost the CAS)', async () => {
    hoisted.db.attention_item = [workCard({ status: 'accepted' })]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('ALREADY_RESOLVED')
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('403s when the caller is not a member of the card’s workspace', async () => {
    hoisted.db.attention_item = [workCard({ workspace_id: 'ws-OTHER' })]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(403)
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('400s when the work card has no task', async () => {
    hoisted.db.attention_item = [workCard({ payload: { task: '  ' } })]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('NO_TASK')
  })

  it('NO_DEFAULT_STATE does NOT consume the card (lookup runs BEFORE the CAS)', async () => {
    // No default workflow state → the team/state lookup fails. Because that read now
    // runs before the CAS, the card must stay PENDING (approved work not dropped) and
    // no run/action is filed.
    hoisted.db.attention_item = [workCard()]
    hoisted.db.workflow_state = []
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('NO_DEFAULT_STATE')
    expect(hoisted.db.attention_item[0].status).toBe('pending') // card NOT consumed
    expect(hoisted.db.actions.length).toBe(0)
    expect(hoisted.db.agent_run.length).toBe(0)
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('reverts the claimed card to pending when the tracked-action insert fails', async () => {
    hoisted.db.attention_item = [workCard()]
    hoisted.failInsert.add('actions')
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(500)
    // Card reverted to pending — approved work is retryable, not silently dropped.
    expect(hoisted.db.attention_item[0].status).toBe('pending')
    expect(hoisted.db.attention_item[0].resolved_at).toBeNull()
    // No orphan action / run / dispatch.
    expect(hoisted.db.actions.length).toBe(0)
    expect(hoisted.db.agent_run.length).toBe(0)
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('deletes the action AND reverts the card when the run insert fails', async () => {
    hoisted.db.attention_item = [workCard()]
    hoisted.db.proposed_change = [{ id: 'p1', workspace_id: 'ws-1', status: 'pending' }]
    hoisted.failInsert.add('agent_run')
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(500)
    // The action that was inserted is deleted (no orphan 'starting' action) …
    expect(hoisted.db.actions.length).toBe(0)
    // … the run never landed, and the card is back to pending.
    expect(hoisted.db.agent_run.length).toBe(0)
    expect(hoisted.db.attention_item[0].status).toBe('pending')
    // The proposal CAS runs AFTER the run insert, so a run-insert failure never
    // marks it applied — no dangling result_entity_id pointing at the deleted action.
    expect(hoisted.db.proposed_change[0].status).toBe('pending')
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('on dispatch (inngest.send) failure: run→failed, action→idle, card→pending', async () => {
    hoisted.db.attention_item = [workCard()]
    hoisted.inngestSend.mockRejectedValueOnce(new Error('inngest down'))
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('DISPATCH_FAILED')
    // No orphan QUEUED run — it's marked failed so no worker picks it up.
    expect(hoisted.db.agent_run[0].status).toBe('failed')
    // The action isn't stuck 'starting'.
    expect(hoisted.db.actions[0].agent_run_status).toBe('idle')
    // The card is reverted so the user can retry.
    expect(hoisted.db.attention_item[0].status).toBe('pending')
    // The ledger row is settled too: Activity must not show a queued run with a
    // Stop that no worker will ever pick up.
    expect(hoisted.db.tracked_job[0]).toMatchObject({ status: 'failed' })
  })

  it('drops a foreign/unknown resource id but KEEPS its label (workspace fence)', async () => {
    // con-9 does NOT exist in ws-1 (contact table empty) → id dropped, label kept.
    // A cycle whose team IS in ws-1 keeps its id (team-fenced validation).
    hoisted.db.cycle = [{ id: 'cyc-1', team_id: 'team-1' }] // team-1 is in ws-1
    hoisted.db.attention_item = [
      workCard({
        payload: {
          task: 'Do work',
          resources: [
            { type: 'contact', id: 'con-9', label: 'Randy' }, // foreign/missing id
            { type: 'cycle', id: 'cyc-1', label: 'Sprint 3' }, // valid, team-fenced
            { type: 'sasquatch', id: 'x-1', label: 'mystery' }, // unknown type → id dropped
          ],
        },
      }),
    ]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(200)
    const resources = hoisted.db.agent_run[0].resources as Array<Record<string, unknown>>
    expect(resources.length).toBe(3) // every label survives
    const byLabel = Object.fromEntries(resources.map((r) => [r.label, r]))
    expect(byLabel['Randy'].id).toBeUndefined() // foreign id dropped
    expect(byLabel['mystery'].id).toBeUndefined() // unknown type → id dropped
    expect(byLabel['Sprint 3'].id).toBe('cyc-1') // valid team-fenced id kept
  })

  it('keeps a resource id that DOES resolve in the card workspace', async () => {
    hoisted.db.contact = [{ id: 'con-9', workspace_id: 'ws-1' }]
    hoisted.db.attention_item = [
      workCard({ payload: { task: 'Do work', resources: [{ type: 'contact', id: 'con-9', label: 'Randy' }] } }),
    ]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(200)
    const resources = hoisted.db.agent_run[0].resources as Array<Record<string, unknown>>
    expect(resources[0].id).toBe('con-9')
  })

  // W-C widened snapshotResources: the five types that entityInWorkspace now
  // fences via their own workspace_id column (claim / email / attachment /
  // member / conversation). Each: a valid id in the card's ws is KEPT; a
  // foreign/missing id is DROPPED (label kept). The route delegates to the REAL
  // entityInWorkspace (claims.ts is unmocked), whose selects the fake client
  // answers from these tables.
  describe('W-C — newly-covered resource types keep valid / drop foreign ids', () => {
    // resource type → { table it fences on, a row proving membership in ws-1 }.
    const CASES: Array<{ type: string; table: keyof typeof hoisted.db; id: string }> = [
      { type: 'claim', table: 'claim', id: 'clm-1' },
      { type: 'email', table: 'email_thread_index', id: 'em-1' },
      { type: 'attachment', table: 'attachments', id: 'att-1' },
      { type: 'member', table: 'member', id: 'mem-res-1' },
      { type: 'conversation', table: 'chat_conversations', id: 'conv-1' },
      // Added by the entity registry — same own-workspace_id fence.
      { type: 'company', table: 'company', id: 'co-1' },
    ]

    for (const { type, table, id } of CASES) {
      it(`keeps a valid ${type} id that resolves in the card workspace`, async () => {
        ;(hoisted.db[table] as Record<string, unknown>[]).push({ id, workspace_id: 'ws-1' })
        hoisted.db.attention_item = [
          workCard({ payload: { task: 'Do work', resources: [{ type, id, label: `${type} label` }] } }),
        ]
        const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
        expect(res.status).toBe(200)
        const resources = hoisted.db.agent_run[0].resources as Array<Record<string, unknown>>
        expect(resources[0].id).toBe(id)
        expect(resources[0].label).toBe(`${type} label`)
      })

      it(`drops a foreign ${type} id (wrong workspace) but keeps the label`, async () => {
        // The row exists, but in ANOTHER workspace → entityInWorkspace's fenced
        // select (eq workspace_id ws-1) finds nothing → id dropped.
        ;(hoisted.db[table] as Record<string, unknown>[]).push({ id, workspace_id: 'ws-OTHER' })
        hoisted.db.attention_item = [
          workCard({ payload: { task: 'Do work', resources: [{ type, id, label: `${type} label` }] } }),
        ]
        const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
        expect(res.status).toBe(200)
        const resources = hoisted.db.agent_run[0].resources as Array<Record<string, unknown>>
        expect(resources.length).toBe(1) // label survives
        expect(resources[0].id).toBeUndefined() // foreign id dropped
        expect(resources[0].label).toBe(`${type} label`)
      })
    }
  })

  it('package + cycle special cases still fence exactly as before', async () => {
    // package keeps its own knowledge_package fence; cycle its team fence. Both
    // valid-in-ws ids are kept; a foreign package id is dropped.
    hoisted.db.knowledge_package = [{ id: 'pkg-1', workspace_id: 'ws-1' }]
    hoisted.db.cycle = [{ id: 'cyc-1', team_id: 'team-1' }] // team-1 ∈ ws-1
    hoisted.db.attention_item = [
      workCard({
        payload: {
          task: 'Do work',
          resources: [
            { type: 'package', id: 'pkg-1', label: 'Pkg' }, // valid → kept
            { type: 'package', id: 'pkg-FOREIGN', label: 'Foreign pkg' }, // missing → dropped
            { type: 'cycle', id: 'cyc-1', label: 'Sprint' }, // valid team-fence → kept
          ],
        },
      }),
    ]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(200)
    const resources = hoisted.db.agent_run[0].resources as Array<Record<string, unknown>>
    const byLabel = Object.fromEntries(resources.map((r) => [r.label, r]))
    expect(byLabel['Pkg'].id).toBe('pkg-1')
    expect(byLabel['Foreign pkg'].id).toBeUndefined()
    expect(byLabel['Sprint'].id).toBe('cyc-1')
  })

  // `milestone` became a linkable type with the entity registry. It has no
  // workspace_id of its own, so entityInWorkspace's can't-verify→allow would
  // wave a foreign id straight through — the route fences it via its project,
  // exactly as it fences a cycle via its team.
  it('fences a milestone id through its project, not by can-not-verify-allow', async () => {
    hoisted.db.projects.push({ id: 'prj-1', workspace_id: 'ws-1' })
    hoisted.db.projects.push({ id: 'prj-OTHER', workspace_id: 'ws-OTHER' })
    hoisted.db.milestone = [
      { id: 'ms-1', project_id: 'prj-1' },
      { id: 'ms-FOREIGN', project_id: 'prj-OTHER' },
    ]
    hoisted.db.attention_item = [
      workCard({
        payload: {
          task: 'Do work',
          resources: [
            { type: 'milestone', id: 'ms-1', label: 'Beta' },
            { type: 'milestone', id: 'ms-FOREIGN', label: 'Foreign ms' },
            { type: 'milestone', id: 'ms-MISSING', label: 'Missing ms' },
          ],
        },
      }),
    ]
    const res = await PATCH(patchReq({ id: 'wc1', action: 'start' }))
    expect(res.status).toBe(200)
    const resources = hoisted.db.agent_run[0].resources as Array<Record<string, unknown>>
    const byLabel = Object.fromEntries(resources.map((r) => [r.label, r]))
    expect(byLabel['Beta'].id).toBe('ms-1')
    expect(byLabel['Foreign ms'].id).toBeUndefined()
    expect(byLabel['Missing ms'].id).toBeUndefined()
  })
})
