/**
 * The auto-attempt gate (Sequence step 3, B PR 3; docs/plans/agent-orchestration-
 * followup.md §B.1–B.3): should a triage verdict's `work_proposal` START a work
 * run on its own, instead of becoming a card with a Start button?
 *
 * It is a CALLER of existing gates, not a new authority: the autonomy policy
 * (agent-autonomy-policy.ts), the closed role / expects sets (roles.ts), the
 * trust floor the verdict already resolved, the plan meter
 * (`check_ai_usage_limit`) and the start body a person's click runs
 * (start-work-item.ts). An attempt never applies a board mutation: the run it
 * starts gets the drafting ceiling (ceilingForWorkRun) and its output lands in
 * review like any other.
 *
 * ON BY DEFAULT (Liam, 2026-10-17: opinionated platform, no configuration
 * fatigue): agents make the first pass on drafting work unless a switch says
 * otherwise. Two switches can stop it, both checked before any other read:
 * the deployment's env kill switch `AGENT_AUTO_ATTEMPT_ENABLED` (exactly
 * 'false' turns attempts off everywhere; unset means on) and the workspace's
 * own kill switch, `settings.agent_autonomy.mode` (default 'attempt'; 'off'
 * from Settings → Autonomy stops it, and a malformed policy fails closed to
 * 'propose', which also refuses). The role teammates an attempt needs are
 * created on first need (ensureRoleTeammates, role-routing.ts), so a new
 * workspace attempts without anyone visiting a settings page.
 *
 * Conditions, evaluated in order; the first failure refuses and the verdict
 * cards the item exactly as today:
 *   env switch → workspace mode → the verdict ran in act mode → a draftable
 *   shape (an attemptable role, `expects` present and all draftable, no board
 *   hint) → an idempotency key → [an existing run for the key is REUSED here,
 *   before any budget, so a retry never falls back to a second card] → the
 *   verdict is a first-hop run (fire depth 1) → confidence ≥ the attempt bar
 *   (the policy's attempt_min_confidence, else the verdict's trust floor) →
 *   a teammate for the role with autonomy 'attempt' that may draft → grounded
 *   provenance: a quote (the proposal's trigger quote, or one in the item's
 *   `why`) found verbatim in the transcript of a workspace-visible capture
 *   (speaker labels aside; an elided quote's pieces in order) →
 *   per-capture and per-day budgets → the role's circuit breaker → the plan
 *   meter (fail closed).
 *
 * An attempt files NO board action: the run anchors to its source capture
 * (start-work-item.ts `trackedAction: false`).
 *
 * Budgets are SOFT under concurrency: two verdict runs deciding at the same
 * moment can each see the last free slot. The per-workspace flow concurrency
 * keeps that rare; the numbers are a cost bound, not a security boundary.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveAgentAutonomyPolicy, type AgentAutonomyPolicy } from './agent-autonomy-policy'
import { ATTEMPTABLE_WORK_ROLES, isWorkRole, normalizeWorkExpects, type WorkRole } from './roles'
import { roleBreakerState } from './role-breaker'
import { ensureRoleTeammates, resolveRoleTeammate } from './role-routing'
import { launchWorkItem, planWorkItem, type WorkRunDispatchSend } from './start-work-item'
import type { WorkResourceRef } from '@/lib/agent-run/types'
import { attemptCodingProposal, type ProactiveCodingRefusal } from '@/lib/coding/proactive'
import {
  MIN_QUOTE_PIECE_CHARS,
  locateQuote,
  matchPiecesInOrder,
  normalizeForQuote,
  quotePieces,
  quotedSpans,
  transcriptForQuote,
} from '@/lib/transcript/quote-match'

// The quote matcher lives in src/lib/transcript/quote-match.ts; its names stay
// importable from here.
export { MIN_QUOTE_PIECE_CHARS, locateQuote, matchPiecesInOrder, normalizeForQuote, quotePieces, quotedSpans, transcriptForQuote }

/**
 * The env kill switch above every workspace setting. Attempts are on unless it
 * is exactly 'false': the switch exists to stop a deployment in an incident,
 * not to opt in.
 */
