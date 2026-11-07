import { getServiceClient } from '@/lib/admin'
import { logUsage } from '@/lib/ai/auth'
import { usageProviderLabel } from '@/lib/ai/models'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import { runDecision } from '@/lib/ai/decisions/run-decision'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { resolveUtilityModel } from '@/lib/eve/utility/spec'
import { embed } from '@/lib/ai/embeddings'
import {
  resolveClaimsAutoAcceptPolicy,
  shouldPromoteByCorroboration,
  CORROBORATION_CONFIDENCE_SLACK,
} from '@/lib/knowledge/auto-accept'
import { regenerateWorkspaceBriefs } from '@/lib/knowledge/brief'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'
import { excludePrivateSourcedClaims } from '@/lib/knowledge/claim-visibility'
import { anchorDescriptor, entityDescriptor } from '@/lib/knowledge/entity-registry'
import { resolveWeaverSettings, type AnchorType } from '@/lib/knowledge/anchor-types'
import { z } from 'zod'
import { inngest } from './client'

// The claim-visibility rule moved to lib/knowledge (brief.ts needs it too and
// cannot import from lib/inngest without a cycle); re-exported from its
// historical home so existing importers are unaffected.
export { filterClaimsVisibleToNobody } from '@/lib/knowledge/claim-visibility'

/**
 * knowledge/weaver — the nightly pass that makes knowledge COMPOUND instead of
 * pile up. Three phases per workspace, cheapest first:
 *
 *   1. PROMOTE (pure SQL, zero LLM): retroactively confirm suggested claims
 *      that clear the workspace auto-accept threshold (the pre-auto-accept
 *      backlog), and corroboration-promote suggested claims that accumulated
 *      multiple independent sources.
 *
 *   2. WEAVE (vectors first, LLM only for the ambiguous band): for each
 *      not-yet-woven claim, find semantic neighbors using the embeddings that
 *      ALREADY exist in claim_chunks (no re-embedding). Then:
 *        - sim < SIM_FLOOR            → unrelated, skip (no LLM)
 *        - sim ≥ SIM_AUTO_MERGE AND high lexical overlap
 *                                     → duplicate, merge without an LLM call
 *        - everything between        → bounded Jev judgments per claim,
 *          with one utility fallback for only the unresolved candidates,
 *          classifying all its candidates at once (duplicate / related_to /
 *          contradicts / depends_on / none). The lexical check above exists
 *          because pure vector similarity CANNOT tell "launch moved to Q3"
 *          from "launch is in Q2" — near-identical embeddings, opposite
 *          meaning. Disagreeing values/dates must reach the judge.
 *      Claims are stamped woven_at as they're processed, so the backlog
 *      drains across nights and nothing is ever judged twice.
 *
 *   2b. ANCHOR LINK: link each claim to the workspace's ANCHORS — the entity
 *      types it organizes knowledge around (project, company, campaign;
 *      "anchors are configuration", resolved per workspace from its features
 *      and settings.weaver.anchor_types). Vectors first, per-type thresholds
 *      from ENTITY_REGISTRY, and ONE pooled judge call per claim across every
 *      type, so N anchor types cost what one used to.
 *
 *   2c. BACKFILL LINK (vectors first, tiny separate judge budget): Phase 2b
 *      only ever sees a claim on the night it is FIRST woven, so a claim woven
 *      before its anchor existed stays anchor-less forever. This pass revisits
 *      already-woven, still-active claims missing at least one of the
 *      workspace's anchor types and runs them through the same tiering, offering
 *      only the types they are missing. Below-floor candidates cost nothing, so
 *      it is free until the workspace's anchors actually match — and it is what
 *      catches up a workspace the day it turns CRM on.
 *
 *   3. BRIEFS (LLM only for changed scopes): recompile the workspace /
 *      anchor / package briefs whose claim fingerprints changed.
 *
 * Cost ceiling per workspace per night: ≤ JUDGE_CALLS_PER_WORKSPACE judge
 * calls for weaving (~700 tokens in / ~120 out each), ≤
 * BACKFILL_JUDGE_CALLS_PER_WORKSPACE for the backfill (a SEPARATE budget, so
 * the backfill can never starve claim-relation judging), plus one call per
 * CHANGED brief. A quiet workspace costs zero LLM calls. Workspaces can set
 * settings.weaver.llm_judge=false to run vectors-only (related_to edges from
 * the band, no merges/contradictions).
 *
 * Workspace selection: phases 1/2 run on workspaces with a weaving BACKLOG,
 * while phase 3 runs on the UNION of those and workspaces whose briefs went
 * stale (claims edited/promoted without any new claims arriving) — a workspace
 * that goes claim-quiet for one night must not lose brief regeneration forever.
 * Each workspace's work is isolated: one workspace throwing must not abort the
 * nightly run for every other workspace.
 */

export const SIM_FLOOR = 0.8
export const SIM_AUTO_MERGE = 0.97
const LEXICAL_AUTO_MERGE = 0.9
const CLAIMS_PER_WORKSPACE = 60
/** Windows of CLAIMS_PER_WORKSPACE unwoven claims read past the ones that never weave. */
const QUEUE_WINDOWS = 5
const CANDIDATES_PER_CLAIM = 5
const JUDGE_CALLS_PER_WORKSPACE = 30
const PROMOTE_BATCH = 400
const WORKSPACES_PER_RUN = 20

// Phase 2c — project-link backfill. Bounded per workspace per run, with its
// OWN judge budget so it can never eat into JUDGE_CALLS_PER_WORKSPACE (the
// claim-relation pass is the higher-value spend and always goes first).
const BACKFILL_LINK_PER_WORKSPACE = 40
const BACKFILL_JUDGE_CALLS_PER_WORKSPACE = 10
// Cap on the already-linked ids sent as a NOT IN filter: the list travels in
// the request URL, so it cannot be unbounded. ~1000 UUIDs is ~37KB, well inside
// PostgREST's limit, and selectBackfillClaims re-applies the full exclusion in
// JS so nothing linked ever slips through.
const BACKFILL_EXCLUDE_MAX = 1000

// Phase 3 brief-staleness scan: how many recent active claims to inspect when
// deciding which workspaces have briefs older than their claims. Read-only, and
// ordered updated_at DESC — so the claims that could possibly be newer than a
// brief are exactly the ones this window holds. A workspace whose every claim
// falls outside the window is by construction NOT stale (its brief is newer
// than all of them), so the window bounds cost without missing staleness.
const BRIEF_STALE_CLAIM_SCAN = 4000
// A workspace with no workspace-scope brief row is only "stale" once it has
// enough claims for generateBriefForScope to produce one (its MIN_CLAIMS floor).
// Counted within the scan window; a brief-less workspace whose claims are all
// older than the window is one generateBriefForScope would call 'empty' anyway.
const BRIEF_MIN_CLAIMS = 3

// Phase 2b — claim↔ANCHOR linking (plan item 17, generalized by "anchors are
// configuration"). A claim whose text is a near-restatement of an anchor's
// descriptive text is auto-linked; the ambiguous middle band goes to the
// judge; below the floor is "no anchor". Same two-tier philosophy as the
// claim↔claim tiering above.
//
// The thresholds are PER ANCHOR TYPE and live in ENTITY_REGISTRY (a company's
// name+enrichment text scores differently against a claim than a project's
// name+description does, so one global pair could only ever be right for one
// of them). These two are the fallback for a type whose descriptor somehow
// carries none, and the historical project values are what they are set to.
export const PROJECT_LINK_AUTO = 0.85
export const PROJECT_LINK_FLOOR = 0.55
// Anchor descriptions can run long; cap so one verbose company can't blow the
// judge prompt (the auto-tier is on embedding similarity, not this text).
const ANCHOR_DESC_MAX = 400
// The embedded text itself gets a much larger cap than the prompt slice above:
// embeddings tolerate long input, judge prompts do not, and the two caps serve
// different purposes.
const ANCHOR_EMBED_MAX = 2000

// Weaver judge/project-link calls run on the knowledge surface's fixed model
// (SURFACE_MODELS), resolved once per workspace in the sweep loop.

const PairVerdicts = z.object({
  verdicts: z.array(
    z.object({
      candidate_id: z.string(),
      relation: z.enum([
        'duplicate',
        'related_to',
        'contradicts',
        'depends_on',
        'none',
      ]),
    }),
  ),
})

// The pair judge's rules (its system prompt) live with the utility agent's
// other prompts: src/lib/eve/utility/prompts.ts WEAVER_PAIR_JUDGE_PROMPT.

