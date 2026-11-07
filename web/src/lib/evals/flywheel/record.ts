/**
 * The ONE writer of `eval_candidate` rows (the evals flywheel's capture,
 * ./types.ts; migrations 349, 442). The feedback route, the sweep, the send
 * path and the discard path all record through `recordEvalCandidate`.
 *
 * Rules it enforces so no writer gets them wrong:
 *   - ONE ROW PER SIGNAL: keyed on (workspace_id, user_id, dedupe_key), the
 *     table's unique index. A second record of the same key updates the row in
 *     place (a rating changed), or, with `onExisting: 'skip'`, leaves it (the
 *     sweep's overlapping windows see the same turn twice).
 *   - A REVIEWED ROW IS NEVER OVERWRITTEN: only a row still `new` is updated,
 *     and the update is fenced on `status = 'new'`, so a reviewer's promote
 *     between the read and the write wins. A reviewed row answers 'locked';
 *     the feedback route turns that into its 409.
 *   - CLIPPED, NEVER REFUSED FOR SIZE: every text is cut to FLYWHEEL_LIMITS and
 *     the evidence is trimmed (steps first, then texts) until it fits the
 *     table's 16,000-byte check, measured the way Postgres prints jsonb.
 *   - POLARITY FROM THE SOURCE (polarityOf): a writer never picks it.
 *   - NEVER THROWS: a lost candidate is a missed test case, never a failed
 *     turn, send or sweep. The outcome says what happened, and a failure
 *     logs one line (the source and the database's message, never content).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { jsonbTextBytes, sliceEnd, sliceStart } from './bytes'
import {
  FLYWHEEL_LIMITS,
  isDraftDismissReason,
  isNudgeReason,
  polarityOf,
  type ChatTurnEvidence,
  type DraftDismissedEvidence,
  type DraftRewriteEvidence,
  type EvalCandidateEvidence,
  type EvalCandidateSource,
  type LoopRunEvidence,
  type TurnToolStep,
} from './types'

export type RecordOutcome = 'inserted' | 'updated' | 'skipped' | 'locked' | 'failed'

export interface RecordEvalCandidateInput {
  workspaceId: string
  userId: string
  source: EvalCandidateSource
  /** One of evalCandidateKey's keys. */
  dedupeKey: string
  evidence: EvalCandidateEvidence
  refType?: string | null
  refId?: string | null
  conversationId?: string | null
  skillSlugs?: readonly string[]
  tools?: readonly string[]
  /**
   * The person's words (a rating's reason). On an update, `undefined` keeps
   * the row's reason and `null` clears it.
   */
  reason?: string | null
  /** What a second record of the key does to a row still `new`: update it (default), or leave it ('skipped'). */
  onExisting?: 'update' | 'skip'
}

/** The table's other limits (migration 349's checks). */
const REF_TYPE_MAX = 40
const REF_ID_MAX = 300
const DEDUPE_KEY_MAX = 300
const STEP_NAME_MAX = 120
const LIST_ITEM_MAX = 120
const FLOW_ERRORS_MAX = 10

// ── Pure clipping helpers ────────────────────────────────────────────────────

/**
 * `value` trimmed and cut to `max` characters (an ellipsis marks a cut). Empty
 * for anything but a string. A cut never splits a surrogate pair (./bytes).
 */
export function clipText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length <= max) return text
  return max <= 1 ? sliceStart(text, max) : `${sliceStart(text, max - 1)}…`
}

/** The END of `value`, cut to `max` characters (a log's tail is where it failed). Never splits a surrogate pair. */
export function clipTail(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length <= max) return text
  return max <= 1 ? sliceEnd(text, max) : `…${sliceEnd(text, max - 1)}`
}