export const AUTO_ATTEMPT_ENV = 'AGENT_AUTO_ATTEMPT_ENABLED'

export function autoAttemptEnvEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[AUTO_ATTEMPT_ENV] !== 'false'
}

/**
 * Roles an attempt can serve. A work run (kind 'workspace') drafts documents and
 * email drafts; a developer's PR needs a coding run with a repo and a sandbox,
 * which this gate does not start (B.1's rejected candidate: that precondition
 * lives with the Developer role, not here).
 */
export const ATTEMPTABLE_ROLES: readonly WorkRole[] = ATTEMPTABLE_WORK_ROLES
/** Artifacts the drafting ceiling can produce. `action` is a board write, `entity` a CRM row or a PR. */
export const DRAFTABLE_EXPECT_TYPES: readonly string[] = ['document', 'email_draft']
/** `deliverable_hint` values compatible with drafting (absent is fine too). */
const DRAFTABLE_HINTS: ReadonlySet<string> = new Set(['document', 'email_draft'])
/** A transcript quote shorter than this proves nothing (a name, "ok", "sure"). */
export const MIN_GROUNDING_QUOTE_CHARS = 16

export type AutoAttemptRefusal =
  | 'env_off'
  | 'mode_not_attempt'
  | 'report_mode'
  | 'no_role'
  | 'role_not_attemptable'
  | 'no_expects'
  | 'expects_not_draftable'
  | 'hint_not_draftable'
  | 'no_idempotency_key'
  | 'no_flow'
  | 'fire_depth'
  | 'below_confidence'
  | 'no_teammate'
  | 'teammate_not_attempt'
  | 'teammate_cannot_draft'
  | 'ungrounded'
  | 'private_capture'
  | 'capture_budget'
  | 'day_budget'
  | 'breaker_open'
  | 'usage_limit'
  | 'usage_check_failed'
  | 'read_failed'

/** The work_proposal candidate the verdict walk built (already clamped). */
export interface AttemptCandidate {
  proposalId: string | null
  /** The id the card WOULD have had (verdict-apply's deterministic card id), for a proposal-less item. */
  cardId: string | null
  title: string
  why: string
  payload: Record<string, unknown>
  confidence: number
}

export interface AutoAttemptContext {
  /** Service-role client (the verdict walk's). */
  supabase: SupabaseClient
  workspaceId: string
  /** The verdict's run-as user: the attempted run's `triggered_by`, whose plan pays. */
  userId: string
  /** The verdict's mode; only 'act' may attempt. */
  mode: 'report' | 'act'
  /** The verdict run's own loop-guard depth (1 for a capture or schedule fire). */
  fireDepth: number
  /** The fire's triggering capture, when it had one. */
  captureId: string | null
  /**
   * The flow the verdict ran for. An attempted run files no board action, so it
   * records this flow as its origin (the agent_run_has_origin CHECK requires an
   * action or a flow); no flow, no attempt.
   */
  flowId?: string | null
  /** The verdict's resolved trust floor (min_confidence). */
  minConfidence: number
  policy: AgentAutonomyPolicy
  env?: Record<string, string | undefined>
  now?: Date
}

export interface AttemptTeammate {
  id: string
  role: WorkRole
}

export type AutoAttemptDecision =
  | {
      attempt: true
      reused: false
      fireKey: string
      teammate: AttemptTeammate
      /** The capture the attempt came from (its per-capture budget key and first resource). */
      captureId: string
      /** The transcript quote that grounded it (the brief's source quote). */
      quote: string
    }
  | { attempt: true; reused: true; fireKey: string; agentRunId: string }
  | { attempt: false; reason: AutoAttemptRefusal; detail?: string }

