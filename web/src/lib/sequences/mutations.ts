/**
 * Shared sequence mutation logic — the single implementation behind BOTH the
 * API routes (src/app/api/account/sequences/*) and the AI agent tools
 * (src/lib/ai/tools/sequences.ts). Extracted so the two surfaces cannot
 * drift: the guards that protect an investor's inbox (suppression,
 * one-active-sequence-per-contact, step validation, the graduated per-step
 * edit rules, never-burst resume/recompute) must be identical no matter who
 * calls them.
 *
 * Everything here runs on whatever Supabase client the caller holds (the
 * routes pass the RLS-scoped client; the agent tools may hold the MCP
 * service-role client), so every query MUST carry an explicit workspace_id
 * filter — never trust RLS alone.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { containsHeaderInjectionChars, selectNextActiveStep } from './engine-logic'
import {
  computeEditedNextSendAt,
  computeNextSendAt,
  normalizeWindow,
  randomJitterMs,
  type SendWindow,
} from './schedule'
import type { SequenceDelayUnit } from './types'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { fetchAllRows, inChunks } from '@/lib/supabase/paging'
import { optedOutByTag } from '@/lib/outreach/opt-out'

// ──────────────────────────────────────────────────────────────────
// Step normalization + validation (create + wholesale-replace edits)
// ──────────────────────────────────────────────────────────────────

export interface NormalizedStep {
  step_order: number
  subject: string | null
  body: string
  delay_days: number
  is_active: boolean
}

export type NormalizeStepsResult =
  | { ok: true; steps: NormalizedStep[] }
  | { ok: false; error: string }

/**
 * Normalize raw step input (API JSON or tool args) into insert-ready rows and
 * validate the business rules:
 *
 *   - non-empty array; step_order is assigned from ARRAY POSITION (1-based) —
 *     callers that accept an explicit step_order must sort first,
 *   - every step: non-empty body, integer delay_days >= 0,
 *   - subjects must not contain header-injection characters (they become raw
 *     RFC 822 headers on the Gmail path),
 *   - step 1 must have a subject (a follow-up may omit it to thread as a
 *     reply under step 1's thread — but step 1 has no thread to reply under).
 *
 * Error strings are the exact messages the API routes have always returned.
 */
export function normalizeSteps(raw: unknown): NormalizeStepsResult {
  const rawSteps = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
  if (rawSteps.length === 0) return { ok: false, error: 'steps must be a non-empty array' }

  const steps = rawSteps.map((s, idx) => ({
    step_order: idx + 1,
    subject: typeof s.subject === 'string' && s.subject.trim() !== '' ? s.subject : null,
    body: typeof s.body === 'string' ? s.body : '',
    delay_days:
      typeof s.delay_days === 'number' && Number.isInteger(s.delay_days) && s.delay_days >= 0
        ? s.delay_days
        : null,
    is_active: s.is_active === false ? false : true,
  }))

  for (const s of steps) {
    if (!s.body.trim()) return { ok: false, error: `step ${s.step_order}: body is required` }
    if (s.delay_days === null) {
      return { ok: false, error: `step ${s.step_order}: delay_days must be a non-negative integer` }
    }
    // Subjects become raw RFC 822 headers on the Gmail path — reject header
    // injection (CR/LF, control chars) at the write boundary.
    if (s.subject !== null && containsHeaderInjectionChars(s.subject)) {
      return { ok: false, error: `step ${s.step_order}: subject must not contain control characters` }
    }
  }
  // Step 1 with no subject has no thread to reply under.
  if (steps[0].subject === null) {
    return { ok: false, error: 'step 1 must have a subject (follow-ups may omit it to thread)' }
  }

  return { ok: true, steps: steps as NormalizedStep[] }
}

// ──────────────────────────────────────────────────────────────────
// Graduated edit rules — per-step verdicts (replaces sequence_locked)
// ──────────────────────────────────────────────────────────────────
//
// The blanket "structure is locked while any enrollment is active" rule is
// gone. In its place, PER-STEP guards, evaluated by ONE implementation shared
// by the PATCH route, the update_sequence agent tool, and the builder UI's
// pinned indicators (no drift between the three surfaces):
//
//   ALWAYS editable, even mid-flight:
//     - step subject/body copy (the engine renders at send time — the next
//       send picks up the new copy),
//     - delay_days of steps NO enrollment has received yet,
//     - send_window / timezone / delay_unit (future snaps only),
//     - name / description,
//     - ADDING steps at the end (completed enrollments STAY completed — an
//       exit_reason='completed' row is never resurrected by a longer funnel),
//     - subject NULL↔set on a never-sent step (threading applies forward).
//
//   GUARDED per step (blocked with a visible reason, never a whole-form lock):
//     - DELETE of a step with any sequence_send ledger rows (the FK CASCADE
//       would erase send history — blocked unconditionally, never worked
//       around) or that an active enrollment is about to receive,
//     - REORDER of any step at-or-before the frontier (max current_step_order
//       + 1 across active enrollments) — position IS meaning mid-flight; tail
//       steps beyond every active enrollment reorder freely,
//     - delay_days / subject NULL↔set changes on a step that has been sent.
//
//   is_active toggles are always allowed — including on the about-to-send
//   step: the engine's claim skips forward to the next active step (or exits
//   'completed' when none remain). See selectNextActiveStep in engine-logic.