// Phase 2b judge: ONE pooled call per claim across EVERY anchor type the
// workspace uses. Candidates arrive typed ("[project] …", "[company] …") and
// the judge picks at most one of them, or none. Pooling is what keeps the
// generalization free: N anchor types still cost one judge call per claim, and
// the judge sees the alternatives it is choosing against — a claim that looks
// half like a project and half like a company is exactly the case a per-type
// judge would resolve twice, badly.
const AnchorVerdict = z.object({
  anchor_type: z
    .string()
    .nullable()
    .describe("The chosen candidate's type, exactly as given in brackets, or null."),
  anchor_id: z
    .string()
    .nullable()
    .describe('The id of the single best-fit anchor, or null if none fits.'),
})

// The anchor judge's rules live there too: WEAVER_ANCHOR_JUDGE_PROMPT.

/**
 * The task message for the claim↔claim judge — byte-identical to the prompt
 * the pre-port generateObject call sent.
 */
export function pairJudgeMessage(
  claimText: string,
  candidates: ReadonlyArray<{ claim_id: string; claim_text: string }>,
): string {
  return `NEW claim:\n${claimText}\n\nCANDIDATES:\n${candidates
    .map((c) => `- candidate_id ${c.claim_id}: ${c.claim_text}`)
    .join('\n')}`
}

/**
 * The task message for the pooled anchor judge — byte-identical to the prompt
 * the pre-port generateObject call sent.
 */
export function anchorJudgeMessage(
  claimText: string,
  candidates: ReadonlyArray<Pick<AnchorCandidate, 'entity_type' | 'entity_id' | 'name' | 'description'>>,
): string {
  return `CLAIM:\n${claimText}\n\nCANDIDATE ANCHORS:\n${candidates
    .map(
      (c) =>
        `- [${c.entity_type}] ${c.entity_id}: ${c.name}${
          c.description ? ` — ${c.description.slice(0, ANCHOR_DESC_MAX)}` : ''
        }`,
    )
    .join('\n')}`
}

/**
 * Jev resolves up to four candidate relationships at once, serially within the
 * existing per-claim judgment slot. Only unresolved batches reach one utility
 * session. Its existing model/billing policy stays intact; Jev meters itself.
 */
export async function runPairJudge(args: {
  ws: string
  knowledgeModel: string
  ownerUserId: string | undefined
  claimId?: string
  claimText: string
  candidates: ReadonlyArray<{ claim_id: string; claim_text: string }>
}): Promise<z.infer<typeof PairVerdicts>> {
  const { ws, knowledgeModel, ownerUserId } = args
  const accepted: z.infer<typeof PairVerdicts>['verdicts'] = []
  const unresolved: Array<(typeof args.candidates)[number]> = []
  // The surrounding weaver caps candidates at five. Keep larger external calls
  // on the old one-session path instead of allowing unbounded decision fanout.
  if (ownerUserId && args.candidates.length <= CANDIDATES_PER_CLAIM) {
    for (let start = 0; start < args.candidates.length; start += 4) {
      const batch = args.candidates.slice(start, start + 4)
      try {
        const decision = await runDecision('knowledge.relationship', { claimText: args.claimText, candidates: [...batch] },
          { userId: ownerUserId, workspaceId: ws, runId: args.claimId })
        const parsed = decision.status === 'accepted' ? PairVerdicts.safeParse(decision.value) : null
        const ids = new Set(batch.map(candidate => candidate.claim_id))
        if (parsed?.success && parsed.data.verdicts.length === batch.length &&
            new Set(parsed.data.verdicts.map(verdict => verdict.candidate_id)).size === batch.length &&
            parsed.data.verdicts.every(verdict => ids.has(verdict.candidate_id))) {
          accepted.push(...parsed.data.verdicts)
          continue
        }
      } catch { /* An unavailable decision preserves the existing utility judge. */ }
      unresolved.push(...batch)
    }
    if (!unresolved.length) return { verdicts: accepted }
  } else unresolved.push(...args.candidates)
  const result = await runUtilityTask({
    kind: 'knowledge_weaver_judge',
    model: knowledgeModel,
    workspaceId: ws,
    // ownerUserId may be undefined (a workspace with no resolvable owner) →
    // Gateway attribution is feature + workspace only.
    userId: ownerUserId ?? null,
    // A free owner's judge runs on their own ChatGPT plan (Jev, above, is
    // Dial8-paid and refuses them, so the fallback is their only judge).
    chatgptPlan: await chatgptPlanFor(ownerUserId),
    outputSchema: PairVerdicts,
    message: pairJudgeMessage(args.claimText, unresolved),
  }).catch(error => {
    // Successful batches remain useful if the unresolved utility call fails.
    // With no accepted batch, retain the old throwing failure contract.
    if (accepted.length) return null
    throw error
  })
  if (!result) return { verdicts: accepted }
  if (ownerUserId) {
    await logUsage(ownerUserId, {
      // Derive provider/model from the model actually running — the
      // workspace's "Knowledge graph" default, NOT the global one — so the
      // (provider, model) pair matches its ai_model_costs row. A wrong pair
      // would miss the pricing row and bill at the $15/$75 catch-all. Bare app
      // id, not the Gateway slug: that is what the pricing table is keyed by
      // (every other logUsage site logs the same form).
      provider: usageProviderLabel(result.model),
      model: result.model,
      feature: 'knowledge_weaver_judge',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      durationMs: 0,
      // eve's cost is 0/absent → null → omitted: the RPC prices from ai_model_costs.
      costUsd: result.usage.costUsd ?? undefined,
      metadata: { workspace_id: ws, ...usageCacheMetadata(result.usage) },
    })
  }
  // A fallback response cannot overrule a batch Jev already accepted or name
  // a candidate it was not shown. The outer loop retains its merge safeguards.
  const unresolvedIds = new Set(unresolved.map(candidate => candidate.claim_id))
  return { verdicts: [...accepted, ...result.object.verdicts.filter(verdict => unresolvedIds.has(verdict.candidate_id))] }
}

/**
 * One bounded Jev choice over the pooled anchors, then the existing utility
 * judge only if uncertain/unavailable. An unowned workspace retains its old
 * utility path rather than bypassing the shared runner's membership check.
 */
export async function runAnchorJudge(args: {
  ws: string
  knowledgeModel: string
  ownerUserId: string | undefined
  claimId?: string
  claimText: string
  candidates: readonly AnchorCandidate[]
  usageMetadata: Record<string, unknown>
}): Promise<z.infer<typeof AnchorVerdict>> {
  const { ws, knowledgeModel, ownerUserId } = args
  if (ownerUserId && args.candidates.length > 0) {
    try {
      const decision = await runDecision('knowledge.anchor', { claimText: args.claimText,
        candidates: args.candidates.map(candidate => ({ entity_type: candidate.entity_type, entity_id: candidate.entity_id,
          name: candidate.name, description: candidate.description?.slice(0, ANCHOR_DESC_MAX) ?? null })) },
      { userId: ownerUserId, workspaceId: ws, runId: args.claimId })
      if (decision.status === 'accepted' &&
          ((decision.value.anchor_type === null && decision.value.anchor_id === null) || validateAnchorVerdict(decision.value, args.candidates))) {
        return decision.value
      }
    } catch { /* An unavailable decision preserves the existing utility judge. */ }
  }
  const result = await runUtilityTask({
    kind: 'knowledge_weaver_anchor_link',
    model: knowledgeModel,
    workspaceId: ws,
    userId: ownerUserId ?? null,
    // A free owner's judge runs on their own ChatGPT plan.
    chatgptPlan: await chatgptPlanFor(ownerUserId),
    outputSchema: AnchorVerdict,
    message: anchorJudgeMessage(args.claimText, args.candidates),
  })
  if (ownerUserId) {
    await logUsage(ownerUserId, {
      // The model that ACTUALLY ran (the workspace's knowledge-graph
      // default), as a bare app id — what ai_model_costs is keyed by.
      provider: usageProviderLabel(result.model),
      model: result.model,
      // Renamed from 'knowledge_weaver_project_link': the feature label
      // feeds cost-by-feature reporting, and this judge now links companies
      // and campaigns too.
      feature: 'knowledge_weaver_anchor_link',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      durationMs: 0,
      costUsd: result.usage.costUsd ?? undefined,
      metadata: { workspace_id: ws, ...args.usageMetadata, ...usageCacheMetadata(result.usage) },
    })
  }
  return result.object
}

/**
 * Token-level Jaccard overlap, used as the cheap second factor for no-LLM
 * merges. Two claims that disagree only on a number/date share most tokens
 * but not all — they fall below LEXICAL_AUTO_MERGE and reach the judge.
 */
export function lexicalOverlap(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1),
    )
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  return inter / (ta.size + tb.size - inter)
}

export interface WeaveCandidate {
  claim_id: string
  claim_text: string
  confirmation: string
  similarity: number
}

/**
 * Split a claim's vector neighbors into no-LLM merges vs. judge-needed
 * candidates. Exported pure so the tiering is unit-testable.
 */
