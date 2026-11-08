/**
 * Proposal matching: precision and recall against the case's expected list
 * (spec §6.3).
 *
 * ===========================================================================
 * WHY EMBEDDINGS SHORTLIST AND AN LLM DECIDES
 * ===========================================================================
 * The proposals dimension is an extraction problem, and the matcher's
 * thresholds are the single thing most likely to turn a harmless PHRASING
 * change into a fake regression — which is the fastest way to make a suite
 * untrusted. A cosine cutoff cannot tell "Send Dana the security questionnaire"
 * from "Email Dana the security doc" reliably at ANY threshold: pick it high and
 * paraphrase reads as a miss, pick it low and two different actions read as the
 * same one.
 *
 * So the layers are split by what each is actually good at:
 *   1. EMBEDDINGS SHORTLIST the top-3 candidate proposals per expected item.
 *      They are cheap, they are stable, and they never decide anything.
 *   2. ONE BATCHED LLM CALL decides "same item, yes/no" for every shortlisted
 *      pair at once. One call for the whole trial, not one per pair — the
 *      decisions are independent and batching turns N calls into one.
 *   3. `must_have` is checked STRUCTURALLY on matched pairs. Those are fields
 *      (`assignee`, `entity_type`, `change_type`, `due_date`), not prose, so
 *      exactness is right there and a model would only add noise.
 *
 * Every check records `match_method` and the shortlist scores in `evidence`, so
 * the compare view can answer the question that actually matters when a number
 * moves: is this a genuinely different proposal, or did the matcher flip?
 *
 * DEGRADATION: no gateway credentials, or a decision call that fails, falls back
 * to the embedding shortlist's top candidate above a deliberately CONSERVATIVE
 * cosine floor, and stamps `match_method: 'embedding_fallback'`. It never
 * silently reports a miss it is not sure about.
 */
import { generateObject } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { aiModel } from '@/lib/ai/gateway'
import { batchEmbed } from '@/lib/ai/embeddings'
import { surfaceModelSlug } from '@/lib/ai/model-defaults'
import type { DraftCheck } from './deterministic'
import {
  ZERO_GRADING_USAGE,
  gradingUsageOf,
  judgeOnPlan,
  type GradingUsage,
  type JudgePlan,
} from './judges'
import type {
  EvalTrace,
  ExpectedGist,
  ExpectedOutcomes,
  ExpectedProposal,
  Severity,
  TraceProposal,
} from '../types'

/** Candidates the LLM is asked about per expected item. Three, not ten: the
 *  shortlist exists to bound the decision prompt, and an item whose true match
 *  is not in the embedding top-3 is almost never in the top-10 either. */
const SHORTLIST_SIZE = 3

/** Cosine floor for the EMBEDDING-ONLY fallback. Deliberately high (0.82): the
 *  fallback runs when the decider is unavailable, and a false match there is
 *  worse than an honest `unknown`, because it silently reports a pass. */
const FALLBACK_COSINE_FLOOR = 0.82

/** How a match was decided, recorded on every check's evidence. */
export type MatchMethod = 'llm' | 'embedding_fallback' | 'no_candidates'

/** One shortlisted pair with its cosine score. */
interface Candidate {
  proposal: TraceProposal
  score: number
}

/** The matcher's decision for one expected item. */
interface MatchDecision {
  matched: TraceProposal | null
  method: MatchMethod
  candidates: Array<{ id: string; score: number; text: string }>
}

/** Text an expected item is embedded and compared as. */
function expectedText(item: { gist: string; entity_type?: string; change_type?: string }): string {
  const kind = item.entity_type && item.change_type ? `${item.change_type} ${item.entity_type}: ` : ''
  return `${kind}${item.gist}`
}

/** Text a real proposal is embedded and compared as. Title AND display_text,
 *  because the model puts the substance in one or the other depending on the
 *  entity, and embedding only one of them loses half the trials' signal. */
function proposalText(p: TraceProposal): string {
  const parts = [p.title, p.display_text].filter(Boolean)
  return `${p.change_type} ${p.entity_type}: ${parts.join(' — ')}`
}

/** Cosine similarity of two equal-length vectors. */
function cosine(a: number[], b: number[]): number {
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB)
  return mag === 0 ? 0 : dot / mag
}

/** The batched decider's output: one verdict per pair, keyed by the index pair
 *  the prompt enumerated. `same` is the decision; `why` is what the evidence
 *  records so a matcher flip is explainable rather than mysterious. */
