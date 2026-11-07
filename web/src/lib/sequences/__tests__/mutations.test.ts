import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  enrollContacts,
  normalizeSteps,
  resumePastDueEnrollments,
} from '../mutations'

/**
 * Tests for the shared sequence mutation logic (mutations.ts) — the single
 * implementation behind both the API routes and the AI agent tools. All
 * Supabase access goes through a recording fake; zero network.
 */

// ──────────────────────────────────────────────────────────────────
// Recording fake Supabase client
// ──────────────────────────────────────────────────────────────────

interface Captured {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete'
  payload?: unknown
  filters: Array<{ method: string; args: unknown[] }>
}

interface FakeResult {
  data?: unknown
  error?: { message: string; code?: string } | null
  count?: number | null
}

/**
 * Chainable thenable builder: every from() call is captured; the handler maps
 * a captured query to its canned result when the chain is awaited (or
 * .single()/.maybeSingle() is called).
 */
function makeFakeSupabase(handler: (q: Captured) => FakeResult) {
  const queries: Captured[] = []
  function from(table: string) {
    const q: Captured = { table, op: 'select', filters: [] }
    queries.push(q)
    const b: Record<string, unknown> = {}
    const chain =
      (name: string) =>
      (...args: unknown[]) => {
        q.filters.push({ method: name, args })
        return b
      }
    Object.assign(b, {
      select: chain('select'),
      insert: (payload: unknown) => {
        q.op = 'insert'
        q.payload = payload
        return b
      },
      update: (payload: unknown) => {
        q.op = 'update'
        q.payload = payload
        return b
      },
      delete: () => {
        q.op = 'delete'
        return b
      },
      eq: chain('eq'),
      is: chain('is'),
      in: chain('in'),
      not: chain('not'),
      lt: chain('lt'),
      order: chain('order'),
      range: chain('range'),
      maybeSingle: async () => ({ error: null, data: null, ...handler(q) }),
      single: async () => ({ error: null, data: null, ...handler(q) }),
      then: (
        onFulfilled: (v: FakeResult) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve({ error: null, data: null, ...handler(q) }).then(onFulfilled, onRejected),
    })
    return b
  }
  return { client: { from } as unknown as SupabaseClient, queries }
}

function filterArgs(q: Captured, method: string): unknown[][] {
  return q.filters.filter((f) => f.method === method).map((f) => f.args)
}

// ──────────────────────────────────────────────────────────────────
// normalizeSteps
// ──────────────────────────────────────────────────────────────────

describe('normalizeSteps', () => {
  const validSteps = [
    { subject: 'Intro', body: 'Hi {{first_name|there}}', delay_days: 0 },
    { body: 'Bump', delay_days: 3 },
  ]

  it('rejects a non-array and an empty array with the route message', () => {
    for (const raw of [undefined, null, 'nope', {}, []]) {
      const res = normalizeSteps(raw)
      expect(res).toEqual({ ok: false, error: 'steps must be a non-empty array' })
    }
  })

  it('normalizes valid steps: 1-based order from array position, null subject on follow-ups, is_active default', () => {
    const res = normalizeSteps(validSteps)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.steps).toEqual([
      { step_order: 1, subject: 'Intro', body: 'Hi {{first_name|there}}', delay_days: 0, is_active: true },
      { step_order: 2, subject: null, body: 'Bump', delay_days: 3, is_active: true },
    ])
  })

  it('preserves is_active false', () => {
    const res = normalizeSteps([{ subject: 'S', body: 'B', delay_days: 0, is_active: false }])
    expect(res.ok && res.steps[0].is_active).toBe(false)
  })

  it('treats a whitespace-only subject as absent', () => {
    const res = normalizeSteps([{ subject: '   ', body: 'B', delay_days: 0 }])
    expect(res).toEqual({
      ok: false,
      error: 'step 1 must have a subject (follow-ups may omit it to thread)',
    })
  })

  it('requires a non-empty body per step', () => {
    const res = normalizeSteps([{ subject: 'S', body: '  ', delay_days: 0 }])
    expect(res).toEqual({ ok: false, error: 'step 1: body is required' })
  })

  it('requires integer delay_days >= 0 (rejects missing, negative, fractional)', () => {
    for (const delay of [undefined, -1, 1.5, '3']) {
      const res = normalizeSteps([
        { subject: 'S', body: 'B', delay_days: 0 },
        { body: 'B2', delay_days: delay },
      ])
      expect(res).toEqual({
        ok: false,
        error: 'step 2: delay_days must be a non-negative integer',
      })
    }
  })

  it('rejects header-injection characters in subjects', () => {
    const res = normalizeSteps([{ subject: 'Hi\r\nBcc: evil@x.com', body: 'B', delay_days: 0 }])
    expect(res).toEqual({
      ok: false,
      error: 'step 1: subject must not contain control characters',
    })
  })

  it('requires a subject on step 1', () => {
    const res = normalizeSteps([{ body: 'B', delay_days: 0 }])
    expect(res).toEqual({
      ok: false,
      error: 'step 1 must have a subject (follow-ups may omit it to thread)',
    })
  })
})

