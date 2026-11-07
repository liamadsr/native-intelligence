import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSequenceTools } from '@/lib/ai/tools/sequences'

/**
 * Tests for the Sequences agent tools (src/lib/ai/tools/sequences.ts):
 * input validation, the deliberate NO-LAUNCH product boundary, and the
 * result shapes the agent narrates from ("14 enrolled, 2 skipped…").
 * All Supabase access goes through a recording fake; zero network.
 */

// ──────────────────────────────────────────────────────────────────
// Recording fake Supabase client (same shape as mutations.test.ts)
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

/** `hiddenContacts`: ids contact_visible_to answers false for (another member's private contact). */
function makeFakeSupabase(handler: (q: Captured) => FakeResult, hiddenContacts: string[] = []) {
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
  const rpc = async (fn: string, args: { p_contact_id: string }) =>
    fn === 'contact_visible_to'
      ? { data: !hiddenContacts.includes(args.p_contact_id), error: null }
      : { data: null, error: { message: `unexpected rpc ${fn}` } }
  return { client: { from, rpc } as unknown as SupabaseClient, queries }
}

/** A client whose every query throws — for paths that must fail BEFORE any DB access. */
const throwingClient = {
  from() {
    throw new Error('validation must reject before any DB access')
  },
} as unknown as SupabaseClient

function makeTools(client: SupabaseClient) {
  return createSequenceTools('user-1', client, 'ws-1')
}

const VALID_STEPS = [
  { step_order: 1, subject: 'Intro to {{company}}', body: 'Hi {{first_name|there}}', delay_days: 0 },
  { step_order: 2, body: 'Bumping this, {{first_name|there}}', delay_days: 3 },
]

// ──────────────────────────────────────────────────────────────────
// The product boundary: one launch tool, gated on the person's card
// ──────────────────────────────────────────────────────────────────

describe('sequence tool set — the launch is the person\'s yes', () => {
  const tools = makeTools(throwingClient)

  it('exposes the six staging/read tools and launch_sequence', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'create_sequence',
      'enroll_contacts_in_sequence',
      'get_sequence',
      'launch_sequence',
      'list_sequences',
      'remove_from_sequence',
      'update_sequence',
    ])
  })

  it('has no other tool that launches or arms sending (launch_sequence only raises a card; see launch-sequence.test.ts)', () => {
    for (const name of Object.keys(tools).filter((n) => n !== 'launch_sequence')) {
      expect(name).not.toMatch(/launch|send|arm/)
    }
  })
})

// ──────────────────────────────────────────────────────────────────
// create_sequence
// ──────────────────────────────────────────────────────────────────

