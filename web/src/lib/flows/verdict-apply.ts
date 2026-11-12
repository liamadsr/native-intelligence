/**
 * Verdict apply engine — the "act" half of the loop (Phase 2, Workstream B).
 *
 * A verdict-class skill run (recipe.agent_config.output_contract === 'verdict')
 * commits its structured judgment ONCE (eve's outputSchema, verdict-schema.ts). The MODEL applies
 * nothing — this module, running as server code, walks the decisions and does the
 * work: applies qualifying accepts via the existing apply-engine (corrections
 * folded in), dismisses/folds the rest, revokes bad auto-accepts under hard
 * guardrails, and surfaces what needs the user as attention cards. Every effect
 * is recorded in a ledger so claimed == actual (fixes F2 — no more narration).
 *
 * Design: docs/loop-engine/VERDICT-PIPELINE-DESIGN.md.
 *
 * ISOLATION note: this is invoked ONLY from the run_skill executor's delivery
 * (deliverVerdictRun), with a service-role client, every write fenced by
 * workspace_id.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyChange, deleteAppliedEntity, type ApplyResult } from '@/lib/proposed-changes/apply-engine'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import { decideAutoApply } from '@/lib/proposed-changes/auto-apply-gate'
import { resolveWorkspaceEdition } from '@/lib/editions'
import type { TrustPolicy, ResolvedTrustPolicy } from '@/lib/proposed-changes/trust-policy'
import { cardEntityRef } from './card-entity'
import { isWorkRole, normalizeWorkExpects } from '@/lib/work/roles'
import { createWorkProposalAttempter, type WorkProposalAttempter } from '@/lib/work/auto-attempt'
import { createStaysInCapture, isCaptureOnlyCard, isUnbackedCard } from '@/lib/attention/pending-cards'
import { isChatAskCard, type AddedItem } from '@/lib/attention/chat-asks'
import { requestHomeAsks, sourceWords } from '@/lib/attention/home-asks'
import { canonicalEntityType } from '@/lib/knowledge/entity-registry'
import {
  WORK_TASK_MAX_CHARS,
  WORK_TITLE_MAX_CHARS,
  WORK_RESOURCES_MAX,
  WORK_RESOURCE_LABEL_MAX_CHARS,
  WORK_RESOURCE_TYPES,
  type WorkProposalPayload,
  type WorkResourceRef,
} from '@/lib/agent-run/types'

/** The known resource types whose id survives the clamp. A garbage type keeps its
 *  label chip but loses the id, so it can't smuggle an unresolvable id through to
 *  the brief (matches Start's snapshot behavior). */
const KNOWN_RESOURCE_TYPES: ReadonlySet<string> = new Set(WORK_RESOURCE_TYPES)
import type {
  VerdictLedger,
  VerdictLedgerEntry,
  VerdictAttemptEntry,
  RunSkillActionConfig,
  StatusChangeOrigin,
} from './types'

/** The validated verdict the model submitted (shape mirrors the tool schema). */
export interface RunVerdict {
  decisions: VerdictDecision[]
  needs_user: NeedsUserItem[]
  summary: string
}

export interface VerdictDecision {
  proposal_id: string
  verdict: 'accept' | 'dismiss' | 'fold_into' | 'revoke'
  corrections?: {
    priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent'
    due_date?: string | null
    status?: string
  }
  fold_target_action_id?: string
  reason: string
  confidence: number
  /** C3 explicitness gate: true iff the commitment is first-person / explicitly
   *  the run-as user's. Only an explicit-mine accept can auto-apply. */
  is_mine_explicit?: boolean
  /** WS-2b: model judgment that this accept is an outreach commitment ("reach out
   *  to X"). When such an accept AUTO-APPLIES, the engine synthesizes + cards a
   *  companion draft email so the return path isn't just a silent board row. */
  is_outreach?: boolean
  /** WS-2b: the person to reach out to, as the model names them. Resolved
   *  server-side to a contact/participant email — NEVER trusted as an address. */
  outreach_contact_name?: string
}

export interface NeedsUserItem {
  kind: 'action_card' | 'draft_email' | 'question' | 'work_proposal'
  proposal_id?: string
  title: string
  why: string
  payload?: Record<string, unknown>
  /** Carried for ranking against carded accepts; defaults low. */
  confidence?: number
  /**
   * work_proposal only (verdict-schema.ts puts these BESIDE `payload`, and the
   * mig-281 prompt teaches them there). Folded into the card payload by
   * buildNeedsUserCandidate; an item-level value wins over one in the payload.
   */
  role?: unknown
  expects?: unknown
}

/** Resolved trust config with all defaults filled (never trusts partial input). */
export interface ResolvedTrust {
  auto_apply: boolean
  min_confidence: number
  allow_external: false
  max_cards_per_run: number
  /** WS-2b: surface a companion draft_email card when an auto-applied accept is
   *  outreach-class. Default true. */
  outreach_draft_cards: boolean
}

/**
 * Resolve a flow's trust into the fully-defaulted shape the verdict gate uses.
 *
 * W-2 (One Accept Authority, D3) — EXPLICIT-policy-only inheritance: a flow's
 * own trust field overrides where set; where the flow leaves a field unset it
 * inherits the workspace trust policy value ONLY when that policy is EXPLICIT
 * (the workspace set trust_policy, or tuned the legacy auto_accept_policy).
 * A pure-default workspace keeps this channel's historic hard default (0.85) —
 * inheriting the extraction default (0.8) there would silently loosen the
 * verdict gate fleet-wide for workspaces that never expressed intent. The
 * verdict gate auto-applies only actions, so `actions.min_confidence` is the
 * inheritance source for `min_confidence`, and the master `enabled` gates
 * `auto_apply` (an explicit workspace kill-switch beats a flow's auto_apply).
 *
 * `workspacePolicy` is optional so existing callers (and the verdict-apply
 * suite, which passes complete flow-trust objects) stay behavior-identical:
 * with no workspace policy, a non-explicit one, or every flow field set,
 * inheritance never fires.
 */
export function resolveTrust(
  trust: RunSkillActionConfig['trust'],
  workspacePolicy?: ResolvedTrustPolicy,
): ResolvedTrust {
  const inherit = workspacePolicy?.explicit === true
  const wsMinConf = inherit ? workspacePolicy.actions.min_confidence : undefined
  const wsAutoApply = inherit
    ? workspacePolicy.enabled && workspacePolicy.actions.enabled
    : undefined
  return {
    auto_apply:
      trust?.auto_apply === true &&
      // An explicit workspace kill-switch (or disabled actions class) suppresses
      // auto-apply even when the flow armed it. No explicit policy → flow decides.
      (wsAutoApply ?? true),
    min_confidence:
      typeof trust?.min_confidence === 'number'
        ? trust.min_confidence
        : typeof wsMinConf === 'number'
          ? wsMinConf
          : 0.85,
    allow_external: false,
    max_cards_per_run:
      typeof trust?.max_cards_per_run === 'number' ? trust.max_cards_per_run : 3,
    // Default TRUE — only an explicit false suppresses the outreach draft card.
    outreach_draft_cards: trust?.outreach_draft_cards !== false,
  }
}

/**
 * Project a per-flow ResolvedTrust into the shared TrustPolicy shape the gate
 * reads. The verdict authority auto-applies ONLY actions, so only the actions
 * rule is load-bearing: `enabled` ← auto_apply (the flow's arm switch), the
 * action floor ← min_confidence, external always disallowed. Decisions/milestones
 * are given the verdict floor too, but the gate stages them regardless for the
 * verdict authority — they exist here only to complete the shape.
 */
function trustAsPolicy(trust: ResolvedTrust): TrustPolicy {
  const rule = {
    enabled: true,
    min_confidence: trust.min_confidence,
    require_explicit: false,
  }
  return {
    enabled: trust.auto_apply,
    actions: { ...rule },
    decisions: { ...rule },
    milestones: { ...rule },
    claims: { ...rule },
    allow_external: false,
  }
}