export function partitionCandidates(
  claimText: string,
  candidates: WeaveCandidate[],
): { autoMerge: WeaveCandidate[]; judge: WeaveCandidate[] } {
  const autoMerge: WeaveCandidate[] = []
  const judge: WeaveCandidate[] = []
  for (const c of candidates) {
    if (c.similarity < SIM_FLOOR) continue
    if (
      c.similarity >= SIM_AUTO_MERGE &&
      lexicalOverlap(claimText, c.claim_text) >= LEXICAL_AUTO_MERGE
    ) {
      autoMerge.push(c)
    } else {
      judge.push(c)
    }
  }
  return { autoMerge, judge: judge.slice(0, CANDIDATES_PER_CLAIM) }
}

/**
 * Full cosine similarity between two vectors (normalizes internally, so it
 * doesn't assume unit-length inputs). Used for the claim↔project match; kept
 * local so the weaver stays self-contained and unit-testable.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * pgvector returns embeddings as a JSON-array string ("[0.1,0.2,...]") over
 * the wire. Parse it to a number[] for in-JS cosine; returns null on anything
 * that isn't a numeric vector so a bad row can't crash the pass.
 */
export function parseEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    return raw.every((n) => typeof n === 'number') ? (raw as number[]) : null
  }
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')) {
      return parsed as number[]
    }
  } catch {
    /* not JSON — fall through */
  }
  return null
}

export interface AnchorCandidate {
  entity_type: string
  entity_id: string
  name: string
  description: string | null
  similarity: number
}

export interface AnchorThresholds {
  auto: number
  floor: number
}

/** A type's thresholds from the registry, falling back to the project pair. */
export function anchorThresholds(type: string): AnchorThresholds {
  const a = anchorDescriptor(type)
  return {
    auto: a?.autoThreshold ?? PROJECT_LINK_AUTO,
    floor: a?.floorThreshold ?? PROJECT_LINK_FLOOR,
  }
}

export interface AnchorPartition {
  /**
   * At most one auto-link PER TYPE — zero, one, or several. A claim that is
   * clearly about a company does not stop being about a campaign, so unlike
   * the project-only predecessor this is a LIST: every type whose own top
   * candidate clears its own auto bar gets linked. Within a type the
   * single-winner rule is unchanged.
   */
  auto: AnchorCandidate[]
  /**
   * The pooled ambiguous band: every type's floor-clearing candidates, merged,
   * ranked, capped — ONE judge call sees them all and picks at most one.
   */
  judge: AnchorCandidate[]
}

/**
 * Tier a claim's cosine matches against the workspace's anchor embeddings,
 * mirroring the claim↔claim tiering — but per anchor type, since each type
 * carries its own thresholds:
 *   - a type whose top match < its floor      → that type contributes nothing
 *   - a type whose top match ≥ its auto bar   → auto-link it, no LLM
 *   - a type in the ambiguous band in between → its floor-clearing candidates
 *     join the POOLED judge list
 * A type that auto-linked is deliberately absent from the judge list: it is
 * already decided, and offering it would let the judge overrule the vectors.
 * Exported pure so the tiering is unit-testable without a DB or an LLM.
 */
export function partitionAnchorCandidates(
  candidates: AnchorCandidate[],
  thresholds: (type: string) => AnchorThresholds = anchorThresholds,
): AnchorPartition {
  const byType = new Map<string, AnchorCandidate[]>()
  for (const c of candidates) {
    const list = byType.get(c.entity_type)
    if (list) list.push(c)
    else byType.set(c.entity_type, [c])
  }

  const auto: AnchorCandidate[] = []
  const band: AnchorCandidate[] = []
  for (const [type, list] of byType) {
    const { auto: autoBar, floor } = thresholds(type)
    const ranked = [...list].sort((a, b) => b.similarity - a.similarity)
    const top = ranked[0]
    if (!top || top.similarity < floor) continue
    if (top.similarity >= autoBar) {
      auto.push(top)
      continue
    }
    for (const c of ranked) {
      if (c.similarity >= floor) band.push(c)
    }
  }

  // Best-first across types, then capped — a workspace with four anchor types
  // must not send four times as much prompt as one with a single type.
  auto.sort((a, b) => b.similarity - a.similarity)
  const judge = band
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, CANDIDATES_PER_CLAIM)
  return { auto, judge }
}

/**
 * Should the pooled judge be called for this claim? Pure so the budget-sharing
 * and kill-switch behaviors are unit-testable without a DB or an LLM.
 *
 * Note what this does NOT decide: the auto-tier. Under one global threshold an
 * auto-link was the whole answer for a claim, so the old `decideProjectLink`
 * could return 'auto-link' and suppress the judge. With per-type thresholds a
 * claim can be auto-decided for one type and still ambiguous for another, so
 * `partition.auto` is written UNCONDITIONALLY by the caller (it costs nothing
 * and needs no permission) and this gate covers only the LLM spend.
 *
 * `judgeBudget` is the SHARED JUDGE_CALLS_PER_WORKSPACE counter after the
 * claim↔claim pass spent its share — claim-relations first, remainder here.
 */
export function shouldJudgeAnchors(
  partition: AnchorPartition,
  llmJudge: boolean,
  judgeBudget: number,
): boolean {
  if (!llmJudge) return false
  if (partition.judge.length === 0) return false
  if (judgeBudget <= 0) return false
  return true
}

export interface BriefStaleClaimRow {
  workspace_id: string
  updated_at: string
}

export interface BriefStaleBriefRow {
  workspace_id: string
  generated_at: string
}

/**
 * Which workspaces need their briefs recompiled, independent of whether they
 * have any UNWOVEN claims.
 *
 * The bug this exists for: Phase 3 used to run only for the workspaces picked
 * by the weave list (active claims with woven_at IS NULL). A workspace whose
 * claims keep CHANGING — promoted, edited, merged — but which adds no new
 * claims drops off that list entirely, and its briefs freeze at whatever they
 * said the last night a claim happened to be new. Brief freshness depends on
 * claim `updated_at`, not on the weave backlog, so it gets its own selection.
 *
 * A workspace is brief-stale when either:
 *   - it has ≥1 active claim whose updated_at is newer than the workspace-scope
 *     brief's generated_at, or
 *   - it has ≥ minClaims active claims and NO workspace-scope brief row at all
 *     (a workspace that never got a first brief).
 *
 * Over-selection is cheap: generateBriefForScope fingerprints the claim set and
 * skips unchanged scopes without an LLM call. Pure so the selection rule is
 * unit-testable without a DB.
 */
export function selectBriefStaleWorkspaces(
  claims: BriefStaleClaimRow[],
  briefs: BriefStaleBriefRow[],
  cap: number,
  minClaims = BRIEF_MIN_CLAIMS,
): string[] {
  const generatedAt = new Map<string, number>()
  for (const b of briefs) {
    generatedAt.set(b.workspace_id, new Date(b.generated_at).getTime())
  }

  // Per workspace: newest claim updated_at, and how many claims were seen.
  const newest = new Map<string, number>()
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const c of claims) {
    const ws = c.workspace_id
    if (!counts.has(ws)) order.push(ws)
    counts.set(ws, (counts.get(ws) ?? 0) + 1)
    const t = new Date(c.updated_at).getTime()
    if (Number.isNaN(t)) continue
    if (!newest.has(ws) || t > (newest.get(ws) as number)) newest.set(ws, t)
  }

  const stale: string[] = []
  for (const ws of order) {
    const briefAt = generatedAt.get(ws)
    if (briefAt === undefined) {
      if ((counts.get(ws) ?? 0) >= minClaims) stale.push(ws)
      continue
    }
    const claimAt = newest.get(ws)
    if (claimAt !== undefined && claimAt > briefAt) stale.push(ws)
  }
  return stale.slice(0, cap)
}

/**
 * Order-preserving de-dupe used to build the Phase 3 workspace list: the
 * workspaces actually processed this run first (their briefs are the ones most
 * likely to have changed), then the brief-stale extras.
 */
export function unionWorkspaces(...lists: string[][]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const ws of list) {
      if (seen.has(ws)) continue
      seen.add(ws)
      out.push(ws)
    }
  }
  return out
}

/**
 * Claims eligible for the Phase 2c anchor-link backfill, given the claim rows
 * the query returned and the set of claim ids that are FULLY anchored (they
 * already carry an `about` edge to EVERY one of the workspace's active anchor
 * types). A claim missing any type is still eligible — it is simply offered
 * only the types it lacks. The exclusion is applied in SQL (the caller passes
 * the fully-anchored ids into a `.not('id','in',…)` filter) so the per-run cap
 * is spent on genuinely under-anchored claims; this helper is the same rule
 * expressed purely, both as a belt-and-braces filter and so the eligibility is
 * unit-testable.
 */
export function selectBackfillClaims<T extends { id: string }>(
  claims: T[],
  fullyAnchored: Set<string>,
  cap: number,
): T[] {
  return claims.filter((c) => !fullyAnchored.has(c.id)).slice(0, cap)
}