/** What the guard evaluation needs to know about an EXISTING step. */
export interface EditableStepState {
  id: string
  step_order: number
  subject: string | null
  delay_days: number
  is_active: boolean
  /** Any sequence_send ledger row references this step (any status). */
  has_sends: boolean
}

export interface EditVerdict {
  allowed: boolean
  reason?: string
}

export interface StepEditVerdict {
  step_id: string
  step_order: number
  /** Removing the step entirely. */
  delete: EditVerdict
  /** Changing the step's position (step_order). */
  reorder: EditVerdict
  /** Changing delay_days. */
  delay: EditVerdict
  /** Flipping subject between NULL (threaded reply) and set (new thread). */
  subject_presence: EditVerdict
}

const REASON_DELETE_HAS_SENDS =
  'this step has send history — deleting it would erase the send ledger; deactivate it instead'
const REASON_DELETE_ABOUT_TO_RECEIVE =
  'an enrolled contact is about to receive this step; deactivate it instead of deleting'
const REASON_REORDER_FRONTIER =
  'enrolled contacts are mid-flight at or before this step — only steps beyond every active contact can move'
const REASON_DELAY_HAS_SENDS =
  'contacts have already received this step — its delay cannot change'
const REASON_SUBJECT_PRESENCE_HAS_SENDS =
  'this step has been sent — whether it threads as a reply (blank subject) or starts a new thread cannot change'
const REASON_INSERT_BEFORE_FRONTIER =
  'new steps can only be added after every enrolled contact’s position (add them at the end)'
const REASON_UNKNOWN_STEP = 'not a step of this sequence'

/**
 * The reorder/insert frontier: the highest step an active enrollment is about
 * to receive, as an order number (max current_step_order + 1). 0 when nothing
 * is actively enrolled — no guards apply. Staged enrollments (order 0,
 * next_send_at NULL) count: they are status 'active' and step 1 is what they
 * will receive at launch.
 */
function editFrontier(activeEnrollmentOrders: number[]): number {
  return activeEnrollmentOrders.length > 0 ? Math.max(...activeEnrollmentOrders) + 1 : 0
}

/**
 * Per-step edit verdicts for the CURRENT structure — the single rule set
 * behind the API guard, the agent-tool guard, and the builder's pinned
 * indicators/tooltips.
 *
 * "About to receive" follows the engine's real semantics (the first ACTIVE
 * step past current_step_order — selectNextActiveStep), not a literal +1, so
 * a deactivated step in between doesn't hide the true next send.
 */
export function stepEditVerdicts(
  existing: EditableStepState[],
  activeEnrollmentOrders: number[],
): Map<string, StepEditVerdict> {
  const frontier = editFrontier(activeEnrollmentOrders)
  const aboutToReceive = new Set<string>()
  for (const order of new Set(activeEnrollmentOrders)) {
    const next = selectNextActiveStep(existing, order)
    if (next) aboutToReceive.add(next.id)
  }

  const verdicts = new Map<string, StepEditVerdict>()
  for (const step of existing) {
    verdicts.set(step.id, {
      step_id: step.id,
      step_order: step.step_order,
      delete: step.has_sends
        ? { allowed: false, reason: REASON_DELETE_HAS_SENDS }
        : aboutToReceive.has(step.id)
          ? { allowed: false, reason: REASON_DELETE_ABOUT_TO_RECEIVE }
          : { allowed: true },
      reorder:
        frontier > 0 && step.step_order <= frontier
          ? { allowed: false, reason: REASON_REORDER_FRONTIER }
          : { allowed: true },
      delay: step.has_sends
        ? { allowed: false, reason: REASON_DELAY_HAS_SENDS }
        : { allowed: true },
      subject_presence: step.has_sends
        ? { allowed: false, reason: REASON_SUBJECT_PRESENCE_HAS_SENDS }
        : { allowed: true },
    })
  }
  return verdicts
}

// ──────────────────────────────────────────────────────────────────
// Reconcile-by-id step edits (replaces the wholesale delete+reinsert)
// ──────────────────────────────────────────────────────────────────

/** An incoming step: an existing step's new state (id set) or a new step. */
export interface IncomingStepEdit extends NormalizedStep {
  /** Existing sequence_step id, or null for a newly added step. */
  id: string | null
}

export type NormalizeStepEditsResult =
  | { ok: true; steps: IncomingStepEdit[] }
  | { ok: false; error: string }

