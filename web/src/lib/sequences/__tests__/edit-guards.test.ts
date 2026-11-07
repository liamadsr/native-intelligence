import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  evaluateStepEdits,
  normalizeStepEdits,
  stepEditVerdicts,
  updateSequenceStructure,
  type EditableStepState,
  type IncomingStepEdit,
} from '../mutations'
import { MIN_EDIT_RESCHEDULE_MS } from '../schedule'

/**
 * Tests for the GRADUATED edit rules that replaced the blanket
 * sequence_locked: per-step verdicts (stepEditVerdicts), the reconcile-by-id
 * planner (evaluateStepEdits), and the shared DB implementation
 * (updateSequenceStructure) — the single code path behind the PATCH route,
 * the update_sequence agent tool, and the builder's pinned indicators.
 *
 * Spec (Liam, 2026-08-12), every rule pinned here:
 *   ALWAYS editable mid-flight: copy, delays of never-sent steps (with
 *   pending recompute), send_window/timezone/delay_unit, name/description,
 *   adding steps at the end, subject NULL↔set on a never-sent step.
 *   GUARDED per step: delete with ledger rows or about-to-receive, reorder
 *   at-or-before the frontier, delay / threading changes on sent steps.
 */

// ──────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────

function step(
  id: string,
  order: number,
  overrides: Partial<EditableStepState> = {},
): EditableStepState {
  return {
    id,
    step_order: order,
    subject: order === 1 ? 'Subject' : null,
    delay_days: order === 1 ? 0 : 3,
    is_active: true,
    has_sends: false,
    ...overrides,
  }
}

function incoming(
  id: string | null,
  order: number,
  overrides: Partial<IncomingStepEdit> = {},
): IncomingStepEdit {
  return {
    id,
    step_order: order,
    subject: order === 1 ? 'Subject' : null,
    body: 'Body',
    delay_days: order === 1 ? 0 : 3,
    is_active: true,
    ...overrides,
  }
}

// ──────────────────────────────────────────────────────────────────
// stepEditVerdicts — every rule in the spec
// ──────────────────────────────────────────────────────────────────

