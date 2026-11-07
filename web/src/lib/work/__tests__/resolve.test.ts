/**
 * The two doors out of "Needs you" (ACTIVITY-AND-REVIEW-DESIGN §4.2-4.3):
 * acting on a deliverable on its own surface, and the item's own review verbs.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { resolveWorkForDeliverable, settleReview, settleReviewSubtree, settleWorkReview } from '../resolve'

function waiting(id: string, deliverables: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'email_drafts',
    title: 'Reply drafts',
    status: 'needs_review',
    needs: { kind: 'review', verb: 'review' },
    deliverables,
    progress: { done: 2, total: 2 },
    created_at: '2026-09-17T10:00:00.000Z',
    reviewed_at: null,
    ...over,
  }
}

describe('resolveWorkForDeliverable', () => {
  it('stamps the acted-on deliverable and completes the item only when nothing reviewable is left', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      waiting('two-drafts', [
        { type: 'email_draft', id: 'd1', label: 'Re: Pricing' },
        { type: 'email_draft', id: 'd2', label: 'Re: Renewal' },
      ]),
      waiting('draft-and-capture', [
        { type: 'email_draft', id: 'd1', label: 'Re: Pricing' },
        { type: 'capture', id: 'c1', label: 'Pricing sync' },
      ]),
      waiting('already-done', [{ type: 'email_draft', id: 'd1', label: 'Re: Pricing' }], {
        status: 'done',
        needs: null,
      }),
      waiting('other-draft', [{ type: 'email_draft', id: 'd9', label: 'Re: Other' }]),
    ])

    // Send d1: the two-draft item keeps waiting on d2; the item whose only other
    // deliverable is a capture (no human verb) completes; a delivered (done)
    // item stamps it and stays done; the rest are untouched.
    const first = await resolveWorkForDeliverable(fake as never, { type: 'email_draft', id: 'd1' }, { nowIso: '2026-09-17T11:00:00.000Z' })
    expect(first.touched.sort()).toEqual(['already-done', 'draft-and-capture', 'two-drafts'])
    expect(first.completed).toEqual(['draft-and-capture'])

    const rows = Object.fromEntries(fake.rows('tracked_job').map((r) => [r.id as string, r]))
    expect(rows['two-drafts']).toMatchObject({
      status: 'needs_review',
      deliverables: [
        { type: 'email_draft', id: 'd1', resolved_at: '2026-09-17T11:00:00.000Z' },
        { type: 'email_draft', id: 'd2' },
      ],
    })
    expect((rows['two-drafts'].deliverables as Array<{ resolved_at?: string }>)[1].resolved_at).toBeUndefined()
    expect(rows['draft-and-capture']).toMatchObject({
      status: 'done',
      needs: null,
      reviewed_at: '2026-09-17T11:00:00.000Z',
    })
    expect(rows['already-done']).toMatchObject({ status: 'done', reviewed_at: null, deliverables: [{ type: 'email_draft', id: 'd1', resolved_at: '2026-09-17T11:00:00.000Z' }] })
    expect(rows['other-draft'].status).toBe('needs_review')

    // Send d2: the two-draft item now completes.
    const second = await resolveWorkForDeliverable(fake as never, { type: 'email_draft', id: 'd2' })
    expect(second.completed).toEqual(['two-drafts'])
    expect(fake.rows('tracked_job').find((r) => r.id === 'two-drafts')).toMatchObject({ status: 'done', needs: null })

    // Sending again is a no-op: nothing waits on d2 any more.
    const again = await resolveWorkForDeliverable(fake as never, { type: 'email_draft', id: 'd2' })
    expect(again).toEqual({ touched: [], completed: [] })
  })

  it('matches on type AND id — a document with the same id is a different deliverable', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [waiting('doc', [{ type: 'document', id: 'x', label: 'Doc' }])])
    const out = await resolveWorkForDeliverable(fake as never, { type: 'email_draft', id: 'x' })
    expect(out.touched).toEqual([])
    expect(fake.rows('tracked_job')[0].status).toBe('needs_review')
  })

  it('never throws — an empty id or a broken client yields nothing', async () => {
    const fake = makeFakeSupabase()
    expect(await resolveWorkForDeliverable(fake as never, { type: 'pr', id: '' })).toEqual({ touched: [], completed: [] })
    const broken = { from: () => { throw new Error('db down') } }
    await expect(resolveWorkForDeliverable(broken as never, { type: 'pr', id: 'u' })).resolves.toEqual({
      touched: [],
      completed: [],
    })
  })
})

describe('settleReview', () => {
  it('flips a waiting item to done for its owner and keeps the outcome on progress', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [waiting('item', [{ type: 'document', id: 'doc1', label: 'Recap' }])])
    const row = fake.rows('tracked_job')[0]
    const ok = await settleReview(fake as never, row as never, 'dismissed', { nowIso: '2026-09-17T12:00:00.000Z' })
    expect(ok).toBe(true)
    expect(fake.rows('tracked_job')[0]).toMatchObject({
      status: 'done',
      needs: null,
      reviewed_at: '2026-09-17T12:00:00.000Z',
      progress: { done: 2, total: 2, review: 'dismissed' },
    })
    // A second review of a settled item changes nothing.
    expect(await settleReview(fake as never, row as never, 'reviewed')).toBe(false)
    expect((fake.rows('tracked_job')[0].progress as { review: string }).review).toBe('dismissed')
  })

  it('is fenced on the owning member and on needs_review', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      waiting('theirs', [{ type: 'document', id: 'doc1', label: 'Recap' }], { member_id: 'm2' }),
      waiting('running', [], { status: 'running', needs: null }),
    ])
    expect(await settleReview(fake as never, { id: 'theirs', member_id: 'm1', progress: {} }, 'reviewed')).toBe(false)
    expect(await settleReview(fake as never, { id: 'running', member_id: 'm1', progress: {} }, 'reviewed')).toBe(false)
    expect(fake.rows('tracked_job').map((r) => r.status)).toEqual(['needs_review', 'running'])
  })
})

describe('resolveWorkForDeliverable — the wire encoding of the scan', () => {
  it('sends the deliverables filter as jsonb containment (JSON text), not a Postgres array literal, and resolves what it finds', async () => {
    const { createClient } = await import('@supabase/supabase-js')
    const requests: Array<{ method: string; url: URL; body: string | null }> = []
    const row = waiting('found', [{ type: 'document', id: 'doc-1', label: 'Brief' }])
    const client = createClient('http://localhost:54321', 'service-key', {
      auth: { persistSession: false },
      global: {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
          const method = init?.method ?? 'GET'
          requests.push({ method, url, body: typeof init?.body === 'string' ? init.body : null })
          const payload = method === 'GET' ? [{ id: row.id, deliverables: row.deliverables }] : { id: row.id }
          return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
        }) as typeof fetch,
      },
    })

    const out = await resolveWorkForDeliverable(client, { type: 'document', id: 'doc-1' }, { nowIso: '2026-09-26T12:00:00.000Z' })

    const scan = requests.find((r) => r.method === 'GET')
    expect(scan?.url.searchParams.get('deliverables')).toBe('cs.[{"type":"document","id":"doc-1"}]')
    expect(scan?.url.searchParams.get('status')).toBe('in.(needs_review,done)')
    expect(out).toEqual({ touched: ['found'], completed: ['found'] })
    const write = requests.find((r) => r.method === 'PATCH')
    expect(JSON.parse(write?.body ?? '{}')).toMatchObject({ status: 'done', reviewed_at: '2026-09-26T12:00:00.000Z' })
  })
})

describe('settleReviewSubtree (row 14)', () => {
  it('settles the handoffs under a reviewed item that still wait on review, with the same outcome, at every depth', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      waiting('root', [], { status: 'done' }),
      waiting('child', [], { parent_id: 'root', root_id: 'root' }),
      waiting('grand', [], { parent_id: 'child', root_id: 'root' }),
      waiting('running', [], { parent_id: 'root', root_id: 'root', status: 'running', needs: null }),
      waiting('theirs', [], { parent_id: 'root', root_id: 'root', member_id: 'm2' }),
      waiting('elsewhere', [], {}),
    ])
    const ids = await settleReviewSubtree(fake as never, { id: 'root', member_id: 'm1' }, 'dismissed', { nowIso: '2026-09-29T00:00:00.000Z' })
    expect(ids).toEqual(['child', 'grand'])
    const by = (id: string) => fake.rows('tracked_job').find((r) => r.id === id)!
    expect(by('child')).toMatchObject({ status: 'done', progress: { review: 'dismissed' } })
    expect(by('grand')).toMatchObject({ status: 'done', progress: { review: 'dismissed' } })
    expect(by('running').status).toBe('running')
    expect(by('theirs').status).toBe('needs_review')
    expect(by('elsewhere').status).toBe('needs_review')
  })

  it('a row with no handoffs settles nothing, and a broken client never throws', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [waiting('alone', [])])
    expect(await settleReviewSubtree(fake as never, { id: 'alone', member_id: 'm1' }, 'reviewed')).toEqual([])
    const broken = { from: () => { throw new Error('down') } }
    await expect(settleReviewSubtree(broken as never, { id: 'x', member_id: 'm1' }, 'reviewed')).resolves.toEqual([])
  })
})

describe('settleWorkReview (the review verbs, end to end: the activity PATCH and settle_work_item)', () => {
  it('settles the row and its handoffs waiting on review, and reads the owner’s notices for each of them, nobody else’s', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      waiting('root', []),
      waiting('child', [], { parent_id: 'root', root_id: 'root' }),
      waiting('grand', [], { parent_id: 'child', root_id: 'root' }),
      waiting('running', [], { parent_id: 'root', root_id: 'root', status: 'running', needs: null }),
    ])
    fake.seed('notification', [
      { id: 'n-root', recipient_id: 'm1', target_type: 'work_item', target_id: 'root', is_read: false },
      { id: 'n-child', recipient_id: 'm1', target_type: 'work_item', target_id: 'child', is_read: false },
      { id: 'n-grand', recipient_id: 'm1', target_type: 'work_item', target_id: 'grand', is_read: false },
      // A handoff still running keeps its notice; so does someone else's.
      { id: 'n-running', recipient_id: 'm1', target_type: 'work_item', target_id: 'running', is_read: false },
      { id: 'n-theirs', recipient_id: 'm2', target_type: 'work_item', target_id: 'child', is_read: false },
    ])
    const out = await settleWorkReview(fake as never, { id: 'root', member_id: 'm1', progress: {} }, 'reviewed', { nowIso: '2026-10-07T00:00:00.000Z' })
    expect(out).toEqual({ changed: true, handoffs: 2, noticesRead: 3 })
    const n = (id: string) => fake.rows('notification').find((r) => r.id === id)!
    for (const id of ['n-root', 'n-child', 'n-grand']) expect(n(id), id).toMatchObject({ is_read: true, read_at: '2026-10-07T00:00:00.000Z' })
    expect([n('n-running').is_read, n('n-theirs').is_read]).toEqual([false, false])
    // Every notice read is fenced on the owner.
    for (const call of fake.calls.filter((c) => c.table === 'notification' && c.op === 'update')) expect(call.filters).toContainEqual(['recipient_id', 'm1'])
  })

  it('a row no longer waiting on review: nothing settled, nothing read', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [waiting('root', [], { status: 'done' }), waiting('child', [], { parent_id: 'root', root_id: 'root' })])
    fake.seed('notification', [{ id: 'n-child', recipient_id: 'm1', target_type: 'work_item', target_id: 'child', is_read: false }])
    expect(await settleWorkReview(fake as never, { id: 'root', member_id: 'm1', progress: {} }, 'dismissed')).toEqual({ changed: false, handoffs: 0, noticesRead: 0 })
    expect(fake.rows('notification')[0].is_read).toBe(false)
    expect(fake.rows('tracked_job')[1].status).toBe('needs_review')
  })
})