/**
 * normalizeSteps plus id passthrough — the edit surfaces send the FULL desired
 * step list where each kept step carries its existing id (order comes from
 * array position, exactly like create).
 */
export function normalizeStepEdits(raw: unknown): NormalizeStepEditsResult {
  const base = normalizeSteps(raw)
  if (!base.ok) return base
  const rawSteps = raw as Record<string, unknown>[]
  return {
    ok: true,
    steps: base.steps.map((s, idx) => {
      const id = rawSteps[idx]?.id
      return { ...s, id: typeof id === 'string' && id !== '' ? id : null }
    }),
  }
}

export interface StepGuardError {
  /** Existing step id, or null when the violation is a new (inserted) step. */
  step_id: string | null
  /** 1-based position in the INCOMING list (deletes report the old order). */
  step_order: number
  reason: string
}

export interface StepEditPlan {
  /** Surviving existing steps with their final values (incl. final order). */
  updates: Array<NormalizedStep & { id: string }>
  /** New steps to insert (final orders; never colliding with updates). */
  inserts: NormalizedStep[]
  /** Existing steps to delete — every one already verdict-checked. */
  deleteIds: string[]
  /**
   * Some surviving step's order changes, so applying the final orders naively
   * would trip UNIQUE(sequence_id, step_order) mid-write. The applier must do
   * the two-phase dance: bump every surviving step out of the live range
   * first, then write finals.
   */
  needsTwoPhaseReorder: boolean
  /** Ids of surviving steps whose delay_days changed (drives recompute). */
  delayChangedIds: string[]
}

export type EvaluateStepEditsResult =
  | { ok: true; plan: StepEditPlan }
  | { ok: false; guardErrors: StepGuardError[] }

/**
 * Diff the incoming full step list against the existing structure and either
 * return an apply plan or EVERY per-step guard violation (never fail-fast —
 * the UI pins each offending step with its reason).
 */
export function evaluateStepEdits(
  existing: EditableStepState[],
  incoming: IncomingStepEdit[],
  activeEnrollmentOrders: number[],
): EvaluateStepEditsResult {
  const guardErrors: StepGuardError[] = []
  const verdicts = stepEditVerdicts(existing, activeEnrollmentOrders)
  const frontier = editFrontier(activeEnrollmentOrders)
  const existingById = new Map(existing.map((s) => [s.id, s]))

  // Unknown / duplicated ids are input errors, reported through the same
  // per-step channel so a partially-stale client sees exactly which row.
  const seenIds = new Set<string>()
  for (const step of incoming) {
    if (step.id === null) continue
    if (!existingById.has(step.id)) {
      guardErrors.push({ step_id: step.id, step_order: step.step_order, reason: REASON_UNKNOWN_STEP })
    } else if (seenIds.has(step.id)) {
      guardErrors.push({
        step_id: step.id,
        step_order: step.step_order,
        reason: 'the same step appears twice in the list',
      })
    }
    seenIds.add(step.id)
  }
  if (guardErrors.length > 0) return { ok: false, guardErrors }

  const updates: Array<NormalizedStep & { id: string }> = []
  const inserts: NormalizedStep[] = []
  let needsTwoPhaseReorder = false
  const delayChangedIds: string[] = []

  const maxSurvivorFinalOrder = incoming.reduce(
    (max, s) => (s.id !== null && s.step_order > max ? s.step_order : max),
    0,
  )

  for (const step of incoming) {
    if (step.id === null) {
      // Insert. Appends (beyond every surviving step) are always allowed —
      // that's the spec's "ADDING steps at the end". A mid-list injection at
      // or before the frontier would change what mid-flight contacts receive
      // next, so it is guarded.
      if (frontier > 0 && step.step_order <= frontier && step.step_order <= maxSurvivorFinalOrder) {
        guardErrors.push({
          step_id: null,
          step_order: step.step_order,
          reason: REASON_INSERT_BEFORE_FRONTIER,
        })
        continue
      }
      inserts.push({
        step_order: step.step_order,
        subject: step.subject,
        body: step.body,
        delay_days: step.delay_days,
        is_active: step.is_active,
      })
      continue
    }

    const old = existingById.get(step.id)!
    const verdict = verdicts.get(step.id)!

    if (step.step_order !== old.step_order) {
      needsTwoPhaseReorder = true
      // Both ends of a move matter: a guarded step may not move, and an
      // unguarded tail step may not move INTO the guarded region.
      if (!verdict.reorder.allowed) {
        guardErrors.push({
          step_id: step.id,
          step_order: step.step_order,
          reason: verdict.reorder.reason!,
        })
      } else if (frontier > 0 && step.step_order <= frontier) {
        guardErrors.push({
          step_id: step.id,
          step_order: step.step_order,
          reason: REASON_REORDER_FRONTIER,
        })
      }
    }
    if (step.delay_days !== old.delay_days) {
      if (!verdict.delay.allowed) {
        guardErrors.push({
          step_id: step.id,
          step_order: step.step_order,
          reason: verdict.delay.reason!,
        })
      } else {
        delayChangedIds.push(step.id)
      }
    }
    if ((step.subject === null) !== (old.subject === null) && !verdict.subject_presence.allowed) {
      guardErrors.push({
        step_id: step.id,
        step_order: step.step_order,
        reason: verdict.subject_presence.reason!,
      })
    }

    updates.push({
      id: step.id,
      step_order: step.step_order,
      subject: step.subject,
      body: step.body,
      delay_days: step.delay_days,
      is_active: step.is_active,
    })
  }

  // Deletes: every existing step absent from the incoming list.
  const deleteIds: string[] = []
  for (const old of existing) {
    if (seenIds.has(old.id)) continue
    const verdict = verdicts.get(old.id)!
    if (!verdict.delete.allowed) {
      guardErrors.push({ step_id: old.id, step_order: old.step_order, reason: verdict.delete.reason! })
      continue
    }
    deleteIds.push(old.id)
  }

  if (guardErrors.length > 0) return { ok: false, guardErrors }
  return { ok: true, plan: { updates, inserts, deleteIds, needsTwoPhaseReorder, delayChangedIds } }
}