type ServiceClient = ReturnType<typeof getServiceClient>

/**
 * The workspace owner, when they run on their own ChatGPT plan (the free
 * tier), else null: whose plan a workspace-scoped compile runs on.
 */
async function planOwnerOf(supabase: ServiceClient, ws: string): Promise<string | null> {
  const { data } = await supabase.from('member').select('user_id').eq('workspace_id', ws).eq('role', 'owner').limit(1).maybeSingle()
  const owner = (data?.user_id as string | undefined) ?? null
  return owner && (await chatgptPlanFor(owner)) ? owner : null
}

/** Upsert one claim↔claim edge; duplicates are silently ignored. */
async function upsertClaimEdge(
  supabase: ServiceClient,
  workspaceId: string,
  sourceClaimId: string,
  targetClaimId: string,
  relation: string,
): Promise<boolean> {
  if (sourceClaimId === targetClaimId) return false
  const { error } = await supabase.from('entity_link').upsert(
    {
      workspace_id: workspaceId,
      source_type: 'claim',
      source_id: sourceClaimId,
      target_type: 'claim',
      target_id: targetClaimId,
      relation,
      created_by: null,
    },
    {
      onConflict:
        'workspace_id,source_type,source_id,target_type,target_id,relation',
      ignoreDuplicates: true,
    },
  )
  return !error
}

/**
 * Upsert one claim→anchor `about` edge (Phase 2b linking). Idempotent against
 * the same unique constraint as claim↔claim edges, so re-runs and any edge the
 * extraction already wrote are silently ignored.
 */
async function upsertAnchorEdge(
  supabase: ServiceClient,
  workspaceId: string,
  claimId: string,
  anchorType: string,
  anchorId: string,
): Promise<boolean> {
  const { error } = await supabase.from('entity_link').upsert(
    {
      workspace_id: workspaceId,
      source_type: 'claim',
      source_id: claimId,
      target_type: anchorType,
      target_id: anchorId,
      relation: 'about',
      created_by: null,
    },
    {
      onConflict:
        'workspace_id,source_type,source_id,target_type,target_id,relation',
      ignoreDuplicates: true,
    },
  )
  return !error
}

/** Merge-rank key: confirmed beats suggested, then the OLDER claim wins. */
function mergeRank(c: { confirmation: string; created_at: string }): string {
  return `${c.confirmation === 'confirmed' ? 0 : 1}:${c.created_at}`
}

/**
 * Would `current` be the KEEPER (survivor) of a merge against `other`? Uses the
 * exact same rank rule mergeDuplicate applies, so the weave loop can tell —
 * without an extra query — whether merging left the current claim alive
 * (keeper) or superseded away (loser). When this returns false, the current
 * claim was merged AWAY: the loop MUST stop processing it (no further merges
 * into a dead claim, no judge phase, no project-linking). Exported pure so the
 * loser-short-circuit invariant is unit-testable without a DB or an LLM.
 */
export function mergeKeeperIsSelf(
  current: { confirmation: string; created_at: string },
  other: { confirmation: string; created_at: string },
): boolean {
  return mergeRank(current) <= mergeRank(other)
}

/**
 * Merge `dupe` into `keeper`: the dupe is superseded (pointer set), the
 * keeper gains the dupe's evidence rows and a supersedes edge. Keeper choice:
 * confirmed beats suggested, then the older claim wins (it's the original).
 */
export async function mergeDuplicate(
  supabase: ServiceClient,
  workspaceId: string,
  a: { id: string; confirmation: string; created_at: string },
  b: { id: string; confirmation: string; created_at: string },
): Promise<boolean> {
  const [keeper, dupe] = mergeRank(a) <= mergeRank(b) ? [a, b] : [b, a]

  const { error } = await supabase
    .from('claim')
    .update({ status: 'superseded', superseded_by: keeper.id })
    .eq('id', dupe.id)
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
  if (error) return false

  await upsertClaimEdge(supabase, workspaceId, keeper.id, dupe.id, 'supersedes')

  // Carry the dupe's evidence to the keeper so no provenance is lost.
  const { data: sources } = await supabase
    .from('claim_source')
    .select('source_type, source_id, source_uri, excerpt')
    .eq('claim_id', dupe.id)
    .limit(50)
  if (sources?.length) {
    await supabase.from('claim_source').upsert(
      sources.map((s) => ({ ...s, claim_id: keeper.id, workspace_id: workspaceId })),
      { onConflict: 'claim_id,source_type,source_id,source_uri', ignoreDuplicates: true },
    )
  }

  // MOVE the dupe's GRAPH EDGES to the keeper (plan item 8). The evidence copy
  // above only moved claim_source rows; without this the dupe's entity_link
  // edges (about→project, committed_to→member, related_to→claim, …) are silently
  // erased when status flips to superseded — the exact bug the plan calls out.
  // MOVE (copy → delete originals), not just copy: list_entity_links reads
  // entity_link directly with no status join, so leaving the dupe's originals
  // in place keeps a superseded claim's stale edges visible to direct readers.
  // Re-point both directions at the keeper:
  //   outbound: (source=claim/dupe → target X)  →  (source=claim/keeper → X)
  //   inbound:  (source Y → target=claim/dupe)  →  (Y → target=claim/keeper)
  // Skip rows that would become a keeper↔keeper SELF-LOOP (the no-self-loop
  // CHECK from mig 109 would otherwise make the whole insert error), and let the
  // unique constraint + ignoreDuplicates drop rows the keeper already has. The
  // supersedes edge just written (keeper→dupe) is an inbound-to-dupe edge; its
  // re-point would be keeper→keeper, so the self-loop filter correctly drops it.
  const { data: dupeEdges } = await supabase
    .from('entity_link')
    .select('source_type, source_id, target_type, target_id, relation, weight, created_by')
    .eq('workspace_id', workspaceId)
    .or(
      `and(source_type.eq.claim,source_id.eq.${dupe.id}),and(target_type.eq.claim,target_id.eq.${dupe.id})`,
    )
    .limit(500)
  if (dupeEdges?.length) {
    const repointed = dupeEdges
      .map((e) => {
        const isOutbound = e.source_type === 'claim' && e.source_id === dupe.id
        return {
          workspace_id: workspaceId,
          source_type: isOutbound ? 'claim' : (e.source_type as string),
          source_id: isOutbound ? keeper.id : (e.source_id as string),
          target_type: isOutbound ? (e.target_type as string) : 'claim',
          target_id: isOutbound ? (e.target_id as string) : keeper.id,
          relation: e.relation as string,
          weight: (e.weight as number | null) ?? null,
          created_by: (e.created_by as string | null) ?? null,
        }
      })
      // Drop keeper↔keeper self-loops (the CHECK forbids them).
      .filter(
        (r) =>
          !(r.source_type === r.target_type && r.source_id === r.target_id),
      )
    let copied = true
    if (repointed.length) {
      const { error: copyErr } = await supabase.from('entity_link').upsert(repointed, {
        onConflict:
          'workspace_id,source_type,source_id,target_type,target_id,relation',
        ignoreDuplicates: true,
      })
      copied = !copyErr
    }

    // Delete the dupe's ORIGINAL edges only after the copy succeeded (so a
    // failed copy never loses edges). Two deletes:
    //   outbound: every (source_type='claim', source_id=dupe) row.
    //   inbound:  every (target_type='claim', target_id=dupe) row EXCEPT the
    //             supersedes edge just written by upsertClaimEdge, whose source
    //             is the keeper — that edge IS the supersession chain and must
    //             survive.
    if (copied) {
      await supabase
        .from('entity_link')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('source_type', 'claim')
        .eq('source_id', dupe.id)

      // Complement of "keep the keeper→dupe supersedes edge": delete inbound
      // rows where NOT (source_id = keeper AND relation = supersedes), i.e.
      // (source_id != keeper) OR (relation != supersedes). Expressed as an
      // .or() so the keeper's supersession edge is the only inbound survivor.
      await supabase
        .from('entity_link')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('target_type', 'claim')
        .eq('target_id', dupe.id)
        .or(`source_id.neq.${keeper.id},relation.neq.supersedes`)
    }
  }
  return true
}

export interface AnchorEmbedding {
  entity_type: string
  entity_id: string
  name: string
  description: string | null
  embedding: number[]
}

/** How many anchor rows of ONE type are loaded per workspace per run. */
const ANCHORS_PER_TYPE = 500

/**
 * The text an anchor row is embedded as, per its registry descriptor, capped.
 * Pure and exported so the per-type composition (notably that a company folds
 * in its Exa enrichment blob, which is often the only real text it has) is
 * unit-testable without a DB or an embedding call.
 */
export function anchorEmbedText(entityType: string, row: Record<string, unknown>): string {
  const descriptor = anchorDescriptor(entityType)
  if (!descriptor) return ''
  return descriptor.embedText(row).slice(0, ANCHOR_EMBED_MAX).trim()
}