describe('stepEditVerdicts', () => {
  it('everything is allowed with no active enrollments and no sends', () => {
    const verdicts = stepEditVerdicts([step('a', 1), step('b', 2)], [])
    for (const v of verdicts.values()) {
      expect(v.delete.allowed).toBe(true)
      expect(v.reorder.allowed).toBe(true)
      expect(v.delay.allowed).toBe(true)
      expect(v.subject_presence.allowed).toBe(true)
    }
  })

  it('blocks DELETE of a step with ledger rows even with ZERO active enrollments — never worked around', () => {
    const verdicts = stepEditVerdicts([step('a', 1, { has_sends: true }), step('b', 2)], [])
    expect(verdicts.get('a')!.delete.allowed).toBe(false)
    expect(verdicts.get('a')!.delete.reason).toContain('send history')
    expect(verdicts.get('b')!.delete.allowed).toBe(true)
  })

  it('blocks DELETE of the step an active enrollment is about to receive', () => {
    // Enrollment at order 1 → about to receive step 2 (no sends on it yet).
    const verdicts = stepEditVerdicts(
      [step('a', 1, { has_sends: true }), step('b', 2), step('c', 3)],
      [1],
    )
    expect(verdicts.get('b')!.delete.allowed).toBe(false)
    expect(verdicts.get('b')!.delete.reason).toContain('about to receive')
    // The tail step beyond the enrollment is deletable.
    expect(verdicts.get('c')!.delete.allowed).toBe(true)
  })

  it('about-to-receive follows the engine (skips a deactivated step in between)', () => {
    // Enrollment at 1; step 2 is deactivated → the engine will send step 3.
    const verdicts = stepEditVerdicts(
      [step('a', 1, { has_sends: true }), step('b', 2, { is_active: false }), step('c', 3)],
      [1],
    )
    expect(verdicts.get('c')!.delete.allowed).toBe(false)
    // The deactivated, never-sent step 2 is NOT about to send — deletable.
    expect(verdicts.get('b')!.delete.allowed).toBe(true)
  })

  it('blocks REORDER at-or-before the frontier (max current_step_order + 1); tail moves freely', () => {
    // Enrollments at orders 1 and 2 → frontier 3.
    const verdicts = stepEditVerdicts(
      [step('a', 1), step('b', 2), step('c', 3), step('d', 4), step('e', 5)],
      [1, 2],
    )
    expect(verdicts.get('a')!.reorder.allowed).toBe(false)
    expect(verdicts.get('b')!.reorder.allowed).toBe(false)
    expect(verdicts.get('c')!.reorder.allowed).toBe(false) // exactly AT the frontier
    expect(verdicts.get('d')!.reorder.allowed).toBe(true)
    expect(verdicts.get('e')!.reorder.allowed).toBe(true)
  })

  it('staged enrollments (order 0) count: frontier 1 pins step 1', () => {
    const verdicts = stepEditVerdicts([step('a', 1), step('b', 2)], [0])
    expect(verdicts.get('a')!.reorder.allowed).toBe(false)
    expect(verdicts.get('b')!.reorder.allowed).toBe(true)
  })

  it('blocks DELAY changes only on steps that have been sent', () => {
    const verdicts = stepEditVerdicts(
      [step('a', 1, { has_sends: true }), step('b', 2)],
      [1],
    )
    expect(verdicts.get('a')!.delay.allowed).toBe(false)
    expect(verdicts.get('b')!.delay.allowed).toBe(true)
  })

  it('blocks subject NULL↔set only on steps that have been sent (threading is meaning)', () => {
    const verdicts = stepEditVerdicts(
      [step('a', 1, { has_sends: true }), step('b', 2)],
      [1],
    )
    expect(verdicts.get('a')!.subject_presence.allowed).toBe(false)
    expect(verdicts.get('b')!.subject_presence.allowed).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────
// evaluateStepEdits — reconcile-by-id planner
// ──────────────────────────────────────────────────────────────────

describe('evaluateStepEdits', () => {
  it('plans updates / appended inserts / unguarded deletes; copy edits are always allowed', () => {
    const existing = [
      step('a', 1, { has_sends: true }),
      step('b', 2, { has_sends: true }),
      step('c', 3),
    ]
    const res = evaluateStepEdits(
      existing,
      [
        // Copy edits on SENT steps — always fine (engine renders at send time).
        incoming('a', 1, { subject: 'New subject wording', body: 'New body' }),
        incoming('b', 2, { body: 'Reworded bump' }),
        // step 'c' omitted → delete (no sends, beyond the frontier of [1]).
        // A brand-new step appended at the end.
        incoming(null, 3, { body: 'Fresh closer', delay_days: 5 }),
      ],
      [1],
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.plan.updates.map((u) => u.id)).toEqual(['a', 'b'])
    expect(res.plan.deleteIds).toEqual(['c'])
    expect(res.plan.inserts).toEqual([
      { step_order: 3, subject: null, body: 'Fresh closer', delay_days: 5, is_active: true },
    ])
    expect(res.plan.needsTwoPhaseReorder).toBe(false)
    expect(res.plan.delayChangedIds).toEqual([])
  })

  it('flags two-phase reorder when surviving orders change (UNIQUE(sequence_id, step_order))', () => {
    const existing = [step('a', 1), step('b', 2), step('c', 3)]
    const res = evaluateStepEdits(
      existing,
      [incoming('a', 1), incoming('c', 2, { delay_days: 3 }), incoming('b', 3)],
      [], // nothing enrolled — tail reorder everywhere
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.plan.needsTwoPhaseReorder).toBe(true)
  })

  it('records delayChangedIds for allowed delay edits (drives the pending recompute)', () => {
    const existing = [step('a', 1, { has_sends: true }), step('b', 2)]
    const res = evaluateStepEdits(
      existing,
      [incoming('a', 1), incoming('b', 2, { delay_days: 7 })],
      [1],
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.plan.delayChangedIds).toEqual(['b'])
  })

  it('collects EVERY violation instead of failing fast', () => {
    const existing = [
      step('a', 1, { has_sends: true }),
      step('b', 2, { has_sends: true }),
      step('c', 3),
    ]
    const res = evaluateStepEdits(
      existing,
      [
        // Guarded: delay change on a sent step.
        incoming('a', 1, { delay_days: 2 }),
        // Guarded: threading flip on a sent step (NULL → set).
        incoming('b', 2, { subject: 'Now its own thread' }),
        incoming('c', 3),
      ],
      [2],
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.guardErrors).toHaveLength(2)
    expect(res.guardErrors.map((g) => g.step_id).sort()).toEqual(['a', 'b'])
    for (const g of res.guardErrors) expect(g.reason).toBeTruthy()
  })

  it('refuses reordering a guarded step AND moving a tail step into the guarded region', () => {
    const existing = [step('a', 1), step('b', 2), step('c', 3)]
    // Enrollment at 1 → frontier 2: 'a' and 'b' are pinned.
    const res = evaluateStepEdits(
      existing,
      [incoming('c', 1, { subject: 'S', delay_days: 0 }), incoming('a', 2, { subject: 'Subject', delay_days: 3 }), incoming('b', 3)],
      [1],
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    const ids = res.guardErrors.map((g) => g.step_id)
    expect(ids).toContain('a') // pinned step moved
    expect(ids).toContain('c') // tail step moved into the pinned region
  })

  it('refuses a mid-list INSERT at-or-before the frontier, but allows appends', () => {
    const existing = [step('a', 1), step('b', 2)]
    // Enrollment at 1 → frontier 2. Injecting a new step at position 2
    // displaces 'b' and changes what the enrollment receives next.
    const blocked = evaluateStepEdits(
      existing,
      [incoming('a', 1), incoming(null, 2, { body: 'Injected' }), incoming('b', 3)],
      [1],
    )
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.guardErrors.some((g) => g.step_id === null)).toBe(true)
    }

    // Appending at the end is the spec's ALWAYS-allowed case.
    const appended = evaluateStepEdits(
      existing,
      [incoming('a', 1), incoming('b', 2), incoming(null, 3, { body: 'Closer' })],
      [1],
    )
    expect(appended.ok).toBe(true)
  })

  it('append stays allowed even when the frontier sits past the last step (deactivated tail)', () => {
    // Enrollment pending at order 1 with step 2 deactivated → frontier 2,
    // beyond nothing: appending step 3 must still be allowed (spec: adding
    // at the end is ALWAYS editable).
    const existing = [step('a', 1, { has_sends: true }), step('b', 2, { is_active: false })]
    const res = evaluateStepEdits(
      existing,
      [incoming('a', 1), incoming('b', 2, { is_active: false }), incoming(null, 3, { body: 'New closer' })],
      [1],
    )
    expect(res.ok).toBe(true)
  })

  it('allows is_active toggles anywhere — including the about-to-send step (the engine skips forward)', () => {
    const existing = [step('a', 1, { has_sends: true }), step('b', 2), step('c', 3)]
    const res = evaluateStepEdits(
      existing,
      [incoming('a', 1), incoming('b', 2, { is_active: false }), incoming('c', 3)],
      [1], // 'b' is exactly what the enrollment would receive next
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.plan.updates.find((u) => u.id === 'b')!.is_active).toBe(false)
  })

  it('rejects unknown and duplicated step ids per step', () => {
    const existing = [step('a', 1)]
    const unknown = evaluateStepEdits(existing, [incoming('ghost', 1, { subject: 'S' })], [])
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.guardErrors[0]).toMatchObject({ step_id: 'ghost' })

    const dup = evaluateStepEdits(
      existing,
      [incoming('a', 1, { subject: 'S' }), incoming('a', 2)],
      [],
    )
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.guardErrors[0].reason).toContain('twice')
  })
})

// ──────────────────────────────────────────────────────────────────
// normalizeStepEdits
// ──────────────────────────────────────────────────────────────────

describe('normalizeStepEdits', () => {
  it('passes ids through and keeps normalizeSteps semantics (order from position)', () => {
    const res = normalizeStepEdits([
      { id: 'a', subject: 'S', body: 'B', delay_days: 0 },
      { subject: '', body: 'B2', delay_days: 3, is_active: false },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.steps).toEqual([
      { id: 'a', step_order: 1, subject: 'S', body: 'B', delay_days: 0, is_active: true },
      { id: null, step_order: 2, subject: null, body: 'B2', delay_days: 3, is_active: false },
    ])
  })

  it('surfaces the shared validation errors unchanged', () => {
    expect(normalizeStepEdits([])).toEqual({ ok: false, error: 'steps must be a non-empty array' })
    expect(normalizeStepEdits([{ id: 'a', body: 'B', delay_days: 0 }])).toEqual({
      ok: false,
      error: 'step 1 must have a subject (follow-ups may omit it to thread)',
    })
  })
})

// ──────────────────────────────────────────────────────────────────
// updateSequenceStructure — recording fake Supabase (mutations.test.ts shape)
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

const WS = 'ws-1'
const SEQ = {
  id: 'seq-1',
  timezone: 'America/Los_Angeles',
  delay_unit: 'business' as const,
  send_window: { days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 16 },
}

interface StructureWorld {
  steps: Array<Record<string, unknown>>
  enrollments: Array<Record<string, unknown>>
  /** sequence_send rows served for BOTH the step_id and enrollment_id scans. */
  sends: Array<Record<string, unknown>>
}

function structureHandler(world: StructureWorld) {
  return (q: Captured): FakeResult => {
    if (q.table === 'sequence_enrollment' && q.op === 'select') return { data: world.enrollments }
    if (q.table === 'sequence_step' && q.op === 'select') return { data: world.steps }
    if (q.table === 'sequence_send' && q.op === 'select') return { data: world.sends }
    // The recompute's CAS update reads back the matched rows via .select('id')
    // and counts them — report the row as matched (the CAS-lost case is
    // covered by the dedicated test below returning data: []).
    if (q.table === 'sequence_enrollment' && q.op === 'update') return { data: [{ id: 'matched' }] }
    if (q.op === 'update' || q.op === 'delete' || q.op === 'insert') return {}
    if (q.table === 'sequence' && q.op === 'select') return { data: null }
    throw new Error(`unexpected query: ${q.table} ${q.op}`)
  }
}

describe('updateSequenceStructure', () => {
  it('refuses a time zone Intl rejects, before writing anything (it would make every send-time computation throw)', async () => {
    const { client, queries } = makeFakeSupabase(structureHandler({ steps: [], enrollments: [], sends: [] }))
    const res = await updateSequenceStructure(client, { workspaceId: WS, sequence: SEQ, input: { timezone: 'PT' } })
    expect(res).toMatchObject({ ok: false, code: 'invalid_steps' })
    expect(queries).toHaveLength(0)
  })

  it('returns per-step guard errors and writes NOTHING when a guard trips', async () => {
    const { client, queries } = makeFakeSupabase(
      structureHandler({
        steps: [
          { id: 'a', step_order: 1, subject: 'S', delay_days: 0, is_active: true },
          { id: 'b', step_order: 2, subject: null, delay_days: 3, is_active: true },
        ],
        enrollments: [{ id: 'e-1', current_step_order: 1, next_send_at: '2027-01-01T00:00:00Z' }],
        sends: [{ step_id: 'a' }],
      }),
    )
    const res = await updateSequenceStructure(client, {
      workspaceId: WS,
      sequence: SEQ,
      input: {
        // Deleting sent step 'a' (kept list omits it) — guarded.
        steps: [{ id: 'b', subject: 'Promoted', body: 'B', delay_days: 0 }],
      },
    })
    expect(res).toMatchObject({ ok: false, code: 'step_guarded' })
    if (res.ok || res.code !== 'step_guarded') return
    expect(res.guardErrors.some((g) => g.step_id === 'a')).toBe(true)
    expect(queries.filter((q) => q.op !== 'select')).toHaveLength(0)
  })

  it('two-phase reorder: bumps every survivor out of the live range BEFORE writing final orders', async () => {
    const { client, queries } = makeFakeSupabase(
      structureHandler({
        steps: [
          { id: 'a', step_order: 1, subject: 'S', delay_days: 0, is_active: true },
          { id: 'b', step_order: 2, subject: null, delay_days: 3, is_active: true },
          { id: 'c', step_order: 3, subject: null, delay_days: 3, is_active: true },
        ],
        enrollments: [],
        sends: [],
      }),
    )
    const res = await updateSequenceStructure(client, {
      workspaceId: WS,
      sequence: SEQ,
      input: {
        steps: [
          { id: 'a', subject: 'S', body: 'B', delay_days: 0 },
          { id: 'c', subject: null, body: 'B', delay_days: 3 },
          { id: 'b', subject: null, body: 'B', delay_days: 3 },
        ],
      },
    })
    expect(res).toMatchObject({ ok: true })

    const stepUpdates = queries.filter((q) => q.table === 'sequence_step' && q.op === 'update')
    // 3 bump writes then 3 final writes, in that order — the bumps all land
    // outside 1..20 so no intermediate state can violate the unique index.
    expect(stepUpdates).toHaveLength(6)
    const orders = stepUpdates.map((q) => (q.payload as { step_order: number }).step_order)
    expect(orders.slice(0, 3).every((o) => o > 20)).toBe(true)
    expect(orders.slice(3)).toEqual([1, 2, 3])
    // Every write is keyed to the sequence (tenancy fence for service-role callers).
    for (const q of stepUpdates) {
      expect(filterArgs(q, 'eq')).toContainEqual(['sequence_id', SEQ.id])
    }
  })

  it('in-place edits skip the bump phase entirely', async () => {
    const { client, queries } = makeFakeSupabase(
      structureHandler({
        steps: [{ id: 'a', step_order: 1, subject: 'S', delay_days: 0, is_active: true }],
        enrollments: [],
        sends: [],
      }),
    )
    const res = await updateSequenceStructure(client, {
      workspaceId: WS,
      sequence: SEQ,
      input: { steps: [{ id: 'a', subject: 'Reworded', body: 'New body', delay_days: 0 }] },
    })
    expect(res).toMatchObject({ ok: true })
    const stepUpdates = queries.filter((q) => q.table === 'sequence_step' && q.op === 'update')
    expect(stepUpdates).toHaveLength(1)
    expect(stepUpdates[0].payload).toMatchObject({ step_order: 1, subject: 'Reworded' })
  })

  it('recomputes pending next_send_at from the latest SENT row when the next step’s delay changes — never earlier than now+2min', async () => {
    const lastSent = new Date(Date.now() - 10 * 86_400_000).toISOString()
    const world: StructureWorld = {
      steps: [
        { id: 'a', step_order: 1, subject: 'S', delay_days: 0, is_active: true },
        { id: 'b', step_order: 2, subject: null, delay_days: 3, is_active: true },
      ],
      enrollments: [
        // Pending: sent step 1, waiting on step 2.
        { id: 'e-pending', current_step_order: 1, next_send_at: '2027-01-01T00:00:00Z' },
        // Staged: never scheduled — must NOT be touched.
        { id: 'e-staged', current_step_order: 0, next_send_at: null },
      ],
      sends: [
        { step_id: 'a' },
        { enrollment_id: 'e-pending', sent_at: lastSent },
      ],
    }
    const { client, queries } = makeFakeSupabase(structureHandler(world))
    const before = Date.now()
    const res = await updateSequenceStructure(client, {
      workspaceId: WS,
      sequence: SEQ,
      input: {
        // Shrink step 2's delay to 1 — recomputed from lastSent, that's due
        // NOW; the floor must keep it ≥ now+2min (recompute-never-bursts).
        steps: [
          { id: 'a', subject: 'S', body: 'B', delay_days: 0 },
          { id: 'b', subject: null, body: 'B', delay_days: 1 },
        ],
      },
    })
    expect(res).toMatchObject({ ok: true, recomputedEnrollments: 1 })

    const enrollmentUpdates = queries.filter(
      (q) => q.table === 'sequence_enrollment' && q.op === 'update',
    )
    expect(enrollmentUpdates).toHaveLength(1)
    // Only the pending enrollment, CAS-guarded on still-active AND on the
    // next_send_at value that was read — a racing lease-claim/finalize wins.
    expect(filterArgs(enrollmentUpdates[0], 'eq')).toEqual([
      ['id', 'e-pending'],
      ['status', 'active'],
      ['next_send_at', '2027-01-01T00:00:00Z'],
    ])
    const payload = enrollmentUpdates[0].payload as {
      next_send_at: string
      dispatch_attempts?: number
    }
    // The reaper's budget must NOT be reset by an edit — only a successful
    // finalize clears it.
    expect(payload).not.toHaveProperty('dispatch_attempts')
    expect(new Date(payload.next_send_at).getTime()).toBeGreaterThanOrEqual(
      before + MIN_EDIT_RESCHEDULE_MS,
    )
  })

  it('recompute LOSES a race against a lease-claim/finalize: the CAS matches 0 rows and counts nothing', async () => {
    const lastSent = new Date(Date.now() - 10 * 86_400_000).toISOString()
    const base = structureHandler({
      steps: [
        { id: 'a', step_order: 1, subject: 'S', delay_days: 0, is_active: true },
        { id: 'b', step_order: 2, subject: null, delay_days: 3, is_active: true },
      ],
      enrollments: [
        { id: 'e-pending', current_step_order: 1, next_send_at: '2027-01-01T00:00:00Z' },
      ],
      sends: [{ step_id: 'a' }, { enrollment_id: 'e-pending', sent_at: lastSent }],
    })
    const { client, queries } = makeFakeSupabase((q) => {
      // A dispatcher tick claimed the row mid-edit: its next_send_at no longer
      // matches what the recompute read, so the CAS update matches nothing.
      if (q.table === 'sequence_enrollment' && q.op === 'update') return { data: [] }
      return base(q)
    })
    const res = await updateSequenceStructure(client, {
      workspaceId: WS,
      sequence: SEQ,
      input: {
        steps: [
          { id: 'a', subject: 'S', body: 'B', delay_days: 0 },
          { id: 'b', subject: null, body: 'B', delay_days: 1 },
        ],
      },
    })
    // The write was attempted but lost — recomputedEnrollments must say 0.
    expect(res).toMatchObject({ ok: true, recomputedEnrollments: 0 })
    expect(
      queries.filter((q) => q.table === 'sequence_enrollment' && q.op === 'update'),
    ).toHaveLength(1)
  })

  it('recompute uses a FRESH enrollment read, not the pre-write snapshot (a finalize mid-edit advances the row)', async () => {
    const world: StructureWorld = {
      steps: [
        { id: 'a', step_order: 1, subject: 'S', delay_days: 0, is_active: true },
        { id: 'b', step_order: 2, subject: null, delay_days: 3, is_active: true },
        { id: 'c', step_order: 3, subject: null, delay_days: 3, is_active: true },
      ],
      enrollments: [],
      sends: [{ step_id: 'a' }, { enrollment_id: 'e-1', sent_at: '2026-08-01T17:00:00Z' }],
    }
    let enrollmentSelects = 0
    const base = structureHandler(world)
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'sequence_enrollment' && q.op === 'select') {
        enrollmentSelects += 1
        // First read (guard snapshot): waiting on step 2 — whose delay this
        // edit changes, so the STALE snapshot would mark the row affected and
        // recompute from step 2's new delay, clobbering the fresher value.
        // Second read (the recompute's): step 2's send finalized mid-edit —
        // the row advanced to order 2 with a finalize-written next_send_at,
        // now waiting on step 3, whose delay did NOT change.
        return {
          data:
            enrollmentSelects === 1
              ? [{ id: 'e-1', current_step_order: 1, next_send_at: '2027-01-01T00:00:00Z' }]
              : [{ id: 'e-1', current_step_order: 2, next_send_at: '2027-02-01T00:00:00Z' }],
        }
      }
      return base(q)
    })
    const res = await updateSequenceStructure(client, {
      workspaceId: WS,
      sequence: SEQ,
      input: {
        // Never-sent step 2's delay 3 → 7 (allowed); step 3 untouched.
        steps: [
          { id: 'a', subject: 'S', body: 'B', delay_days: 0 },
          { id: 'b', subject: null, body: 'B', delay_days: 7 },
          { id: 'c', subject: null, body: 'B', delay_days: 3 },
        ],
      },
    })
    // The fresh row's NEXT step (3) is unchanged → not affected, no write.
    expect(res).toMatchObject({ ok: true, recomputedEnrollments: 0 })
    expect(enrollmentSelects).toBe(2)
    expect(
      queries.filter((q) => q.table === 'sequence_enrollment' && q.op === 'update'),
    ).toHaveLength(0)
  })

  it('leaves pending rows alone when only OTHER steps’ delays changed', async () => {
    const { client, queries } = makeFakeSupabase(
      structureHandler({
        steps: [
          { id: 'a', step_order: 1, subject: 'S', delay_days: 0, is_active: true },
          { id: 'b', step_order: 2, subject: null, delay_days: 3, is_active: true },
          { id: 'c', step_order: 3, subject: null, delay_days: 3, is_active: true },
        ],
        // Waiting on step 2; only step 3's delay changes.
        enrollments: [
          { id: 'e-1', current_step_order: 1, next_send_at: '2027-01-01T00:00:00Z' },
        ],
        sends: [{ step_id: 'a' }, { enrollment_id: 'e-1', sent_at: '2026-08-01T17:00:00Z' }],
      }),
    )
    const res = await updateSequenceStructure(client, {
      workspaceId: WS,
      sequence: SEQ,
      input: {
        steps: [
          { id: 'a', subject: 'S', body: 'B', delay_days: 0 },
          { id: 'b', subject: null, body: 'B', delay_days: 3 },
          { id: 'c', subject: null, body: 'B', delay_days: 9 },
        ],
      },
    })
    expect(res).toMatchObject({ ok: true, recomputedEnrollments: 0 })
    expect(queries.filter((q) => q.table === 'sequence_enrollment' && q.op === 'update')).toHaveLength(0)
  })

  it('a schedule-field edit (send_window) recomputes ALL pending enrollments with sent history', async () => {
    const { client, queries } = makeFakeSupabase(
      structureHandler({
        steps: [
          { id: 'a', step_order: 1, subject: 'S', delay_days: 0, is_active: true },
          { id: 'b', step_order: 2, subject: null, delay_days: 3, is_active: true },
        ],
        enrollments: [
          { id: 'e-1', current_step_order: 1, next_send_at: '2027-01-01T00:00:00Z' },
          // Armed step-1 row: pending but NO sent ledger rows → left alone
          // (no actual send to count the delay from).
          { id: 'e-armed', current_step_order: 0, next_send_at: '2027-01-01T00:00:00Z' },
        ],
        sends: [{ enrollment_id: 'e-1', sent_at: '2026-08-01T17:00:00Z' }],
      }),
    )
    const res = await updateSequenceStructure(client, {
      workspaceId: WS,
      sequence: SEQ,
      input: { send_window: { days: [1, 2, 3], start_hour: 10, end_hour: 12 } },
    })
    expect(res).toMatchObject({ ok: true, recomputedEnrollments: 1 })
    const updates = queries.filter((q) => q.table === 'sequence_enrollment' && q.op === 'update')
    expect(updates).toHaveLength(1)
    expect(filterArgs(updates[0], 'eq')).toContainEqual(['id', 'e-1'])
  })

  it('name/description-only edits touch nothing but the sequence row (no scans, no recompute)', async () => {
    const { client, queries } = makeFakeSupabase(
      structureHandler({ steps: [], enrollments: [], sends: [] }),
    )
    const res = await updateSequenceStructure(client, {
      workspaceId: WS,
      sequence: SEQ,
      input: { name: '  Renamed  ', description: '' },
    })
    expect(res).toMatchObject({ ok: true, recomputedEnrollments: 0 })
    expect(queries).toHaveLength(1)
    expect(queries[0]).toMatchObject({ table: 'sequence', op: 'update' })
    expect(queries[0].payload).toEqual({ name: 'Renamed', description: null })
    expect(filterArgs(queries[0], 'eq')).toEqual([
      ['id', SEQ.id],
      ['workspace_id', WS],
    ])
  })

  it('propagates invalid step input as invalid_steps (shared validation)', async () => {
    const { client, queries } = makeFakeSupabase(
      structureHandler({ steps: [], enrollments: [], sends: [] }),
    )
    const res = await updateSequenceStructure(client, {
      workspaceId: WS,
      sequence: SEQ,
      input: { steps: [{ body: 'no subject on step 1', delay_days: 0 }] },
    })
    expect(res).toMatchObject({ ok: false, code: 'invalid_steps' })
    expect(queries.filter((q) => q.op !== 'select')).toHaveLength(0)
  })
})