// ──────────────────────────────────────────────────────────────────
// updateSequenceStructure — the ONE structure-edit implementation
// ──────────────────────────────────────────────────────────────────

/**
 * Two-phase step_order offset. Steps are capped at 20 per sequence, so
 * old_order + 1000 can never collide with another bumped row (old orders are
 * unique) nor with any final order (≤ 20).
 */
const REORDER_BUMP_OFFSET = 1000

/** The already-workspace-fenced sequence row fields the edit needs. */
export interface EditableSequence {
  id: string
  timezone: string
  delay_unit: SequenceDelayUnit
  send_window: unknown
}

export interface SequenceStructureEditInput {
  name?: unknown
  description?: unknown
  timezone?: unknown
  send_window?: unknown
  delay_unit?: unknown
  /** Full desired step list ({ id?, subject, body, delay_days, is_active }). */
  steps?: unknown
}

export type UpdateSequenceStructureResult =
  | { ok: true; recomputedEnrollments: number }
  | { ok: false; code: 'invalid_steps'; error: string }
  | { ok: false; code: 'step_guarded'; error: string; guardErrors: StepGuardError[] }
  | { ok: false; code: 'server_error'; error: string }

/**
 * Apply a structure edit under the graduated rules — shared verbatim by the
 * PATCH route and the update_sequence agent tool. The caller passes the
 * ALREADY-FENCED sequence row (loaded with an explicit workspace_id filter);
 * every write here keys on that row's id, never on raw input.
 *
 * Steps are reconciled BY ID (update matched, insert new, delete only when
 * unguarded), with the two-phase order rewrite UNIQUE(sequence_id, step_order)
 * requires. After a successful apply, pending next_send_at is recomputed for
 * every ACTIVE enrollment whose NEXT step's delay changed (or whose schedule
 * inputs — send_window / timezone / delay_unit — changed), counting the new
 * delay from the enrollment's latest SENT ledger row and never landing
 * earlier than now + 2 minutes (edits must not cause an instant burst).
 * Staged rows (next_send_at NULL) and exited rows — including
 * exit_reason='completed' ones, which a longer funnel must NOT resurrect —
 * are never touched.
 */
