/**
 * GET / PATCH /api/account/activity/[id] — one work item and its review verbs.
 *
 * Locked in: the read is the caller's own row (404 otherwise); the GET also
 * folds `output` out of the item's execution rows (src/lib/work/output.ts) so
 * the panel renders what the run produced; 'reviewed' and 'dismiss' both land
 * on done with reviewed_at and keep which one it was; a settled item is left
 * alone (changed:false); a bad action is a 400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { WorkOutput } from '@/lib/work/output'

const hoisted = vi.hoisted(() => ({ fake: null as unknown }))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: vi.fn(async () => ({
    supabase: hoisted.fake,
    user: { id: 'user-1' },
    workspaceId: 'w1',
    member: { id: 'm1' },
  })),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.fake }))

const { GET, PATCH } = await import('@/app/api/account/activity/[id]/route')

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
function patchReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest
}
const getReq = {} as NextRequest

let fake: FakeSupabase

beforeEach(() => {
  fake = makeFakeSupabase()
  hoisted.fake = fake
  fake.seed('tracked_job', [
    {
      id: 'waiting',
      workspace_id: 'w1',
      member_id: 'm1',
      kind: 'email_drafts',
      title: 'Reply drafts for 2 threads',
      status: 'needs_review',
      needs: { kind: 'review', verb: 'review' },
      deliverables: [{ type: 'email_draft', id: 'd1000000-0000-4000-8000-000000000001', label: 'Re: Pricing' }],
      progress: { done: 1, total: 2 },
      reviewed_at: null,
      created_at: '2026-09-17T10:00:00.000Z',
    },
    { id: 'settled', workspace_id: 'w1', member_id: 'm1', kind: 'flow_run', title: 't', status: 'done', progress: {}, created_at: '2026-09-17T09:00:00.000Z' },
    {
      id: 'triage',
      workspace_id: 'w1',
      member_id: 'm1',
      kind: 'flow_run',
      title: 'Meeting triage',
      status: 'done',
      progress: {},
      deliverables: [{ type: 'attention_cards', id: 'fr-1', label: '1 card for you', count: 1 }],
      source: {},
      flow_run_id: 'fr-1',
      created_at: '2026-09-17T08:00:00.000Z',
    },
  ])
})

/** The execution rows behind the 'triage' item, which the GET folds into `output`. */
function seedTriageRun() {
  fake.seed('flow_run', [
    {
      id: 'fr-1',
      status: 'success',
      error_message: null,
      action_results: [
        {
          skipped: false,
          status: 'success',
          error_message: null,
          verdict: {
            summary: 'One real commitment came out of the pricing sync.',
            entries: [
              { proposal_id: 'p1', decision: 'accept', outcome: 'carded', reason: 'Needs your wording' },
              { proposal_id: 'p2', decision: 'dismiss', outcome: 'dismissed', reason: 'Already tracked' },
            ],
            cards_surfaced: 1,
            cards_overflow: 0,
            revoked_count: 0,
          },
        },
      ],
    },
  ])
  fake.seed('proposed_change', [
    { id: 'p1', display_text: 'Draft the pricing recap', title: null, entity_type: 'email', change_type: 'send_email', status: 'pending' },
    { id: 'p2', display_text: 'Chase the security review', title: null, entity_type: null, change_type: null, status: 'dismissed' },
  ])
  fake.seed('attention_item', [
    {
      id: 'card-1',
      source_flow_run_id: 'fr-1',
      kind: 'draft_email',
      title: 'Draft the pricing recap',
      why: 'Dana asked twice',
      payload: { email_to_name: 'Dana Reed' },
      proposal_id: 'p1',
      status: 'pending',
      expires_at: null,
      created_at: '2026-09-17T08:00:10.000Z',
      resolved_at: null,
    },
  ])
}