describe('create_sequence', () => {
  it('rejects a blank name before any DB access', async () => {
    const res = await makeTools(throwingClient).create_sequence.execute!(
      { name: '   ', steps: VALID_STEPS },
      {} as never,
    )
    expect(res).toMatchObject({ success: false, error: 'name is required' })
  })

  it('rejects step_order gaps and duplicates', async () => {
    const tools = makeTools(throwingClient)
    for (const orders of [
      [1, 3],
      [2, 3],
      [1, 1],
    ]) {
      const res = await tools.create_sequence.execute!(
        {
          name: 'Investors',
          steps: orders.map((step_order, i) => ({
            step_order,
            subject: i === 0 ? 'S' : undefined,
            body: 'B',
            delay_days: 0,
          })),
        },
        {} as never,
      )
      expect(res).toMatchObject({ success: false })
      expect((res as { error: string }).error).toContain('step_order')
    }
  })

  it('requires a subject on step 1 (same rule as the API route)', async () => {
    const res = await makeTools(throwingClient).create_sequence.execute!(
      { name: 'Investors', steps: [{ step_order: 1, body: 'B', delay_days: 0 }] },
      {} as never,
    )
    expect(res).toMatchObject({
      success: false,
      error: 'step 1 must have a subject (follow-ups may omit it to thread)',
    })
  })

  it('creates a DRAFT with steps sorted by step_order and returns url + merge-field summary', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'sequence' && q.op === 'insert') {
        return { data: { id: 'seq-9', ...(q.payload as Record<string, unknown>) } }
      }
      if (q.table === 'sequence_step' && q.op === 'insert') {
        return { data: q.payload }
      }
      throw new Error(`unexpected query: ${q.table} ${q.op}`)
    })
    // Steps intentionally given out of order — step_order is authoritative.
    const res = await makeTools(client).create_sequence.execute!(
      { name: ' Investors ', steps: [VALID_STEPS[1], VALID_STEPS[0]], timezone: 'Europe/Paris' },
      {} as never,
    )

    expect(res).toMatchObject({ success: true, url: expect.stringContaining('seq-9') })
    expect((res as { merge_fields_used: string[] }).merge_fields_used.sort()).toEqual([
      'company',
      'first_name',
    ])

    const seqInsert = queries.find((q) => q.table === 'sequence' && q.op === 'insert')!
    expect(seqInsert.payload).toMatchObject({
      workspace_id: 'ws-1',
      name: 'Investors',
      status: 'draft',
      created_by: 'user-1',
      timezone: 'Europe/Paris',
      delay_unit: 'business',
    })
    // No auto_send in the insert — arming is the launch route's job, never ours.
    expect(Object.keys(seqInsert.payload as object)).not.toContain('auto_send')

    const stepInsert = queries.find((q) => q.table === 'sequence_step' && q.op === 'insert')!
    const steps = stepInsert.payload as Array<Record<string, unknown>>
    expect(steps.map((s) => [s.step_order, s.subject])).toEqual([
      [1, 'Intro to {{company}}'],
      [2, null],
    ])
  })

  it('unwinds the sequence row when the step insert fails (no orphan shells)', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'sequence' && q.op === 'insert') return { data: { id: 'seq-9' } }
      if (q.table === 'sequence_step' && q.op === 'insert') return { error: { message: 'boom' } }
      if (q.table === 'sequence' && q.op === 'delete') return {}
      throw new Error(`unexpected query: ${q.table} ${q.op}`)
    })
    const res = await makeTools(client).create_sequence.execute!(
      { name: 'Investors', steps: VALID_STEPS },
      {} as never,
    )
    expect(res).toMatchObject({ success: false })
    const unwind = queries.find((q) => q.table === 'sequence' && q.op === 'delete')!
    expect(unwind).toBeDefined()
    // Service-role DELETE must stay tenancy-fenced like every other query.
    expect(unwind.filters).toContainEqual({ method: 'eq', args: ['id', 'seq-9'] })
    expect(unwind.filters).toContainEqual({ method: 'eq', args: ['workspace_id', 'ws-1'] })
  })
})

// ──────────────────────────────────────────────────────────────────
// update_sequence
// ──────────────────────────────────────────────────────────────────