export async function updateSequenceStructure(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    sequence: EditableSequence
    input: SequenceStructureEditInput
  },
): Promise<UpdateSequenceStructureResult> {
  const { workspaceId, sequence, input } = args
  const sequenceId = sequence.id
  const fail = (error: string): UpdateSequenceStructureResult => {
    console.error('[sequences] structure edit failed:', error)
    return { ok: false, code: 'server_error', error }
  }

  // ── Sequence-level fields (always editable) ─────────────────────
  const update: Record<string, unknown> = {}
  if (typeof input.name === 'string' && input.name.trim() !== '') update.name = input.name.trim()
  if (input.description !== undefined) {
    update.description =
      typeof input.description === 'string' && input.description.trim() !== ''
        ? input.description.trim()
        : null
  }
  if (typeof input.timezone === 'string' && input.timezone.trim() !== '') {
    // A zone Intl rejects ("PT", "Pacific Time") makes every send-time
    // computation throw after the row is saved. `invalid_steps` is the input
    // error code the PATCH route answers with a 400.
    if (!isTimeZone(input.timezone.trim())) {
      return { ok: false, code: 'invalid_steps', error: 'timezone must be an IANA zone like America/New_York' }
    }
    update.timezone = input.timezone.trim()
  }
  if (input.send_window !== undefined) update.send_window = normalizeWindow(input.send_window)
  if (input.delay_unit === 'business' || input.delay_unit === 'calendar') {
    update.delay_unit = input.delay_unit
  }

  // Schedule inputs changed → every pending enrollment's next snap moves.
  const scheduleChanged =
    update.timezone !== undefined ||
    update.send_window !== undefined ||
    update.delay_unit !== undefined

  // ── Load edit context (only what this edit needs) ───────────────
  const wantsStepEdit = input.steps !== undefined
  const needsEnrollments = wantsStepEdit || scheduleChanged

  let activeEnrollments: Array<{
    id: string
    current_step_order: number
    next_send_at: string | null
  }> = []
  if (needsEnrollments) {
    const { data, error } = await supabase
      .from('sequence_enrollment')
      .select('id, current_step_order, next_send_at')
      .eq('workspace_id', workspaceId)
      .eq('sequence_id', sequenceId)
      .eq('status', 'active')
    if (error) return fail(error.message)
    activeEnrollments = (data ?? []) as typeof activeEnrollments
  }
  const activeOrders = activeEnrollments.map((e) => e.current_step_order)

  // Final structure (for the recompute pass): survivors + inserts. Newly
  // inserted steps have no id yet — marked isNew so the recompute can treat
  // "next step is brand new" as delay-changed.
  let finalSteps: Array<{
    id: string | null
    step_order: number
    delay_days: number
    is_active: boolean
    isNew: boolean
  }> | null = null
  let delayChangedIds = new Set<string>()

  if (wantsStepEdit) {
    const normalized = normalizeStepEdits(input.steps)
    if (!normalized.ok) return { ok: false, code: 'invalid_steps', error: normalized.error }

    const { data: existingRows, error: stepsError } = await supabase
      .from('sequence_step')
      .select('id, step_order, subject, delay_days, is_active')
      .eq('sequence_id', sequenceId)
      .order('step_order', { ascending: true })
    if (stepsError) return fail(stepsError.message)
    const existingSteps = (existingRows ?? []) as Array<{
      id: string
      step_order: number
      subject: string | null
      delay_days: number
      is_active: boolean
    }>

    // Ledger references per step (ANY status: a claimed/sending row is history
    // in the making, and the FK CASCADE on delete doesn't care about status).
    const sentStepIds = new Set<string>()
    if (existingSteps.length > 0) {
      const { data: sendRows, error: sendsError } = await supabase
        .from('sequence_send')
        .select('step_id')
        .eq('workspace_id', workspaceId)
        .in('step_id', existingSteps.map((s) => s.id))
      if (sendsError) return fail(sendsError.message)
      for (const row of sendRows ?? []) sentStepIds.add(row.step_id as string)
    }

    const evaluated = evaluateStepEdits(
      existingSteps.map((s) => ({ ...s, has_sends: sentStepIds.has(s.id) })),
      normalized.steps,
      activeOrders,
    )
    if (!evaluated.ok) {
      return {
        ok: false,
        code: 'step_guarded',
        error: 'Some steps cannot be changed while contacts are enrolled',
        guardErrors: evaluated.guardErrors,
      }
    }
    const { plan } = evaluated
    delayChangedIds = new Set(plan.delayChangedIds)

    // Apply: deletes first (frees their orders), then the two-phase order
    // bump when any survivor moves, then final values, then inserts.
    if (plan.deleteIds.length > 0) {
      const { error } = await supabase
        .from('sequence_step')
        .delete()
        .eq('sequence_id', sequenceId)
        .in('id', plan.deleteIds)
      if (error) return fail(error.message)
    }
    if (plan.needsTwoPhaseReorder) {
      for (const step of plan.updates) {
        const old = existingSteps.find((s) => s.id === step.id)!
        const { error } = await supabase
          .from('sequence_step')
          .update({ step_order: old.step_order + REORDER_BUMP_OFFSET })
          .eq('id', step.id)
          .eq('sequence_id', sequenceId)
        if (error) return fail(error.message)
      }
    }
    for (const step of plan.updates) {
      const { id, ...values } = step
      const { error } = await supabase
        .from('sequence_step')
        .update(values)
        .eq('id', id)
        .eq('sequence_id', sequenceId)
      if (error) return fail(error.message)
    }
    if (plan.inserts.length > 0) {
      const { error } = await supabase
        .from('sequence_step')
        .insert(plan.inserts.map((s) => ({ sequence_id: sequenceId, ...s })))
      if (error) return fail(error.message)
    }

    finalSteps = [
      ...plan.updates.map((s) => ({
        id: s.id,
        step_order: s.step_order,
        delay_days: s.delay_days,
        is_active: s.is_active,
        isNew: false,
      })),
      ...plan.inserts.map((s) => ({
        id: null,
        step_order: s.step_order,
        delay_days: s.delay_days,
        is_active: s.is_active,
        isNew: true,
      })),
    ]
  }

  // ── Sequence-level update ───────────────────────────────────────
  if (Object.keys(update).length > 0) {
    const { error } = await supabase
      .from('sequence')
      .update(update)
      .eq('id', sequenceId)
      .eq('workspace_id', workspaceId)
    if (error) return fail(error.message)
  }

  // ── Recompute pending next_send_at ──────────────────────────────
  // Only ACTIVE enrollments with a scheduled (non-NULL) next_send_at, and
  // only when their NEXT step's timing inputs actually changed. Staged rows
  // (NULL) wait for launch; exited rows stay exited.
  //
  // Race note: writing next_send_at can overlap a dispatcher lease (the
  // lease is itself a next_send_at value) or a finalize. Two defenses:
  //   1. The enrollment snapshot loaded BEFORE the step writes is stale by
  //      the time we get here (the writes above are many round-trips — a send
  //      can finalize mid-edit and advance current_step_order), so the rows
  //      are RE-READ fresh for this pass. The guard evaluation keeps the
  //      earlier snapshot: an advance only ever makes guards stricter, and
  //      the server re-evaluates on the next edit.
  //   2. Each update is CAS-guarded on the next_send_at value just read —
  //      every state change that matters (lease claim, finalize, exit)
  //      rewrites next_send_at, so a recompute racing one of those simply
  //      matches 0 rows and loses, exactly like a losing dispatcher tick.
  //      Without the CAS it would silently cancel an in-flight lease and the
  //      re-claim could re-send a step whose ledger row was deliberately
  //      released (the account-unavailable path deletes its 'sending' row).
  // dispatch_attempts is deliberately NOT reset here: a structure edit is no
  // evidence the enrollment is healthy — only a successful finalize clears
  // the reaper's budget, otherwise repeated edits would let a genuinely
  // stuck row churn forever instead of exiting 'failed'.
  let recomputed = 0
  const wantsRecompute = scheduleChanged || delayChangedIds.size > 0 || finalSteps !== null
  if (wantsRecompute && activeEnrollments.length > 0) {
    if (finalSteps === null) {
      const { data, error } = await supabase
        .from('sequence_step')
        .select('id, step_order, delay_days, is_active')
        .eq('sequence_id', sequenceId)
      if (error) return fail(error.message)
      finalSteps = ((data ?? []) as Array<{
        id: string
        step_order: number
        delay_days: number
        is_active: boolean
      }>).map((s) => ({ ...s, isNew: false }))
    }

    // Fresh read (defense 1 above) — never reuse the pre-write snapshot to
    // pick each enrollment's next step.
    const { data: freshRows, error: freshError } = await supabase
      .from('sequence_enrollment')
      .select('id, current_step_order, next_send_at')
      .eq('workspace_id', workspaceId)
      .eq('sequence_id', sequenceId)
      .eq('status', 'active')
    if (freshError) return fail(freshError.message)
    const freshEnrollments = (freshRows ?? []) as typeof activeEnrollments

    const pending = freshEnrollments.filter((e) => e.next_send_at !== null)
    const affected = pending.filter((e) => {
      const next = selectNextActiveStep(finalSteps!, e.current_step_order)
      if (!next) return false // nothing left to send — the claim exits 'completed'
      return scheduleChanged || next.isNew || (next.id !== null && delayChangedIds.has(next.id))
    })

    if (affected.length > 0) {
      // Delay counts from the latest ACTUAL send. Enrollments with no sent
      // ledger rows (e.g. armed step-1 rows) keep their next_send_at — there
      // is no send to count from, and step 1's timing was set at launch.
      const { data: sentRows, error: sentError } = await supabase
        .from('sequence_send')
        .select('enrollment_id, sent_at')
        .eq('workspace_id', workspaceId)
        .in('enrollment_id', affected.map((e) => e.id))
        .eq('status', 'sent')
      if (sentError) return fail(sentError.message)
      const lastSentAt = new Map<string, string>()
      for (const row of sentRows ?? []) {
        const id = row.enrollment_id as string
        const sentAt = row.sent_at as string | null
        if (!sentAt) continue
        const prev = lastSentAt.get(id)
        if (!prev || sentAt > prev) lastSentAt.set(id, sentAt)
      }

      const timezone = (update.timezone as string | undefined) ?? sequence.timezone
      const delayUnit =
        (update.delay_unit as SequenceDelayUnit | undefined) ?? sequence.delay_unit
      const window: SendWindow = normalizeWindow(
        update.send_window !== undefined ? update.send_window : sequence.send_window,
      )

      for (const enrollment of affected) {
        const from = lastSentAt.get(enrollment.id)
        if (!from) continue
        const next = selectNextActiveStep(finalSteps!, enrollment.current_step_order)!
        const nextSendAt = computeEditedNextSendAt({
          from: new Date(from),
          delayDays: next.delay_days,
          delayUnit,
          timezone,
          window,
          jitterMs: randomJitterMs(),
          now: new Date(),
        }).toISOString()
        // CAS on the value read above (defense 2): a concurrent lease-claim /
        // finalize / exit rewrote next_send_at, so this stale write matches 0
        // rows and is dropped. Only rows the CAS actually matched count.
        const { data: matched, error } = await supabase
          .from('sequence_enrollment')
          .update({ next_send_at: nextSendAt })
          .eq('id', enrollment.id)
          .eq('status', 'active')
          .eq('next_send_at', enrollment.next_send_at!)
          .select('id')
        if (error) return fail(error.message)
        recomputed += (matched ?? []).length
      }
    }
  }

  return { ok: true, recomputedEnrollments: recomputed }
}