/**
 * The short label+description pair shown to the judge. `description` falls
 * back to the rest of the embed text for a type whose table has no description
 * column, so a company with only an enrichment blob is still recognizable in
 * the prompt.
 */
export function anchorDisplay(
  entityType: string,
  row: Record<string, unknown>,
): { name: string; description: string | null } {
  const descriptor = entityDescriptor(entityType)
  const name = descriptor ? descriptor.label.render(row) : String(row.name ?? '')
  const text = anchorEmbedText(entityType, row)
  // Everything after the name is the description. Newlines are collapsed
  // because the judge prompt is one line per candidate — an embedded newline
  // would split a company across two bullets and make its id unattributable.
  const rest = (text.startsWith(name) ? text.slice(name.length) : text)
    .replace(/\s+/g, ' ')
    .trim()
  return { name, description: rest || null }
}

/**
 * Load every anchor's embedding for a workspace, for each of the workspace's
 * ACTIVE anchor types, refreshing the `anchor_embedding` cache first (plan
 * item 17, generalized). An anchor is embedded exactly once and only
 * re-embedded when its source row changed since (live `updated_at` strictly
 * newer than the cached `source_updated_at`) — so on a quiet workspace this is
 * pure reads, zero embedding spend.
 *
 * Returns the usable embeddings as number[] (cached rows parsed from the
 * pgvector wire string, freshly-computed rows used directly). Anchors that fail
 * to embed — or types with no table yet, like `campaign` before its migration —
 * are simply absent: the linking pass has fewer candidates, never a crash.
 */
async function refreshAnchorEmbeddings(
  supabase: ServiceClient,
  workspaceId: string,
  ownerUserId: string | undefined,
  anchorTypes: readonly string[],
): Promise<AnchorEmbedding[]> {
  const result: AnchorEmbedding[] = []
  if (anchorTypes.length === 0) return result

  // One cache read for the whole workspace, sliced per type below — the old
  // project-only code paid one read for one type, and N types must not become
  // N reads.
  const { data: cachedRows } = await supabase
    .from('anchor_embedding')
    .select('entity_type, entity_id, source_updated_at, embedding')
    .eq('workspace_id', workspaceId)
    .limit(ANCHORS_PER_TYPE * Math.max(anchorTypes.length, 1))
  const cached = new Map<string, { source_updated_at: string; embedding: unknown }>()
  for (const r of cachedRows ?? []) {
    cached.set(`${r.entity_type as string}:${r.entity_id as string}`, {
      source_updated_at: r.source_updated_at as string,
      embedding: r.embedding,
    })
  }

  for (const entityType of anchorTypes) {
    const descriptor = entityDescriptor(entityType)
    const anchor = descriptor?.anchor
    if (!descriptor || !anchor) continue

    const columns = ['id', ...anchor.embedTextColumns, 'updated_at'].join(', ')
    const { data: rows, error } = await supabase
      .from(descriptor.table)
      .select(columns)
      .eq('workspace_id', workspaceId)
      .limit(ANCHORS_PER_TYPE)
    // A type whose table does not exist yet (campaign, before its migration)
    // errors here. That is expected and non-fatal: skip the type.
    if (error || !rows?.length) continue

    for (const raw of rows as unknown as Record<string, unknown>[]) {
      const id = raw.id as string
      const updatedAt = (raw.updated_at as string) ?? new Date(0).toISOString()
      const { name, description } = anchorDisplay(entityType, raw)

      const hit = cached.get(`${entityType}:${id}`)
      const fresh =
        hit &&
        new Date(hit.source_updated_at).getTime() >= new Date(updatedAt).getTime()

      if (fresh) {
        const parsed = parseEmbedding(hit.embedding)
        if (parsed) {
          result.push({ entity_type: entityType, entity_id: id, name, description, embedding: parsed })
        }
        continue
      }

      const text = anchorEmbedText(entityType, raw)
      if (!text) continue
      try {
        const embedding = await embed(text, ownerUserId)
        await supabase.from('anchor_embedding').upsert(
          {
            workspace_id: workspaceId,
            entity_type: entityType,
            entity_id: id,
            // pgvector accepts the JSON-array form (same as capture_chunks writes).
            embedding: JSON.stringify(embedding),
            source_updated_at: updatedAt,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'workspace_id,entity_type,entity_id' },
        )
        result.push({ entity_type: entityType, entity_id: id, name, description, embedding })
      } catch {
        // Embedding failure is non-fatal: this anchor is just absent as a
        // candidate this run; next run retries it.
      }
    }
  }
  return result
}

/**
 * The per-type similarity distribution one pass observed, for threshold tuning.
 * Recorded for EVERY candidate scored — not only the ones that linked — so the
 * numbers describe the real incoming signal rather than only the band we
 * already decided to act on.
 */
export interface AnchorSimilarityStats {
  candidates: number
  max: number
  p50: number
  above_floor: number
  auto_linked: number
}

/** Accumulate per-type similarities, then reduce them into the run summary. */
export class AnchorStats {
  private readonly sims = new Map<string, number[]>()
  private readonly autoLinked = new Map<string, number>()

  record(candidates: readonly AnchorCandidate[]): void {
    for (const c of candidates) {
      const list = this.sims.get(c.entity_type)
      if (list) list.push(c.similarity)
      else this.sims.set(c.entity_type, [c.similarity])
    }
  }

  recordAutoLink(entityType: string): void {
    this.autoLinked.set(entityType, (this.autoLinked.get(entityType) ?? 0) + 1)
  }

  summarize(): Record<string, AnchorSimilarityStats> {
    const out: Record<string, AnchorSimilarityStats> = {}
    for (const [type, sims] of this.sims) {
      const sorted = [...sims].sort((a, b) => a - b)
      const { floor } = anchorThresholds(type)
      out[type] = {
        candidates: sorted.length,
        max: round(sorted[sorted.length - 1] ?? 0),
        p50: round(sorted[Math.floor((sorted.length - 1) / 2)] ?? 0),
        above_floor: sorted.filter((s) => s >= floor).length,
        auto_linked: this.autoLinked.get(type) ?? 0,
      }
    }
    return out
  }
}