const DecisionSchema = z.object({
  decisions: z.array(
    z.object({
      expected_index: z.number().int(),
      candidate_index: z.number().int(),
      same: z.boolean(),
      why: z.string(),
    }),
  ),
})

const DECIDER_INSTRUCTIONS = `You decide whether two descriptions refer to THE SAME item of work.

You are shown EXPECTED items (what a meeting-notes agent was supposed to propose) and CANDIDATE items (what it actually proposed). For each pair, answer whether they are the same underlying thing.

The same item may be worded completely differently. "Send Dana the security questionnaire" and "Email the security doc over to Dana" are THE SAME ITEM. "Send Dana the questionnaire" and "Schedule a follow-up with Dana" are NOT — same person, different work.

Judge the WORK, not the wording. Ignore differences in tense, formality, length and detail. Say no when the actor, the object, or the deliverable genuinely differs.

Write your reasoning in "why" first, then set "same".`

/** Shortlist by embedding, then decide with one batched model call. */
async function decideMatches(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    expected: Array<{ key: string; text: string }>
    proposals: TraceProposal[]
    /** The starter's ChatGPT plan: the decision call runs there (judgeOnPlan). */
    plan?: JudgePlan
  },
): Promise<{ decisions: Map<string, MatchDecision>; usage: GradingUsage }> {
  const out = new Map<string, MatchDecision>()
  // The matcher's decision call is grading spend like a judge's, and it was
  // discarded the same way — a run's `cost_usd` reported the target call alone.
  let usage = ZERO_GRADING_USAGE
  if (args.expected.length === 0) return { decisions: out, usage }

  if (args.proposals.length === 0) {
    for (const item of args.expected) {
      out.set(item.key, { matched: null, method: 'no_candidates', candidates: [] })
    }
    return { decisions: out, usage }
  }

  // ── 1. Shortlist ─────────────────────────────────────────────────────────
  const proposalTexts = args.proposals.map(proposalText)
  let shortlists: Candidate[][] = []
  try {
    const vectors = await batchEmbed([...args.expected.map((e) => e.text), ...proposalTexts])
    const expectedVectors = vectors.slice(0, args.expected.length)
    const proposalVectors = vectors.slice(args.expected.length)
    shortlists = expectedVectors.map((vec) =>
      args.proposals
        .map((proposal, i) => ({ proposal, score: cosine(vec, proposalVectors[i]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, SHORTLIST_SIZE),
    )
  } catch (err) {
    // No embeddings: fall back to considering EVERY proposal, scored 0. The
    // decider is what actually decides, so a missing shortlist costs prompt
    // size and nothing else — far better than reporting every item unmatched.
    console.warn('[evals] proposal shortlist embedding failed:', err)
    shortlists = args.expected.map(() =>
      args.proposals.map((proposal) => ({ proposal, score: 0 })),
    )
  }

  const candidatesOf = (i: number) =>
    shortlists[i].map((c) => ({
      id: c.proposal.id,
      score: Math.round(c.score * 10_000) / 10_000,
      text: proposalText(c.proposal),
    }))

  // ── 2. One batched decision call ─────────────────────────────────────────
  const pairs = args.expected.flatMap((item, ei) =>
    shortlists[ei].map((c, ci) => ({ ei, ci, expected: item.text, candidate: proposalText(c.proposal) })),
  )

  try {
    const prompt = pairs
      .map(
        (p) =>
          `PAIR expected_index=${p.ei} candidate_index=${p.ci}\n  EXPECTED: ${p.expected}\n  CANDIDATE: ${p.candidate}`,
      )
      .join('\n\n')
    let object: z.infer<typeof DecisionSchema>
    if (args.plan) {
      // On the starter's own ChatGPT plan: never Native Intelligence's models.
      const decided = await judgeOnPlan(args.plan, { instructions: DECIDER_INSTRUCTIONS, prompt, schema: DecisionSchema })
      usage = decided.usage
      object = decided.object
    } else {
      const model = surfaceModelSlug('knowledge')
      const result = await generateObject({
        model: aiModel(model),
        schema: DecisionSchema,
        instructions: DECIDER_INSTRUCTIONS,
        prompt,
      })
      usage = gradingUsageOf(result)
      object = result.object
    }

    // The first candidate the decider says yes to wins — the shortlist is
    // already ordered by cosine, so "first yes" is "best yes".
    for (let ei = 0; ei < args.expected.length; ei++) {
      const yes = object.decisions
        .filter((d) => d.expected_index === ei && d.same)
        .sort((a, b) => a.candidate_index - b.candidate_index)[0]
      const matched = yes ? (shortlists[ei][yes.candidate_index]?.proposal ?? null) : null
      out.set(args.expected[ei].key, {
        matched,
        method: 'llm',
        candidates: candidatesOf(ei),
      })
    }
    return { decisions: out, usage }
  } catch (err) {
    console.warn('[evals] proposal decider call failed, falling back to cosine:', err)
  }

  // ── 3. Conservative embedding-only fallback ──────────────────────────────
  for (let ei = 0; ei < args.expected.length; ei++) {
    const best = shortlists[ei][0]
    out.set(args.expected[ei].key, {
      matched: best && best.score >= FALLBACK_COSINE_FLOOR ? best.proposal : null,
      method: 'embedding_fallback',
      candidates: candidatesOf(ei),
    })
  }
  return { decisions: out, usage }
}

/** `must_have` checked structurally on a matched pair. Returns the failures. */
function checkMustHave(
  expected: ExpectedProposal,
  proposal: TraceProposal,
): string[] {
  const failures: string[] = []
  for (const [field, want] of Object.entries(expected.must_have ?? {})) {
    switch (field) {
      case 'entity_type':
        if (proposal.entity_type !== want) {
          failures.push(`entity_type is "${proposal.entity_type}", expected "${want}"`)
        }
        break
      case 'change_type':
        if (proposal.change_type !== want) {
          failures.push(`change_type is "${proposal.change_type}", expected "${want}"`)
        }
        break
      case 'assignee': {
        // "self" is the case author's shorthand for the run starter, who is the
        // capture's owner — and the route resolves that to a real display name.
        // Any non-empty assignee satisfies "self" here rather than matching a
        // name the case cannot know at authoring time; the ownership question
        // itself is what `gate.would_have_applied` measures.
        const assignee = proposal.assignee_name ?? ''
        if (want === 'self' ? !assignee : assignee.toLowerCase() !== want.toLowerCase()) {
          failures.push(`assignee is "${assignee || 'unset'}", expected "${want}"`)
        }
        break
      }
      default:
        // An unknown must_have key is a case-authoring mistake, and silently
        // passing it would let a typo'd expectation read as satisfied forever.
        failures.push(`unknown must_have field "${field}"`)
    }
  }
  return failures
}

/** Options the caller threads through, all optional. */
export interface MatchProposalsArgs {
  workspaceId: string
  trace: EvalTrace
  expected: ExpectedOutcomes
  /** From the deterministic pass: a truncated flush makes every recall verdict
   *  `unknown`, because a proposal the agent never got to make is not a
   *  prompt failure. */
  proposalsUnknown?: boolean
  /** The starter's ChatGPT plan, when the run is on it: see JudgePlan (./judges.ts). */
  plan?: JudgePlan
}

/** What the matcher returns: its checks, and what its decision call cost. */
export type MatchProposalsResult = {
  checks: DraftCheck[]
  usage: GradingUsage
}

/**
 * Every proposals-dimension check for one trial.
 *
 * Emits, per spec §6.3:
 *   - one RECALL check per expected proposal (`pass` matched, `fail` missing);
 *   - one check per forbidden gist that MATCHED an actual proposal (gate fail);
 *   - one soft PRECISION check over the proposals nothing expected.
 */
export async function matchProposals(
  supabase: SupabaseClient,
  args: MatchProposalsArgs,
): Promise<MatchProposalsResult> {
  const proposals = args.trace.proposals_final ?? []
  const expectedProposals = args.expected.proposals ?? []
  const forbidden = args.expected.forbidden_proposals ?? []
  if (expectedProposals.length === 0 && forbidden.length === 0) {
    return { checks: [], usage: ZERO_GRADING_USAGE }
  }

  const { decisions, usage } = await decideMatches(supabase, {
    workspaceId: args.workspaceId,
    expected: [
      ...expectedProposals.map((e) => ({ key: `expected:${e.key}`, text: expectedText(e) })),
      ...forbidden.map((f) => ({ key: `forbidden:${f.key}`, text: expectedText(f) })),
    ],
    proposals,
    ...(args.plan ? { plan: args.plan } : {}),
  })

  const out: DraftCheck[] = []
  const matchedIds = new Set<string>()
  /** Proposals that matched a FORBIDDEN gist — never "expected". */
  const forbiddenIds = new Set<string>()

  // ── Recall: each expected proposal ───────────────────────────────────────
  for (const item of expectedProposals) {
    const decision = decisions.get(`expected:${item.key}`)
    const matched = decision?.matched ?? null
    if (matched) matchedIds.add(matched.id)

    const mustHaveFailures = matched ? checkMustHave(item, matched) : []
    const severity: Severity = item.severity ?? 'gate'
    const outcome = args.proposalsUnknown
      ? ('unknown' as const)
      : matched && mustHaveFailures.length === 0
        ? ('pass' as const)
        : ('fail' as const)

    out.push({
      dimension: 'proposals',
      grader: 'proposal_match',
      check_key: `proposal:${item.key}`,
      label: item.gist,
      severity,
      outcome,
      score: null,
      threshold: null,
      rationale: args.proposalsUnknown
        ? 'A flush hit the step ceiling, so a missing proposal measures the budget rather than the prompt.'
        : !matched
          ? `No proposal matched "${item.gist}".`
          : mustHaveFailures.length
            ? `Matched a proposal but ${mustHaveFailures.join('; ')}.`
            : `Matched proposal ${matched.id}.`,
      evidence: {
        match_method: decision?.method ?? 'no_candidates',
        candidates: decision?.candidates ?? [],
        ...(matched ? { matched_proposal_id: matched.id } : {}),
        ...(mustHaveFailures.length ? { must_have_failures: mustHaveFailures } : {}),
      },
      human_override: null,
      human_note: null,
    })
  }

  // ── Forbidden: a match is the FAILURE ────────────────────────────────────
  for (const item of forbidden as ExpectedGist[]) {
    const decision = decisions.get(`forbidden:${item.key}`)
    const matched = decision?.matched ?? null
    // Deliberately NOT into `matchedIds`. That set means "a proposal the case
    // EXPECTED", and it is the precision numerator — adding a forbidden match
    // would score the very proposals the suite bans as precise, inflating the
    // trend line a reviewer reads to see whether the prompt over-proposes.
    if (matched) forbiddenIds.add(matched.id)
    out.push({
      dimension: 'proposals',
      grader: 'proposal_forbidden',
      check_key: `forbidden:${item.key}`,
      label: item.gist,
      severity: item.severity ?? 'gate',
      outcome: matched ? 'fail' : 'pass',
      score: null,
      threshold: null,
      rationale: matched
        ? `Proposal ${matched.id} matches the forbidden "${item.gist}".`
        : `Nothing proposed matched "${item.gist}".`,
      evidence: {
        match_method: decision?.method ?? 'no_candidates',
        candidates: decision?.candidates ?? [],
        ...(matched ? { matched_proposal_id: matched.id } : {}),
      },
      human_override: null,
      human_note: null,
    })
  }

  // ── Precision: proposals nothing expected ────────────────────────────────
  // SOFT, always. An agent that notices something true the case author did not
  // think of is not broken, and gating on precision would train cases to be
  // exhaustive rather than pointed. The number is still recorded so the trend
  // is visible.
  if (expectedProposals.length > 0) {
    // A forbidden match is outside this check entirely: it already failed its own
    // gate, so counting it here would penalise the same proposal twice on a
    // metric that is deliberately soft. It is simply not an EXPECTED one.
    const scored = proposals.filter((p) => !forbiddenIds.has(p.id))
    const unmatched = scored.filter((p) => !matchedIds.has(p.id))
    const precision = scored.length === 0 ? 1 : matchedIds.size / scored.length
    out.push({
      dimension: 'proposals',
      grader: 'proposal_precision',
      check_key: 'proposal_precision',
      label: 'Proposals were all expected',
      severity: 'soft',
      outcome: args.proposalsUnknown ? 'unknown' : unmatched.length === 0 ? 'pass' : 'fail',
      score: Math.round(precision * 10_000) / 10_000,
      threshold: 1,
      rationale:
        unmatched.length === 0
          ? `All ${scored.length} proposal(s) matched an expected item.`
          : `${unmatched.length} of ${scored.length} proposal(s) were not expected by this case.`,
      evidence: {
        match_method: 'llm',
        unexpected: unmatched.map((p) => ({ id: p.id, text: proposalText(p) })),
      },
      human_override: null,
      human_note: null,
    })
  }

  return { checks: out, usage }
}