// ──────────────────────────────────────────────────────────────────
// Resume — reschedule past-due enrollments, never burst
// ──────────────────────────────────────────────────────────────────

export interface ResumableSequence {
  id: string
  delay_unit: 'business' | 'calendar'
  timezone: string
  send_window: unknown
}

/**
 * Resume support: snap every PAST-DUE next_send_at forward through the send
 * window from NOW (the delay was already served while paused) — never fire
 * the accumulated backlog as a burst. Callers flip the sequence's status to
 * 'active' themselves AFTER this succeeds.
 *
 * Returns { error: null } on success; on failure the message is logged here
 * and returned so the caller can produce its surface's error shape.
 */
export async function resumePastDueEnrollments(
  supabase: SupabaseClient,
  sequence: ResumableSequence,
): Promise<{ error: string | null }> {
  const nowIso = new Date().toISOString()
  const { data: stale, error: staleError } = await supabase
    .from('sequence_enrollment')
    .select('id, next_send_at')
    .eq('sequence_id', sequence.id)
    .eq('status', 'active')
    .not('next_send_at', 'is', null)
    .lt('next_send_at', nowIso)
  if (staleError) {
    console.error('[sequences] resume stale scan failed:', staleError.message)
    return { error: staleError.message }
  }
  for (const row of stale ?? []) {
    const next = computeNextSendAt({
      from: new Date(),
      delayDays: 0,
      delayUnit: sequence.delay_unit,
      timezone: sequence.timezone,
      window: normalizeWindow(sequence.send_window),
      jitterMs: randomJitterMs(),
    }).toISOString()
    const { error: rescheduleError } = await supabase
      .from('sequence_enrollment')
      .update({ next_send_at: next, dispatch_attempts: 0 })
      .eq('id', row.id)
      .eq('status', 'active')
    if (rescheduleError) {
      console.error('[sequences] resume reschedule failed:', rescheduleError.message)
      return { error: rescheduleError.message }
    }
  }
  return { error: null }
}

