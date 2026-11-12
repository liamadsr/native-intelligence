/**
 * The utility agent's kind registry and spec rebuild (WS-4).
 *
 * One entry per one-shot generator. For each kind this module owns:
 *   - the MODEL SURFACE it runs on ('drafting' / 'knowledge') and therefore the
 *     only place a utility call resolves its workspace model
 *     (resolveUtilityModel → SURFACE_MODELS). eve agent code cannot
 *     import src/, so this can never move into agents/utility;
 *   - its Gateway telemetry feature — byte-identical to the `feature` the call
 *     site passes to logUsage (the parity tests pin the pair);
 *   - its system prompt, templated on the token's small `params`;
 *   - its per-call output-token cap, where the pre-port call had one
 *     (`maxOutputTokens:` on generateText/generateObject) — enforced on the
 *     model call itself by the utility agent's step resolver;
 *   - its model-step ceiling (maxSteps) — also enforced by the step resolver;
 *   - its wall-clock timeout.
 *
 * buildUtilitySpec is what GET /api/internal/utility/spec returns to the eve
 * agent's resolvers. It is a pure function of the VERIFIED token claims, so the
 * rebuild on the internal route is deterministic and cannot drift from what
 * the dispatcher signed.
 *
 * Adding a kind: add the literal to UTILITY_KINDS (utility-run-token.ts) and an
 * entry below — the Record type makes a missing entry a compile error.
 *
 * The model is resolved at DISPATCH (resolveUtilityModel, called by
 * runUtilityTask) and carried in the signed token; the spec route only maps
 * that claim to a Gateway slug. That is deliberate: the model logUsage records
 * is then exactly the model the session ran (skill-run's RunTokenClaims.model
 * does the same). Do not move the resolve onto the spec route.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { gatewayTelemetryValues } from '@/lib/ai/gateway-telemetry'
import { surfaceModel, type ModelSurface } from '@/lib/ai/model-defaults'
import { deepseekSurfacePolicy, gatewayModelSlug, type DeepSeekThinking } from '@/lib/ai/models'
import { differentPlanModels, differentVendors } from '@/lib/ai/reviewer-model'
import { PLAN_HELPER_MODEL, PLAN_MAIN_MODEL, planModelFromSlug, type ChatGptPlanSpec } from '@/lib/chatgpt/plan-models'
import type { UtilityKind, UtilityParams, UtilityTokenClaims } from '@/lib/eve/utility-run-token'
import {
  AGENT_MEMORY_SUMMARY_PROMPT,
  BROWSER_FIELD_TEXT_PROMPT,
  PLAN_DECISION_PROMPT,
  PLAN_WEB_RESEARCH_PROMPT,
  EVAL_JUDGE_PROMPT,
  CLAIM_EXTRACTION_PROMPT,
  CODE_REVIEW_PROMPT,
  CODING_PRECHECK_PROMPT,
  KNOWLEDGE_BRIEF_PROMPT,
  LOOK_AHEAD_EXTRACT_PROMPT,
  MEMORY_CAPTURE_PROMPT,
  MEMORY_LEARN_MAIL_TONE_PROMPT,
  NOTE_CONTINUATION_INSTRUCTIONS,
  REFERENCE_INGEST_CLASSIFY_PROMPT,
  REFERENCE_INGEST_SEGMENT_PROMPT,
  SKILL_DESCRIPTION_INSTRUCTIONS,
  WEAVER_ANCHOR_JUDGE_PROMPT,
  WEAVER_PAIR_JUDGE_PROMPT,
  draftFollowupInstructions,
  draftReviewInstructions,
  emailDraftReplyInstructions,
  outreachDraftInstructions,
} from './prompts'

export interface UtilityKindSpec {
  surface: ModelSurface
  /** Gateway telemetry feature tag — equals the call site's logUsage feature. */
  feature: string
  /** Params the system prompt needs; a token missing one is refused. */
  requiredParams: readonly string[]
  /** The session's system instructions, or null for a kind that never had any. */
  systemPrompt: (params: UtilityParams) => string | null
  /**
   * Per-call output-token cap — the pre-port call's `maxOutputTokens`, for the
   * kinds that had one. Absent = uncapped per call, exactly as before the port.
   */
  maxOutputTokens?: number
  /**
   * How many model steps one session may take — the utility agent's step
   * resolver refuses step index >= maxSteps, failing the session. The
   * pre-port generateText / generateObject made exactly ONE model call; eve
   * would otherwise keep stepping after a truncated or malformed
   * `eve__reply` call (an invalid tool input becomes a tool error and the
   * loop runs another step with the WHOLE message again — for reference
   * ingest, the PDF). TEXT_MAX_STEPS for text kinds (no tools, so a second
   * step can only follow a hallucinated tool call); STRUCTURED_MAX_STEPS for
   * outputSchema kinds (one repair of a bad eve__reply, then fail — the
   * pre-port equivalent was the throw Inngest / the caller already handles).
   *
   * Steps, not model calls: inside a step eve may re-issue the call once on an
   * empty response (and retry transient errors), with no new step.started, so
   * the completed-call bound is 2 × maxSteps (see stepCeilingError in
   * agents/utility/lib/spec-client.ts).
   */
  maxSteps: number
  /** Wall clock for the whole eve round trip (create + stream to terminal). */
  timeoutMs: number
  /**
   * Whether DeepSeek thinks on this kind (deepseekSurfacePolicy). Absent = off.
   * Off wherever someone waits (drafts, titles, note continuation), and on
   * every kind whose output cap or wall clock can't hold DeepSeek's reasoning
   * (~5–8K tokens at ~100 tok/s on the hosts that think): the knowledge brief
   * (1,600 tokens), the weaver judges (60 s), the memory summary (1,000 tokens,
   * 60 s) and reference ingest (3,000 / 12,000 tokens). 'on' only for claim
   * extraction, an uncapped background pass with a 270 s clock.
   */
  deepseekThinking?: DeepSeekThinking
  /**
   * A last check on the VERIFIED claims, after requiredParams: false refuses
   * the call (the spec route answers 422), so the session never runs. For a
   * rule the kind must never break whoever mints the token, e.g. draft_review's
   * "the reviewer is another vendor than the writer".
   */
  validate?: (claims: UtilityTokenClaims) => boolean
  /**
   * Route only to hosts with a zero-data-retention agreement that don't train
   * on prompts (the Gateway's `zeroDataRetention` / `disallowPromptTraining`
   * filters), whatever the model. DeepSeek already gets this from its fixed
   * private-host list (deepseekSurfacePolicy); this covers the other vendors,
   * e.g. draft_review's Haiku. Checked 2026-10-19 against
   * /v1/models/anthropic/claude-haiku-4.5/endpoints: all four hosts
   * (anthropic, bedrock, claudeaws, vertexAnthropic) are ZDR + no-training, so
   * the filter narrows nothing today and keeps a future host from slipping in.
   */
  privateRouting?: true
  /**
   * The eve agent that runs the kind, when it isn't the utility agent: the
   * web-research agent (agents/web-research), the one with OpenAI's own web
   * search on the person's plan. runUtilityTask dispatches there, and each
   * agent refuses a spec meant for the other.
   */
  agent?: UtilityAgent
}