export interface ApplyVerdictContext {
  supabase: SupabaseClient
  workspaceId: string
  /** The run-as member id (authorship + card recipient). */
  memberId: string
  /** The run-as auth user id (apply-engine needs it for actions.user_id). */
  userId: string
  mode: 'report' | 'act'
  trust: ResolvedTrust
  /**
   * Stable per-fire key (Inngest event id / fireId), constant across step
   * retries. Cards are deduped on (proposal_id, run_key) so an infra-retry that
   * re-runs the executor never double-inserts a card. May be null on paths with
   * no stable fire id (then cards aren't retry-deduped, but the apply CAS still
   * prevents double board writes).
   */
  runKey: string | null
  /** flow_run id for the audit-ledger deep link. Pre-generated at the dispatch
   *  site so cards can back-link to their run (source_flow_run_id). */
  flowRunId: string | null
  /** Provenance for the card footer ("from <skill> · <capture>"). Optional —
   *  the footer degrades to nothing when absent. */
  provenance?: {
    skillName?: string | null
    captureTitle?: string | null
  }
  /**
   * The workspace EDITION's auto-createable entity_type set. Resolved ONCE by
   * applyVerdict and stamped onto the context it already threads — callers do
   * not pass it. Absent/'all' ⇒ no edition restriction.
   */
  allowedEntityTypes?: 'all' | string[]
  /**
   * Who these applies are, for the status-change loop guard
   * (flows/types.ts StatusChangeOrigin). The verdict is the pipeline's own
   * judgment: `{ actor: 'loop', depth }`. Absent → a person at depth 0.
   */
  origin?: StatusChangeOrigin
  /**
   * The fire's triggering capture (Sequence step 3): the auto-attempt gate's
   * grounding for a proposal-less work item, and its per-capture budget key.
   */
  captureId?: string | null
  /**
   * The flow this verdict ran for (Sequence step 3): an attempted run records it
   * as its origin, since it files no board action (agent_run_has_origin).
   */
  flowId?: string | null
  /**
   * The teammate whose run this is (the fire's ledger row's `ai_team_member_id`):
   * stamped on every card as `payload.raised_by_ai_member_id`, so the card is
   * its bot's from the moment it lands, before (or without) the
   * `source_flow_run_id` back-fill (bots-v3.md "Attribution"). Absent → none.
   */
  teammateId?: string | null
  /**
   * The fire's ledger row (`tracked_job.id`): stamped on every card as
   * `payload.work_item_id`, the key one run's cards share (one batch per run,
   * never one per `run_key`, which every loop of one capture fire shares).
   */
  workItemId?: string | null
  /**
   * The auto-attempt gate for work_proposal candidates (src/lib/work/auto-attempt.ts).
   * `undefined` → built here from the context (null — nothing read — unless the
   * env switch is on AND the workspace is in mode 'attempt'); `null` → off.
   * Tests inject one.
   */
  attemptWorkProposal?: WorkProposalAttempter | null
  /** Test seam: how a run that carded something asks for its home-thread message (default: the debounced event). */
  requestHomeAsks?: typeof requestHomeAsks
}

/** Revoke recency window — a correction, not archaeology. */
const REVOKE_MAX_AGE_MS = 72 * 60 * 60 * 1000
/** Small skew grace so the create's own updated_at doesn't read as "touched". */
const TOUCHED_SKEW_MS = 5000
/** Card TTL — the rail expires cards so it can't become a second graveyard. */
const CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** A candidate card produced during the walk, pre-cap. */
interface CardCandidate {
  kind: 'action_card' | 'draft_email' | 'question' | 'work_proposal'
  proposal_id: string | null
  title: string
  why: string
  payload: Record<string, unknown>
  confidence: number
}

/**
 * Walk a verdict and execute it. Returns the ledger to attach to the run's
 * ActionResult. Never throws — a per-item failure is recorded as outcome
 * 'failed'/'skipped' and the walk continues (one bad proposal never abandons the
 * rest). Idempotent: every board write is CAS-guarded on the proposal's
 * pre-state, so an Inngest infra retry that re-invokes the walk no-ops the
 * already-done items.
 */