const refuse = (reason: AutoAttemptRefusal, detail?: string): AutoAttemptDecision => ({
  attempt: false,
  reason,
  ...(detail ? { detail } : {}),
})

/** The fire_key of an attempt: one per proposal, or per would-be card for a proposal-less item. */
export function attemptFireKey(candidate: Pick<AttemptCandidate, 'proposalId' | 'cardId'>): string | null {
  const anchor = candidate.proposalId ?? candidate.cardId
  return anchor ? `attempt:${anchor}` : null
}

/** Decide one candidate. Never throws: a failed read refuses ('read_failed'). */
export async function decideAutoAttempt(
  candidate: AttemptCandidate,
  ctx: AutoAttemptContext,
): Promise<AutoAttemptDecision> {
  try {
    return await decide(candidate, ctx)
  } catch (err) {
    return refuse('read_failed', err instanceof Error ? err.message : String(err))
  }
}

async function decide(candidate: AttemptCandidate, ctx: AutoAttemptContext): Promise<AutoAttemptDecision> {
  const { supabase, workspaceId, policy } = ctx

  // 0–1. The two switches. Nothing is read when either is off.
  if (!autoAttemptEnvEnabled(ctx.env)) return refuse('env_off')
  if (policy.mode !== 'attempt') return refuse('mode_not_attempt')
  if (ctx.mode !== 'act') return refuse('report_mode')

  // 2. A draftable shape: the item names WHO and WHAT, and both fit drafting.
  const payload = candidate.payload ?? {}
  const role = payload.role
  if (!isWorkRole(role)) return refuse('no_role')
  if (!ATTEMPTABLE_ROLES.includes(role)) return refuse('role_not_attemptable', role)
  const expects = normalizeWorkExpects(payload.expects)
  if (!expects) return refuse('no_expects')
  const undraftable = expects.find((e) => !DRAFTABLE_EXPECT_TYPES.includes(e.type))
  if (undraftable) return refuse('expects_not_draftable', undraftable.type)
  const hint = payload.deliverable_hint
  if (hint !== undefined && !(typeof hint === 'string' && DRAFTABLE_HINTS.has(hint))) {
    return refuse('hint_not_draftable', String(hint))
  }

  // 3. The idempotency key. No key, no attempt: a retry could not find its run.
  const fireKey = attemptFireKey(candidate)
  if (!fireKey) return refuse('no_idempotency_key')

  // 4. Already attempted (a retried verdict step, a re-fire of the same
  //    proposal): the existing run IS this decision — checked before depth,
  //    budgets and breaker, which that run itself now counts against.
  const { data: existing, error: existingErr } = await supabase
    .from('agent_run')
    .select('id')
    .eq('fire_key', fireKey)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (existingErr) return refuse('read_failed', existingErr.message)
  if (existing?.id) return { attempt: true, reused: true, fireKey, agentRunId: existing.id as string }

  // 4b. The run's recorded origin: the verdict's flow (it files no board action).
  if (!ctx.flowId) return refuse('no_flow')

  // 5. Only a first-hop verdict attempts (a capture or schedule fire → the
  //    verdict at depth 1). A verdict a status change fired is already an
  //    automated hop deeper; its items stay cards. This also makes the
  //    attempted run's loop-guard depth (2) exact.
  if (ctx.fireDepth !== 1) return refuse('fire_depth', String(ctx.fireDepth))

  // 6. The model's own bar: the workspace's attempt bar, else the verdict's trust floor.
  const bar = policy.attempt_min_confidence ?? ctx.minConfidence
  if (!(candidate.confidence >= bar)) {
    return refuse('below_confidence', `${candidate.confidence} < ${bar}`)
  }

  // 7. The role's teammate that may work unattended: autonomy `attempt` and
  //    allowed to draft. The role routing (role-routing.ts) picks the role's
  //    default; a person's Start routes through the same resolver. A workspace
  //    that has never had role teammates gets them here, on first need, and the
  //    role is routed again (ensureRoleTeammates says why only then).
  let routed = await resolveRoleTeammate(supabase, { workspaceId, role, purpose: 'attempt' })
  if (!('error' in routed) && !routed.teammate && routed.reason === 'no_teammate') {
    const ensured = await ensureRoleTeammates(supabase, { workspaceId, createdBy: ctx.userId })
    if ('error' in ensured) return refuse('read_failed', ensured.error)
    if (ensured.seeded > 0) routed = await resolveRoleTeammate(supabase, { workspaceId, role, purpose: 'attempt' })
  }
  if ('error' in routed) return refuse('read_failed', routed.error)
  const roster = routed.roster
  if (!routed.teammate) return refuse(routed.reason === 'teammate_off' ? 'teammate_not_attempt' : routed.reason, role)
  const teammate = routed.teammate

  // 8. Grounded provenance, on a capture the whole workspace may see.
  const grounded = await groundedCapture(candidate, ctx)
  if ('refusal' in grounded) return grounded.refusal
  const captureId = grounded.captureId
  const quote = grounded.quote

  // 9. Budgets. A zero budget means "never".
  const perCapture = await supabase
    .from('agent_run')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('origin', 'attempt')
    // Coding runs (proactive drafts, CI fixes) keep their own cap (P10, Q2).
    .neq('kind', 'coding')
    .contains('resources', JSON.stringify([{ type: 'capture', id: captureId }]))
  if (perCapture.error) return refuse('read_failed', perCapture.error.message)
  if ((perCapture.count ?? 0) >= policy.max_attempts_per_capture) {
    return refuse('capture_budget', `${perCapture.count ?? 0}/${policy.max_attempts_per_capture}`)
  }
  const now = ctx.now ?? new Date()
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  const perDay = await supabase
    .from('agent_run')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('origin', 'attempt')
    .neq('kind', 'coding')
    .gte('created_at', utcMidnight)
  if (perDay.error) return refuse('read_failed', perDay.error.message)
  if ((perDay.count ?? 0) >= policy.max_attempts_per_day) {
    return refuse('day_budget', `${perDay.count ?? 0}/${policy.max_attempts_per_day}`)
  }

  // 10. The role's circuit breaker (role-breaker.ts): its last N attempted
  //     items were all dismissed. The Agents page's roster reads the same state.
  const breaker = await roleBreakerState(supabase, {
    workspaceId,
    role,
    teammateIds: roster.map((m) => m.id),
    policy,
    now,
  })
  if ('error' in breaker) return refuse('read_failed', breaker.error)
  if (breaker.open) return refuse('breaker_open', `last ${breaker.window} ${role} attempts dismissed`)

  // 11. The plan meter — the same RPC a skill run checks. FAIL CLOSED: an
  //     unattended run never spends on a plan it could not read. Opted in to
  //     the ChatGPT free tier: an attempt is a work run, and a work run for a
  //     person on their own ChatGPT plan runs on it (run-work-spec-rebuild.ts).
  const { data: limit, error: limitErr } = await supabase.rpc('check_ai_usage_limit', { p_user_id: ctx.userId, p_chatgpt_plan: true })
  if (limitErr) return refuse('usage_check_failed', limitErr.message)
  const row = Array.isArray(limit) ? (limit[0] as { allowed?: boolean; reason?: string } | undefined) : undefined
  if (!row) return refuse('usage_check_failed', 'no limit row')
  if (row.allowed !== true) return refuse('usage_limit', row.reason ?? 'plan limit')

  return { attempt: true, reused: false, fireKey, teammate: { id: teammate.id, role }, captureId, quote }
}