/** The eve agents that run utility kinds besides the utility agent itself. */
export type UtilityAgent = 'web-research'

/** The Gateway's privacy filters (see UtilityKindSpec.privateRouting). */
export const PRIVATE_GATEWAY_ROUTING = { zeroDataRetention: true, disallowPromptTraining: true } as const

/** Model-step ceiling for a kind that answers in text. */
export const TEXT_MAX_STEPS = 1
/** Model-step ceiling for a kind called with an outputSchema: the answer plus one repair. */
export const STRUCTURED_MAX_STEPS = 2

/**
 * email_draft_reply's per-call timeout. Measured 2026-09-25 on a local boot
 * (eve 0.66.3 dev, deepseek-v4-flash — the drafting default, which reasons
 * before answering), 10 serial drafts of a realistic 3-message thread:
 *   - pre-port in-process generateText: mean 23.0s, p50 22.1s, max 40.0s;
 *   - eve utility round trip:           mean 13.0s, p50 14.5s, max 20.7s.
 * A draft is NOT a few seconds (as the retired chat title was, with thinking off), so a
 * tight timeout would cut healthy drafts. 45s is ~2x the slowest eve draft and
 * above the slowest pre-port one; it bounds a HUNG call so three of them cost
 * at most 135s of the cron's 300s. Healthy latency alone (10 drafts × ~13s per
 * user, users serial) already strains that budget — a throughput limit of the
 * cron itself, not something the timeout can fix.
 */