/** A string list: non-empty strings, each clipped, first occurrence kept, at most `max`. */
export function clipList(list: readonly unknown[] | null | undefined, max: number, itemMax = LIST_ITEM_MAX): string[] {
  const out: string[] = []
  for (const item of list ?? []) {
    const text = clipText(item, itemMax)
    if (!text || out.includes(text)) continue
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

/** A string or nothing: clipped, and left out when empty. */
function optional(value: unknown, max: number): string | undefined {
  const text = clipText(value, max)
  return text ? text : undefined
}

/** A JSON value as JSON text, clipped (a step's input). Undefined when there is nothing to keep. */
export function clipJson(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return undefined
  }
  if (typeof text !== 'string' || !text || text === '{}') return undefined
  return clipText(text, max)
}

function clipStep(step: TurnToolStep): TurnToolStep {
  const out: TurnToolStep = { name: clipText(step.name, STEP_NAME_MAX) || 'tool', ok: step.ok === true }
  const input = optional(step.input, FLYWHEEL_LIMITS.stepInput)
  if (input) out.input = input
  const code = optional(step.code, 60)
  if (code) out.code = code
  const error = optional(step.error, FLYWHEEL_LIMITS.stepError)
  if (error) out.error = error
  return out
}

/** Every field of one evidence object cut to FLYWHEEL_LIMITS (no byte budget yet: see clipEvidence). */
export function clipEvidenceFields(evidence: EvalCandidateEvidence): EvalCandidateEvidence {
  switch (evidence.kind) {
    case 'chat_turn': {
      const out: ChatTurnEvidence = {
        kind: 'chat_turn',
        request: clipText(evidence.request, FLYWHEEL_LIMITS.request),
        steps: (evidence.steps ?? []).slice(0, FLYWHEEL_LIMITS.steps).map(clipStep),
        loads: clipList(evidence.loads, FLYWHEEL_LIMITS.skillSlugs),
        messageId: clipText(evidence.messageId, REF_ID_MAX),
      }
      const reply = optional(evidence.reply, FLYWHEEL_LIMITS.reply)
      if (reply) out.reply = reply
      const at = optional(evidence.at, 40)
      if (at) out.at = at
      // A nudge's pointers (ids and a timestamp, never meeting text).
      const nudgeKind = optional(evidence.nudge_kind, 40)
      if (nudgeKind) out.nudge_kind = nudgeKind
      const captureId = optional(evidence.capture_id, 60)
      if (captureId) out.capture_id = captureId
      const nudgeAt = optional(evidence.nudge_at, 40)
      if (nudgeAt) out.nudge_at = nudgeAt
      const goalId = optional(evidence.meeting_goal_id, 60)
      if (goalId) out.meeting_goal_id = goalId
      if (isNudgeReason(evidence.nudge_reason)) out.nudge_reason = evidence.nudge_reason
      return out
    }
    case 'loop_run': {
      const out: LoopRunEvidence = { kind: 'loop_run', jobKind: clipText(evidence.jobKind, 60) || 'job' }
      const title = optional(evidence.title, FLYWHEEL_LIMITS.title)
      if (title) out.title = title
      const error = optional(evidence.error, FLYWHEEL_LIMITS.error)
      if (error) out.error = error
      const flowErrors = (evidence.flowErrors ?? [])
        .slice(0, FLOW_ERRORS_MAX)
        .map((e) => ({ action: clipText(e.action, 80) || 'action', error: clipText(e.error, FLYWHEEL_LIMITS.stepError) }))
        .filter((e) => e.error)
      if (flowErrors.length) out.flowErrors = flowErrors
      const logTail = clipTail(evidence.logTail, FLYWHEEL_LIMITS.logTail)
      if (logTail) out.logTail = logTail
      for (const key of ['flowId', 'flowRunId', 'agentRunId', 'captureId', 'skill', 'at'] as const) {
        const value = optional(evidence[key], key === 'skill' ? LIST_ITEM_MAX : 80)
        if (value) out[key] = value
      }
      return out
    }
    case 'draft_rewrite': {
      // A score and pointers only: whatever else a caller passed is dropped here.
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      const out: DraftRewriteEvidence = {
        kind: 'draft_rewrite',
        similarity: Math.min(1, Math.max(0, num(evidence.similarity))),
        wordsBefore: Math.max(0, Math.round(num(evidence.wordsBefore))),
        wordsAfter: Math.max(0, Math.round(num(evidence.wordsAfter))),
        origin: evidence.origin === 'automatic' || evidence.origin === 'chat' ? evidence.origin : 'unknown',
      }
      for (const key of ['providerThreadId', 'accountId', 'contactId', 'at'] as const) {
        const value = optional(evidence[key], 300)
        if (value) out[key] = value
      }
      return out
    }
    case 'draft_dismissed': {
      // The reason and pointers only: whatever else a caller passed is dropped here.
      const out: DraftDismissedEvidence = {
        kind: 'draft_dismissed',
        reason: isDraftDismissReason(evidence.reason) ? evidence.reason : 'other',
        origin: evidence.origin === 'automatic' || evidence.origin === 'chat' ? evidence.origin : 'unknown',
        by: evidence.by === 'person' ? 'person' : 'agent',
      }
      // A domain, never an address: anything with an @ (or a space) is dropped.
      const domain = optional(evidence.recipientDomain, 253)?.toLowerCase()
      if (domain && /^[a-z0-9.-]+$/.test(domain)) out.recipientDomain = domain
      for (const key of ['providerThreadId', 'accountId', 'at'] as const) {
        const value = optional(evidence[key], 300)
        if (value) out[key] = value
      }
      return out
    }
  }
}

/** Halve a text (keeping its opening), with the ellipsis clipText adds. */
function halve(text: string | undefined): string | undefined {
  if (!text) return text
  return text.length <= 40 ? undefined : clipText(text, Math.floor(text.length / 2))
}

/**
 * Evidence clipped to FLYWHEEL_LIMITS and trimmed to the byte budget, never
 * refused: a chat turn drops its later successful steps first, then any later
 * step, then step inputs, then halves its reply and request; a loop run halves
 * its log tail, drops flow errors, then halves its error. Whatever is left
 * always fits (the kind and the pointers are small).
 */
export function clipEvidence(evidence: EvalCandidateEvidence, maxBytes: number = FLYWHEEL_LIMITS.evidenceBytes): EvalCandidateEvidence {
  const out = clipEvidenceFields(evidence)
  const fits = () => jsonbTextBytes(out) <= maxBytes
  if (fits()) return out
  if (out.kind === 'chat_turn') {
    // Later successful steps say least: drop them first (the failures are the case).
    for (let i = out.steps.length - 1; i >= 0 && !fits(); i--) {
      if (out.steps[i].ok && out.steps.length > 1) out.steps.splice(i, 1)
    }
    while (!fits() && out.steps.length > 1) out.steps.pop()
    for (const step of out.steps) if (!fits()) delete step.input
    for (let round = 0; round < 12 && !fits(); round++) {
      out.reply = halve(out.reply)
      if (!out.reply) delete out.reply
      if (!fits()) out.request = halve(out.request) ?? ''
    }
    if (!fits()) {
      out.steps = out.steps.map((s) => ({ name: s.name, ok: s.ok, ...(s.code ? { code: s.code } : {}) }))
      out.loads = out.loads.slice(0, 5)
    }
    return out
  }
  if (out.kind === 'loop_run') {
    for (let round = 0; round < 12 && !fits() && out.logTail; round++) {
      out.logTail = out.logTail.length <= 40 ? undefined : clipTail(out.logTail, Math.floor(out.logTail.length / 2))
      if (!out.logTail) delete out.logTail
    }
    while (!fits() && out.flowErrors?.length) {
      out.flowErrors.pop()
      if (!out.flowErrors.length) delete out.flowErrors
    }
    for (let round = 0; round < 12 && !fits(); round++) {
      out.error = halve(out.error)
      if (!out.error) delete out.error
      out.title = halve(out.title)
      if (!out.title) delete out.title
    }
  }
  return out
}

// ── The writer ───────────────────────────────────────────────────────────────

/** The row's columns from an input (clipped), minus the identity. */
function rowFields(input: RecordEvalCandidateInput) {
  const fields: Record<string, unknown> = {
    source: input.source,
    polarity: polarityOf(input.source),
    ref_type: input.refType ? clipText(input.refType, REF_TYPE_MAX) || null : null,
    ref_id: input.refId ? clipText(input.refId, REF_ID_MAX) || null : null,
    conversation_id: input.conversationId ?? null,
    skill_slugs: clipList(input.skillSlugs, FLYWHEEL_LIMITS.skillSlugs),
    tools: clipList(input.tools, FLYWHEEL_LIMITS.tools),
    evidence: clipEvidence(input.evidence),
  }
  if (input.reason !== undefined) fields.reason = input.reason === null ? null : clipText(input.reason, FLYWHEEL_LIMITS.reason) || null
  return fields
}

function logFailure(input: RecordEvalCandidateInput, what: string, message: unknown): void {
  const text = message instanceof Error ? message.message : typeof message === 'string' ? message : 'unknown error'
  console.error(`[eval-flywheel] ${input.source} candidate ${what} failed: ${text}`)
}

type Existing = { id: string; status: string }

async function readExisting(supabase: SupabaseClient, input: RecordEvalCandidateInput, dedupeKey: string): Promise<Existing | null | 'error'> {
  const { data, error } = await supabase
    .from('eval_candidate')
    .select('id, status')
    .eq('workspace_id', input.workspaceId)
    .eq('user_id', input.userId)
    .eq('dedupe_key', dedupeKey)
    .maybeSingle()
  if (error) {
    logFailure(input, 'read', error.message)
    return 'error'
  }
  return (data as Existing | null) ?? null
}

/** Apply the rules to a row that already holds the key. */
async function onExistingRow(supabase: SupabaseClient, input: RecordEvalCandidateInput, existing: Existing): Promise<RecordOutcome> {
  if (existing.status !== 'new') return 'locked'
  if (input.onExisting === 'skip') return 'skipped'
  const { data, error } = await supabase
    .from('eval_candidate')
    .update({ ...rowFields(input), updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .eq('status', 'new')
    .select('id')
  if (error) {
    logFailure(input, 'update', error.message)
    return 'failed'
  }
  // Fenced on 'new': no row back means a reviewer took it between the read and the write.
  return Array.isArray(data) && data.length > 0 ? 'updated' : 'locked'
}

/** Record one candidate (see the module header). Never throws. */
export async function recordEvalCandidate(supabase: SupabaseClient, input: RecordEvalCandidateInput): Promise<RecordOutcome> {
  try {
    const dedupeKey = clipText(input.dedupeKey, DEDUPE_KEY_MAX)
    if (!input.workspaceId || !input.userId || !dedupeKey) return 'failed'
    const existing = await readExisting(supabase, input, dedupeKey)
    if (existing === 'error') return 'failed'
    if (existing) return await onExistingRow(supabase, input, existing)

    const { error } = await supabase.from('eval_candidate').insert({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      dedupe_key: dedupeKey,
      status: 'new',
      reason: null,
      ...rowFields(input),
    })
    if (!error) return 'inserted'
    if (error.code !== '23505') {
      logFailure(input, 'insert', error.message)
      return 'failed'
    }
    // Another writer inserted the key first: the rules apply to its row.
    const raced = await readExisting(supabase, input, dedupeKey)
    if (raced === 'error' || !raced) return 'failed'
    return await onExistingRow(supabase, input, raced)
  } catch (err) {
    logFailure(input, 'record', err)
    return 'failed'
  }
}