describe('update_sequence', () => {
  interface UpdateWorld {
    sequence: Record<string, unknown> | null
    /** Active enrollment rows ({ id, current_step_order, next_send_at }). */
    enrollments?: Array<Record<string, unknown>>
    /** Existing sequence_step rows. */
    steps?: Array<Record<string, unknown>>
    /** sequence_send rows (step_id / enrollment_id lookups). */
    sends?: Array<Record<string, unknown>>
  }

  function worldWith(world: UpdateWorld | Record<string, unknown> | null) {
    const w: UpdateWorld =
      world === null || !('sequence' in world) ? { sequence: world as never } : (world as UpdateWorld)
    return makeFakeSupabase((q) => {
      if (q.table === 'sequence' && q.op === 'select') return { data: w.sequence }
      if (q.table === 'sequence_enrollment' && q.op === 'select') {
        return { data: w.enrollments ?? [] }
      }
      if (q.table === 'sequence_step' && q.op === 'select') return { data: w.steps ?? [] }
      if (q.table === 'sequence_send' && q.op === 'select') return { data: w.sends ?? [] }
      if (q.op === 'update' || q.op === 'delete' || q.op === 'insert') return {}
      throw new Error(`unexpected query: ${q.table} ${q.op}`)
    })
  }

  it('allows a rename (and other always-editable fields) while enrollments are active — the old blanket lock is gone', async () => {
    const { client, queries } = worldWith({
      sequence: { id: 'seq-1', status: 'active', timezone: 'UTC', delay_unit: 'business', send_window: null },
      enrollments: [{ id: 'e-1', current_step_order: 1, next_send_at: null }],
    })
    const res = await makeTools(client).update_sequence.execute!(
      { sequence_id: 'seq-1', name: 'Renamed' },
      {} as never,
    )
    expect(res).toMatchObject({ success: true })
    const seqUpdate = queries.find((q) => q.table === 'sequence' && q.op === 'update')!
    expect(seqUpdate.payload).toEqual({ name: 'Renamed' })
  })

  it('refuses a guarded step edit PER STEP (deleting a sent step) with code step_guarded', async () => {
    const { client, queries } = worldWith({
      sequence: { id: 'seq-1', status: 'active', timezone: 'UTC', delay_unit: 'business', send_window: null },
      enrollments: [{ id: 'e-1', current_step_order: 1, next_send_at: '2027-01-01T00:00:00Z' }],
      steps: [
        { id: 'st-1', step_order: 1, subject: 'S', delay_days: 0, is_active: true },
        { id: 'st-2', step_order: 2, subject: null, delay_days: 3, is_active: true },
      ],
      sends: [{ step_id: 'st-1' }],
    })
    // Keep only step 2 → deletes st-1, which has ledger history.
    const res = await makeTools(client).update_sequence.execute!(
      {
        sequence_id: 'seq-1',
        steps: [{ id: 'st-2', step_order: 1, subject: 'Now first', body: 'B', delay_days: 0 }],
      },
      {} as never,
    )
    expect(res).toMatchObject({ success: false, code: 'step_guarded' })
    const guardErrors = (res as { guard_errors: Array<{ step_id: string | null }> }).guard_errors
    expect(guardErrors.some((g) => g.step_id === 'st-1')).toBe(true)
    // Nothing was written.
    expect(queries.filter((q) => q.op !== 'select')).toHaveLength(0)
  })

  it('refuses to resume a draft — points at launch_sequence instead', async () => {
    const { client } = worldWith({ id: 'seq-1', status: 'draft' })
    const res = await makeTools(client).update_sequence.execute!(
      { sequence_id: 'seq-1', status: 'resume' },
      {} as never,
    )
    expect(res).toMatchObject({ success: false })
    expect((res as { error: string }).error).toContain('launch_sequence')
  })

  it('refuses to pause a non-active sequence', async () => {
    const { client } = worldWith({ id: 'seq-1', status: 'draft' })
    const res = await makeTools(client).update_sequence.execute!(
      { sequence_id: 'seq-1', status: 'pause' },
      {} as never,
    )
    expect(res).toMatchObject({ success: false, error: 'Cannot pause a draft sequence' })
  })

  it('archives: flips status, disarms auto_send, exits active enrollments as removed', async () => {
    const { client, queries } = worldWith({ id: 'seq-1', status: 'active' })
    const res = await makeTools(client).update_sequence.execute!(
      { sequence_id: 'seq-1', status: 'archive' },
      {} as never,
    )
    expect(res).toMatchObject({ success: true })
    const seqUpdate = queries.find((q) => q.table === 'sequence' && q.op === 'update')!
    expect(seqUpdate.payload).toEqual({ status: 'archived', auto_send: false })
    const exitUpdate = queries.find((q) => q.table === 'sequence_enrollment' && q.op === 'update')!
    expect(exitUpdate.payload).toEqual({
      status: 'exited',
      exit_reason: 'removed',
      next_send_at: null,
    })
  })

  it('returns not-found for a sequence outside the workspace', async () => {
    const { client } = worldWith(null)
    const res = await makeTools(client).update_sequence.execute!(
      { sequence_id: 'seq-x', name: 'X' },
      {} as never,
    )
    expect(res).toMatchObject({ success: false, error: 'Sequence not found' })
  })

  // sequence_step has no workspace_id column and the MCP path runs on a
  // service-role client (no RLS backstop) — these two tests pin the tenancy
  // fence on the step writes so a refactor cannot silently drop it.
  it('touches ZERO sequence_step rows for a foreign sequence_id (service-role/MCP path)', async () => {
    const { client, queries } = worldWith(null)
    const res = await makeTools(client).update_sequence.execute!(
      { sequence_id: 'seq-foreign', steps: VALID_STEPS },
      {} as never,
    )
    expect(res).toMatchObject({ success: false, error: 'Sequence not found' })
    expect(queries.filter((q) => q.table === 'sequence_step')).toHaveLength(0)
    expect(queries.filter((q) => q.op !== 'select')).toHaveLength(0)
  })

  it('keys step reads/writes on the workspace-fenced row id (never the raw input) and workspace-fences the enrollment scan', async () => {
    // The fenced load returns a row whose id differs from the raw input, so
    // any query keyed on the raw input id would show up in the recording.
    const { client, queries } = worldWith({ sequence: { id: 'seq-fenced', status: 'draft' } })
    const res = await makeTools(client).update_sequence.execute!(
      { sequence_id: 'seq-raw-input', steps: VALID_STEPS },
      {} as never,
    )
    expect(res).toMatchObject({ success: true })

    const enrollmentScan = queries.find(
      (q) => q.table === 'sequence_enrollment' && q.op === 'select',
    )!
    expect(enrollmentScan.filters).toContainEqual({ method: 'eq', args: ['workspace_id', 'ws-1'] })
    expect(enrollmentScan.filters).toContainEqual({ method: 'eq', args: ['sequence_id', 'seq-fenced'] })

    const stepRead = queries.find((q) => q.table === 'sequence_step' && q.op === 'select')!
    expect(stepRead.filters).toContainEqual({ method: 'eq', args: ['sequence_id', 'seq-fenced'] })

    // Steps without ids reconcile as inserts (nothing existed to update).
    const stepInsert = queries.find((q) => q.table === 'sequence_step' && q.op === 'insert')!
    for (const row of stepInsert.payload as Array<Record<string, unknown>>) {
      expect(row.sequence_id).toBe('seq-fenced')
    }
  })
})