export const EMAIL_DRAFT_REPLY_TIMEOUT_MS = 45_000

/**
 * draft_review's wall clock. The reviewer reads one draft (a few hundred
 * words) plus the rubric and answers a short structured verdict, on a fast
 * model with thinking off (Haiku 4.5 for a DeepSeek writer). 30s bounds a hung
 * call; the draft is saved either way (the review fails open).
 */
export const DRAFT_REVIEW_TIMEOUT_MS = 30_000

/**
 * coding_precheck's wall clock. One action (title and description, the
 * description capped at 20K characters) in, a short verdict out, on Flash with
 * thinking off. 45s bounds a hung call; the run goes ahead either way (the
 * pre-check fails open for a person's Start).
 */
export const CODING_PRECHECK_TIMEOUT_MS = 45_000

/**
 * code_review's wall clock. Up to ~60K characters of diff plus the item in, a
 * structured verdict out, on DeepSeek V4 Pro with thinking on (Liam's Q4: a
 * stronger reviewer for code), so the output cap holds its reasoning too.
 * The coder's finish_run waits on it, inside the outcome route's 300s; 180s
 * bounds a hung call (a person's run then opens a draft marked unreviewed).
 */
export const CODE_REVIEW_TIMEOUT_MS = 180_000

export const UTILITY_KIND_SPECS: Record<UtilityKind, UtilityKindSpec> = {
  browser_field_text: {
    surface: 'drafting', feature: 'browser.field_text', requiredParams: [],
    systemPrompt: () => BROWSER_FIELD_TEXT_PROMPT,
    maxOutputTokens: 900, maxSteps: TEXT_MAX_STEPS, timeoutMs: 8_000,
  },
  // A Jev decision on a free user's own ChatGPT plan (src/lib/ai/decisions/
  // plan-decision.ts): only ever dispatched with `chatgptPlan`, so it runs on
  // the plan's helper model; the surface is nominal. Its usage is logged by
  // runDecision under each decision's own feature (`decision.<kind>`).
  plan_decision: {
    surface: 'drafting', feature: 'decision.plan', requiredParams: [],
    systemPrompt: () => PLAN_DECISION_PROMPT,
    maxOutputTokens: 1_200, maxSteps: TEXT_MAX_STEPS, timeoutMs: 30_000,
    // Only ever on the plan: a token for any other model is refused.
    validate: (claims) => planModelFromSlug(claims.model) !== null,
  },
  // An eval judge on the run starter's own ChatGPT plan (src/lib/evals/
  // graders/judges.ts judgeOnPlan): only ever dispatched with `chatgptPlan`
  // and the plan's main model; the surface is nominal. A judge reads a whole
  // meeting transcript, so it gets the time a long read needs.
  eval_judge: {
    surface: 'knowledge', feature: 'eval.judge', requiredParams: [],
    systemPrompt: () => EVAL_JUDGE_PROMPT,
    maxOutputTokens: 2_000, maxSteps: STRUCTURED_MAX_STEPS, timeoutMs: 120_000,
    // Only ever on the plan: a token for any other model is refused.
    validate: (claims) => planModelFromSlug(claims.model) !== null,
  },
  // Exa's deep search on a free user's own ChatGPT plan
  // (src/lib/web-research/plan-deep-search.ts): only ever dispatched with
  // `chatgptPlan`, on the plan's helper model, by the web-research agent (its
  // OpenAI web search runs the searches inside one step). Steps: the
  // research and its structured answer, one repair, and a step to spare for
  // a search the model runs after reading. The clock: a CRM card's caller
  // cuts it at 60 s with its own signal; prospecting discovery (up to 20
  // companies from 25 pages) passes none, and gets the time a long read
  // needs inside its Inngest step.
  plan_web_search: {
    surface: 'knowledge', feature: 'web_research.plan', requiredParams: [],
    systemPrompt: () => PLAN_WEB_RESEARCH_PROMPT,
    maxSteps: 4, timeoutMs: 180_000,
    agent: 'web-research',
    // Only ever on the plan: a token for any other model is refused.
    validate: (claims) => planModelFromSlug(claims.model) !== null,
  },
  // The pre-port call sent ONE `prompt` string and no instructions; the whole
  // prompt rides as the task message.
  generate_title: {
    surface: 'drafting',
    feature: 'generate_title',
    requiredParams: [],
    systemPrompt: () => null,
    maxSteps: TEXT_MAX_STEPS,
    timeoutMs: 45_000,
  },
  skill_draft: {
    surface: 'drafting',
    feature: 'skill_draft',
    requiredParams: [],
    systemPrompt: () => SKILL_DESCRIPTION_INSTRUCTIONS,
    maxSteps: STRUCTURED_MAX_STEPS,
    timeoutMs: 45_000,
  },
  claim_extraction: {
    surface: 'knowledge',
    feature: 'claim_extraction',
    requiredParams: [],
    systemPrompt: () => CLAIM_EXTRACTION_PROMPT,
    maxSteps: STRUCTURED_MAX_STEPS,
    deepseekThinking: 'on',
    // Up to 60k chars of source and 40 claims back, on a reasoning default,
    // with no measurement behind a tighter bound. The pre-port generateObject
    // had no timeout and could run to the extraction step's 300s limit, so
    // (like reference_ingest_segment) stop just short of that: this only
    // catches a HUNG call, never a slow healthy one.
    timeoutMs: 270_000,
  },
  draft_followup: {
    surface: 'drafting',
    feature: 'draft_followup_email',
    requiredParams: ['tone'],
    systemPrompt: (p) => draftFollowupInstructions(p.tone),
    maxSteps: TEXT_MAX_STEPS,
    timeoutMs: 90_000,
  },
  email_draft_reply: {
    surface: 'drafting',
    feature: 'email_draft_reply',
    requiredParams: ['tone', 'userName'],
    systemPrompt: (p) => emailDraftReplyInstructions(p.tone, p.userName),
    maxSteps: TEXT_MAX_STEPS,
    // Runs up to max_drafts (10) times per user, serially, inside the
    // email-management cron (maxDuration 300s). The timeout bounds a HUNG call
    // without cutting a slow-but-healthy one (measurements on the constant).
    timeoutMs: EMAIL_DRAFT_REPLY_TIMEOUT_MS,
  },
  outreach_draft: {
    surface: 'drafting',
    feature: 'outreach_draft',
    requiredParams: ['userName'],
    systemPrompt: (p) => outreachDraftInstructions(p.userName),
    maxSteps: TEXT_MAX_STEPS,
    timeoutMs: 90_000,
  },
  knowledge_brief: {
    surface: 'knowledge',
    feature: 'knowledge_brief',
    requiredParams: [],
    systemPrompt: () => KNOWLEDGE_BRIEF_PROMPT,
    maxSteps: TEXT_MAX_STEPS,
    // The pre-port generateText sent maxOutputTokens: 1600 (the prompt asks
    // for ~900 words). Up to ~49 briefs run per workspace per nightly weave,
    // with no usage row, so the cap is the only bound on their spend.
    maxOutputTokens: 1600,
    timeoutMs: 120_000,
  },
  knowledge_weaver_judge: {
    surface: 'knowledge',
    feature: 'knowledge_weaver_judge',
    requiredParams: [],
    systemPrompt: () => WEAVER_PAIR_JUDGE_PROMPT,
    maxSteps: STRUCTURED_MAX_STEPS,
    timeoutMs: 60_000,
  },
  knowledge_weaver_anchor_link: {
    surface: 'knowledge',
    feature: 'knowledge_weaver_anchor_link',
    requiredParams: [],
    systemPrompt: () => WEAVER_ANCHOR_JUDGE_PROMPT,
    maxSteps: STRUCTURED_MAX_STEPS,
    timeoutMs: 60_000,
  },
  // reference/ingest — the PDF classify+overview call, then one structuring
  // call per page-range segment. The PDF rides in the task message as a file
  // part. Telemetry-only feature 'reference_ingest' (this job logs no usage,
  // by design — do not add billing here). The 'document_ingest' surface is
  // Anthropic-only because the model reads the PDF itself.
  reference_ingest_outline: {
    surface: 'document_ingest',
    feature: 'reference_ingest',
    requiredParams: [],
    systemPrompt: () => REFERENCE_INGEST_CLASSIFY_PROMPT,
    maxSteps: STRUCTURED_MAX_STEPS,
    maxOutputTokens: 3_000,
    timeoutMs: 150_000,
  },
  reference_ingest_segment: {
    surface: 'document_ingest',
    feature: 'reference_ingest',
    requiredParams: [],
    systemPrompt: () => REFERENCE_INGEST_SEGMENT_PROMPT,
    maxSteps: STRUCTURED_MAX_STEPS,
    maxOutputTokens: 12_000,
    // Up to 25 PDF pages in and 12k tokens out; each segment is its own
    // Inngest step (route maxDuration 300s), so stop just short of that. A
    // ceiling: the handler passes less when the step's download / slice /
    // upload already used part of it (stepModelTimeoutMs, reference-ingest.ts).
    timeoutMs: 270_000,
  },
  // /api/ai/complete ("continue writing" in the note editor). The only kind
  // that STREAMS: streamUtilityText forwards the session's text deltas to the
  // editor as they arrive. Feature 'ai_complete' is the route's logUsage key.
  // The pre-port streamText had no output cap and no timeout of its own — the
  // route's maxDuration (60s) was the bound.
  note_continuation: {
    surface: 'drafting',
    feature: 'ai_complete',
    requiredParams: [],
    systemPrompt: () => NOTE_CONTINUATION_INSTRUCTIONS,
    maxSteps: TEXT_MAX_STEPS,
    // Covers the create and the whole stream. It, the post-timeout cancel
    // (≤ 5s) and the route's auth / model lookup must end inside its 60s: this
    // is the ceiling — the route passes less when its own pre-work already
    // used part of the 60s (routeModelTimeoutMs, stream-route.ts).
    timeoutMs: 50_000,
  },
  // What a teammate remembers from a finished work run (plan row 15;
  // src/lib/work/agent-memory-summary.ts). Background, one call per completed
  // teammate run, logged under its own feature. 'knowledge' like the other
  // knowledge-graph summarisers: the work surface's model is the expensive one.
  agent_memory_summary: {
    surface: 'knowledge',
    feature: 'agent_memory_summary',
    requiredParams: [],
    systemPrompt: () => AGENT_MEMORY_SUMMARY_PROMPT,
    maxSteps: STRUCTURED_MAX_STEPS,
    maxOutputTokens: 1_000,
    timeoutMs: 60_000,
  },
  // The nightly memory pass for Mail (one-agent plan Part 3, "Memory";
  // src/lib/packs/memory-learning.ts): up to three tone and sign-off lines
  // from a person's recent sent mail (read live, kept nowhere), saved live as
  // what Native Intelligence noticed (2026-10-17). Background, at most one
  // call per person per day, under the pass's per-run cap; 'knowledge' like
  // the other background summarisers. Thinking off: three short lines need
  // none, and the cap below can't hold DeepSeek's reasoning.
  memory_learn_mail_tone: {
    surface: 'knowledge',
    feature: 'memory_learning',
    requiredParams: [],
    systemPrompt: () => MEMORY_LEARN_MAIL_TONE_PROMPT,
    maxSteps: STRUCTURED_MAX_STEPS,
    maxOutputTokens: 600,
    timeoutMs: 60_000,
  },
  // The capture pass (always-on plan §3b, A2c; src/lib/memory/capture-pass.ts):
  // what a chat said since its last capture, read into facts the person
  // stated, facts it inferred (proposals), and replacements or removals of
  // facts it was shown. Background (Inngest), one call per compaction or
  // nightly catch-up; 'knowledge' like the mail-tone pass. Thinking off: a
  // short structured answer, and the cap can't hold DeepSeek's reasoning.
  memory_capture: {
    surface: 'knowledge',
    feature: 'memory_capture',
    requiredParams: [],
    systemPrompt: () => MEMORY_CAPTURE_PROMPT,
    maxSteps: STRUCTURED_MAX_STEPS,
    maxOutputTokens: 1_500,
    timeoutMs: 90_000,
  },
  // The look-ahead (docs/plans/look-ahead-heartbeat.md,
  // src/lib/look-ahead/facts.ts): a slot's calendar items and the mail behind
  // them to checked facts. Structured, small, on the Fast surface like a
  // decision. It reads mail, so the Gateway's privacy filters (as for the
  // coding precheck, which can quote an email).
  look_ahead_extract: {
    surface: 'drafting',
    feature: 'look_ahead.extract',
    requiredParams: [],
    systemPrompt: () => LOOK_AHEAD_EXTRACT_PROMPT,
    maxSteps: STRUCTURED_MAX_STEPS,
    // Answers ran to about 1,800 tokens on DEV (six items, four booking mails): room to finish.
    maxOutputTokens: 3_000,
    timeoutMs: 60_000,
    privateRouting: true,
  },
  // The quality layer's reviewer (eve-templates-lessons.md §3b P1;
  // src/lib/writing/review.ts): a fresh context that gets only the surface
  // and the draft, and returns { verdict, issues }. The caller always passes
  // the model (pickReviewerModel: another vendor than the writer), so the
  // surface below is only the fallback resolveUtilityModel would use, and
  // validate refuses a token whose model shares the writer's vendor. Capped:
  // eight short issues fit well inside 1,200 tokens, and it runs at most
  // twice per automatic draft.
  draft_review: {
    surface: 'drafting',
    feature: 'draft_review',
    requiredParams: ['surface', 'writerModel'],
    systemPrompt: (p) => draftReviewInstructions(p.surface),
    maxSteps: STRUCTURED_MAX_STEPS,
    maxOutputTokens: 1_200,
    timeoutMs: DRAFT_REVIEW_TIMEOUT_MS,
    // Another vendor, or on the person's own ChatGPT plan (only OpenAI's
    // models) the plan's other model (reviewer-model.ts planReviewerModel). A
    // plan reviewer is judged by that rule alone: `chatgpt-plan` isn't a
    // vendor, so the vendor rule would pass a plan model reviewing itself
    // under its `openai/` name.
    validate: (claims) =>
      planModelFromSlug(claims.model)
        ? differentPlanModels(claims.model, claims.params.writerModel)
        : differentVendors(claims.model, claims.params.writerModel),
    // The draft quotes mail: the reviewer gets the writer's privacy routing.
    privateRouting: true,
  },
  // A coding run's pre-check (P10 F5; src/lib/coding/precheck.ts): is the
  // action clear enough to build, and what must the change do. One short
  // structured answer before any sandbox, on the cheap drafting model with
  // thinking off. The action can quote a call or an email, so its routing is
  // private like the reviewer's.
  coding_precheck: {
    surface: 'drafting',
    feature: 'coding_precheck',
    requiredParams: [],
    systemPrompt: () => CODING_PRECHECK_PROMPT,
    maxSteps: STRUCTURED_MAX_STEPS,
    maxOutputTokens: 1_200,
    timeoutMs: CODING_PRECHECK_TIMEOUT_MS,
    privateRouting: true,
  },
  // A coding run's reviewer (P10 F6; src/lib/coding/review.ts): the work item,
  // its criteria, the branch's commits and the real diff in, a verdict with each criterion's
  // evidence out. Like draft_review, the caller always passes the model
  // (pickReviewerModel: another vendor than the coder, decision 13) and
  // validate refuses a token that breaks that rule. The diff is private code.
  code_review: {
    surface: 'drafting',
    feature: 'code_review',
    requiredParams: ['writerModel'],
    systemPrompt: () => CODE_REVIEW_PROMPT,
    maxSteps: STRUCTURED_MAX_STEPS,
    maxOutputTokens: 16_000,
    timeoutMs: CODE_REVIEW_TIMEOUT_MS,
    deepseekThinking: 'on',
    validate: (claims) => differentVendors(claims.model, claims.params.writerModel),
    privateRouting: true,
  },
}

