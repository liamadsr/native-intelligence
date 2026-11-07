import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for GET /api/account/captures/[id]/move/preflight.
 *
 * The route fans out count/list queries and delegates the judgement calls to
 * the pure helpers in @/lib/captures/move-artifacts (unit-tested separately).
 * These tests lock in the response CONTRACT the move dialog consumes:
 * confirmed actions with edited flags (including the external-tracker
 * signal), the sole-vs-shared claim split, the auto-created contact list,
 * the active share count, plus the auth/404/error paths.
 *
 * The supabase mock dispatches per-table FIFO queues: each `.from(table)`
 * call consumes the next preprogrammed result for that table, which keeps
 * the mock honest about how many times each table is hit while staying
 * agnostic to filter-chain details.
 */

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

const { GET } = await import(
  '@/app/api/account/captures/[id]/move/preflight/route'
)

// Proxy that returns itself for any chained filter method and resolves to
// `result` when awaited (or via .single()/.maybeSingle()).
function chain(result: unknown): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(result).then(resolve, reject)
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve(result)
        }
        return () => proxy
      },
    },
  )
  return proxy
}

function makeSupabase(queues: Record<string, unknown[]>) {
  const calls: string[] = []
  return {
    calls,
    from: (table: string) => {
      calls.push(table)
      const queue = queues[table]
      const result =
        queue && queue.length > 0 ? queue.shift() : { data: [], error: null }
      return chain(result)
    },
  }
}

const params = Promise.resolve({ id: 'cap-1' })
const req = new Request('https://dial8.ai/api/account/captures/cap-1/move/preflight')

const captureRow = {
  data: { id: 'cap-1', workspace_id: 'w1' },
  error: null,
}

function authWith(supabase: unknown) {
  hoisted.requireWorkspace.mockResolvedValue({
    supabase,
    user: { id: 'user-1' },
    workspaceId: 'w1',
  })
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
})