// ──────────────────────────────────────────────────────────────────
// Enroll — stage contacts with per-contact skip reasons
// ──────────────────────────────────────────────────────────────────

export type EnrollSkipReason = 'not_found' | 'no_email' | 'suppressed' | 'already_active'

export interface EnrollSkipEntry {
  contact_id: string
  reason: EnrollSkipReason
}

export type EnrollContactsResult =
  | { ok: true; enrolled: string[]; skipped: EnrollSkipEntry[] }
  | { ok: false; code: 'sequence_not_found' | 'sequence_archived' | 'server_error' }

/**
 * Stage contacts into a sequence. Enrollments are inserted ACTIVE with
 * next_send_at NULL: inert until launch arms the sequence and seeds the
 * schedule. Per-contact guards with skip reasons (callers show exactly why
 * each contact was left out):
 *
 *   not_found      — not in this workspace (or a merge tombstone / not visible
 *                    under the contact's RLS to this caller)
 *   no_email       — no email address to send to
 *   suppressed     — on the workspace outreach_suppression list, or tagged
 *                    as unsubscribed from email where they came from (a Brevo
 *                    import's 'unsubscribed email', src/lib/outreach/opt-out.ts)
 *   already_active — already in an active enrollment ANYWHERE in the workspace
 *                    (both uniques: contact-keyed AND lower(email)-keyed), or
 *                    previously enrolled in THIS sequence (the total pair
 *                    unique — re-enrollment is not a v1 feature)
 */