/**
 * The bare app model id a utility kind runs on: its surface's fixed model
 * (SURFACE_MODELS: Flash, or STRONG_MODEL for document ingest, which sends the
 * PDF itself). Nobody picks a model, so the workspace no longer matters; the
 * signature stays so call sites are unchanged.
 */
export async function resolveUtilityModel(
  kind: UtilityKind,
  _supabase: SupabaseClient,
  _workspaceId: string | null,
): Promise<string> {
  return surfaceModel(UTILITY_KIND_SPECS[kind].surface)
}

/**
 * The ChatGPT plan model a utility kind runs on for a person on their own plan
 * (the free tier): Sol where the surface is Native Intelligence's strong model (document
 * ingest), Luna for every other one-shot.
 */
export function utilityPlanModel(kind: UtilityKind): string {
  return UTILITY_KIND_SPECS[kind].surface === 'document_ingest' ? PLAN_MAIN_MODEL : PLAN_HELPER_MODEL
}

/** JSON-serializable provider options, keyed by provider (eve's providerOptions shape). */
export type UtilityProviderOptions = Record<string, Record<string, unknown>>

/** The eve-facing spec: everything the utility agent's resolvers need. */
export interface UtilitySpec {
  kind: UtilityKind
  /** Gateway catalog slug (provider-qualified). */
  model: string
  /** System instructions for the session, or null (the static contract only). */
  systemPrompt: string | null
  /** Gateway telemetry and provider tuning; absent when there is none. */
  providerOptions?: UtilityProviderOptions
  /** Per-call output-token cap; absent when the kind has none. */
  maxOutputTokens?: number
  /** Model-step ceiling for the session (see UtilityKindSpec.maxSteps). */
  maxSteps: number
  /**
   * Present when the call runs on the person's own ChatGPT plan (its token
   * was signed with a `chatgpt-plan/<model>` model, runUtilityTask's
   * `chatgptPlan`): the utility agent then runs it on its plan model through
   * the plan proxy, never the Gateway, and `model` is OpenAI's catalog slug
   * for the same model (the session's guard selection).
   */
  chatgptPlan?: ChatGptPlanSpec
  /** The agent that runs it, when it isn't the utility agent (UtilityKindSpec.agent). */
  agent?: UtilityAgent
}