// ──────────────────────────────────────────────────────────────────
// get_sequence
// ──────────────────────────────────────────────────────────────────

describe('get_sequence', () => {
  function worldWithEnrollments(n: number) {
    const enrollments = Array.from({ length: n }, (_, i) => ({
      id: `enr-${i}`,
      contact_id: `c-${i}`,
      contact_email: `p${i}@x.com`,
      status: i % 2 === 0 ? 'active' : 'exited',
      exit_reason: i % 2 === 0 ? null : 'replied',
      current_step_order: 1,
      next_send_at: null,
      created_at: '2026-01-01T00:00:00Z',
      contact: null,
    }))
    return makeFakeSupabase((q) => {
      if (q.table === 'sequence') return { data: { id: 'seq-1', status: 'active' } }
      if (q.table === 'sequence_step') return { data: [] }
      if (q.table === 'sequence_enrollment') return { data: enrollments }
      if (q.table === 'sequence_send') return { data: [] }
      throw new Error(`unexpected query: ${q.table} ${q.op}`)
    })
  }

  it("nulls the embedded contact when it is another member's private contact (service role: contact_visible_to)", async () => {
    const enrollments = [
      { id: 'enr-a', contact_id: 'c-private', contact_email: 'p@x.com', status: 'active', exit_reason: null,
        current_step_order: 1, next_send_at: null, created_at: '2026-01-01T00:00:00Z',
        contact: { id: 'c-private', full_name: 'Ana Private', email: 'p@x.com' } },
      { id: 'enr-b', contact_id: 'c-shared', contact_email: 's@x.com', status: 'active', exit_reason: null,
        current_step_order: 1, next_send_at: null, created_at: '2026-01-01T00:00:00Z',
        contact: { id: 'c-shared', full_name: 'Sam Shared', email: 's@x.com' } },
    ]
    const { client } = makeFakeSupabase(
      (q) => {
        if (q.table === 'sequence') return { data: { id: 'seq-1', status: 'active' } }
        if (q.table === 'sequence_step') return { data: [] }
        if (q.table === 'sequence_enrollment') return { data: enrollments }
        if (q.table === 'sequence_send') return { data: [] }
        throw new Error(`unexpected query: ${q.table} ${q.op}`)
      },
      ['c-private'],
    )
    const res = (await makeTools(client).get_sequence.execute!({ sequence_id: 'seq-1' }, {} as never)) as Record<
      string,
      unknown
    >
    const rows = res.enrollments as Array<Record<string, unknown>>
    expect(rows.map((r) => r.contact_name)).toEqual([null, 'Sam Shared'])
    expect(JSON.stringify(res)).not.toContain('Ana Private')
  })

  it('caps the per-contact list at 50 by default while aggregates cover ALL enrollments', async () => {
    const { client } = worldWithEnrollments(60)
    const res = (await makeTools(client).get_sequence.execute!(
      { sequence_id: 'seq-1' },
      {} as never,
    )) as Record<string, unknown>
    expect(res.success).toBe(true)
    expect((res.enrollments as unknown[]).length).toBe(50)
    expect(res.enrollments_total).toBe(60)
    expect(res.enrollments_truncated).toBe(true)
    // Headline counts come from the full set, not the capped list.
    expect(res.enrollment_counts).toEqual({ total: 60, active: 30, replied: 30 })
  })

  it('honors an explicit enrollment_limit and reports no truncation when under it', async () => {
    const { client } = worldWithEnrollments(5)
    const res = (await makeTools(client).get_sequence.execute!(
      { sequence_id: 'seq-1', enrollment_limit: 10 },
      {} as never,
    )) as Record<string, unknown>
    expect(res.success).toBe(true)
    expect((res.enrollments as unknown[]).length).toBe(5)
    expect(res.enrollments_total).toBe(5)
    expect(res.enrollments_truncated).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────
// Input-schema caps — bounds enforced at the write boundary
// ──────────────────────────────────────────────────────────────────

describe('input schema caps', () => {
  const tools = makeTools(throwingClient)
  const parse = (t: { inputSchema: unknown }, value: unknown) =>
    (t.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(value)

  it('rejects more than 200 contact_ids per enroll call (batch instead of timing out mid-loop)', () => {
    const ids = Array.from({ length: 201 }, (_, i) => `c-${i}`)
    expect(
      parse(tools.enroll_contacts_in_sequence, { sequence_id: 's', contact_ids: ids }).success,
    ).toBe(false)
    expect(
      parse(tools.enroll_contacts_in_sequence, {
        sequence_id: 's',
        contact_ids: ids.slice(0, 200),
      }).success,
    ).toBe(true)
  })

  it('names the sequence it enrolled into, so the report is not a uuid', async () => {
    // "14 enrolled in Q4 Outbound" is the sentence the user needs; the caller
    // cannot supply the name, because the model passes a uuid. Read AFTER the
    // enrollment landed, so a name that could not be read never costs a save.
    const { client } = makeFakeSupabase((q) => {
      if (q.table === 'sequence') {
        const selected = q.filters.find((f) => f.method === 'select')?.args[0]
        // enrollContacts' own guard reads a narrow projection; the tool's
        // display read is the `*` one.
        return selected === '*'
          ? { data: { id: 's-1', name: 'Q4 Outbound', status: 'draft' } }
          : { data: { id: 's-1', status: 'draft' } }
      }
      if (q.table === 'contact') return { data: [{ id: 'c-1', email: 'ada@acme.test' }] }
      if (q.table === 'outreach_suppression') return { data: [] }
      if (q.table === 'sequence_enrollment') return { data: [] }
      return { data: null }
    })
    const res = (await makeTools(client).enroll_contacts_in_sequence.execute!(
      { sequence_id: 's-1', contact_ids: ['c-1'] },
      {} as never,
    )) as Record<string, unknown>
    expect(res).toMatchObject({
      success: true,
      enrolled_count: 1,
      sequence_id: 's-1',
      sequence_name: 'Q4 Outbound',
    })
  })

  it('degrades to a null sequence name rather than failing an enrollment that landed', async () => {
    let sequenceReads = 0
    const { client } = makeFakeSupabase((q) => {
      if (q.table === 'sequence') {
        sequenceReads += 1
        // Reads 1-2 succeed — the workspace-routing resolve (its fast path)
        // and enrollContacts' own internal guard read; the FINAL display read
        // (loadSequence, for the name) does not.
        return sequenceReads <= 2
          ? { data: { id: 's-1', status: 'draft' } }
          : { data: null, error: { message: 'boom' } }
      }
      if (q.table === 'contact') return { data: [{ id: 'c-1', email: 'ada@acme.test' }] }
      if (q.table === 'outreach_suppression') return { data: [] }
      if (q.table === 'sequence_enrollment') return { data: [] }
      return { data: null }
    })
    const res = (await makeTools(client).enroll_contacts_in_sequence.execute!(
      { sequence_id: 's-1', contact_ids: ['c-1'] },
      {} as never,
    )) as Record<string, unknown>
    expect(res).toMatchObject({ success: true, enrolled_count: 1, sequence_name: null })
  })

  it('rejects more than 20 steps on create and update', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      step_order: i + 1,
      subject: i === 0 ? 'S' : undefined,
      body: 'B',
      delay_days: 0,
    }))
    expect(parse(tools.create_sequence, { name: 'N', steps: tooMany }).success).toBe(false)
    expect(parse(tools.update_sequence, { sequence_id: 's', steps: tooMany }).success).toBe(false)
  })

  it('rejects oversized step bodies and subjects', () => {
    const huge = (body: string, subject = 'S') => [
      { step_order: 1, subject, body, delay_days: 0 },
    ]
    expect(
      parse(tools.create_sequence, { name: 'N', steps: huge('x'.repeat(20001)) }).success,
    ).toBe(false)
    expect(
      parse(tools.create_sequence, { name: 'N', steps: huge('B', 's'.repeat(501)) }).success,
    ).toBe(false)
    expect(parse(tools.create_sequence, { name: 'N', steps: huge('B') }).success).toBe(true)
  })

  it('caps get_sequence enrollment_limit at 200', () => {
    expect(parse(tools.get_sequence, { sequence_id: 's', enrollment_limit: 500 }).success).toBe(
      false,
    )
    expect(parse(tools.get_sequence, { sequence_id: 's', enrollment_limit: 200 }).success).toBe(
      true,
    )
  })
})

// ──────────────────────────────────────────────────────────────────
// enroll_contacts_in_sequence
// ──────────────────────────────────────────────────────────────────

describe('enroll_contacts_in_sequence', () => {
  it('returns per-contact results the agent can narrate, plus the review URL', async () => {
    const { client } = makeFakeSupabase((q) => {
      if (q.table === 'sequence') return { data: { id: 'seq-1', status: 'draft' } }
      if (q.table === 'contact') {
        return {
          data: [
            { id: 'c-1', email: 'a@x.com' },
            { id: 'c-2', email: 'b@x.com' },
          ],
        }
      }
      if (q.table === 'outreach_suppression') return { data: [] }
      if (q.table === 'sequence_enrollment' && q.op === 'select') {
        return { data: [{ contact_id: 'c-2', contact_email: 'b@x.com', sequence_id: 'other' }] }
      }
      if (q.table === 'sequence_enrollment' && q.op === 'insert') return {}
      throw new Error(`unexpected query: ${q.table} ${q.op}`)
    })
    const res = await makeTools(client).enroll_contacts_in_sequence.execute!(
      { sequence_id: 'seq-1', contact_ids: ['c-1', 'c-2', 'c-3'] },
      {} as never,
    )
    expect(res).toMatchObject({
      success: true,
      enrolled: ['c-1'],
      enrolled_count: 1,
      skipped_count: 2,
      skipped: [
        { contact_id: 'c-2', reason: 'already_active' },
        { contact_id: 'c-3', reason: 'not_found' },
      ],
      url: expect.stringContaining('seq-1'),
    })
  })

  it("never enrolls another member's private contact: it reads as not_found and never reaches the insert", async () => {
    const { client, queries } = makeFakeSupabase(
      (q) => {
        if (q.table === 'sequence') return { data: { id: 'seq-1', status: 'draft' } }
        if (q.table === 'contact') {
          // Service role: the row comes back regardless of its visibility.
          const ids = (q.filters.find((f) => f.method === 'in')?.args[1] ?? []) as string[]
          return {
            data: [
              { id: 'c-1', email: 'a@x.com' },
              { id: 'c-private', email: 'p@x.com' },
            ].filter((c) => ids.includes(c.id)),
          }
        }
        if (q.table === 'outreach_suppression') return { data: [] }
        if (q.table === 'sequence_enrollment' && q.op === 'select') return { data: [] }
        if (q.table === 'sequence_enrollment' && q.op === 'insert') return {}
        throw new Error(`unexpected query: ${q.table} ${q.op}`)
      },
      ['c-private'],
    )
    const res = await makeTools(client).enroll_contacts_in_sequence.execute!(
      { sequence_id: 'seq-1', contact_ids: ['c-private', 'c-1'] },
      {} as never,
    )
    expect(res).toMatchObject({
      success: true,
      enrolled: ['c-1'],
      enrolled_count: 1,
      skipped_count: 1,
      skipped: [{ contact_id: 'c-private', reason: 'not_found' }],
    })
    const inserted = JSON.stringify(
      queries.filter((q) => q.table === 'sequence_enrollment' && q.op === 'insert').map((q) => q.payload),
    )
    expect(inserted).not.toContain('c-private')
  })

  it('surfaces archived-sequence refusal', async () => {
    const { client } = makeFakeSupabase((q) => {
      if (q.table === 'sequence') return { data: { id: 'seq-1', status: 'archived' } }
      throw new Error(`unexpected query: ${q.table} ${q.op}`)
    })
    const res = await makeTools(client).enroll_contacts_in_sequence.execute!(
      { sequence_id: 'seq-1', contact_ids: ['c-1'] },
      {} as never,
    )
    expect(res).toMatchObject({
      success: false,
      error: 'Cannot enroll into an archived sequence',
    })
  })
})

// ──────────────────────────────────────────────────────────────────
// remove_from_sequence
// ──────────────────────────────────────────────────────────────────

describe('remove_from_sequence', () => {
  it('requires enrollment_id or contact_id', async () => {
    const res = await makeTools(throwingClient).remove_from_sequence.execute!(
      { sequence_id: 'seq-1' },
      {} as never,
    )
    expect(res).toMatchObject({ success: false, error: 'Provide enrollment_id or contact_id' })
  })

  it('exits an active enrollment as removed (by contact_id)', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.op === 'select') {
        return { data: { id: 'enr-1', status: 'active', exit_reason: null } }
      }
      return {}
    })
    const res = await makeTools(client).remove_from_sequence.execute!(
      { sequence_id: 'seq-1', contact_id: 'c-1' },
      {} as never,
    )
    expect(res).toMatchObject({ success: true, removed: true })
    const update = queries.find((q) => q.op === 'update')!
    expect(update.payload).toEqual({
      status: 'exited',
      exit_reason: 'removed',
      next_send_at: null,
    })
  })

  it('is a safe no-op on an already-exited enrollment', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.op === 'select') {
        return { data: { id: 'enr-1', status: 'exited', exit_reason: 'replied' } }
      }
      throw new Error('must not update an exited enrollment')
    })
    const res = await makeTools(client).remove_from_sequence.execute!(
      { sequence_id: 'seq-1', enrollment_id: 'enr-1' },
      {} as never,
    )
    expect(res).toMatchObject({ success: true, removed: false })
    expect(queries.filter((q) => q.op === 'update')).toHaveLength(0)
  })

  it('reports a missing enrollment', async () => {
    const { client } = makeFakeSupabase(() => ({ data: null }))
    const res = await makeTools(client).remove_from_sequence.execute!(
      { sequence_id: 'seq-1', enrollment_id: 'enr-x' },
      {} as never,
    )
    expect(res).toMatchObject({ success: false, error: 'Enrollment not found' })
  })
})