export async function enrollContacts(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    sequenceId: string
    /** user id recorded as sequence_enrollment.enrolled_by */
    enrolledBy: string
    contactIds: string[]
  },
): Promise<EnrollContactsResult> {
  const { workspaceId, sequenceId, enrolledBy, contactIds } = args

  const { data: sequence, error: sequenceError } = await supabase
    .from('sequence')
    .select('id, status')
    .eq('id', sequenceId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (sequenceError) {
    console.error('[sequences] enroll sequence load failed:', sequenceError.message)
    return { ok: false, code: 'server_error' }
  }
  if (!sequence) return { ok: false, code: 'sequence_not_found' }
  if (sequence.status === 'archived') return { ok: false, code: 'sequence_archived' }

  const uniqueIds = [...new Set(contactIds)]

  // The contact ids are chunked out of one URL ("add all" on a big list
  // overflowed it), and the two workspace-wide sets are paged: a response
  // stops at 1000 rows, and a missed row here is a missed skip.
  const [contactsRes, suppressionRes, activeRes] = await Promise.all([
    inChunks(uniqueIds, 100, (ids) =>
      supabase
        .from('contact')
        .select('id, email, tags')
        .eq('workspace_id', workspaceId)
        .is('merged_into_contact_id', null)
        .in('id', ids),
    ),
    fetchAllRows(() => supabase.from('outreach_suppression').select('email').eq('workspace_id', workspaceId)),
    // Workspace-wide active set — BOTH uniques matter: the contact-keyed one
    // and the lower(email)-keyed one (a contact-less enrollment can hold the
    // same human's email).
    fetchAllRows(() =>
      supabase
        .from('sequence_enrollment')
        .select('contact_id, contact_email, sequence_id')
        .eq('workspace_id', workspaceId)
        .eq('status', 'active'),
    ),
  ])
  if (contactsRes.error || suppressionRes.error || activeRes.error) {
    console.error(
      '[sequences] enroll lookups failed:',
      contactsRes.error?.message ?? suppressionRes.error?.message ?? activeRes.error?.message,
    )
    return { ok: false, code: 'server_error' }
  }

  const contactById = new Map(
    (contactsRes.data ?? []).map((c) => [c.id as string, c as { id: string; email: string | null; tags?: unknown }]),
  )
  const suppressedEmails = new Set(
    (suppressionRes.data ?? []).map((s) => (s.email as string).toLowerCase()),
  )
  const activeContactIds = new Set(
    (activeRes.data ?? []).map((e) => e.contact_id as string | null).filter(Boolean),
  )
  const activeEmails = new Set(
    (activeRes.data ?? []).map((e) => (e.contact_email as string).toLowerCase()),
  )

  const enrolled: string[] = []
  const skipped: EnrollSkipEntry[] = []

  for (const contactId of uniqueIds) {
    const contact = contactById.get(contactId)
    if (!contact) {
      skipped.push({ contact_id: contactId, reason: 'not_found' })
      continue
    }
    const email = contact.email?.trim()
    if (!email) {
      skipped.push({ contact_id: contactId, reason: 'no_email' })
      continue
    }
    const emailLower = email.toLowerCase()
    if (suppressedEmails.has(emailLower) || optedOutByTag(contact.tags, 'email')) {
      skipped.push({ contact_id: contactId, reason: 'suppressed' })
      continue
    }
    if (activeContactIds.has(contactId) || activeEmails.has(emailLower)) {
      skipped.push({ contact_id: contactId, reason: 'already_active' })
      continue
    }

    // Inert until launch: active with next_send_at NULL.
    const { error: insertError } = await supabase.from('sequence_enrollment').insert({
      workspace_id: workspaceId,
      sequence_id: sequenceId,
      contact_id: contactId,
      contact_email: email,
      enrolled_by: enrolledBy,
      status: 'active',
      next_send_at: null,
    })
    if (insertError) {
      // Any of the three uniques (pair, active-per-contact, active-per-email)
      // firing under a race maps to the same user-facing reason.
      if (insertError.code === '23505') {
        skipped.push({ contact_id: contactId, reason: 'already_active' })
        continue
      }
      console.error('[sequences] enroll insert failed:', insertError.message)
      return { ok: false, code: 'server_error' }
    }
    enrolled.push(contactId)
    // Keep the in-memory sets honest for duplicate emails within one batch.
    activeContactIds.add(contactId)
    activeEmails.add(emailLower)
  }

  return { ok: true, enrolled, skipped }
}

/**
 * Resolve a sending account the CALLER owns. Explicit ownership +
 * capability filters — this can run on a service-role client (agent tools),
 * where RLS provides no backstop; it is the same security boundary
 * sendEmail's account_id pinning enforces.
 */
export async function resolveOwnedEmailAccount(
  supabase: SupabaseClient,
  args: { accountId: string; userId: string },
): Promise<{ id: string; account_email: string | null } | null> {
  const { data } = await supabase
    .from('connected_account')
    .select('id, account_email')
    .eq('id', args.accountId)
    .eq('user_id', args.userId)
    .eq('capability', 'email')
    .eq('is_enabled', true)
    .maybeSingle()
  return (data as { id: string; account_email: string | null } | null) ?? null
}

/**
 * The caller's default sending account: primary preferred, else the first
 * enabled email account. Null when none are connected — creation proceeds
 * (the builder and launch both surface the missing-mailbox state).
 */
export async function defaultOwnedEmailAccount(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ id: string; account_email: string | null } | null> {
  const { data } = await supabase
    .from('connected_account')
    .select('id, account_email')
    .eq('user_id', userId)
    .eq('capability', 'email')
    .eq('is_enabled', true)
    .order('is_primary', { ascending: false })
    .limit(1)
  return (data?.[0] as { id: string; account_email: string | null } | undefined) ?? null
}