/**
 * Rebuild a call's spec from its verified claims. Returns null when the claims
 * lack a param the kind's prompt needs (a malformed mint — refuse rather than
 * run the model with a hole in its instructions), or fail the kind's validate.
 */
export function buildUtilitySpec(claims: UtilityTokenClaims): UtilitySpec | null {
  const kindSpec = UTILITY_KIND_SPECS[claims.kind]
  for (const name of kindSpec.requiredParams) {
    if (typeof claims.params[name] !== 'string') return null
  }
  if (kindSpec.validate && !kindSpec.validate(claims)) return null

  // A call on the person's own ChatGPT plan: the plan model, no Gateway
  // attribution or host routing (no Gateway call is made).
  const planModel = planModelFromSlug(claims.model)
  if (planModel) {
    return {
      kind: claims.kind,
      model: `openai/${planModel}`,
      systemPrompt: kindSpec.systemPrompt(claims.params),
      ...(kindSpec.maxOutputTokens !== undefined ? { maxOutputTokens: kindSpec.maxOutputTokens } : {}),
      maxSteps: kindSpec.maxSteps,
      chatgptPlan: { model: planModel, helperModel: planModel, reasoning: 'low' },
      ...(kindSpec.agent ? { agent: kindSpec.agent } : {}),
    }
  }

  const model = gatewayModelSlug(claims.model)
  const providerOptions: UtilityProviderOptions = {}

  // Per-user Gateway attribution (Phase A), same feature string as the call
  // site's logUsage, tagged runtime:eve like every other eve path. Null when
  // GATEWAY_USER_TAGGING is off; `user` is omitted for unattributed work.
  const telemetry = gatewayTelemetryValues(claims.userId, kindSpec.feature, {
    workspaceId: claims.workspaceId,
    runtime: 'eve',
  })
  if (telemetry) providerOptions.gateway = telemetry

  // DeepSeek reasons before every answer unless told not to (a chat title with
  // it off arrives in well under a second instead of 8–9 s). Its thinking
  // option and private-host routing ride the provider options: the utility
  // agent forwards those, and the `deepseek` entry decides thinking on every
  // allowed host, so no top-level `reasoning` is needed. Other models: nothing.
  const policy = deepseekSurfacePolicy(claims.model, kindSpec.deepseekThinking ?? 'off')
  if (policy?.providerOptions) Object.assign(providerOptions, policy.providerOptions)
  if (policy?.gateway) providerOptions.gateway = { ...providerOptions.gateway, ...policy.gateway }
  if (kindSpec.privateRouting) providerOptions.gateway = { ...providerOptions.gateway, ...PRIVATE_GATEWAY_ROUTING }

  return {
    kind: claims.kind,
    model,
    systemPrompt: kindSpec.systemPrompt(claims.params),
    ...(kindSpec.agent ? { agent: kindSpec.agent } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    ...(kindSpec.maxOutputTokens !== undefined ? { maxOutputTokens: kindSpec.maxOutputTokens } : {}),
    maxSteps: kindSpec.maxSteps,
  }
}