export async function applyVerdict(
  verdict: RunVerdict,
  ctx: ApplyVerdictContext,
): Promise<VerdictLedger> {
  const entries: VerdictLedgerEntry[] = []
  const cardCandidates: CardCandidate[] = []
  let revokedCount = 0

  // The workspace edition's auto-createable entity set, resolved ONCE for the
  // whole walk (acceptDecision runs per proposal — a per-call resolve would be
  // one DB read per decision) and carried on the context the walk already
  // threads. Fails open to 'full' ⇒ 'all' ⇒ no restriction.
  const edition = await resolveWorkspaceEdition(ctx.supabase, ctx.workspaceId)
  ctx = { ...ctx, allowedEntityTypes: edition.autoCreateEntities }

  // What the rail already holds for these proposals (issues 12 and 13 in
  // docs/plans/orchestration-followups.md): a card still waiting on the user,
  // or a card this member dismissed. A later triage pass over the same queue
  // must not overrule either.
  const cards = await loadCardState(ctx, verdict)

  // Belt over the producers' normalization: verdicts cross process boundaries
  // (eve outputSchema results, MCP calls, salvaged partials), and a missing
  // array here crashed the Inngest step ("needs_user is not iterable",
  // recurring since 2026-07-13). Iterate defensively regardless of the type.
  for (const decision of verdict.decisions ?? []) {
    try {
      const entry = await applyDecision(decision, ctx, cardCandidates, cards)
      entries.push(entry)
      if (entry.outcome === 'revoked') revokedCount++
    } catch (err) {
      entries.push({
        proposal_id: decision.proposal_id,
        decision: decision.verdict,
        outcome: 'failed',
        reason: decision.reason,
        detail: err instanceof Error ? err.message : 'unknown error',
      })
    }
  }

  // 1e-iii: DEDUPE needs_user against already-carded decisions BEFORE ranking. A
  // proposal listed in BOTH decisions (carded) and needs_user must not spend two
  // card slots or collide at insert — keep the decision's card, drop the
  // needs_user duplicate. This is the root cause of the Jul-6 "3 surfaced vs 2
  // rows" miscount: the same proposal cardded twice, the second insert 23505'd.
  const cardedProposalIds = new Set(
    cardCandidates.map((c) => c.proposal_id).filter((id): id is string => id != null),
  )
  // A needs_user item for a proposal that already had a card is suppressed
  // before ranking: one still waiting on the user (it could only dedup,
  // spending a slot), one this member dismissed (the user's answer), or one
  // that expired unanswered (asking again is how a proposal came to be carded
  // twice). A card to add a to-do or a decision is not made at all: Triage
  // leaves those in their capture (acceptDecision), and a needs_user one is no
  // different.
  // An action or email card that names no proposal is not made either: its
  // accept applies its proposal, so it would have nothing to apply (a dead
  // "Unsupported: undefined undefined" button, isUnbackedCard). Triage lists a
  // call's "next steps" that way; a to-do it means is a proposal it accepts.
  let cardsSuppressed = 0
  for (const nu of verdict.needs_user ?? []) {
    if (nu.proposal_id && cardedProposalIds.has(nu.proposal_id)) continue
    if (nu.proposal_id && cards.carded.has(nu.proposal_id)) {
      cardsSuppressed++
      continue
    }
    const candidate = buildNeedsUserCandidate(nu)
    if (isCaptureOnlyCard(candidate) || isUnbackedCard(candidate)) {
      cardsSuppressed++
      continue
    }
    cardCandidates.push(candidate)
  }

  // Only a pending proposal is carded. The walk checked each accept's proposal
  // when it read it, but a needs_user item names its proposal without that
  // read, and a decision earlier in this walk may have resolved it: a card over
  // a resolved proposal is one nothing would ever take down.
  const cardable = await filterCardableCandidates(ctx, cardCandidates)
  cardsSuppressed += cardCandidates.length - cardable.length

  // Rank by confidence desc, take top max_cards_per_run; overflow stays pending
  // in the capture (never dropped) and is counted for the notification.
  const ranked = [...cardable].sort((a, b) => b.confidence - a.confidence)
  const taken = ranked.slice(0, ctx.trust.max_cards_per_run)
  const overflow = ranked.length - taken.length

  // Sequence step 3 — the auto-attempt gate. A work_proposal that would be
  // carded is instead STARTED when the gate passes (Start without the click);
  // otherwise it is carded exactly as before. Attempts spend card slots, so the
  // rail cap bounds cards + attempts together. On by default; null when the env
  // kill switch or the workspace's Off switch is thrown (createWorkProposalAttempter).
  const attempter =
    ctx.attemptWorkProposal !== undefined
      ? ctx.attemptWorkProposal
      : await createWorkProposalAttempter(
          {
            supabase: ctx.supabase,
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            memberId: ctx.memberId,
            mode: ctx.mode,
            // The verdict's own depth (run-skill: the fire's + 1). Absent → 0,
            // which the gate refuses (it attempts only from a first-hop verdict).
            fireDepth: ctx.origin?.depth ?? 0,
            captureId: ctx.captureId ?? null,
            flowId: ctx.flowId ?? null,
            captureTitle: ctx.provenance?.captureTitle ?? null,
            minConfidence: ctx.trust.min_confidence,
          },
          { hasWorkProposal: taken.some((c) => c.kind === 'work_proposal') },
        )
  const attempts: VerdictAttemptEntry[] = []

  // 1e-i: distinguish real inserts from dedups/failures so cards_surfaced — and
  // the grouped notification built from it — counts ONLY rows that actually
  // landed. A 23505 (already surfaced) is a dedup, not a surface.
  let cardsSurfaced = 0
  let cardsDeduped = 0
  let cardsFailed = 0
  let cardsAsked = 0
  for (const card of taken) {
    if (attempter && card.kind === 'work_proposal') {
      const title = card.title.slice(0, 500)
      const outcome = await attempter({
        proposalId: card.proposal_id,
        cardId: card.proposal_id == null && ctx.runKey != null ? deterministicCardId(ctx.runKey, card.kind, title) : null,
        title: card.title,
        why: card.why,
        payload: card.payload,
        confidence: card.confidence,
      })
      if (outcome.attempted) {
        attempts.push({
          title: card.title,
          proposal_id: card.proposal_id,
          outcome: outcome.reused ? 'reused' : 'started',
          agent_run_id: outcome.agentRunId,
        })
        continue
      }
      attempts.push({
        title: card.title,
        proposal_id: card.proposal_id,
        outcome: 'carded',
        reason: outcome.reason,
        detail: outcome.detail ?? null,
      })
    }
    const outcome = await insertAttentionCard(card, ctx)
    if (outcome === 'inserted') {
      cardsSurfaced++
      if (isChatAskCard(card)) cardsAsked++
    } else if (outcome === 'deduped') cardsDeduped++
    else cardsFailed++
  }
  // P13: what the run added on its own (its existing gate) is said in the
  // owner's home thread with an Undo, and what it carded asks there, batched
  // per call and per burst (src/lib/attention/home-asks.ts), never For you.
  const source = sourceWords(ctx.provenance?.captureTitle, ctx.provenance?.skillName)
  const added: AddedItem[] = entries.flatMap((e) =>
    e.outcome === 'applied' && e.created && e.entity_id
      ? [{ change_id: e.proposal_id, entity_id: e.entity_id, entity_type: e.entity_type ?? 'action', ...(ctx.captureId ? { capture_id: ctx.captureId } : {}), source }]
      : [],
  )
  if (cardsAsked > 0 || added.length > 0) {
    await (ctx.requestHomeAsks ?? requestHomeAsks)({ workspaceId: ctx.workspaceId, userId: ctx.userId, ...(added.length ? { added } : {}) })
  }

  return {
    summary: verdict.summary,
    entries,
    // 1e-ii: persist the exact verdict the model submitted (decisions +
    // needs_user + summary), so every surfaced-or-not item is reconstructible —
    // even one deduped or overflowed out of a card.
    submitted: verdict,
    cards_surfaced: cardsSurfaced,
    cards_deduped: cardsDeduped,
    cards_failed: cardsFailed,
    cards_overflow: Math.max(0, overflow),
    ...(cardsSuppressed > 0 ? { cards_suppressed: cardsSuppressed } : {}),
    revoked_count: revokedCount,
    ...(attempter ? { attempts } : {}),
  }
}

// ── Per-decision handling ────────────────────────────────────────────────────

async function applyDecision(
  decision: VerdictDecision,
  ctx: ApplyVerdictContext,
  cardCandidates: CardCandidate[],
  cards: CardState = NO_CARD_STATE,
): Promise<VerdictLedgerEntry> {
  const base = {
    proposal_id: decision.proposal_id,
    decision: decision.verdict,
    reason: decision.reason,
  }

  // Load the proposal, workspace-fenced.
  const { data: rawChange } = await ctx.supabase
    .from('proposed_change')
    .select('*')
    .eq('id', decision.proposal_id)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle()

  if (!rawChange) {
    return { ...base, outcome: 'skipped', detail: 'proposal not found in workspace' }
  }
  const change = rawChange as unknown as ProposedChange

  // The rail already asked the user about this proposal. While that card is
  // pending the question is theirs: no pass re-decides it (issue 13: a
  // backlog pass dismissed a proposal six minutes after another pass carded
  // it, and the card stayed live over a dismissed proposal). A card this
  // member dismissed is their answer: no pass accepts it again, by card or by
  // auto-apply (issue 12). Agreeing with them (dismiss, fold) still goes
  // through. An expired card is neither: the proposal can still auto-apply,
  // but it is not carded again (acceptDecision stages it).
  if (change.status === 'pending' && decision.verdict !== 'revoke') {
    if (cards.pending.has(change.id)) {
      return { ...base, outcome: 'skipped', detail: 'its card is waiting on the user' }
    }
    if (decision.verdict === 'accept' && cards.dismissed.has(change.id)) {
      return { ...base, outcome: 'skipped', detail: 'the user dismissed its card' }
    }
  }

  // REPORT MODE IS A DRY-RUN FOR THE BOARD. Liam's locked invariant + the F1
  // incident: a report-mode run applies NOTHING to the board. accept already
  // becomes a card in report mode (its trust gate requires act); dismiss / fold /
  // revoke would ALSO mutate the board (dismiss pulls a proposal from the queue,
  // fold comments + dismisses, revoke HARD-DELETES an action) — so in report
  // mode we ledger the intended decision WITHOUT applying it. (Adversarial
  // review finding: without this gate, "report" runs re-open F1 and can even
  // delete a live action.)
  if (ctx.mode !== 'act' && decision.verdict !== 'accept') {
    return { ...base, outcome: 'skipped', detail: 'report mode — recorded, not applied' }
  }

  switch (decision.verdict) {
    case 'revoke':
      return revokeDecision(decision, change, ctx)
    case 'dismiss':
      return dismissDecision(decision, change, ctx)
    case 'fold_into':
      return foldDecision(decision, change, ctx)
    case 'accept':
      return acceptDecision(decision, change, ctx, cardCandidates, cards)
    default:
      return { ...base, outcome: 'skipped', detail: `unknown verdict ${decision.verdict}` }
  }
}

/** The rail's cards for a verdict's proposals (loadCardState). */
interface CardState {
  /** Proposals holding a pending card (for anyone: one live card per proposal, migration 171). */
  pending: ReadonlySet<string>
  /** Proposals whose card this member dismissed. */
  dismissed: ReadonlySet<string>
  /** Proposals that ever had a card, in any status, for anyone. None is carded again. */
  carded: ReadonlySet<string>
}

const NO_CARD_STATE: CardState = { pending: new Set(), dismissed: new Set(), carded: new Set() }

/**
 * One read of the cards behind the proposals a verdict names, in every status:
 * an accepted, dismissed or expired card means the proposal was already put in
 * front of someone, and a proposal is carded once. Fails open to no state (the
 * walk behaves as it did before this check existed), so a failed read never
 * blocks a verdict.
 */