describe('GET /api/account/captures/[id]/move/preflight', () => {
  it('returns the auth response when requireWorkspace fails', async () => {
    const denied = new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
    })
    hoisted.requireWorkspace.mockResolvedValue(denied)
    const res = await GET(req, { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the capture is not in the current workspace', async () => {
    authWith(makeSupabase({ captures: [{ data: null, error: null }] }))
    const res = await GET(req, { params })
    expect(res.status).toBe(404)
  })

  it('returns 500 when a count query errors instead of under-counting', async () => {
    authWith(
      makeSupabase({
        captures: [captureRow],
        actions: [
          { data: [], error: null },
          { count: null, error: { message: 'boom' } },
        ],
      }),
    )
    const res = await GET(req, { params })
    expect(res.status).toBe(500)
  })

  it('returns empty artifact sets for a bare capture', async () => {
    const supabase = makeSupabase({
      captures: [captureRow],
      actions: [
        { data: [], error: null },
        { count: 0, error: null },
      ],
      decision: [
        { count: 0, error: null },
        { count: 0, error: null },
      ],
      proposed_change: [{ count: 0, error: null }],
      attachments: [{ data: [], error: null }],
      capture_participant: [{ data: [], error: null }],
      share: [{ count: 0, error: null }],
      claim_source: [{ data: [], error: null }],
    })
    authWith(supabase)

    const res = await GET(req, { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      capture_id: 'cap-1',
      source_workspace_id: 'w1',
      accepted_actions_unlinked: 0,
      shares_active: 0,
      confirmed_actions: [],
      claims: { sole_sourced: 0, shared: 0 },
      contacts: { auto_created: [], other: 0 },
    })
    // With no confirmed actions / attachments / participants, the dependent
    // queries must be skipped, not sent with empty IN lists.
    expect(supabase.calls.filter((t) => t === 'comment')).toHaveLength(0)
    expect(supabase.calls.filter((t) => t === 'contact')).toHaveLength(0)
    expect(supabase.calls.filter((t) => t === 'claim')).toHaveLength(0)
    expect(supabase.calls.filter((t) => t === 'action_external_task')).toHaveLength(0)
  })

  it('surfaces edited flags, the claim split, and copyable contacts', async () => {
    const supabase = makeSupabase({
      captures: [captureRow],
      actions: [
        {
          data: [
            { id: 'a1', identifier: 'ENG-1', title: 'Untouched', description: 'same' },
            { id: 'a2', identifier: 'ENG-2', title: 'Commented on', description: null },
          ],
          error: null,
        },
        { count: 3, error: null }, // suggested actions
      ],
      decision: [
        { count: 2, error: null }, // confirmed
        { count: 1, error: null }, // suggested
      ],
      proposed_change: [
        { count: 4, error: null }, // pending
        {
          data: [{ result_entity_id: 'a1', title: 'Untouched', description: 'same' }],
          error: null,
        }, // applied action-create proposals
      ],
      attachments: [{ data: [{ id: 'att-1' }], error: null }],
      capture_participant: [
        { data: [{ contact_id: 'c-auto' }, { contact_id: 'c-manual' }], error: null },
      ],
      share: [{ count: 2, error: null }],
      comment: [{ data: [{ commentable_id: 'a2' }], error: null }],
      action_label: [{ data: [], error: null }],
      action_github_pr: [{ data: [], error: null }],
      action_external_task: [{ data: [], error: null }],
      claim_source: [
        // evidence rows pointing at the capture
        { data: [{ claim_id: 'claim-sole' }, { claim_id: 'claim-shared' }], error: null },
        // evidence rows pointing at the capture's attachments
        { data: [{ claim_id: 'claim-sole' }], error: null },
        // full evidence for the linked claims
        {
          data: [
            { claim_id: 'claim-sole', source_type: 'capture', source_id: 'cap-1' },
            { claim_id: 'claim-sole', source_type: 'attachment', source_id: 'att-1' },
            { claim_id: 'claim-shared', source_type: 'capture', source_id: 'cap-1' },
            { claim_id: 'claim-shared', source_type: 'capture', source_id: 'other-cap' },
          ],
          error: null,
        },
      ],
      contact: [
        {
          data: [
            {
              id: 'c-auto',
              full_name: 'Koko Link',
              email: 'koko@example.com',
              source: 'calendar_sync',
            },
            {
              id: 'c-manual',
              full_name: 'Hand Curated',
              email: 'hand@example.com',
              source: 'manual',
            },
          ],
          error: null,
        },
      ],
      claim: [
        { data: [{ id: 'claim-sole' }, { id: 'claim-shared' }], error: null },
      ],
    })
    authWith(supabase)

    const res = await GET(req, { params })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.accepted_actions_unlinked).toBe(2)
    expect(body.pending_suggestions).toBe(4)
    expect(body.suggested_actions).toBe(3)
    expect(body.confirmed_decisions).toBe(2)
    expect(body.suggested_decisions).toBe(1)
    expect(body.attachments).toBe(1)
    expect(body.shares_active).toBe(2)

    expect(body.confirmed_actions).toEqual([
      {
        id: 'a1',
        identifier: 'ENG-1',
        title: 'Untouched',
        edited: false,
        edit_reasons: [],
      },
      {
        id: 'a2',
        identifier: 'ENG-2',
        title: 'Commented on',
        edited: true,
        edit_reasons: ['has comments'],
      },
    ])

    expect(body.claims).toEqual({ sole_sourced: 1, shared: 1 })

    expect(body.contacts).toEqual({
      auto_created: [
        { id: 'c-auto', full_name: 'Koko Link', email: 'koko@example.com' },
      ],
      other: 1,
    })
  })

  it('flags actions synced to an external tracker and counts live share links', async () => {
    const supabase = makeSupabase({
      captures: [captureRow],
      actions: [
        {
          data: [
            { id: 'a1', identifier: 'ENG-1', title: 'Local only', description: null },
            { id: 'a2', identifier: 'ENG-2', title: 'In Jira too', description: null },
          ],
          error: null,
        },
        { count: 0, error: null },
      ],
      decision: [
        { count: 0, error: null },
        { count: 0, error: null },
      ],
      proposed_change: [
        { count: 0, error: null },
        { data: [], error: null },
      ],
      attachments: [{ data: [], error: null }],
      capture_participant: [{ data: [], error: null }],
      share: [{ count: 1, error: null }],
      comment: [{ data: [], error: null }],
      action_label: [{ data: [], error: null }],
      action_github_pr: [{ data: [], error: null }],
      action_external_task: [{ data: [{ action_id: 'a2' }], error: null }],
      claim_source: [{ data: [], error: null }],
    })
    authWith(supabase)

    const res = await GET(req, { params })
    expect(res.status).toBe(200)
    const body = await res.json()

    // The move severs the tracker link, so the synced action is ambiguous and
    // the dialog leaves it unchecked.
    expect(body.confirmed_actions).toEqual([
      { id: 'a1', identifier: 'ENG-1', title: 'Local only', edited: false, edit_reasons: [] },
      {
        id: 'a2',
        identifier: 'ENG-2',
        title: 'In Jira too',
        edited: true,
        edit_reasons: ['synced to an external tracker'],
      },
    ])
    // The share row stays in the source workspace, deactivated.
    expect(body.shares_active).toBe(1)
  })

  it('drops claims outside the current workspace from the partition', async () => {
    const supabase = makeSupabase({
      captures: [captureRow],
      actions: [
        { data: [], error: null },
        { count: 0, error: null },
      ],
      decision: [
        { count: 0, error: null },
        { count: 0, error: null },
      ],
      proposed_change: [{ count: 0, error: null }],
      attachments: [{ data: [], error: null }],
      capture_participant: [{ data: [], error: null }],
      claim_source: [
        { data: [{ claim_id: 'foreign-claim' }], error: null },
        // full-evidence query must not run: the claim scoping returned none
      ],
      claim: [{ data: [], error: null }],
    })
    authWith(supabase)

    const res = await GET(req, { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.claims).toEqual({ sole_sourced: 0, shared: 0 })
    // claim_source is queried once for capture evidence; the follow-up
    // evidence query is skipped because no workspace-scoped claim survived.
    expect(supabase.calls.filter((t) => t === 'claim_source')).toHaveLength(1)
  })
})