// ──────────────────────────────────────────────────────────────────
// enrollContacts
// ──────────────────────────────────────────────────────────────────

const WS = 'ws-1'
const SEQ = 'seq-1'

interface EnrollWorld {
  sequence: { id: string; status: string } | null
  contacts: Array<{ id: string; email: string | null }>
  suppressed: Array<{ email: string }>
  active: Array<{ contact_id: string | null; contact_email: string; sequence_id: string }>
  insertError?: { message: string; code?: string }
}

function enrollHandler(world: EnrollWorld) {
  return (q: Captured): FakeResult => {
    if (q.table === 'sequence') return { data: world.sequence }
    if (q.table === 'contact') return { data: world.contacts }
    if (q.table === 'outreach_suppression') return { data: world.suppressed }
    if (q.table === 'sequence_enrollment' && q.op === 'select') return { data: world.active }
    if (q.table === 'sequence_enrollment' && q.op === 'insert') {
      return { error: world.insertError ?? null }
    }
    throw new Error(`unexpected query: ${q.table} ${q.op}`)
  }
}

describe('enrollContacts', () => {
  const baseWorld: EnrollWorld = {
    sequence: { id: SEQ, status: 'draft' },
    contacts: [
      { id: 'c-ok', email: 'ok@x.com' },
      { id: 'c-noemail', email: null },
      { id: 'c-blank-email', email: '   ' },
      { id: 'c-suppressed', email: 'Stop@X.com' },
      { id: 'c-busy', email: 'busy@x.com' },
      { id: 'c-dup-email', email: 'OK@x.com' },
    ],
    suppressed: [{ email: 'stop@x.com' }],
    active: [{ contact_id: 'c-busy', contact_email: 'busy@x.com', sequence_id: 'other-seq' }],
  }

  it('returns sequence_not_found when the sequence is not in the workspace', async () => {
    const { client } = makeFakeSupabase(enrollHandler({ ...baseWorld, sequence: null }))
    const res = await enrollContacts(client, {
      workspaceId: WS,
      sequenceId: SEQ,
      enrolledBy: 'u-1',
      contactIds: ['c-ok'],
    })
    expect(res).toEqual({ ok: false, code: 'sequence_not_found' })
  })

  it('refuses an archived sequence', async () => {
    const { client } = makeFakeSupabase(
      enrollHandler({ ...baseWorld, sequence: { id: SEQ, status: 'archived' } }),
    )
    const res = await enrollContacts(client, {
      workspaceId: WS,
      sequenceId: SEQ,
      enrolledBy: 'u-1',
      contactIds: ['c-ok'],
    })
    expect(res).toEqual({ ok: false, code: 'sequence_archived' })
  })

  it('applies every skip reason, dedupes input, and stages the survivor inert', async () => {
    const { client, queries } = makeFakeSupabase(enrollHandler(baseWorld))
    const res = await enrollContacts(client, {
      workspaceId: WS,
      sequenceId: SEQ,
      enrolledBy: 'u-1',
      contactIds: [
        'c-ok',
        'c-ok', // duplicate in the batch — deduped, not double-inserted
        'c-missing',
        'c-noemail',
        'c-blank-email',
        'c-suppressed', // suppression matching is case-insensitive
        'c-busy', // active in ANOTHER sequence (workspace-wide guard)
        'c-dup-email', // same email as c-ok, different case — email unique
      ],
    })

    expect(res).toEqual({
      ok: true,
      enrolled: ['c-ok'],
      skipped: [
        { contact_id: 'c-missing', reason: 'not_found' },
        { contact_id: 'c-noemail', reason: 'no_email' },
        { contact_id: 'c-blank-email', reason: 'no_email' },
        { contact_id: 'c-suppressed', reason: 'suppressed' },
        { contact_id: 'c-busy', reason: 'already_active' },
        { contact_id: 'c-dup-email', reason: 'already_active' },
      ],
    })

    // Exactly ONE insert, and it is the inert staged shape: status active
    // with next_send_at NULL (nothing schedules until the human launches).
    const inserts = queries.filter((q) => q.table === 'sequence_enrollment' && q.op === 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].payload).toEqual({
      workspace_id: WS,
      sequence_id: SEQ,
      contact_id: 'c-ok',
      contact_email: 'ok@x.com',
      enrolled_by: 'u-1',
      status: 'active',
      next_send_at: null,
    })
  })

  it('maps a 23505 unique-violation race to already_active instead of failing the batch', async () => {
    const { client } = makeFakeSupabase(
      enrollHandler({ ...baseWorld, insertError: { message: 'duplicate key', code: '23505' } }),
    )
    const res = await enrollContacts(client, {
      workspaceId: WS,
      sequenceId: SEQ,
      enrolledBy: 'u-1',
      contactIds: ['c-ok'],
    })
    expect(res).toEqual({
      ok: true,
      enrolled: [],
      skipped: [{ contact_id: 'c-ok', reason: 'already_active' }],
    })
  })

  it('fails the batch on a non-unique insert error', async () => {
    const { client } = makeFakeSupabase(
      enrollHandler({ ...baseWorld, insertError: { message: 'boom', code: '500' } }),
    )
    const res = await enrollContacts(client, {
      workspaceId: WS,
      sequenceId: SEQ,
      enrolledBy: 'u-1',
      contactIds: ['c-ok'],
    })
    expect(res).toEqual({ ok: false, code: 'server_error' })
  })

  it('scopes every lookup to the workspace (service-role callers rely on this)', async () => {
    const { client, queries } = makeFakeSupabase(enrollHandler(baseWorld))
    await enrollContacts(client, {
      workspaceId: WS,
      sequenceId: SEQ,
      enrolledBy: 'u-1',
      contactIds: ['c-ok'],
    })
    for (const table of ['sequence', 'contact', 'outreach_suppression']) {
      const q = queries.find((x) => x.table === table)!
      expect(filterArgs(q, 'eq')).toContainEqual(['workspace_id', WS])
    }
    const activeScan = queries.find((x) => x.table === 'sequence_enrollment' && x.op === 'select')!
    expect(filterArgs(activeScan, 'eq')).toContainEqual(['workspace_id', WS])
  })
})