async function loadCardState(ctx: ApplyVerdictContext, verdict: RunVerdict): Promise<CardState> {
  const ids = new Set<string>()
  for (const d of verdict.decisions ?? []) if (typeof d?.proposal_id === 'string') ids.add(d.proposal_id)
  for (const nu of verdict.needs_user ?? []) if (typeof nu?.proposal_id === 'string') ids.add(nu.proposal_id)
  if (ids.size === 0) return NO_CARD_STATE
  try {
    const { data, error } = await ctx.supabase
      .from('attention_item')
      .select('proposal_id, member_id, status')
      .eq('workspace_id', ctx.workspaceId)
      .in('proposal_id', [...ids])
    if (error) throw new Error(error.message)
    const pending = new Set<string>()
    const dismissed = new Set<string>()
    const carded = new Set<string>()
    for (const row of (data ?? []) as Array<{ proposal_id: string | null; member_id: string; status: string }>) {
      if (!row.proposal_id) continue
      carded.add(row.proposal_id)
      if (row.status === 'pending') pending.add(row.proposal_id)
      else if (row.status === 'dismissed' && row.member_id === ctx.memberId) dismissed.add(row.proposal_id)
    }
    return { pending, dismissed, carded }
  } catch (err) {
    console.warn('[flows] verdict card state unreadable; applying without it', {
      workspaceId: ctx.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    return NO_CARD_STATE
  }
}

/**
 * The candidates whose card may land: a proposal-backed one only while its
 * proposal is pending in this workspace (one read for the whole batch), and a
 * proposal-less one (a work proposal, a free question) always. A needs_user
 * item that turns out to name a new to-do or a decision is dropped too, as
 * acceptDecision drops an accepted one: the proposal stays in its capture.
 * A needs_user action or email card carries its proposal's payload, as a
 * decision's card does (the model's needs_user payload is a work proposal's,
 * and names no change: the card would read "Unsupported: undefined undefined").
 * Fails open to the candidates as they are, like loadCardState: a failed read
 * never blocks a verdict, and a card over a proposal resolved later is taken
 * down with it (migration 352). Only a needs_user action or email card is
 * held back then, having no payload to show.
 */
async function filterCardableCandidates(
  ctx: ApplyVerdictContext,
  candidates: CardCandidate[],
): Promise<CardCandidate[]> {
  const ids = [...new Set(candidates.map((c) => c.proposal_id).filter((id): id is string => id != null))]
  if (ids.length === 0) return candidates
  // An action or email card that still names no change once the proposals are
  // read (or can't be) is not carded: its only button would be dead.
  const needsPayload = (card: CardCandidate) =>
    (card.kind === 'action_card' || card.kind === 'draft_email') && !card.payload.change_type
  let proposals: Map<string, ProposedChange>
  try {
    const { data, error } = await ctx.supabase
      .from('proposed_change')
      .select('*')
      .eq('workspace_id', ctx.workspaceId)
      .in('id', ids)
    if (error) throw new Error(error.message)
    proposals = new Map(((data ?? []) as unknown as ProposedChange[]).map((row) => [row.id, row]))
  } catch (err) {
    console.warn('[flows] verdict card proposals unreadable; carding without the pending check', {
      workspaceId: ctx.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    return candidates.filter((card) => !needsPayload(card))
  }
  return candidates.flatMap((card) => {
    if (card.proposal_id == null) return [card]
    const proposal = proposals.get(card.proposal_id)
    if (!proposal || proposal.status !== 'pending') return []
    if (card.kind === 'action_card' && createStaysInCapture(proposal)) return []
    return [needsPayload(card) ? { ...card, payload: cardPayload(proposal, { confidence: card.confidence }) } : card]
  })
}

// ── accept ───────────────────────────────────────────────────────────────────

async function acceptDecision(
  decision: VerdictDecision,
  change: ProposedChange,
  ctx: ApplyVerdictContext,
  cardCandidates: CardCandidate[],
  cards: CardState = NO_CARD_STATE,
): Promise<VerdictLedgerEntry> {
  const base = { proposal_id: decision.proposal_id, decision: 'accept' as const, reason: decision.reason }

  if (change.status !== 'pending') {
    // Already resolved (a prior walk / concurrent turn). Idempotent no-op.
    return { ...base, outcome: 'skipped', detail: `proposal already ${change.status}` }
  }

  const isExternal =
    change.change_type === 'send_email' ||
    change.change_type === 'mcp_call' ||
    change.entity_type === 'external'

  // The trust gate is now the shared decision function (W-1). It reproduces the
  // verdict gate's historical rules exactly for the 'verdict' authority: actions
  // only, create|update only, is_mine_explicit, confidence >= min, act mode,
  // not external. Decisions/milestones always stage in the verdict path (a
  // decision isn't a personal commitment, and createDecision fires an async
  // knowledge claim the lost-CAS rollback can't fully undo). We project the
  // per-flow ResolvedTrust into the shared TrustPolicy shape: the flow's
  // auto_apply is the master enable, its min_confidence is the action floor.
  const gate =
    decideAutoApply(
      {
        change_type: change.change_type,
        entity_type: change.entity_type,
        confidence: decision.confidence,
      },
      trustAsPolicy(ctx.trust),
      {
        authority: 'verdict',
        mode: ctx.mode,
        isMineExplicit: decision.is_mine_explicit === true,
        allowedEntityTypes: ctx.allowedEntityTypes,
      },
    ) === 'apply'

  if (!gate) {
    const why = gateMissReason(ctx, decision, isExternal, change.change_type)
    // A new to-do or a decision the gate won't file is left pending in its
    // capture, not carded (createStaysInCapture). For You holds what is ready
    // to act on (a draft to review, a question, work to start); "Add this to
    // your to-dos" cards were most of it and few were accepted, and nobody
    // accepts a decision a call already made. The proposal stays where the
    // person already reviews a call's suggestions: the capture page, the
    // call's proposals card in chat, and the chat agent's
    // get_action_suggestions.
    if (createStaysInCapture(change)) {
      const what = change.entity_type === 'decision' ? 'a decision' : 'a new to-do'
      return { ...base, outcome: 'staged', detail: `${why}; ${what} stays in its capture` }
    }
    // A proposal is carded once: one whose card expired unanswered (or was
    // settled while the proposal stayed pending) is not asked about again.
    if (cards.carded.has(change.id)) {
      return { ...base, outcome: 'staged', detail: `${why}; it already had a card` }
    }
    // Surface as a card; leave the proposal pending so the card's accept applies it.
    cardCandidates.push({
      kind: isExternal && change.change_type === 'send_email' ? 'draft_email' : 'action_card',
      proposal_id: change.id,
      title: change.title || change.display_text,
      why: decision.reason,
      payload: cardPayload(change, decision),
      confidence: decision.confidence,
    })
    return { ...base, outcome: 'carded', detail: `${why} — surfaced as card` }
  }

  // Apply with corrections folded onto the change (kills the accept-verbatim-
  // then-hope-for-update_action two-step that silently failed in F2).
  const corrected = applyCorrections(change, decision)
  const result: ApplyResult = await applyChange(
    ctx.supabase,
    { ...corrected, auto_accepted: true },
    ctx.workspaceId,
    ctx.memberId,
    ctx.userId,
    ctx.origin ? { origin: ctx.origin } : undefined,
  )
  if (!result.success) {
    return { ...base, outcome: 'failed', detail: result.error ?? 'apply failed' }
  }

  // CAS the proposal to applied — guard on pending so a concurrent/retry walk
  // that already applied it doesn't double-count (and if lost, roll back the
  // entity we just created to avoid an orphan duplicate).
  const effectiveChangeType = result.applied_change_type ?? change.change_type
  const { data: marked } = await ctx.supabase
    .from('proposed_change')
    .update({
      status: 'applied',
      applied_at: new Date().toISOString(),
      applied_by: ctx.memberId,
      result_entity_id: result.entity_id ?? null,
      auto_accepted: true,
      // Clear any stale error_message from a prior failed attempt on this row.
      error_message: null,
      ...(result.applied_change_type ? { change_type: result.applied_change_type } : {}),
      ...(result.applied_entity_type ? { entity_type: result.applied_entity_type } : {}),
    })
    .eq('id', change.id)
    .eq('status', 'pending')
    .eq('workspace_id', ctx.workspaceId)
    .select('id')
    .maybeSingle()

  if (!marked) {
    // Lost the CAS — another turn applied it first. Roll back our orphan create.
    if (effectiveChangeType === 'create' && result.entity_id) {
      await deleteAppliedEntity(
        ctx.supabase,
        'create',
        change.entity_type,
        result.entity_id,
        ctx.workspaceId,
      ).catch(() => {})
    }
    return { ...base, outcome: 'skipped', detail: 'already applied by another turn' }
  }

  // WS-2b — outreach return path. An auto-applied OUTREACH commitment ("reach out
  // to X") still cards a draft email: creating the action was autonomous, but the
  // outreach itself is the user's act. The applied ACTION proposal carries no
  // email_to_* fields (those live only on send_email proposals), so we resolve the
  // contact server-side and synthesize a NEW send_email proposal to back the card.
  // No resolution → no card; the accept is still ledgered 'applied' with a note.
  if (decision.is_outreach === true && ctx.trust.outreach_draft_cards) {
    const name = decision.outreach_contact_name?.trim() ?? ''
    const resolution = name ? await resolveOutreachEmail(change, name, ctx) : null
    const candidate = resolution
      ? await synthesizeOutreachDraft(change, decision, resolution, ctx)
      : null
    if (candidate && resolution) {
      cardCandidates.push(candidate)
      return {
        ...base,
        outcome: 'applied',
        entity_id: result.entity_id ?? null,
        entity_type: change.entity_type ?? null,
        ...createdMark(change),
        detail: `outreach: draft email queued to ${resolution.email}`,
      }
    }
    return {
      ...base,
      outcome: 'applied',
      entity_id: result.entity_id ?? null,
      entity_type: change.entity_type ?? null,
      ...createdMark(change),
      detail: 'outreach: no address resolved',
    }
  }

  return { ...base, outcome: 'applied', entity_id: result.entity_id ?? null, entity_type: change.entity_type ?? null, ...createdMark(change) }
}

/** An applied create is marked so the home thread can say what was added, with an Undo (P13). */
function createdMark(change: { change_type?: string | null }): { created?: true } {
  return change.change_type === 'create' ? { created: true } : {}
}

// ── outreach return path (WS-2b) ─────────────────────────────────────────────

interface OutreachResolution {
  email: string
  name: string
}

function isEmailAddress(v: unknown): v is string {
  return typeof v === 'string' && v.includes('@')
}

/** Loose two-way containment match — the model's name may be a first name and
 *  the stored name a full name (or vice-versa). */
function looseNameMatch(candidate: unknown, target: string): boolean {
  if (typeof candidate !== 'string') return false
  const a = candidate.trim().toLowerCase()
  const b = target.trim().toLowerCase()
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}

/**
 * Resolve the named outreach contact to a real email address — server-side,
 * never from model narration. Order of fidelity: (1) a UNIQUE workspace `contact`
 * ilike match that has an email; then (2) a UNIQUE name-matched
 * `capture_participant` (via the source change's capture) with an external email.
 * Ambiguous (>1 match) or empty → null (no card is surfaced). Fail-safe: any
 * probe error yields null rather than a guessed address.
 */
async function resolveOutreachEmail(
  change: ProposedChange,
  name: string,
  ctx: ApplyVerdictContext,
): Promise<OutreachResolution | null> {
  const target = name.trim()
  if (!target) return null

  try {
    const { data: contacts } = await ctx.supabase
      .from('contact')
      .select('id, full_name, email')
      .eq('workspace_id', ctx.workspaceId)
      .ilike('full_name', `%${target}%`)
      .limit(20)
    const withEmail = (contacts ?? []).filter((c) =>
      isEmailAddress((c as { email?: unknown }).email),
    )
    if (withEmail.length === 1) {
      const c = withEmail[0] as { full_name?: string | null; email: string }
      return { email: c.email, name: c.full_name?.trim() || target }
    }
  } catch {
    // fall through to capture participants
  }

  if (change.capture_id) {
    try {
      const { data: participants } = await ctx.supabase
        .from('capture_participant')
        .select('external_name, external_email')
        .eq('capture_id', change.capture_id)
      const matches = (participants ?? []).filter(
        (p) =>
          isEmailAddress((p as { external_email?: unknown }).external_email) &&
          looseNameMatch((p as { external_name?: unknown }).external_name, target),
      )
      if (matches.length === 1) {
        const p = matches[0] as { external_name?: string | null; external_email: string }
        return { email: p.external_email, name: p.external_name?.trim() || target }
      }
    } catch {
      // no resolution
    }
  }

  return null
}

/**
 * Insert the server-synthesized send_email proposal that backs an outreach draft
 * card, and return the card candidate pointed at it (subject to the normal
 * cap/ranking). To-address/subject/context are built from the resolved contact +
 * the source action — never model prose. Returns null if the insert fails (the
 * caller then ledgers "no address resolved" rather than dangling a card).
 */
async function synthesizeOutreachDraft(
  change: ProposedChange,
  decision: VerdictDecision,
  resolution: OutreachResolution,
  ctx: ApplyVerdictContext,
): Promise<CardCandidate | null> {
  const subject = change.title || change.display_text
  const context =
    [change.trigger_quote, change.description]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .join('\n\n') || null
  const displayText = `Draft email to ${resolution.name}: ${subject}`

  const { data: inserted } = await ctx.supabase
    .from('proposed_change')
    .insert({
      workspace_id: ctx.workspaceId,
      capture_id: change.capture_id,
      change_type: 'send_email',
      entity_type: 'external',
      status: 'pending',
      display_text: displayText,
      title: subject,
      email_to_address: resolution.email,
      email_to_name: resolution.name,
      email_subject: subject,
      email_context: context,
      confidence: decision.confidence,
    })
    .select('id')
    .single()

  const newId = (inserted as { id?: string } | null)?.id
  if (!newId) return null

  // A ProposedChange view of the synthesized row for cardPayload (email fields
  // populated; action-only fields nulled so they don't leak onto the draft card).
  const draftChange: ProposedChange = {
    ...change,
    id: newId,
    change_type: 'send_email',
    entity_type: 'external',
    status: 'pending',
    display_text: displayText,
    title: subject,
    priority: null,
    due_date: null,
    project_id: null,
    assignee_member_id: null,
    assignee_contact_id: null,
    email_to_address: resolution.email,
    email_to_name: resolution.name,
    email_subject: subject,
    email_context: context,
    result_entity_id: null,
    auto_accepted: false,
  }

  return {
    kind: 'draft_email',
    proposal_id: newId,
    title: displayText,
    why: decision.reason,
    payload: cardPayload(draftChange, decision),
    confidence: decision.confidence,
  }
}

function gateMissReason(
  ctx: ApplyVerdictContext,
  decision: VerdictDecision,
  isExternal: boolean,
  changeType?: string,
): string {
  if (ctx.mode !== 'act') return 'report mode'
  if (!ctx.trust.auto_apply) return 'auto_apply off'
  if (isExternal) return 'external side effect, never auto-applies'
  if (changeType === 'delete' || changeType === 'assign') return `${changeType} never auto-applies`
  if (decision.is_mine_explicit !== true) return 'not explicitly the user’s'
  if (decision.confidence < ctx.trust.min_confidence) return 'below confidence threshold'
  return 'did not clear the trust gate'
}

/** Fold corrections onto the change; createAction/updateAction read these off it. */
function applyCorrections(change: ProposedChange, decision: Pick<VerdictDecision, 'corrections'>): ProposedChange {
  const c = decision.corrections
  if (!c) return change
  return {
    ...change,
    ...(c.priority !== undefined ? { priority: c.priority } : {}),
    ...(c.due_date !== undefined ? { due_date: c.due_date } : {}),
    ...(c.status !== undefined ? { status_to: c.status } : {}),
  }
}

// ── dismiss ──────────────────────────────────────────────────────────────────

async function dismissDecision(
  decision: VerdictDecision,
  change: ProposedChange,
  ctx: ApplyVerdictContext,
): Promise<VerdictLedgerEntry> {
  const base = { proposal_id: decision.proposal_id, decision: 'dismiss' as const, reason: decision.reason }
  if (change.status !== 'pending') {
    return { ...base, outcome: 'skipped', detail: `proposal already ${change.status}` }
  }
  const ok = await markDismissed(change, decision.reason, ctx)
  return ok
    ? { ...base, outcome: 'dismissed' }
    : { ...base, outcome: 'skipped', detail: 'lost dismiss CAS' }
}

// ── fold_into ────────────────────────────────────────────────────────────────

async function foldDecision(
  decision: VerdictDecision,
  change: ProposedChange,
  ctx: ApplyVerdictContext,
): Promise<VerdictLedgerEntry> {
  const base = { proposal_id: decision.proposal_id, decision: 'fold_into' as const, reason: decision.reason }
  if (change.status !== 'pending') {
    return { ...base, outcome: 'skipped', detail: `proposal already ${change.status}` }
  }
  const target = decision.fold_target_action_id
  if (!target) {
    return { ...base, outcome: 'skipped', detail: 'fold_into without a target action' }
  }
  // Verify the target action is in this workspace before commenting on it.
  const { data: targetAction } = await ctx.supabase
    .from('actions')
    .select('id')
    .eq('id', target)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle()
  if (!targetAction) {
    return { ...base, outcome: 'skipped', detail: 'fold target not found in workspace' }
  }
  // CLAIM THE FOLD FIRST via the CAS-dismiss, THEN comment. Ordering matters for
  // idempotency: the comment insert has no dedup key, so if we commented first a
  // retry (comment committed, dismiss didn't) would re-read the proposal as
  // pending and add a SECOND identical comment. Dismissing first means a retry
  // finds it already dismissed and skips at the top — no duplicate comment.
  // (Adversarial review: the fold double-comment race.)
  const won = await markDismissed(change, decision.reason, ctx)
  if (!won) {
    return { ...base, outcome: 'skipped', detail: 'lost fold CAS (already resolved)' }
  }
  const body = `**Folded from triage:** ${change.display_text}${
    decision.reason ? `\n\n${decision.reason}` : ''
  }`
  const { error: commentErr } = await ctx.supabase.from('comment').insert({
    body,
    author_id: ctx.memberId,
    commentable_type: 'action',
    commentable_id: target,
  })
  // The fold is committed (proposal dismissed). A comment failure is logged in
  // the ledger but doesn't un-dismiss — better a missing comment than a stuck
  // proposal or a duplicate on retry.
  return {
    ...base,
    outcome: 'folded',
    entity_id: target,
    ...(commentErr ? { detail: `folded but comment failed: ${commentErr.message}` } : {}),
  }
}

// ── revoke (hard guardrails, fail-closed) ────────────────────────────────────

async function revokeDecision(
  decision: VerdictDecision,
  change: ProposedChange,
  ctx: ApplyVerdictContext,
): Promise<VerdictLedgerEntry> {
  const base = { proposal_id: decision.proposal_id, decision: 'revoke' as const, reason: decision.reason }

  // 1. Must be an APPLIED, AUTO-ACCEPTED item — never a human or card accept.
  if (change.status !== 'applied' || change.auto_accepted !== true) {
    return { ...base, outcome: 'skipped', detail: 'revoke refused — not an auto-accepted apply' }
  }
  // 2. Must be a create (deleteAppliedEntity refuses updates/assigns).
  if (change.change_type !== 'create') {
    return { ...base, outcome: 'skipped', detail: 'revoke refused — not a create' }
  }
  if (!change.result_entity_id) {
    return { ...base, outcome: 'skipped', detail: 'revoke refused — no applied entity' }
  }
  // 3. Recency: a correction, not archaeology.
  const appliedAt = change.applied_at ? Date.parse(change.applied_at) : NaN
  if (!Number.isFinite(appliedAt) || Date.now() - appliedAt > REVOKE_MAX_AGE_MS) {
    return { ...base, outcome: 'skipped', detail: 'revoke refused — applied more than 72h ago' }
  }
  // 4. UNTOUCHED: never delete something the user has engaged with. Probe the
  //    entity's updated_at + any comment / agent_run activity since it was applied.
  const touched = await entityTouchedSince(change, appliedAt, ctx)
  if (touched) {
    return { ...base, outcome: 'skipped', detail: 'revoke refused — user touched it since' }
  }

  // Delete the entity, then mark the proposal dismissed+revoked. Guard the
  // dismiss on status='applied' so a concurrent revoke doesn't double-delete.
  const del = await deleteAppliedEntity(
    ctx.supabase,
    'create',
    change.entity_type,
    change.result_entity_id,
    ctx.workspaceId,
  )
  if (!del.success && del.code !== 'NOT_CREATED_BY_PROPOSAL') {
    return { ...base, outcome: 'failed', detail: del.error ?? 'delete failed' }
  }
  const { data: marked } = await ctx.supabase
    .from('proposed_change')
    .update({
      status: 'dismissed',
      result_entity_id: null,
      extra: { ...(change.extra ?? {}), revoked: true, revoke_reason: decision.reason },
    })
    .eq('id', change.id)
    .eq('status', 'applied')
    .eq('workspace_id', ctx.workspaceId)
    .select('id')
    .maybeSingle()

  if (!marked) {
    return { ...base, outcome: 'skipped', detail: 'lost revoke CAS' }
  }
  return { ...base, outcome: 'revoked', entity_id: change.result_entity_id }
}

/**
 * Has the user engaged with the applied entity since it was auto-accepted? Only
 * actions are revocable creates in practice, but the check is entity-agnostic
 * where it can be. Fail-CLOSED: any probe error returns `true` (refuse the
 * revoke) so an error never causes a deletion.
 */
async function entityTouchedSince(
  change: ProposedChange,
  appliedAtMs: number,
  ctx: ApplyVerdictContext,
): Promise<boolean> {
  const entityId = change.result_entity_id
  if (!entityId) return true
  try {
    if (change.entity_type === 'action') {
      const { data: action, error } = await ctx.supabase
        .from('actions')
        .select('updated_at, status_id, agent_run_status, agent_thread_id, completed_at')
        .eq('id', entityId)
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle()
      if (error || !action) return true // fail-closed: can't verify → don't delete
      // Any agent activity or completion = definitely touched. NOTE:
      // actions.agent_run_status is NOT NULL DEFAULT 'idle' (migration 145), so a
      // truthiness test would treat EVERY never-run action as touched and make
      // revoke dead. Compare against the non-active sentinel. (Adversarial review
      // finding — the original `if (action.agent_run_status ...)` was that bug.)
      const agentStatus = action.agent_run_status as string | null
      if ((agentStatus && agentStatus !== 'idle') || action.agent_thread_id || action.completed_at) {
        return true
      }
      const updatedAt = action.updated_at ? Date.parse(action.updated_at) : NaN
      if (Number.isFinite(updatedAt) && updatedAt > appliedAtMs + TOUCHED_SKEW_MS) return true

      // Child tables that FK actions(id) ON DELETE CASCADE would be silently
      // destroyed by a revoke's hard delete. If ANY exist, the action carries
      // real linked work — refuse the revoke. (Adversarial review: the cascade
      // data-loss gap that opened once the idle-check was corrected.)
      // Every such child is probed (the baseline's FKs plus later migrations).
      // None of these is written when the apply creates the action, so any
      // row at all is work added since. Most don't bump actions.updated_at.
      const count = (table: string, column: string) =>
        ctx.supabase.from(table).select('id', { count: 'exact', head: true }).eq(column, entityId)
      const since = new Date(appliedAtMs + TOUCHED_SKEW_MS).toISOString()
      const probes = await Promise.all([
        count('agent_run', 'action_id'),
        // The table is action_github_pr (migration 064). Reading a misspelt
        // `action_github_prs` failed every time, which refused every revoke.
        count('action_github_pr', 'action_id'),
        count('action_document', 'action_id'),
        count('action_external_task', 'action_id'),
        count('action_mail_done', 'action_id'),
        count('action_relation', 'action_id'),
        count('action_relation', 'related_action_id'),
        count('attachments', 'action_id'),
        count('action_contexts', 'action_id'),
        count('insights_dependencies', 'blocked_action_id'),
        count('actions', 'parent_action_id'),
        // The apply writes the assignee and the proposal's labels with the
        // action: only an assignee added later, or a label it didn't carry, counts.
        ctx.supabase
          .from('action_assignee')
          .select('member_id', { count: 'exact', head: true })
          .eq('action_id', entityId)
          .gt('created_at', since),
        ctx.supabase.from('action_label').select('label_id').eq('action_id', entityId),
      ])
      const failed = probes.find((p) => p.error)
      if (failed) {
        // Still fail-closed, but said aloud: a silent probe error reads as "the user touched it".
        console.warn('[verdict-apply] revoke probe failed:', failed.error?.message)
        return true
      }
      const labels = (probes[probes.length - 1].data ?? []) as Array<{ label_id?: unknown }>
      const applied = new Set(change.labels ?? [])
      if (labels.some((l) => !applied.has(String(l.label_id)))) return true
      if (probes.slice(0, -1).some((p) => (p.count ?? 0) > 0)) return true
    } else {
      // For a non-action create, we don't have a specialized freshness probe —
      // fail-closed and refuse the revoke rather than risk deleting edited work.
      return true
    }
    // Any comment on the entity since it was applied = touched.
    const { count, error: cErr } = await ctx.supabase
      .from('comment')
      .select('id', { count: 'exact', head: true })
      .eq('commentable_type', change.entity_type)
      .eq('commentable_id', entityId)
      .gt('created_at', new Date(appliedAtMs).toISOString())
    if (cErr) return true
    if ((count ?? 0) > 0) return true
    return false
  } catch {
    return true // fail-closed
  }
}

// ── shared: dismiss with reason (CAS) ────────────────────────────────────────

async function markDismissed(
  change: ProposedChange,
  reason: string,
  ctx: ApplyVerdictContext,
): Promise<boolean> {
  const { data } = await ctx.supabase
    .from('proposed_change')
    .update({
      status: 'dismissed',
      ...(reason ? { extra: { ...(change.extra ?? {}), dismiss_reason: reason } } : {}),
    })
    .eq('id', change.id)
    .eq('status', 'pending')
    .eq('workspace_id', ctx.workspaceId)
    .select('id')
    .maybeSingle()
  return !!data
}

// ── needs_user → card candidate (with the work_proposal branch) ──────────────

/**
 * Turn a model needs_user item into a card candidate. Every kind rides the same
 * ranking/cap/dedup machinery; work_proposal is the only kind that is server-
 * clamped and can DEGRADE: a work item with no non-empty `task` is unstartable,
 * so it falls back to a plain question card (never an empty work card that the
 * executor can't run — see WORK-PROPOSALS-DESIGN.md).
 */
function buildNeedsUserCandidate(nu: NeedsUserItem): CardCandidate {
  const confidence = typeof nu.confidence === 'number' ? nu.confidence : 0
  const proposal_id = nu.proposal_id ?? null

  if (nu.kind !== 'work_proposal') {
    return { kind: nu.kind, proposal_id, title: nu.title, why: nu.why, payload: nu.payload ?? {}, confidence }
  }

  // The schema (verdict-schema.ts) and the triage prompt (mig 281) put role /
  // expects BESIDE payload; fold them in (the item-level value wins) so the
  // clamp below keeps them. Before step 3 only a payload-level value survived,
  // so a schema-following verdict's role never reached the card.
  const raw: Record<string, unknown> = {
    ...((nu.payload ?? {}) as Record<string, unknown>),
    ...(nu.role !== undefined ? { role: nu.role } : {}),
    ...(nu.expects !== undefined ? { expects: nu.expects } : {}),
  }
  const task = typeof raw.task === 'string' ? raw.task.trim() : ''
  if (!task) {
    // Missing/empty task → degrade to a question card. Recorded so the count of
    // real work proposals never overstates (same accounting honesty as the
    // dedup/overflow ledger). Never insert an unstartable work card.
    console.warn('[flows] work_proposal missing task — degraded to a question card', {
      title: nu.title.slice(0, 120),
    })
    return {
      kind: 'question',
      proposal_id,
      title: nu.title,
      why: nu.why,
      payload: { ...raw, degraded_from: 'work_proposal', degraded_reason: 'missing task' },
      confidence,
    }
  }

  return {
    kind: 'work_proposal',
    proposal_id,
    title: nu.title.slice(0, WORK_TITLE_MAX_CHARS),
    why: nu.why,
    payload: clampWorkProposalPayload(raw, task),
    confidence,
  }
}

/**
 * Server-clamp a work-proposal payload to the constants in agent-run/types: task
 * ≤ WORK_TASK_MAX_CHARS, resources ≤ WORK_RESOURCES_MAX entries with labels ≤
 * WORK_RESOURCE_LABEL_MAX_CHARS. Malformed resource entries (no usable label) are
 * DROPPED, never fatal. Recognized WorkProposalPayload fields are carried through;
 * unknown keys are preserved so nothing the model attached is silently lost.
 */
function clampWorkProposalPayload(
  raw: Record<string, unknown>,
  task: string,
): Record<string, unknown> {
  const clamped: Record<string, unknown> = { ...raw }
  clamped.task = task.slice(0, WORK_TASK_MAX_CHARS)

  // deliverable_hint — keep only a recognized enum value.
  const hint = raw.deliverable_hint
  if (hint === 'email_draft' || hint === 'document' || hint === 'board_update' || hint === 'mixed') {
    clamped.deliverable_hint = hint as WorkProposalPayload['deliverable_hint']
  } else {
    delete clamped.deliverable_hint
  }

  // resources — clamp count + label length, drop label-less entries.
  if (Array.isArray(raw.resources)) {
    const cleaned: WorkResourceRef[] = []
    for (const entry of raw.resources) {
      if (cleaned.length >= WORK_RESOURCES_MAX) break
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const label = typeof e.label === 'string' ? e.label.trim() : ''
      // A retired kind name (a model's `email`) is kept under its current one.
      const type = typeof e.type === 'string' ? canonicalEntityType(e.type.trim()) : ''
      if (!label || !type) continue // malformed → drop, don't fail the card
      const ref: WorkResourceRef = { type, label: label.slice(0, WORK_RESOURCE_LABEL_MAX_CHARS) }
      // The id survives ONLY for a known resource type (LINKABLE_ENTITY_TYPES ∪
      // 'package'). An unknown type keeps its label chip but loses the id, so a
      // garbage type can't smuggle an unresolvable id through to the brief — this
      // matches Start's snapshot behavior (verdict-apply.ts W-A / route W-C).
      if (typeof e.id === 'string' && e.id.trim() && KNOWN_RESOURCE_TYPES.has(type)) {
        ref.id = e.id.trim()
      }
      cleaned.push(ref)
    }
    if (cleaned.length > 0) clamped.resources = cleaned
    else delete clamped.resources
  } else {
    delete clamped.resources
  }

  // role / expects (step 2): keep only the closed-set role and well-formed
  // expectations; anything else is dropped, never fatal (the card still works).
  if (isWorkRole(raw.role)) clamped.role = raw.role
  else delete clamped.role
  const expects = normalizeWorkExpects(raw.expects)
  if (expects) clamped.expects = expects
  else delete clamped.expects

  return clamped
}

// ── shared: card payload + insert ────────────────────────────────────────────

/** The snapshot the card's pickers/actions read (title, properties, provenance). */
function cardPayload(change: ProposedChange, decision: Pick<VerdictDecision, 'corrections' | 'confidence'>): Record<string, unknown> {
  const corrected = applyCorrections(change, decision)
  return {
    change_type: change.change_type,
    entity_type: change.entity_type,
    // W-4b: carry the resolved target id so the card can tell a one-click
    // "Apply update" from a needs-target update (null → needs a picker).
    entity_id: change.entity_id ?? null,
    title: corrected.title || corrected.display_text,
    display_text: corrected.display_text,
    description: corrected.description ?? null,
    priority: corrected.priority ?? null,
    due_date: corrected.due_date ?? null,
    project_id: corrected.project_id ?? null,
    assignee_member_id: corrected.assignee_member_id ?? null,
    assignee_ai_member_id: (corrected.extra?.assignee_ai_member_id as string | undefined) ?? null,
    capture_id: change.capture_id ?? null,
    confidence: decision.confidence,
    // Email draft fields (draft_email cards).
    email_to_name: change.email_to_name ?? null,
    email_to_address: change.email_to_address ?? null,
    email_subject: change.email_subject ?? null,
    email_context: change.email_context ?? null,
  }
}

/**
 * Fixed namespace UUID for deterministically-keyed attention_item rows. Distinct,
 * arbitrary, and stable — any valid UUID works as a v5 namespace. Same technique
 * as agents/onboarding-researcher/lib/seed-id.ts (hand-rolled v5 over node:crypto,
 * no npm `uuid` dep), used here to make a proposal_id-less card retry-idempotent.
 */
const ATTENTION_ITEM_NAMESPACE = 'b7f1a3d2-4c6e-5a8b-9f01-2d3e4c5b6a70'

/**
 * A deterministic id for a proposal_id-less card, so an Inngest retry of the
 * verdict step re-inserts the SAME primary key (and the 23505 handler dedups it)
 * instead of minting a fresh random id and double-carding.
 *
 * WHY this is needed: both attention_item dedup indexes
 * (attention_item_proposal_run_uidx and attention_item_pending_proposal_uidx) are
 * partial on `proposal_id IS NOT NULL`. A work_proposal card is needs_user-only —
 * it carries proposal_id = NULL — so it is exempt from BOTH indexes. Without a
 * stable id, a retried step re-inserts the same work card (fresh gen_random_uuid),
 * the user sees two Start buttons, and pressing them dispatches DUPLICATE agent
 * runs. Anchoring the id on (run_key, kind, title) makes the re-insert collide on
 * the PRIMARY KEY — the same 23505 the uidx path already swallows as 'deduped'.
 *
 * Scoped by run_key (stable across a fire's step retries) so the SAME item within
 * one fire is idempotent while a genuinely new fire (fresh run_key) mints a
 * distinct card. Only used when proposal_id is null AND run_key is present — a
 * proposal-backed card keeps the default random id (the partial indexes already
 * dedup it), and a card with no run_key has no stable retry key to anchor on.
 */
export function deterministicCardId(runKey: string, kind: string, title: string): string {
  return uuidv5([runKey, kind, title].join('\x1f'), ATTENTION_ITEM_NAMESPACE)
}

/**
 * RFC-4122 v5 UUID: SHA-1 of (namespace bytes || name), version nibble forced to
 * 5 and variant bits to 10. Deterministic, dependency-free — mirrors seed-id.ts.
 */
function uuidv5(name: string, namespace: string): string {
  const nsBytes = new Uint8Array(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
  const nameBytes = new Uint8Array(Buffer.from(name, 'utf8'))
  const digest = createHash('sha1').update(nsBytes).update(nameBytes).digest()

  const bytes = new Uint8Array(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10

  const hex = Buffer.from(bytes).toString('hex')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  )
}

/** The payload keys only the server writes: who raised a card, its run's
 *  ledger row and its flow (bots v3 1a). */
export const CARD_ATTRIBUTION_KEYS = ['raised_by_ai_member_id', 'work_item_id', 'flow_id'] as const

/** Insert one attention card, reporting the OUTCOME so the caller can count real
 *  inserts separately from dedups/failures (1e-i): 'inserted' (row landed),
 *  'deduped' (23505 on the partial `attention_item_proposal_run_uidx` unique
 *  index on (proposal_id, run_key) — OR, for a proposal_id-less card, on the
 *  deterministic PRIMARY KEY — already surfaced, idempotent), 'failed' (any other
 *  error). NOTE: the dedup key is run_key, NOT source_flow_run_id (which is a
 *  fresh uuid per Inngest retry and would NOT catch a retry). source_flow_run_id
 *  is left NULL here and BACK-FILLED by the dispatcher after the flow_run row is
 *  written — it is a real FK to flow_run(id), which doesn't exist yet at
 *  card-insert time (the flow_run row is recorded after the run returns). */
async function insertAttentionCard(
  card: CardCandidate,
  ctx: ApplyVerdictContext,
): Promise<'inserted' | 'deduped' | 'failed'> {
  // Stamp provenance into the payload so the card can render a "from <skill> ·
  // <capture>" footer without a client fetch. Only add keys that are present.
  // Attribution (bots v3 1a) is the server's alone: the model's payload never
  // names who raised a card or which run it belongs to, so those keys are
  // dropped from it and set from the context.
  const modelPayload: Record<string, unknown> = { ...card.payload }
  for (const key of CARD_ATTRIBUTION_KEYS) delete modelPayload[key]
  const payload = {
    ...modelPayload,
    ...(ctx.provenance?.skillName ? { skill_name: ctx.provenance.skillName } : {}),
    ...(ctx.provenance?.captureTitle ? { capture_title: ctx.provenance.captureTitle } : {}),
    ...(ctx.teammateId ? { raised_by_ai_member_id: ctx.teammateId } : {}),
    ...(ctx.workItemId ? { work_item_id: ctx.workItemId } : {}),
    ...(ctx.flowId ? { flow_id: ctx.flowId } : {}),
  }
  const title = card.title.slice(0, 500)
  // Proposal_id-less cards (e.g. work_proposal) escape BOTH partial dedup indexes
  // (both are `where proposal_id is not null`), so a step retry would re-insert a
  // fresh-random-id duplicate. Give those a DETERMINISTIC id keyed on the stable
  // (run_key, kind, title) so the retry collides on the PRIMARY KEY → 'deduped'.
  // Proposal-backed cards keep the DB default (the uidx dedups them).
  const deterministicId =
    card.proposal_id == null && ctx.runKey != null
      ? deterministicCardId(ctx.runKey, card.kind, title)
      : null
  // The entity the card is about, as columns (migration 280): the entity tab
  // and its realtime filter join on these instead of walking the payload.
  const ref = cardEntityRef(card.kind, payload)
  const { error } = await ctx.supabase.from('attention_item').insert({
    ...(deterministicId ? { id: deterministicId } : {}),
    workspace_id: ctx.workspaceId,
    member_id: ctx.memberId,
    kind: card.kind,
    title,
    why: card.why ? card.why.slice(0, 1000) : null,
    payload,
    proposal_id: card.proposal_id,
    run_key: ctx.runKey,
    entity_type: ref.entityType,
    entity_id: ref.entityId,
    capture_id: ref.captureId,
    // NULL at insert; the dispatcher back-fills it once the flow_run row exists
    // (the FK forbids referencing a not-yet-written run — the source of the
    // earlier 23503 card-drop bug).
    source_flow_run_id: null,
    expires_at: new Date(Date.now() + CARD_TTL_MS).toISOString(),
  })
  if (!error) return 'inserted'
  // Unique-violation = already surfaced (idempotent retry OR a duplicate
  // candidate). 23505 covers BOTH a unique-index conflict and a PRIMARY KEY
  // conflict (the deterministic-id retry path) — the SQLSTATE is the same for
  // both, and this matches on the state, not the constraint name. Counted as
  // deduped — NEVER as surfaced, so the notification count matches the rows that
  // actually exist (the Jul-6 overstatement fix).
  if ((error as { code?: string }).code === '23505') return 'deduped'
  return 'failed'
}