/**
 * B.1 row 3, as decided for step 3: TRANSCRIPT-QUOTE grounding only. An item
 * attempts when a quote of at least MIN_GROUNDING_QUOTE_CHARS appears verbatim
 * (normalised) in its capture's transcript: the proposal's trigger quote for a
 * proposal-backed item (which must exist in this workspace and not be
 * dismissed), or a quoted span in the item's `why`, for either kind. The
 * transcript's speaker labels are not speech, so a quote that runs across a
 * change of speaker still matches; a quote the writer elided ("...", "…")
 * matches when its pieces appear in that order (quotePieces, matchPiecesInOrder).
 * A paraphrase does not match: there is no fuzzy matching. No
 * `is_mine_explicit` signal is read (a needs_user item carries none; revisit
 * after plan row 8). The capture must be workspace-visible: an unattended run
 * writes into workspace-readable tables and never reads a private capture.
 */
async function groundedCapture(
  candidate: AttemptCandidate,
  ctx: AutoAttemptContext,
): Promise<{ captureId: string; quote: string } | { refusal: AutoAttemptDecision }> {
  const { supabase, workspaceId } = ctx
  let captureId: string | null = null
  const candidateQuotes = quotedSpans(candidate.why)
  if (candidate.proposalId) {
    const { data: proposal, error } = await supabase
      .from('proposed_change')
      .select('id, capture_id, trigger_quote, status')
      .eq('id', candidate.proposalId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error) return { refusal: refuse('read_failed', error.message) }
    if (!proposal) return { refusal: refuse('ungrounded', 'proposal not found') }
    if (proposal.status === 'dismissed') return { refusal: refuse('ungrounded', 'proposal dismissed') }
    if (typeof proposal.trigger_quote === 'string' && proposal.trigger_quote.trim()) {
      candidateQuotes.unshift(proposal.trigger_quote)
    }
    captureId = (proposal.capture_id as string | null) ?? null
    if (!captureId) return { refusal: refuse('ungrounded', 'proposal has no capture') }
  } else {
    captureId = ctx.captureId
    if (!captureId) return { refusal: refuse('ungrounded', 'no capture on this fire') }
  }

  const { data: capture, error: capErr } = await supabase
    .from('captures')
    .select('id, visibility, transcript')
    .eq('id', captureId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (capErr) return { refusal: refuse('read_failed', capErr.message) }
  if (!capture) return { refusal: refuse('ungrounded', 'capture not found') }
  if (capture.visibility !== 'workspace') return { refusal: refuse('private_capture') }

  const transcript = transcriptForQuote(typeof capture.transcript === 'string' ? capture.transcript : '')
  const quotes = candidateQuotes
    .map((raw) => ({ raw: raw.trim(), pieces: quotePieces(raw) }))
    .filter((q) => q.pieces.reduce((n, piece) => n + piece.length, 0) >= MIN_GROUNDING_QUOTE_CHARS)
  if (quotes.length === 0) return { refusal: refuse('ungrounded', 'no transcript quote') }
  // The quote that grounded it rides to the run's brief (B PR 4).
  const found = transcript ? quotes.find((q) => matchPiecesInOrder(transcript, q.pieces)) : undefined
  if (!found) return { refusal: refuse('ungrounded', 'quote not found in the transcript') }
  return { captureId, quote: found.raw }
}

// ── From a decision to a started run ─────────────────────────────────────────

/** What the verdict walk records for one work_proposal the gate looked at. */
export type AttemptOutcome =
  | { attempted: true; reused: boolean; agentRunId: string; fireKey: string; teammateId: string | null }
  | { attempted: false; reason: AutoAttemptRefusal | ProactiveCodingRefusal | 'no_default_state' | 'launch_failed'; detail?: string }

export type WorkProposalAttempter = (candidate: AttemptCandidate) => Promise<AttemptOutcome>

export interface AttempterContext extends Omit<AutoAttemptContext, 'policy'> {
  /** The verdict's run-as member (the proposal's applied_by). */
  memberId: string
  /** The triggering capture's title, for the run's source-capture resource label. */
  captureTitle?: string | null
}

/**
 * Decide, and on a pass START the work through the same body a person's Start
 * runs (start-work-item.ts), minus the board action: the run anchors to its
 * source capture (first among its resources — the run can read it, and the
 * per-capture budget counts by it — and the ledger row's source), with
 * `origin: 'attempt'`, the teammate, and the fire_key.
 */
export async function attemptWorkProposal(
  candidate: AttemptCandidate,
  ctx: AutoAttemptContext & Pick<AttempterContext, 'memberId' | 'captureTitle'>,
  deps: { send?: WorkRunDispatchSend } = {},
): Promise<AttemptOutcome> {
  // A developer's proposal is code: the proactive draft-PR path (P10 F4,
  // src/lib/coding/proactive.ts), which is off unless the workspace switched
  // on its recipe. Off, it refuses and the item is carded as before.
  if (candidate.payload?.role === 'developer') {
    return attemptCodingProposal(candidate, ctx, { ground: (c, x) => groundedCapture(c, x) })
  }
  const decision = await decideAutoAttempt(candidate, ctx)
  if (!decision.attempt) return { attempted: false, reason: decision.reason, ...(decision.detail ? { detail: decision.detail } : {}) }
  if (decision.reused) {
    return { attempted: true, reused: true, agentRunId: decision.agentRunId, fireKey: decision.fireKey, teammateId: null }
  }

  const task = typeof candidate.payload.task === 'string' ? candidate.payload.task : ''
  const declared = Array.isArray(candidate.payload.resources) ? (candidate.payload.resources as WorkResourceRef[]) : []
  const source: WorkResourceRef = {
    type: 'capture',
    id: decision.captureId,
    label: (ctx.captureTitle && ctx.captureTitle.trim()) || 'Source capture',
  }
  const resources = [source, ...declared.filter((r) => !(r?.type === 'capture' && r?.id === decision.captureId))]

  const plan = await planWorkItem(ctx.supabase, { workspaceId: ctx.workspaceId, resources })
  if (!plan) return { attempted: false, reason: 'no_default_state' }
  const launched = await launchWorkItem(
    ctx.supabase,
    ctx.supabase,
    {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      memberId: ctx.memberId,
      title: candidate.title.trim() || task.slice(0, 200),
      task,
      plan,
      proposalId: candidate.proposalId,
      ledgerTitle: candidate.title,
      fireKey: decision.fireKey,
      origin: 'attempt',
      aiTeamMemberId: decision.teammate.id,
      trackedAction: false,
      sourceCaptureId: decision.captureId,
      provenance: { captureId: decision.captureId, quote: decision.quote },
      flowId: ctx.flowId ?? null,
      expects: normalizeWorkExpects(candidate.payload.expects),
    },
    deps.send ? { send: deps.send } : {},
  )
  if (!launched.ok) return { attempted: false, reason: 'launch_failed', detail: `${launched.stage}: ${launched.error}` }
  return {
    attempted: true,
    reused: launched.reused,
    agentRunId: launched.agentRunId,
    fireKey: decision.fireKey,
    teammateId: decision.teammate.id,
  }
}

/**
 * The verdict walk's attempter, built once per verdict. NULL — and nothing is
 * read — while the env kill switch is off, for a report-mode verdict, or when
 * the verdict has no work_proposal; NULL after one settings read when the
 * workspace is not in `mode: 'attempt'` (switched off, or a malformed policy).
 * So while either kill switch is thrown, the walk, its reads and its ledger
 * are the card-only walk.
 */
export async function createWorkProposalAttempter(
  ctx: AttempterContext,
  opts: { hasWorkProposal: boolean },
): Promise<WorkProposalAttempter | null> {
  if (!autoAttemptEnvEnabled(ctx.env)) return null
  // A report-mode verdict applies nothing, so it never attempts either.
  if (ctx.mode !== 'act') return null
  if (!opts.hasWorkProposal) return null
  const policy = await resolveAgentAutonomyPolicy(ctx.supabase, ctx.workspaceId)
  if (policy.mode !== 'attempt') return null
  const full = { ...ctx, policy }
  return (candidate) => attemptWorkProposal(candidate, full)
}