describe('GET /api/account/activity/[id]', () => {
  it('returns the item with the run it mirrors and where its drafts live', async () => {
    fake.seed('agent_run', [{ id: 'run-1', status: 'needs_input', kind: 'workspace', action_id: 'act-1', pr_url: null, pending_input: { questions: [] } }])
    fake.seed('email_draft', [{ id: 'd1000000-0000-4000-8000-000000000001', provider_thread_id: 'thr-1', status: 'pending_review', email_thread: { folder: 'inbox' } }])
    fake.rows('tracked_job')[0].agent_run_id = 'run-1'
    const res = await GET(getReq, ctx('waiting'))
    expect(res.status).toBe(200)
    const body = await readJson<{ item: { id: string; status: string }; run: { id: string } | null; drafts: Record<string, unknown> }>(res)
    expect(body.item).toMatchObject({ id: 'waiting', status: 'needs_review' })
    expect(body.run).toMatchObject({ id: 'run-1', status: 'needs_input', action_id: 'act-1' })
    // With the draft's mailbox id, when its row has one: "Review draft" opens on the draft itself.
    expect(body.drafts).toEqual({ 'd1000000-0000-4000-8000-000000000001': { provider_thread_id: 'thr-1', provider_draft_id: null, folder: 'inbox', status: 'pending_review' } })
  })

  it('a draft the email tools made (a provider id): "Review draft" gets the thread and folder it is listed under', async () => {
    fake.rows('tracked_job')[0].deliverables = [{ type: 'email_draft', id: '1a0e8b6b5baa5eb0', label: 'Heads-up' }]
    fake.seed('email_thread_index', [
      { workspace_id: 'w1', provider_thread_id: '1a0e8b6b5baa5eb0', provider_message_id: '1a0e8b6b5baa5eb0', subject: 'Heads-up', to_emails: ['etienne@corvanne.com'], snippet: 'Hi Etienne', folder: 'drafts' },
    ])
    const res = await GET(getReq, ctx('waiting'))
    expect(res.status).toBe(200)
    const body = await readJson<{ drafts: Record<string, unknown>; output: WorkOutput }>(res)
    expect(body.drafts).toEqual({ '1a0e8b6b5baa5eb0': { provider_thread_id: '1a0e8b6b5baa5eb0', provider_draft_id: '1a0e8b6b5baa5eb0', folder: 'drafts', status: null } })
    // No review row (an older tool draft): the index row says where it is, and nothing of what it says.
    expect(body.output.drafts).toEqual([{ id: '1a0e8b6b5baa5eb0', subject: null, to: [], snippet: null, status: null }])
  })

  it('returns no run and no drafts when the item has neither, and an empty output', async () => {
    const res = await GET(getReq, ctx('settled'))
    const body = await readJson<{ run: unknown; drafts: Record<string, unknown>; output: WorkOutput }>(res)
    expect(body.run).toBeNull()
    expect(body.drafts).toEqual({})
    // No execution rows to fold: every block is empty rather than absent.
    expect(body.output).toEqual({
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

  it("folds the run's own account, its cards and what it looked at into `output`", async () => {
    seedTriageRun()
    const res = await GET(getReq, ctx('triage'))
    expect(res.status).toBe(200)
    const body = await readJson<{ item: { id: string }; output: WorkOutput }>(res)
    expect(body.item.id).toBe('triage')
    expect(body.output.narrative).toBe('One real commitment came out of the pricing sync.')
    expect(body.output.cards[0].title).toBe('Draft the pricing recap')
    expect(body.output.cards[0]).toMatchObject({ status: 'pending', kind: 'draft_email', why: 'Dana asked twice', email_to: 'Dana Reed' })
    expect(body.output.decisions).toHaveLength(2)
  })

  it('404s for a row the caller cannot see', async () => {
    const res = await GET(getReq, ctx('nope'))
    expect(res.status).toBe(404)
  })
})

/**
 * `?light=1` (bots-v4.md Phase 2): who the item is, for a click deciding
 * where it opens (on its teammate's bot's page, else over the Inbox) when
 * nothing on screen holds the row. The same owner-only read, none of the
 * panel's joins.
 */
describe('GET /api/account/activity/[id]?light=1', () => {
  const lightReq = { nextUrl: new URL('http://localhost/api/account/activity/x?light=1') } as unknown as NextRequest

  it('answers its id, workspace, teammate, kind and title, and nothing the panel reads', async () => {
    fake.seed('tracked_job', [
      { id: 'mine', workspace_id: 'w2', member_id: 'm1', kind: 'work_run', title: 'Reply to Acme', status: 'done', ai_team_member_id: 'tm-writer', progress: {}, deliverables: [], created_at: '2026-09-17T08:00:00.000Z' },
    ])
    const res = await GET(lightReq, ctx('mine'))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ item: { id: 'mine', workspace_id: 'w2', ai_team_member_id: 'tm-writer', kind: 'work_run', title: 'Reply to Acme' } })
  })

  it('a row with no teammate says so (null)', async () => {
    const res = await GET(lightReq, ctx('settled'))
    expect(await readJson(res)).toEqual({ item: { id: 'settled', workspace_id: 'w1', ai_team_member_id: null, kind: 'flow_run', title: 't' } })
  })

  it('404s for a row the caller cannot see', async () => {
    const res = await GET(lightReq, ctx('nope'))
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/account/activity/[id]', () => {
  it("'reviewed' flips needs_review → done and stamps reviewed_at", async () => {
    const res = await PATCH(patchReq({ action: 'reviewed' }), ctx('waiting'))
    const body = await readJson<{ ok: boolean; changed: boolean; item: Record<string, unknown> }>(res)
    expect(res.status).toBe(200)
    expect(body.changed).toBe(true)
    expect(body.item).toMatchObject({ status: 'done', needs: null, progress: { done: 1, total: 2, review: 'reviewed' } })
    expect(body.item.reviewed_at).toEqual(expect.any(String))
  })

  it("'dismiss' does the same and remembers it was dismissed", async () => {
    const res = await PATCH(patchReq({ action: 'dismiss' }), ctx('waiting'))
    const body = await readJson<{ changed: boolean; item: { progress: { review: string } } }>(res)
    expect(body.changed).toBe(true)
    expect(body.item.progress.review).toBe('dismissed')
  })

  it('leaves a settled item alone', async () => {
    const res = await PATCH(patchReq({ action: 'reviewed' }), ctx('settled'))
    const body = await readJson<{ changed: boolean; item: { status: string } }>(res)
    expect(res.status).toBe(200)
    expect(body.changed).toBe(false)
    expect(body.item.status).toBe('done')
  })

  it('rejects an unknown action and a missing row', async () => {
    expect((await PATCH(patchReq({ action: 'approve' }), ctx('waiting'))).status).toBe(400)
    expect((await PATCH(patchReq({ action: 'reviewed' }), ctx('nope'))).status).toBe(404)
  })

  it('Reviewed and Dismiss read the owner’s unread notices for the item, and nobody else’s (bots-v4 A2: the path settle_work_item takes too)', async () => {
    for (const action of ['reviewed', 'dismiss'] as const) {
      fake = makeFakeSupabase()
      hoisted.fake = fake
      fake.seed('tracked_job', [{ id: 'waiting', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', title: 't', status: 'needs_review', progress: {}, created_at: '2026-09-17T10:00:00.000Z' }])
      fake.seed('notification', [
        { id: 'n-mine', recipient_id: 'm1', target_type: 'work_item', target_id: 'waiting', is_read: false },
        { id: 'n-other-item', recipient_id: 'm1', target_type: 'work_item', target_id: 'settled', is_read: false },
        { id: 'n-someone', recipient_id: 'm-colleague', target_type: 'work_item', target_id: 'waiting', is_read: false },
      ])
      expect((await PATCH(patchReq({ action }), ctx('waiting'))).status, action).toBe(200)
      const n = (id: string) => fake.rows('notification').find((r) => r.id === id)!
      expect(n('n-mine'), action).toMatchObject({ is_read: true, read_at: expect.any(String) })
      expect([n('n-other-item').is_read, n('n-someone').is_read], action).toEqual([false, false])
    }
  })

  it('a row the caller does not own is never settled and reads no notices (403), whatever the read let through', async () => {
    fake.seed('tracked_job', [{ id: 'theirs', workspace_id: 'w1', member_id: 'm-colleague', kind: 'work_run', title: 't', status: 'needs_review', progress: {}, created_at: '2026-09-17T07:00:00.000Z' }])
    fake.seed('member', [{ id: 'm-colleague', user_id: 'user-2', workspace_id: 'w1' }])
    fake.seed('notification', [{ id: 'n-theirs', recipient_id: 'm-colleague', target_type: 'work_item', target_id: 'theirs', is_read: false }])
    for (const action of ['reviewed', 'dismiss']) {
      const res = await PATCH(patchReq({ action }), ctx('theirs'))
      expect(res.status, action).toBe(403)
    }
    expect(fake.rows('tracked_job').find((r) => r.id === 'theirs')?.status).toBe('needs_review')
    expect(fake.rows('notification')[0].is_read).toBe(false)
  })

  it('the owner in another of their workspaces may review it (their member row there)', async () => {
    fake.seed('tracked_job', [{ id: 'elsewhere', workspace_id: 'w2', member_id: 'm-w2', kind: 'work_run', title: 't', status: 'needs_review', progress: {}, created_at: '2026-09-17T07:00:00.000Z' }])
    fake.seed('member', [{ id: 'm-w2', user_id: 'user-1', workspace_id: 'w2' }])
    expect((await PATCH(patchReq({ action: 'reviewed' }), ctx('elsewhere'))).status).toBe(200)
    expect(fake.rows('tracked_job').find((r) => r.id === 'elsewhere')?.status).toBe('done')
  })

  it('a settled item’s notices are left as they are (nothing changed)', async () => {
    fake.seed('notification', [{ id: 'n-settled', recipient_id: 'm1', target_type: 'work_item', target_id: 'settled', is_read: false }])
    await PATCH(patchReq({ action: 'reviewed' }), ctx('settled'))
    expect(fake.rows('notification')[0].is_read).toBe(false)
  })
})

describe("PATCH /api/account/activity/[id] { action: 'opened' } (migration 295)", () => {
  const by = (id: string) => fake.rows('tracked_job').find((r) => r.id === id)!

  it('stamps opened_at once, for the owner, and answers with it; nothing else on the row moves', async () => {
    const before = { ...by('waiting') }
    const res = await PATCH(patchReq({ action: 'opened' }), ctx('waiting'))
    expect(res.status).toBe(200)
    const body = await readJson<{ ok: boolean; changed: boolean; opened_at: string | null }>(res)
    expect(body).toMatchObject({ ok: true, changed: true })
    expect(body.opened_at).toEqual(expect.any(String))
    expect(by('waiting').opened_at).toBe(body.opened_at)
    // Not a review verb: the row still waits on you, and the reaper's clock is untouched.
    expect(by('waiting')).toMatchObject({ status: 'needs_review', needs: before.needs, reviewed_at: null })
    expect(by('waiting').last_beat_at).toBe(before.last_beat_at)
  })

  it('is idempotent: a second open keeps the first stamp and changes nothing', async () => {
    const first = await readJson<{ opened_at: string }>(await PATCH(patchReq({ action: 'opened' }), ctx('waiting')))
    const writes = fake.calls.filter((c) => c.table === 'tracked_job' && c.op === 'update').length
    const second = await PATCH(patchReq({ action: 'opened' }), ctx('waiting'))
    expect(second.status).toBe(200)
    expect(await readJson(second)).toEqual({ ok: true, changed: false, opened_at: first.opened_at })
    expect(fake.calls.filter((c) => c.table === 'tracked_job' && c.op === 'update').length).toBe(writes)
  })

  it('only fills an empty stamp: a row opened before keeps its time', async () => {
    by('settled').opened_at = '2026-09-20T08:00:00.000Z'
    const body = await readJson<{ changed: boolean; opened_at: string }>(await PATCH(patchReq({ action: 'opened' }), ctx('settled')))
    expect(body).toEqual({ ok: true, changed: false, opened_at: '2026-09-20T08:00:00.000Z' })
    expect(by('settled').opened_at).toBe('2026-09-20T08:00:00.000Z')
  })

  it('stamps any status: a settled row the owner opens is opened too', async () => {
    const body = await readJson<{ changed: boolean }>(await PATCH(patchReq({ action: 'opened' }), ctx('settled')))
    expect(body.changed).toBe(true)
    expect(by('settled').opened_at).toEqual(expect.any(String))
    expect(by('settled').status).toBe('done')
  })

  it('a row the caller does not own is never stamped (403), whatever the read let through', async () => {
    // As a widened SELECT policy would let a workspace colleague read it.
    fake.seed('tracked_job', [{ id: 'theirs', workspace_id: 'w1', member_id: 'm-colleague', kind: 'work_run', title: 't', status: 'needs_review', progress: {}, created_at: '2026-09-17T07:00:00.000Z' }])
    fake.seed('member', [{ id: 'm-colleague', user_id: 'user-2', workspace_id: 'w1' }])
    const res = await PATCH(patchReq({ action: 'opened' }), ctx('theirs'))
    expect(res.status).toBe(403)
    expect(by('theirs').opened_at).toBeUndefined()
    expect(fake.calls.some((c) => c.table === 'tracked_job' && c.op === 'update')).toBe(false)
  })

  it('the owner in another of their workspaces may stamp it (their member row there)', async () => {
    fake.seed('tracked_job', [{ id: 'elsewhere', workspace_id: 'w2', member_id: 'm2', kind: 'work_run', title: 't', status: 'needs_input', progress: {}, created_at: '2026-09-17T07:00:00.000Z' }])
    fake.seed('member', [{ id: 'm2', user_id: 'user-1', workspace_id: 'w2' }])
    const body = await readJson<{ changed: boolean }>(await PATCH(patchReq({ action: 'opened' }), ctx('elsewhere')))
    expect(body.changed).toBe(true)
    expect(by('elsewhere').opened_at).toEqual(expect.any(String))
  })

  it('404s for a row the caller cannot see', async () => {
    expect((await PATCH(patchReq({ action: 'opened' }), ctx('nope'))).status).toBe(404)
  })

  it('reads the owner’s unread notices for the item (bots v3 1b), and nobody else’s', async () => {
    fake.seed('notification', [
      { id: 'n-digest', recipient_id: 'm1', target_type: 'work_item', target_id: 'triage', is_read: false },
      { id: 'n-old', recipient_id: 'm1', target_type: 'work_item', target_id: 'triage', is_read: true, read_at: '2026-09-01T00:00:00.000Z' },
      { id: 'n-other-item', recipient_id: 'm1', target_type: 'work_item', target_id: 'waiting', is_read: false },
      { id: 'n-someone', recipient_id: 'm-colleague', target_type: 'work_item', target_id: 'triage', is_read: false },
      { id: 'n-flow-run', recipient_id: 'm1', target_type: 'flow_run', target_id: 'triage', is_read: false },
    ])
    expect((await PATCH(patchReq({ action: 'opened' }), ctx('triage'))).status).toBe(200)
    const n = (id: string) => fake.rows('notification').find((r) => r.id === id)!
    expect(n('n-digest').is_read).toBe(true)
    expect(n('n-digest').read_at).toEqual(expect.any(String))
    expect(n('n-old').read_at).toBe('2026-09-01T00:00:00.000Z')
    expect([n('n-other-item').is_read, n('n-someone').is_read, n('n-flow-run').is_read]).toEqual([false, false, false])
  })

  it('an item opened before still reads a notice that landed since', async () => {
    by('settled').opened_at = '2026-09-20T08:00:00.000Z'
    fake.seed('notification', [{ id: 'n-late', recipient_id: 'm1', target_type: 'work_item', target_id: 'settled', is_read: false }])
    const body = await readJson<{ changed: boolean }>(await PATCH(patchReq({ action: 'opened' }), ctx('settled')))
    expect(body.changed).toBe(false)
    expect(fake.rows('notification')[0].is_read).toBe(true)
  })

  it('a row the caller does not own reads no notices', async () => {
    fake.seed('tracked_job', [{ id: 'theirs', workspace_id: 'w1', member_id: 'm-colleague', kind: 'work_run', title: 't', status: 'needs_review', progress: {}, created_at: '2026-09-17T07:00:00.000Z' }])
    fake.seed('member', [{ id: 'm-colleague', user_id: 'user-2', workspace_id: 'w1' }])
    fake.seed('notification', [{ id: 'n-theirs', recipient_id: 'm-colleague', target_type: 'work_item', target_id: 'theirs', is_read: false }])
    expect((await PATCH(patchReq({ action: 'opened' }), ctx('theirs'))).status).toBe(403)
    expect(fake.rows('notification')[0].is_read).toBe(false)
  })

  it('GET says whose row it is: `mine` for the owner, in any membership; not for anyone else', async () => {
    fake.seed('tracked_job', [
      { id: 'theirs', workspace_id: 'w1', member_id: 'm-colleague', kind: 'work_run', title: 't', status: 'needs_review', progress: {}, created_at: '2026-09-17T07:00:00.000Z' },
      { id: 'elsewhere', workspace_id: 'w2', member_id: 'm2', kind: 'work_run', title: 't', status: 'needs_review', progress: {}, created_at: '2026-09-17T07:00:00.000Z' },
    ])
    fake.seed('member', [
      { id: 'm-colleague', user_id: 'user-2', workspace_id: 'w1' },
      { id: 'm2', user_id: 'user-1', workspace_id: 'w2' },
    ])
    const mine = async (id: string) => (await readJson<{ mine: boolean }>(await GET(getReq, ctx(id)))).mine
    expect(await mine('waiting')).toBe(true)
    expect(await mine('elsewhere')).toBe(true)
    expect(await mine('theirs')).toBe(false)
  })
})

describe('/api/account/activity/[id] — handoffs (row 14)', () => {
  function seedTree() {
    fake.seed('tracked_job', [
      { id: 'root', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', title: 'Reply to Acme', status: 'needs_review', needs: { kind: 'review', verb: 'review' }, progress: {}, parent_id: null, root_id: null, created_at: '2026-09-29T00:00:00.000Z' },
      { id: 'child', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', title: 'Find the price', status: 'needs_review', needs: { kind: 'review', verb: 'review' }, progress: {}, parent_id: 'root', root_id: 'root', created_at: '2026-09-29T00:00:01.000Z' },
      { id: 'refused', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', title: 'Refused handoff', status: 'skipped', progress: {}, parent_id: 'root', root_id: 'root', created_at: '2026-09-29T00:00:02.000Z' },
    ])
  }

  it('GET returns the item’s parent and its handoffs, oldest first', async () => {
    seedTree()
    const root = await readJson<{ parent: unknown; children: Array<{ id: string }> }>(await GET(getReq, ctx('root')))
    expect(root.parent).toBeNull()
    expect(root.children.map((c) => c.id)).toEqual(['child', 'refused'])
    const child = await readJson<{ parent: { id: string } | null; children: unknown[] }>(await GET(getReq, ctx('child')))
    expect(child.parent?.id).toBe('root')
    expect(child.children).toEqual([])
  })

  it('reviewing the root settles its handoffs still waiting on review, with the same outcome', async () => {
    seedTree()
    const res = await PATCH(patchReq({ action: 'dismiss' }), ctx('root'))
    expect((await readJson<{ changed: boolean }>(res)).changed).toBe(true)
    const by = (id: string) => fake.rows('tracked_job').find((r) => r.id === id)!
    expect(by('child')).toMatchObject({ status: 'done', progress: { review: 'dismissed' } })
    expect(by('refused').status).toBe('skipped')
  })

  it('reviewing a handoff on its own leaves its root waiting', async () => {
    seedTree()
    await PATCH(patchReq({ action: 'reviewed' }), ctx('child'))
    const by = (id: string) => fake.rows('tracked_job').find((r) => r.id === id)!
    expect(by('child').status).toBe('done')
    expect(by('root').status).toBe('needs_review')
  })
})