/** Four decimals is well past what a threshold decision can use. */
function round(n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * Score one claim's embedding against every loaded anchor, optionally narrowed
 * to the types this claim is still MISSING (a claim already linked to its
 * company must not be offered companies again).
 */
export function scoreAnchorCandidates(
  claimEmbedding: number[],
  anchors: readonly AnchorEmbedding[],
  onlyTypes?: ReadonlySet<string>,
): AnchorCandidate[] {
  const out: AnchorCandidate[] = []
  for (const a of anchors) {
    if (onlyTypes && !onlyTypes.has(a.entity_type)) continue
    out.push({
      entity_type: a.entity_type,
      entity_id: a.entity_id,
      name: a.name,
      description: a.description,
      similarity: cosineSimilarity(claimEmbedding, a.embedding),
    })
  }
  return out
}

/**
 * The ONE pooled judge call, shared by Phase 2b and the Phase 2c backfill so
 * the prompt, the verdict validation and the usage attribution cannot drift
 * between them. Returns whether an edge was written.
 *
 * The verdict is trusted only for a candidate the judge was actually OFFERED —
 * both fields, not just the id: a judge that answers `{project, <a company
 * id>}` has invented a pair, and writing it would put a company id behind a
 * project-typed edge.
 */
async function judgeAnchor(
  supabase: ServiceClient,
  ws: string,
  knowledgeModel: string,
  ownerUserId: string | undefined,
  claim: { id: string; text: string },
  candidates: AnchorCandidate[],
  usageMetadata: Record<string, unknown>,
): Promise<boolean> {
  try {
    const object = await runAnchorJudge({
      ws,
      knowledgeModel,
      ownerUserId,
      claimId: claim.id,
      claimText: claim.text,
      candidates,
      usageMetadata,
    })
    const pick = validateAnchorVerdict(object, candidates)
    if (!pick) return false
    return upsertAnchorEdge(supabase, ws, claim.id, pick.entity_type, pick.entity_id)
  } catch {
    // Judge failure is non-fatal, same posture as the claim-relation judge:
    // the claim is already stamped woven, and a missing anchor edge can be
    // added later by the skill, a human, or the backfill sweep.
    return false
  }
}

/**
 * Match a judge verdict back to the candidate it names, or null. Exported pure
 * so the "trust only what was offered" rule — including the type/id pair being
 * validated TOGETHER — is unit-testable without an LLM.
 */
export function validateAnchorVerdict(
  verdict: { anchor_type?: string | null; anchor_id?: string | null },
  candidates: readonly AnchorCandidate[],
): AnchorCandidate | null {
  const { anchor_type: type, anchor_id: id } = verdict
  if (!type || !id) return null
  return (
    candidates.find((c) => c.entity_type === type && c.entity_id === id) ?? null
  )
}

export const knowledgeWeaver = inngest.createFunction(
  {
    id: 'knowledge-weaver',
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: '0 9 * * *' }, // daily, 09:00 UTC (~1am PT)
      // Manual lever: `inngest.send({ name: 'knowledge/weave.requested' })`
      // kicks a run on demand (first-run backfills, admin reruns). The
      // handler ignores event data; concurrency=1 serializes overlaps.
      { event: 'knowledge/weave.requested' },
    ],
  },
  async ({ step }) => {
    const supabase = getServiceClient()

    // Workspaces with weaving backlog or recent claim activity.
    const workspaceIds = await step.run('list-workspaces', async () => {
      const { data } = await supabase
        .from('claim')
        .select('workspace_id')
        .is('woven_at', null)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(2000)
      const ids = [...new Set((data ?? []).map((r) => r.workspace_id as string))]
      return ids.slice(0, WORKSPACES_PER_RUN)
    })

    // Workspaces whose BRIEFS are stale even though they have no weaving
    // backlog — claims that were promoted, edited or merged move updated_at
    // without ever creating an unwoven claim. Selected separately so a
    // claim-quiet workspace never loses brief regeneration (the freeze this
    // fixes: briefs stuck for days while the claim set kept changing).
    const briefStaleIds = await step.run('list-brief-stale-workspaces', async () => {
      const { data: claims } = await supabase
        .from('claim')
        .select('workspace_id, updated_at')
        .eq('status', 'active')
        .neq('confirmation', 'dismissed')
        .order('updated_at', { ascending: false })
        .limit(BRIEF_STALE_CLAIM_SCAN)
      const { data: briefs } = await supabase
        .from('knowledge_brief')
        .select('workspace_id, generated_at')
        .eq('scope_type', 'workspace')
        .is('scope_id', null)
        .limit(2000)
      return selectBriefStaleWorkspaces(
        (claims ?? []) as BriefStaleClaimRow[],
        (briefs ?? []) as BriefStaleBriefRow[],
        WORKSPACES_PER_RUN,
      )
    })

    const summary: Record<string, unknown>[] = []
    const failures: Record<string, unknown>[] = []

    for (const ws of workspaceIds) {
      // Per-workspace isolation: a step that exhausts its own retries rejects
      // here, and without this catch that rejection is FUNCTION-fatal — one bad
      // workspace would abort the nightly run (briefs included) for every
      // workspace after it. Record and move on.
      try {
        await weaveWorkspace(
          (id, fn) => step.run(id, fn),
          supabase,
          ws,
          summary,
        )
      } catch (err) {
        failures.push({
          workspace_id: ws,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Phase 3 runs for every workspace processed above PLUS the brief-stale
    // ones. Deduped; the fingerprint gate inside generateBriefForScope makes a
    // workspace whose claims didn't actually change cost zero LLM calls.
    const briefWorkspaces = unionWorkspaces(workspaceIds, briefStaleIds)
    const briefResults: Record<string, unknown>[] = []
    for (const ws of briefWorkspaces) {
      try {
        const briefs = await step.run(`briefs-${ws}`, async () => {
          // Brief discovery loops the workspace's OWN anchor types, so a
          // sales workspace compiles company briefs and an engineering one
          // does not pay for the query.
          const { anchorTypes } = await resolveWeaverSettings(supabase, ws)
          // A free owner's workspace compiles its briefs on the owner's own
          // ChatGPT plan, never Dial8's models.
          return regenerateWorkspaceBriefs(supabase, ws, anchorTypes, await planOwnerOf(supabase, ws))
        })
        briefResults.push({ workspace_id: ws, briefs })
      } catch (err) {
        failures.push({
          workspace_id: ws,
          phase: 'briefs',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return {
      status: 'completed',
      workspaces: workspaceIds.length,
      brief_workspaces: briefWorkspaces.length,
      summary,
      briefs: briefResults,
      failures,
    }
  },
)

/**
 * The one Inngest capability the per-workspace phases need: memoize an async
 * block as a durable step. Passed in as a plain callback rather than the full
 * `step` object so this file's phase code stays independent of the client's
 * generics (and unit-testable with a pass-through stub).
 */
// The results only ever land in the run summary, so `unknown` is enough here —
// and it sidesteps Inngest's Jsonify<> return transform, which is not assignable
// to the raw `T` a generic passthrough would promise.
type StepRunner = (id: string, fn: () => Promise<unknown>) => Promise<unknown>

/**
 * Phases 1, 2, 2b and 2c for ONE workspace. Extracted from the handler so the
 * per-workspace error isolation is a single try/catch at the call site (Phase 3
 * runs separately, over a wider list — see the handler).
 */
async function weaveWorkspace(
  stepRun: StepRunner,
  supabase: ServiceClient,
  ws: string,
  summary: Record<string, unknown>[],
): Promise<void> {
  // Bare app model id (what ai_model_costs is keyed by, and what logUsage
  // must record), resolved ONCE per workspace for both judge kinds (same
  // 'knowledge' surface); the utility spec route turns it into the Gateway slug.
  const knowledgeModel = await resolveUtilityModel('knowledge_weaver_judge', supabase, ws)
  // The weaver's own settings — the judge kill switch and the workspace's
  // ANCHOR SET — read ONCE here. Phases 2 and 2c each used to re-read
  // `workspace.settings` and hand-parse `weaver.llm_judge` inline; one resolver
  // call replaces both, and gives anchor_types a single fail-open read path.
  const { llmJudge, anchorTypes } = await resolveWeaverSettings(supabase, ws)
  // Phase 1 — promotion. Pure SQL.
  const promoted = await stepRun(`promote-${ws}`, async () => {
    // One Accept Authority (PR-2): claim promotion now reads the ONE trust
    // policy (trust_policy.claims via resolveClaimsAutoAcceptPolicy), not the
    // legacy auto_accept_policy. Flat shape preserved; only the read moved.
    const policy = await resolveClaimsAutoAcceptPolicy(supabase, ws)
    const out = { retro: 0, corroborated: 0 }
    if (!policy.enabled) return out

    // Retroactive auto-accept: the corpus extracted before auto-accept
    // shipped never got the confidence gate applied. Apply it now.
    const { data: retro } = await supabase
      .from('claim')
      .select('id')
      .eq('workspace_id', ws)
      .eq('confirmation', 'suggested')
      .eq('status', 'active')
      .gte('confidence', policy.claims)
      .limit(PROMOTE_BATCH)
    if (retro?.length) {
      const { error } = await supabase
        .from('claim')
        .update({
          confirmation: 'confirmed',
          auto_accepted: true,
          last_verified_at: new Date().toISOString(),
        })
        .in('id', retro.map((r) => r.id))
        .eq('confirmation', 'suggested')
      if (!error) out.retro = retro.length
    }

    // Corroboration: suggested claims just below the threshold with ≥2
    // distinct evidence rows.
    const { data: nearMiss } = await supabase
      .from('claim')
      .select('id, confidence')
      .eq('workspace_id', ws)
      .eq('confirmation', 'suggested')
      .eq('status', 'active')
      .gte('confidence', Math.max(policy.claims - CORROBORATION_CONFIDENCE_SLACK, 0))
      .lt('confidence', policy.claims)
      .limit(PROMOTE_BATCH)
    if (nearMiss?.length) {
      const { data: srcRows } = await supabase
        .from('claim_source')
        .select('claim_id')
        .in('claim_id', nearMiss.map((c) => c.id))
        .limit(5000)
      const counts = new Map<string, number>()
      for (const r of srcRows ?? []) {
        counts.set(r.claim_id as string, (counts.get(r.claim_id as string) ?? 0) + 1)
      }
      const promote = nearMiss.filter((c) =>
        shouldPromoteByCorroboration(
          'claims',
          c.confidence as number | null,
          counts.get(c.id as string) ?? 0,
          policy,
        ),
      )
      if (promote.length) {
        const { error } = await supabase
          .from('claim')
          .update({
            confirmation: 'confirmed',
            auto_accepted: true,
            last_verified_at: new Date().toISOString(),
          })
          .in('id', promote.map((c) => c.id))
          .eq('confirmation', 'suggested')
        if (!error) out.corroborated = promote.length
      }
    }
    return out
  })

  // Phase 2 — weave new claims into the graph.
  const woven = await stepRun(`weave-${ws}`, async () => {
    const out: {
      processed: number
      merged: number
      edges: number
      llm_calls: number
      anchor_edges: number
      anchor_llm_calls: number
      anchor_types: string[]
      anchor_similarity: Record<string, AnchorSimilarityStats>
    } = {
      processed: 0,
      merged: 0,
      edges: 0,
      llm_calls: 0,
      anchor_edges: 0,
      anchor_llm_calls: 0,
      anchor_types: [...anchorTypes],
      anchor_similarity: {},
    }

    // Attribute the (system-scheduled) judge spend to the workspace owner so
    // it isn't unmetered (P0-2/P1-4). Cost is structurally capped
    // (JUDGE_CALLS_PER_WORKSPACE), so we log but don't gate.
    const { data: ownerRow } = await supabase
      .from('member')
      .select('user_id')
      .eq('workspace_id', ws)
      .eq('role', 'owner')
      .limit(1)
      .maybeSingle()
    const ownerUserId = ownerRow?.user_id as string | undefined

    const readQueueWindow = async (from: number) =>
      (
        await supabase
          .from('claim')
          .select('id, text, confirmation, status, created_at')
          .eq('workspace_id', ws)
          .is('woven_at', null)
          .eq('status', 'active')
          .neq('confirmation', 'dismissed')
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, from + CLAIMS_PER_WORKSPACE - 1)
      ).data ?? []

    // Claims sourced only from private captures, or only from someone's chat
    // (353), never enter the weave: the graph edges and briefs it produces
    // are workspace-readable. They are left unwoven (woven_at stays null) so
    // they re-enter automatically if they gain a source everyone can read.
    // Unwoven and newest first, they would hold the front of the queue for
    // good, so it is read in windows past them (QUEUE_WINDOWS at most) until
    // a full batch is found.
    const queue: Awaited<ReturnType<typeof readQueueWindow>> = []
    for (let w = 0; w < QUEUE_WINDOWS && queue.length < CLAIMS_PER_WORKSPACE; w++) {
      const rows = await readQueueWindow(w * CLAIMS_PER_WORKSPACE)
      queue.push(...(await excludePrivateSourcedClaims(supabase, ws, rows)))
      if (rows.length < CLAIMS_PER_WORKSPACE) break
    }
    queue.splice(CLAIMS_PER_WORKSPACE)

    let judgeBudget = JUDGE_CALLS_PER_WORKSPACE

    // Claims that ended the claim↔claim pass MISSING at least one of the
    // workspace's anchor types, carried into the Phase 2b anchor-linking pass
    // below WITH their already-loaded embedding so no claim is re-embedded
    // (plan item 17). `missing` names the types still to try: a claim already
    // linked to its company is still a candidate for a campaign.
    const anchorLinkQueue: Array<{
      id: string
      text: string
      embedding: number[]
      missing: string[]
    }> = []

    for (const claim of queue ?? []) {
      const stamp = () =>
        supabase
          .from('claim')
          .update({ woven_at: new Date().toISOString() })
          .eq('id', claim.id)

      // Reuse the embedding written at creation — no re-embedding.
      const { data: chunk } = await supabase
        .from('claim_chunks')
        .select('embedding')
        .eq('claim_id', claim.id)
        .eq('chunk_index', 0)
        .maybeSingle()
      if (!chunk?.embedding) {
        await stamp()
        out.processed += 1
        continue
      }

      const { data: matches } = await supabase.rpc('match_claims', {
        p_workspace_id: ws,
        p_embedding: chunk.embedding as string,
        p_limit: CANDIDATES_PER_CLAIM + 2,
        p_threshold: SIM_FLOOR,
        p_type: null,
        p_confirmation: null,
        p_status: 'active',
        p_min_confidence: null,
      })

      // Drop self + anything already linked to this claim (re-runs, or
      // edges the extraction/skill already created). Also select the edge
      // ends/relation so we can tell which ANCHOR TYPES this claim already
      // has an `about` edge to. Those types are excluded from Phase 2b below;
      // the rest are still offered. (Project-only, this was one boolean: any
      // about→project edge took the claim out of linking entirely. With a set
      // of anchor types that rule would let the first edge suppress every
      // other type forever.)
      const { data: existingEdges } = await supabase
        .from('entity_link')
        .select('source_type, source_id, target_type, target_id, relation')
        .eq('workspace_id', ws)
        .or(
          `and(source_type.eq.claim,source_id.eq.${claim.id}),and(target_type.eq.claim,target_id.eq.${claim.id})`,
        )
        .limit(200)
      const linked = new Set<string>()
      const anchoredTypes = new Set<string>()
      for (const e of existingEdges ?? []) {
        linked.add(e.source_id as string)
        linked.add(e.target_id as string)
        if (
          e.source_type === 'claim' &&
          e.source_id === claim.id &&
          e.relation === 'about'
        ) {
          anchoredTypes.add(e.target_type as string)
        }
      }
      const missingAnchorTypes = anchorTypes.filter((t) => !anchoredTypes.has(t))
      const parsedEmbedding =
        missingAnchorTypes.length === 0 ? null : parseEmbedding(chunk.embedding)

      const nearby = ((matches ?? []) as WeaveCandidate[]).filter(
        (m) => m.claim_id !== claim.id && !linked.has(m.claim_id),
      )
      // Candidates are merge / edge targets, so a hidden claim must not be
      // reachable here either — merging into one (or citing it) would pull
      // private-sourced text into the workspace-visible graph.
      const candidates = (
        await excludePrivateSourcedClaims(
          supabase,
          ws,
          nearby.map((m) => ({ ...m, id: m.claim_id })),
        )
      ).map(({ id: _id, ...m }) => m as WeaveCandidate)
      const { autoMerge, judge } = partitionCandidates(claim.text as string, candidates)

      // If this new claim gets merged AWAY (superseded into a keeper) during
      // the claim↔claim pass, it must NOT be project-linked below — the edge
      // would land on a dead claim (and mergeDuplicate already re-pointed the
      // keeper's edges before this project edge would exist). keeperIsSelf
      // uses the SAME rank rule mergeDuplicate applies (confirmed<suggested,
      // then older wins) so we can tell without an extra query.
      let mergedAway = false
      const keeperIsSelf = (other: {
        confirmation: string
        created_at: string
      }) =>
        mergeKeeperIsSelf(
          {
            confirmation: claim.confirmation as string,
            created_at: claim.created_at as string,
          },
          other,
        )

      for (const dupe of autoMerge) {
        const { data: other } = await supabase
          .from('claim')
          .select('id, confirmation, created_at')
          .eq('id', dupe.claim_id)
          .eq('workspace_id', ws)
          .eq('status', 'active')
          .maybeSingle()
        if (!other) continue
        const ok = await mergeDuplicate(
          supabase,
          ws,
          { id: claim.id as string, confirmation: claim.confirmation as string, created_at: claim.created_at as string },
          other as { id: string; confirmation: string; created_at: string },
        )
        if (ok) {
          out.merged += 1
          if (!keeperIsSelf(other as { confirmation: string; created_at: string })) {
            // The CURRENT claim lost this merge — it's now superseded into a
            // keeper. Its state (status, edges) is stale: mergeDuplicate
            // already re-pointed its edges onto the keeper. Continuing to
            // merge further dupes INTO it, or judging it, would point
            // superseded_by / re-point edges onto a now-dead claim. Stop
            // processing this claim entirely. (When the claim WINS —
            // keeperIsSelf — continuing to absorb further dupes is correct,
            // so we only break in the losing case.)
            mergedAway = true
            break
          }
        }
      }

      if (!mergedAway && judge.length > 0) {
        if (!llmJudge) {
          // Vectors-only mode: a tight band is still a meaningful
          // related_to signal; contradictions/merges need the judge, so
          // they're skipped entirely in this mode.
          for (const c of judge) {
            if (c.similarity >= 0.85) {
              if (await upsertClaimEdge(supabase, ws, claim.id as string, c.claim_id, 'related_to'))
                out.edges += 1
            }
          }
        } else if (judgeBudget > 0) {
          judgeBudget -= 1
          out.llm_calls += 1
          try {
            const object = await runPairJudge({
              ws,
              knowledgeModel,
              ownerUserId,
              claimId: claim.id as string,
              claimText: claim.text as string,
              candidates: judge,
            })
            for (const v of object.verdicts) {
              const cand = judge.find((c) => c.claim_id === v.candidate_id)
              if (!cand) continue
              if (v.relation === 'none') continue
              if (v.relation === 'duplicate') {
                // Trust the judge for merges only when the vectors agree
                // it's a tight match; otherwise downgrade to related_to.
                if (cand.similarity >= 0.9) {
                  const { data: other } = await supabase
                    .from('claim')
                    .select('id, confirmation, created_at')
                    .eq('id', cand.claim_id)
                    .eq('workspace_id', ws)
                    .eq('status', 'active')
                    .maybeSingle()
                  if (
                    other &&
                    (await mergeDuplicate(
                      supabase,
                      ws,
                      { id: claim.id as string, confirmation: claim.confirmation as string, created_at: claim.created_at as string },
                      other as { id: string; confirmation: string; created_at: string },
                    ))
                  ) {
                    out.merged += 1
                    if (
                      !keeperIsSelf(
                        other as { confirmation: string; created_at: string },
                      )
                    )
                      mergedAway = true
                  }
                } else if (
                  await upsertClaimEdge(supabase, ws, claim.id as string, cand.claim_id, 'related_to')
                ) {
                  out.edges += 1
                }
                continue
              }
              if (await upsertClaimEdge(supabase, ws, claim.id as string, cand.claim_id, v.relation))
                out.edges += 1
            }
          } catch {
            // Judge failure is non-fatal: the claim still gets stamped;
            // tomorrow's run won't retry it (budget protection). Edges
            // can always be added later by the skill or a human.
          }
        }
      }

      // Queue for Phase 2b anchor-linking only if the claim (a) is missing at
      // least one active anchor type, (b) has a usable embedding, and (c)
      // SURVIVED the claim↔claim pass (wasn't merged away into a keeper).
      if (parsedEmbedding && !mergedAway) {
        anchorLinkQueue.push({
          id: claim.id as string,
          text: claim.text as string,
          embedding: parsedEmbedding,
          missing: missingAnchorTypes,
        })
      }

      await stamp()
      out.processed += 1
    }

    // ── Phase 2b — claim↔anchor linking (plan item 17) ──────────────────
    // For the claims that ended the pass missing at least one active anchor
    // type, cosine-match their (already-loaded) embedding against the
    // workspace's anchor embeddings, ALL TYPES AT ONCE. Any type whose top
    // match clears its own auto bar links without an LLM; the remaining
    // ambiguous band goes to ONE pooled judge call on the budget LEFT OVER
    // from claim-relations (spend on relations first, remainder here — never
    // reduces claim-relation capacity). Kill-switch off → auto-tier only.
    if (anchorLinkQueue.length > 0) {
      const anchorEmbeddings = await refreshAnchorEmbeddings(
        supabase,
        ws,
        ownerUserId,
        anchorTypes,
      )
      const stats = new AnchorStats()
      if (anchorEmbeddings.length > 0) {
        for (const claim of anchorLinkQueue) {
          const missing = new Set(claim.missing)
          const candidates = scoreAnchorCandidates(
            claim.embedding,
            anchorEmbeddings,
            missing,
          )
          stats.record(candidates)
          const partition = partitionAnchorCandidates(candidates)

          // The auto tier is unconditional — zero LLM cost, no budget to
          // check — and can link SEVERAL types for one claim.
          for (const a of partition.auto) {
            if (await upsertAnchorEdge(supabase, ws, claim.id, a.entity_type, a.entity_id)) {
              out.anchor_edges += 1
              stats.recordAutoLink(a.entity_type)
            }
          }
          if (!shouldJudgeAnchors(partition, llmJudge, judgeBudget)) continue

          // Spend one leftover judge call on the pooled ambiguous band.
          judgeBudget -= 1
          out.anchor_llm_calls += 1
          const linked = await judgeAnchor(
            supabase,
            ws,
            knowledgeModel,
            ownerUserId,
            claim,
            partition.judge,
            {},
          )
          if (linked) out.anchor_edges += 1
        }
      }
      out.anchor_similarity = stats.summarize()
    }

    return out
  })

  // ── Phase 2c — anchor-link BACKFILL ─────────────────────────────────
  // Phase 2b gets exactly one shot per claim: the queue is gated on
  // woven_at IS NULL and woven_at is stamped unconditionally, so a claim
  // woven before the matching anchor existed is never revisited. This pass
  // re-runs the SAME tiering over already-woven, still-active claims that
  // are missing at least one of the workspace's anchor types, on its OWN
  // small judge budget. Below-floor candidates are pure vector math (zero
  // LLM calls), so it stays free while nothing matches and self-activates
  // once an anchor does — including the day a workspace turns CRM on and
  // `company` joins its anchor set.
  const backfilled = await stepRun(`backfill-link-${ws}`, async () => {
    const out: {
      considered: number
      anchor_edges: number
      anchor_llm_calls: number
      anchor_similarity: Record<string, AnchorSimilarityStats>
    } = { considered: 0, anchor_edges: 0, anchor_llm_calls: 0, anchor_similarity: {} }
    if (anchorTypes.length === 0) return out

    const { data: ownerRow } = await supabase
      .from('member')
      .select('user_id')
      .eq('workspace_id', ws)
      .eq('role', 'owner')
      .limit(1)
      .maybeSingle()
    const ownerUserId = ownerRow?.user_id as string | undefined

    // Which anchor TYPES each claim already has an `about` edge to. A claim
    // is eligible while it is missing ANY active type, and is offered only
    // the types it is missing — so turning on a second anchor type does not
    // re-judge every claim for the type it already has.
    const { data: linkedRows } = await supabase
      .from('entity_link')
      .select('source_id, target_type')
      .eq('workspace_id', ws)
      .eq('source_type', 'claim')
      .eq('relation', 'about')
      .in('target_type', [...anchorTypes])
      .limit(5000)
    const anchoredByClaim = new Map<string, Set<string>>()
    for (const r of linkedRows ?? []) {
      const id = r.source_id as string
      const set = anchoredByClaim.get(id)
      if (set) set.add(r.target_type as string)
      else anchoredByClaim.set(id, new Set([r.target_type as string]))
    }
    // FULLY anchored = has every active type. Only these are excluded.
    const fullyAnchored = new Set<string>()
    for (const [id, types] of anchoredByClaim) {
      if (anchorTypes.every((t) => types.has(t))) fullyAnchored.add(id)
    }

    // Over-fetch a little so the cap still yields work if the trailing
    // pure filter below drops a few rows (see BACKFILL_EXCLUDE_MAX).
    let claimQuery = supabase
      .from('claim')
      .select('id, text')
      .eq('workspace_id', ws)
      .not('woven_at', 'is', null)
      .eq('status', 'active')
      .neq('confirmation', 'dismissed')
      .order('created_at', { ascending: false })
      .limit(BACKFILL_LINK_PER_WORKSPACE * 2)
    if (fullyAnchored.size > 0) {
      // The exclusion travels in the URL, so a workspace with thousands of
      // linked claims would blow the request line. Send the newest slice
      // (the ordering above makes those the ones this batch would hit) and
      // let selectBackfillClaims catch the rest in JS.
      claimQuery = claimQuery.not(
        'id',
        'in',
        `(${[...fullyAnchored].slice(0, BACKFILL_EXCLUDE_MAX).join(',')})`,
      )
    }
    const { data: rawClaims } = await claimQuery

    // Same visibility rule as the weave: a private-sourced claim must not
    // gain a workspace-visible anchor edge.
    const visible = await excludePrivateSourcedClaims(
      supabase,
      ws,
      (rawClaims ?? []) as Array<{ id: string; text: string }>,
    )
    const claims = selectBackfillClaims(
      visible,
      fullyAnchored,
      BACKFILL_LINK_PER_WORKSPACE,
    )
    if (claims.length === 0) return out

    const anchorEmbeddings = await refreshAnchorEmbeddings(
      supabase,
      ws,
      ownerUserId,
      anchorTypes,
    )
    if (anchorEmbeddings.length === 0) return out

    // A budget of its OWN — separate from JUDGE_CALLS_PER_WORKSPACE, which
    // the claim-relation pass above already spent. The backfill can never
    // reduce claim-relation judging capacity. One POOLED judge call covers
    // every anchor type, so adding types does not multiply this budget.
    let judgeBudget = BACKFILL_JUDGE_CALLS_PER_WORKSPACE
    const stats = new AnchorStats()

    for (const claim of claims) {
      const { data: chunk } = await supabase
        .from('claim_chunks')
        .select('embedding')
        .eq('claim_id', claim.id)
        .eq('chunk_index', 0)
        .maybeSingle()
      const embedding = chunk?.embedding
        ? parseEmbedding(chunk.embedding)
        : null
      if (!embedding) continue
      out.considered += 1

      const had = anchoredByClaim.get(claim.id)
      const missing = new Set(anchorTypes.filter((t) => !had?.has(t)))
      const candidates = scoreAnchorCandidates(embedding, anchorEmbeddings, missing)
      stats.record(candidates)
      const partition = partitionAnchorCandidates(candidates)

      for (const a of partition.auto) {
        if (await upsertAnchorEdge(supabase, ws, claim.id, a.entity_type, a.entity_id)) {
          out.anchor_edges += 1
          stats.recordAutoLink(a.entity_type)
        }
      }
      if (!shouldJudgeAnchors(partition, llmJudge, judgeBudget)) continue

      judgeBudget -= 1
      out.anchor_llm_calls += 1
      const linked = await judgeAnchor(
        supabase,
        ws,
        knowledgeModel,
        ownerUserId,
        claim,
        partition.judge,
        { backfill: true },
      )
      if (linked) out.anchor_edges += 1
    }

    out.anchor_similarity = stats.summarize()
    return out
  })

  summary.push({ workspace_id: ws, promoted, woven, backfilled })
}