// ──────────────────────────────────────────────────────────────────
// resumePastDueEnrollments
// ──────────────────────────────────────────────────────────────────

describe('resumePastDueEnrollments', () => {
  const sequence = {
    id: SEQ,
    delay_unit: 'business' as const,
    timezone: 'America/Los_Angeles',
    send_window: { days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 16 },
  }

  it('reschedules each past-due enrollment into the future and resets dispatch_attempts', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.op === 'select') {
        return { data: [{ id: 'e-1', next_send_at: '2020-01-01T00:00:00Z' }] }
      }
      return { error: null }
    })
    const before = Date.now()
    const res = await resumePastDueEnrollments(client, sequence)
    expect(res).toEqual({ error: null })

    const updates = queries.filter((q) => q.op === 'update')
    expect(updates).toHaveLength(1)
    const payload = updates[0].payload as { next_send_at: string; dispatch_attempts: number }
    expect(payload.dispatch_attempts).toBe(0)
    // Never bursts: the new send time is snapped FORWARD from now, never the
    // stale past-due timestamp.
    expect(new Date(payload.next_send_at).getTime()).toBeGreaterThanOrEqual(before)
    // Only still-active rows are touched (CAS-style guard).
    expect(filterArgs(updates[0], 'eq')).toEqual([
      ['id', 'e-1'],
      ['status', 'active'],
    ])
  })

  it('is a no-op when nothing is past due', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.op === 'select') return { data: [] }
      throw new Error('should not update')
    })
    const res = await resumePastDueEnrollments(client, sequence)
    expect(res).toEqual({ error: null })
    expect(queries.filter((q) => q.op === 'update')).toHaveLength(0)
  })

  it('surfaces a scan failure', async () => {
    const { client } = makeFakeSupabase(() => ({ error: { message: 'scan boom' } }))
    const res = await resumePastDueEnrollments(client, sequence)
    expect(res).toEqual({ error: 'scan boom' })
  })

  it('surfaces a reschedule failure', async () => {
    const { client } = makeFakeSupabase((q) => {
      if (q.op === 'select') return { data: [{ id: 'e-1', next_send_at: '2020-01-01T00:00:00Z' }] }
      return { error: { message: 'update boom' } }
    })
    const res = await resumePastDueEnrollments(client, sequence)
    expect(res).toEqual({ error: 'update boom' })
  })
})
