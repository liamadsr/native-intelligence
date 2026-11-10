/**
 * Headless run_skill executor — the loop engine's body. Executes a skill
 * (recipe row, category 'skill') with NO client attached, server-side, as a
 * durable eve TASK session on the `skill-runner` agent (runSpecViaEve →
 * run-skill-eve.ts), the chat route's exact prompt layering reproduced,
 * delivered as a document + notification (or, for a verdict contract, the
 * server-side apply walk). The tool ceiling is SERVER-ENFORCED and STRUCTURAL:
 * the eve resolver advertises only ceiling tools, and the internal skill-run
 * tool route re-derives + re-checks the ceiling from the signed run token.
 *
 * Two data-only seams: `assembleSkillRun` (identity → skill load →
 * preconditions → prompt → tool ceiling → user message → a portable spec) and
 * `deliverSkillOutput` / `deliverVerdictRun` (usage log → document /
 * verdict apply → notification). runSpecViaEve runs the eve session between
 * them.
 *
 * The runner (runner.ts) stays pure: callers build this executor and inject
 * it via runFlow's `executors` option. Every service-role query here filters
 * by workspace_id — this runs RLS-bypassed.
 */
import { placeRunSuggestions } from '@/lib/suggestions/deliver'
import { getServiceClient } from '@/lib/admin'
import { recordVerdictTouches } from '@/lib/work/touch'
import { usageProviderLabel } from '@/lib/ai/models'
import { isModelTier, modelRouteMetadata, tierModel, tierReasoning, type ModelRoute } from '@/lib/ai/model-route'
import { backgroundPlanSpec, isChatGptPlanUsage, planModelSlug } from '@/lib/chatgpt/plan-models'
import { grantStrong } from '@/lib/ai/model-escalation-budget'
import { logUsage } from '@/lib/ai/auth'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { buildSystemPrompt } from '@/lib/ai/system-prompt'
import {
  computeInitialActiveTools,
  computeToolCeiling,
  ALWAYS_ON_CAPABILITY_TOOL_NAMES,
} from '@/lib/ai/tool-discovery'
import { ALL_CATEGORY_IDS, CHAT_NATIVE_TOOL_NAMES, getMutatingToolNames, isAttendedOnlyTool, isChatNativeTool } from '@/lib/ai/tool-registry'
import { attendedOnlyToolsDeniedTo } from '@/lib/safety/caller'
import { createNotification } from '@/lib/notifications'
import { botNoticeCopy, botNoticeMetadata, noticeTeammateName } from '@/lib/bots/bot-notice'
import { skippedNoticeLine, verdictNoticeLine } from '@/lib/bots/narration'
import { renderTemplate, buildTemplateContext } from './template'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { RESPONSE_BODY_PREVIEW_BYTES } from './runner'
import { skillActCeiling } from './skill-tool-profile'
import {
  parsePreconditions,
  checkPreconditions,
  buildEmptyStateMessage,
} from './skill-preconditions'
import { resolveTrustPolicy } from '@/lib/proposed-changes/trust-policy'
import { applyVerdict, resolveTrust, type RunVerdict, type ResolvedTrust } from './verdict-apply'
import { buildContextPack } from './context-pack'
import { EveRunTimeoutError, EveSessionFailedError, cancelParkedSkillSession, runViaEve, type EveRunResult } from './run-skill-eve'
import { parkSkillRunSession, shouldParkSkillRun } from './skill-run-session'
import { phraseForToolNames } from '@/lib/work/step-phrases'
import type { WorkHandle } from '@/lib/work/recorder'
import { areaTeammateId } from '@/lib/work/system-teammates'
import { KINDS_WITHOUT_BOT } from '@/lib/work/bot-owner'
import { areasForSkillRun, backgroundExpertiseSection } from '@/lib/packs/background'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveWorkspaceEdition } from '@/lib/editions'
import { workspaceWordsSection } from '@/lib/customers/business-words'
import type { RunSkillExecutor, RunSkillExecutionResult } from './runner'
import type { RequestSummary, RunSkillActionConfig, VerdictLedger } from './types'
import { connectorInstruction, isStructuredConnector, parseConnectorOutput, type PostSurface, type StructuredConnector } from './output-connectors'
import { deliverConnectorItems } from './deliver-connector'
import { runReadOutsideText, type ToolRead } from './run-outside-reads'
import { isLensKey, lensPromptBlock, lensSkipReason, sortRides, type LensCallFacts, type LensRide } from './lenses'
import { loadCallFacts } from './lens-plan'
import { lensFindingsText } from './lens-runs'
import { deliverLensSections, lensRidesFailed } from './lens-deliver'
import { loadPostWeekMaterial, renderNewsletterBlock, renderPostWeekBlock } from '@/lib/content/post-week'
import { loadAskedBy, onlyToAskers, renderAskedByBlock, renderShippedBlock, type ShippedEntity } from '@/lib/marketing/asked-by'

/**
 * Hard wall for one headless prose (report / act) skill run.
 *
 * 240s, not 120s: 120s cut off the scheduled prose loops on prod. The Native Intelligence
 * Morning brief took 73–121s on the days it finished (Sep 17–28) and was stopped
 * at the wall on Sep 22, 23, 29 and 30; Session Prep took 112s on Sep 23 and was
 * stopped on Sep 16 and 30; the Weekly Groom and Commitment Reconciler loops
 * were stopped every time in three weeks. A run stopped at its wall bills its
 * steps and delivers nothing. Two prose walls still fit one /api/inngest request
 * (MAX_ENABLED_RUN_SKILL_ACTIONS = 2, plus FLOW_TAIL_RESERVE_MS);
 * run-skill-salvage.test.ts pins it.
 */
const EXECUTION_TIMEOUT_MS = 240_000

/**
 * WS-4c: verdict-class runs get a longer wall. 120s timed out the Jul-3 sweep
 * with nothing to show; a verdict-contract run pages through the whole queue and
 * needs the room. If even this is exceeded, the salvage path (runSpecViaEve)
 * still applies whatever verdict the model committed before the abort. A local
 * constant, not a RunSkillActionConfig field — that config type is owned by
 * types.ts, which this workstream must not edit.
 *
 * 480s, not 240s: 240s cut off the Daily Triage Sweep on Sep 18, 24 and 28 while
 * it was writing its verdict. The last one read the queue in ~90s (three rounds
 * of tool calls) and was still writing the verdict for 15 proposals 152s later.
 * On eve that verdict commits only at the turn boundary, so every decision was
 * lost. The runs that finished took 105–211s.
 */
const VERDICT_EXECUTION_TIMEOUT_MS = 480_000

/** The server wall for a spec: verdict runs get the longer one (WS-4c). */
export function serverTimeoutMsForSpec(spec: Pick<SkillRunSpec, 'outputContract'>): number {
  return spec.outputContract === 'verdict' ? VERDICT_EXECUTION_TIMEOUT_MS : EXECUTION_TIMEOUT_MS
}

/**
 * The shortest wall a prose run is worth starting on.
 */
export const MIN_SERVER_WALL_MS = 30_000

/**
 * The shortest wall a verdict run starts on: the old full wall, which the
 * sweep's shorter days fit into. On eve a verdict commits only at the turn
 * boundary, so a verdict run on a much shorter wall bills for a run that most
 * likely ends with nothing. Below this it does not start. A request with less
 * budget than the full 480s wall (the test-fire route) still runs a verdict on
 * whatever it has above this, as before.
 */
export const MIN_VERDICT_WALL_MS = 240_000

/** The shortest wall a server run for this spec may start on. */
export function minServerWallMsForSpec(spec: Pick<SkillRunSpec, 'outputContract'>): number {
  return spec.outputContract === 'verdict' ? MIN_VERDICT_WALL_MS : MIN_SERVER_WALL_MS
}

/**
 * The wall a server run gets when it must finish by `deadlineMs`:
 * min(its normal wall, time left), or null when that is below its minimum
 * (minServerWallMsForSpec) and the run must not start.
 */
export function wallWithinDeadline(
  spec: Pick<SkillRunSpec, 'outputContract'>,
  deadlineMs: number,
  now = Date.now(),
): number | null {
  const wall = serverTimeoutMsForSpec(spec)
  const remaining = deadlineMs - now
  if (remaining < minServerWallMsForSpec(spec)) return null
  return Math.min(wall, remaining)
}

/**
 * /api/inngest's maxDuration, in ms. The flow dispatchers run every run_skill
 * action inside one function request, so their deadline is measured from it.
 * Pinned equal to the route's export by run-skill-salvage.test.ts. 600s so the
 * full verdict wall (480s) fits inside one request with the tail reserve.
 */
export const INNGEST_FUNCTION_BUDGET_MS = 600_000

/**
 * Kept back at the end of the request after the last wall can fire: runViaEve's
 * server-side cancel (≤5s), delivery + the flow_run insert, and the ledger
 * settle.
 */
export const FLOW_TAIL_RESERVE_MS = 45_000

/** The deadline for run_skill walls in a flow dispatch that started at
 *  `startedAt`, on a request whose platform budget is `budgetMs` (the
 *  /api/inngest dispatchers by default; the test-fire route passes its own). */
export function flowRunDeadlineMs(startedAt: number, budgetMs = INNGEST_FUNCTION_BUDGET_MS): number {
  return startedAt + budgetMs - FLOW_TAIL_RESERVE_MS
}

/**
 * Standing headless preamble — prepended in FRONT of the skill layering so
 * the model knows there is no user on the other end before it reads anything
 * else.
 */
const HEADLESS_PREAMBLE = [
  '## Unattended Automation Run',
  'You are running unattended inside an automation flow. There is no user to ask.',
  'Carry the job through to a complete written result; if data is missing, say so briefly and continue.',
].join('\n')

/**
 * Read-only capture tools force-enabled on capture_processed fires. The skill's
 * own categories may not include captures (e.g. an email-drafting skill), but a
 * run whose entire subject IS a capture must always be able to read it.
 */
const CAPTURE_READ_TOOLS = ['get_capture_content', 'get_capture_transcript', 'get_capture_extractions']

/** The verdict terminating tool's bare name (Phase 2, Workstream B). It sits in
 *  a verdict run's ceiling + activeTools as the contract marker; eve commits the
 *  verdict as a structured outputSchema instead (skill-run-rebuild.ts drops this
 *  name from the advertised proxies). */
const VERDICT_TOOL_NAME = 'submit_run_verdict'

interface SkillRecipeRow {
  id: string
  name: string
  system_prompt: string | null
  updated_at: string | null
  /** The skill's area (migration 316): its run gets that area's playbook. */
  area?: string | null
  agent_config: {
    enabled_tools?: string[]
    disabled_tools?: string[]
    context_rules?: string[]
    response_style?: { format?: string; tone?: string; always_cite_sources?: boolean }
    /** GEN-145: capabilities the skill needs before it can produce anything. */
    preconditions?: string[]
    /**
     * Phase 2, Workstream B: 'verdict' turns this into a triage-class skill —
     * it runs with NO mutating tools and ONE submit_run_verdict terminating
     * tool; the engine applies its structured verdict server-side. Absent =
     * legacy prose skill (delivers a document). Only 'verdict' has meaning.
     */
    output_contract?: 'verdict' | 'prose'
    /**
     * F1 (skill-tool-profile.ts): 'agent' on a skill the agent wrote through
     * create_skill / update_skill. With no enabled_tools its act-mode ceiling
     * is reads and drafts only, never the core set.
     */
    authored_by?: 'agent'
    /**
     * Auto model selection (src/lib/ai/model-route.ts): the tier this skill's
     * runs take. Absent = 'think' (Flash at DeepSeek's own effort, what every
     * skill run did before). 'strong' is granted within the run-as person's
     * daily cap and plan (grantStrong), else Think. Skill metadata, no UI.
     */
    model_tier?: 'fast' | 'think' | 'strong'
    /**
     * F3 lens flows (lenses.ts, migration 382): 'content' or 'marketing' on a
     * lens-capable skill. Its capture_processed flow rides Triage's read of the
     * call instead of running on its own (lens-plan.ts); with Triage off it runs
     * alone, committing its lens's section.
     */
    lens?: string
    /**
     * P9 (the opt-in recipes): material the SERVER reads before the run and
     * puts in its message, in a few bounded queries and no model call:
     *   post_week  the weekly post pass (src/lib/content/post-week.ts): the
     *              person's moments from their calls (the content lens), what
     *              shipped, what was published, their brief. Only with
     *              deliver_to post_drafts.
     *   asked_by   "you asked, we shipped" (marketing/asked-by.ts): what
     *              shipped (the flow's entity) and who asked for it. Only with
     *              deliver_to email_drafts; drafts go only to those people.
     *   shipped    the launch kit: what shipped, nothing about who asked.
     *              Prose (a document).
     *   week_of_work  the newsletter: the same week as post_week, as a
     *              document the person copies out (decision 9). Prose.
     */
    material?: string
  } | null
}

/**
 * A skill run's tier: its recipe's `agent_config.model_tier`, Think when
 * unset, and Strong only when granted (the plan, the daily cap, the kill
 * switch: grantStrong), else Think. Never throws.
 */
export async function skillRunTier(
  supabase: SupabaseClient,
  args: { agentConfig: SkillAgentConfig; runAsUserId: string; workspaceId: string; isPaidPlan: boolean; key: string },
): Promise<ModelRoute> {
  const asked = args.agentConfig?.model_tier
  if (!isModelTier(asked)) return { tier: 'think', by: 'fixed', signals: ['skill_default'], reasoning: tierReasoning('think') }
  if (asked !== 'strong') return { tier: asked, by: 'fixed', signals: ['skill_tier'], reasoning: tierReasoning(asked) }
  return grantStrong(supabase, {
    userId: args.runAsUserId,
    workspaceId: args.workspaceId,
    isPaidPlan: args.isPaidPlan,
    key: args.key,
    surface: 'skill_run',
    signals: ['skill_tier'],
  })
}

/** The agent_config sub-shape the deterministic rebuilders read. */
type SkillAgentConfig = SkillRecipeRow['agent_config']

/**
 * Layer a skill's persona/context_rules/response_style onto the base system
 * prompt, with the HEADLESS preamble in front — the EXACT step-3 layering of
 * assembleSkillRun, extracted so the eve internal rebuild (which cannot re-run
 * the whole assembly on a different Next instance) produces a byte-identical
 * system prompt. assembleSkillRun now CALLS this, so there is one code path and
 * they can never drift. Pure: prompt text only, no I/O.
 *
 * Exported for the parity test that asserts the rebuild equals assembleSkillRun.
 */
export function buildSkillSystemPrompt(
  recipeName: string,
  recipeSystemPrompt: string | null,
  agentConfig: SkillAgentConfig,
  basePrompt: string,
  /**
   * The run's area know-how (src/lib/packs/background.ts): the playbook of
   * the skill's area, after the skill's own sections so the skill stays the
   * more specific voice. '' for none.
   */
  expertise = '',
  /**
   * The workspace's words (src/lib/editions/words.ts renderEditionWordsSection):
   * a loop's report to a service business's owner says jobs and customers.
   * '' for an edition that says nothing.
   */
  words = '',
): string {
  const sections = [`## Active Mode: ${recipeName}`]
  if (recipeSystemPrompt) sections.push(recipeSystemPrompt)
  if (agentConfig?.context_rules?.length) {
    sections.push(
      `### Standing Instructions:\n${agentConfig.context_rules.map((r: string) => `- ${r}`).join('\n')}`,
    )
  }
  if (agentConfig?.response_style) {
    const style = agentConfig.response_style
    const parts: string[] = []
    if (style.format) parts.push(`Format: ${style.format}`)
    if (style.tone) parts.push(`Tone: ${style.tone}`)
    if (style.always_cite_sources) parts.push('Always cite sources')
    if (parts.length) sections.push(`### Response Style: ${parts.join(' | ')}`)
  }
  if (expertise.trim()) sections.push(expertise.trim())
  if (words.trim()) sections.push(words.trim())
  return HEADLESS_PREAMBLE + '\n\n' + sections.join('\n\n') + '\n\n' + basePrompt
}

/** The workspace's words for a skill run's prompt ('' for none). Never throws: both reads fail open. */
export async function skillRunWordsSection(supabase: SupabaseClient, workspaceId: string): Promise<string> {
  return workspaceWordsSection(supabase, workspaceId, (await resolveWorkspaceEdition(supabase, workspaceId)).edition)
}

/**
 * Compute the run's tool ceiling — the EXACT step-4 ceiling of assembleSkillRun,
 * including the two fire-context force-adds (capture read tools when the fire has
 * a triggering capture; the verdict terminating tool for a verdict-class skill).
 * Extracted so the eve internal rebuild derives the identical ceiling from
 * {skillId, mode, hasCapture} — the only fire-specific input is `hasCapture`,
 * which the signed token carries. Returns a Set (null-free) of bare tool names,
 * or null for inherit-all (act mode, no category restriction, no force-adds).
 * Never a chat-native tool (CHAT_NATIVE_TOOL_NAMES) or an attended-only one
 * (ATTENDED_ONLY_TOOL_NAMES): a skill run cannot run
 * one, so a set drops them here and inherit-all means NON_CHAT_TOOL_NAMES to
 * every consumer (the spec rebuild's advertised list, the tool route's gate).
 *
 * assembleSkillRun CALLS this so the two paths can't drift. Exported for the
 * parity test.
 */
export function computeSkillCeiling(
  agentConfig: SkillAgentConfig,
  mode: 'report' | 'act',
  hasCapture: boolean,
): Set<string> | null {
  const skillCategories = agentConfig?.enabled_tools ?? []
  const isVerdict = agentConfig?.output_contract === 'verdict'

  // Verdict-class skills run on the read-only report ceiling regardless of mode
  // (mode governs the trust gate, not the tool surface). Act mode is the
  // skill's own ceiling (skillActCeiling): its categories, or, for a skill the
  // AGENT wrote with none, reads and drafts only (skill-tool-profile.ts).
  const ceiling = mode === 'act' && !isVerdict ? skillActCeiling(agentConfig) : computeReportModeCeiling(skillCategories)

  // Fire-context force-adds (mutate the ceiling in place, same as assembleSkillRun).
  if (hasCapture) {
    for (const name of CAPTURE_READ_TOOLS) ceiling?.add(name)
  }
  if (isVerdict) {
    ceiling?.add(VERDICT_TOOL_NAME)
  }
  for (const name of CHAT_NATIVE_TOOL_NAMES) ceiling?.delete(name)
  // Nor an attended-only tool (bots v3 Phase 5): nobody is in an unattended
  // run to have asked for it, so the trust authority denies it
  // (caller.ts: a loop run is agent_unattended). A loop run's follow-up CHAT
  // gets its bot's chat ceiling instead (skill-run-chat-ceiling.ts), never
  // this one.
  for (const name of attendedOnlyToolsDeniedTo('agent_unattended')) ceiling?.delete(name)
  return ceiling
}

/**
 * Report-mode tool ceiling: everything the skill's categories expose, minus
 * every mutating tool. Built on computeToolCeiling's disabledTools arg — but
 * that arg only filters CATEGORY-expanded names while CORE_TOOL_NAMES are
 * seeded unconditionally, so the mutating core trio (create_action /
 * update_action / complete_action) would survive it. We subtract the mutating
 * set from the RESULT too, which makes the exclusion structural regardless of
 * how the base ceiling is assembled.
 *
 * No categories (a skill that inherits everything in chat) = all categories.
 * Exported for the guard test in __tests__/run-skill.test.ts.
 */
export function computeReportModeCeiling(skillCategoryIds?: string[]): Set<string> {
  const mutating = getMutatingToolNames()
  const base =
    computeToolCeiling(
      skillCategoryIds && skillCategoryIds.length > 0 ? skillCategoryIds : ALL_CATEGORY_IDS,
      [...mutating],
    ) ?? new Set<string>()
  const ceiling = new Set<string>()
  for (const name of base) {
    if (!mutating.has(name)) ceiling.add(name)
  }
  return ceiling
}

/**
 * Substitute {skill}/{date} in a document title in ONE pass with a
 * replacement FUNCTION. Sequential String.replace(pattern, string) has two
 * corruption modes this avoids: JS replacement-string patterns ($&, $', $`,
 * $$) inside a skill name would expand, and a literal '{date}' inside the
 * skill name (or a rendered template token) would get re-substituted by the
 * later pass. Exported for the unit tests.
 */
export function substituteTitleTokens(title: string, skillName: string, dateStr: string): string {
  return title.replace(/\{(skill|date)\}/g, (_m, key) => (key === 'skill' ? skillName : dateStr))
}

/** Truncate to the flow_run preview cap by BYTES (matches the http path). */
function truncateBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return text
  // Decode the byte-sliced prefix; a cut multibyte char degrades to U+FFFD.
  return new TextDecoder().decode(bytes.slice(0, maxBytes))
}

/**
 * A skill run's line on flow_run (readable by every member of the workspace).
 * A run given the owner's connected apps may have written their data into its
 * output, so its line says only how much it wrote (F4 review B1); any other
 * run keeps its preview.
 */
export function skillRunPreview(spec: Pick<SkillRunSpec, 'connections'>, text: string): string {
  if (spec.connections?.length) {
    const n = text.length
    return `Wrote ${n} char${n === 1 ? '' : 's'}; it used your connected apps, so its text isn't shown in the run history`
  }
  return truncateBytes(text, RESPONSE_BODY_PREVIEW_BYTES)
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

// ── The portable run spec (the shared assembly output) ──────────────────────

/**
 * Everything a run needs, exactly as the server assembled it — frozen at
 * dispatch time (server-authoritative). runSpecViaEve runs it on eve; a parked
 * run keeps it for the follow-up chat (skill-run-session.ts).
 */
export interface SkillRunSpec {
  runAsUserId: string
  workspaceId: string
  skillId: string
  skillName: string
  skillUpdatedAt: string | null
  systemPrompt: string
  userMessage: string
  /** Bare registry tool names of the run's ceiling (empty = inherit-all). The eve
   *  server path re-derives the same set server-side from the signed run token. */
  ceiling: string[]
  /** Bare registry tool names surfaced from step 1 (a subset of the ceiling). */
  activeTools: string[]
  model: string
  /** How `model` was chosen (skillRunTier), for the usage rows' model_route. */
  modelRoute?: ModelRoute
  mode: 'report' | 'act'
  deliver: RunSkillActionConfig['deliver']
  /** For the document title template ({skill}/{date}). */
  templateTitleDefault: string
  /**
   * Phase 2, Workstream B: 'verdict' when the skill's recipe declares
   * output_contract:'verdict'. The run then commits a structured verdict (an
   * eve outputSchema) and the server-side apply walk runs instead of delivering
   * the model's prose.
   * Absent/'prose' → legacy document delivery.
   */
  outputContract?: 'verdict' | 'prose'
  /**
   * W-B — the resolved trust config FROZEN at assembly (assembleSkillRun stamps
   * it from the action config). deliverVerdictRun applies the run's verdict
   * with THIS trust, not a re-fetch at verdict time: same staleness posture as
   * skill_updated_at — the run executes the contract it was dispatched with
   * (re-fetching would be a TOCTOU on trust). Only meaningful for a verdict
   * contract; carried for prose too so the spec shape is uniform.
   */
  trust?: ResolvedTrust
  /**
   * W-B — provenance for the verdict card footer ("from <skill> · <capture>"),
   * frozen at assembly so deliverVerdictRun's context needs no re-fetch.
   * captureTitle is null on a schedule/entity fire.
   * captureId (Sequence step 3) is the auto-attempt gate's grounding and
   * per-capture budget key; flowId is the flow an attempted run records as
   * its origin (agent_run_has_origin needs an action or a flow). Both are absent
   * on a spec frozen before they existed.
   */
  provenance?: { skillName: string; captureTitle: string | null; captureId?: string | null; flowId?: string | null }
  /**
   * F3 output connectors: a prose skill whose flow delivers to a structured
   * connector (post_drafts, doc_proposals, email_drafts) commits that
   * connector's typed output (an eve outputSchema, output-connectors.ts) and
   * deterministic code delivers it (deliver-connector.ts). Absent: prose,
   * delivered as a document or a notice. Never set on a verdict run.
   */
  outputConnector?: StructuredConnector
  /** The connector's destination, from the flow's config (never the model's). */
  connectorTarget?: { docKey?: string | null; surface?: PostSurface | null }
  /**
   * F3 lens flows riding this verdict run, in their stable order (frozen at
   * dispatch). Their sections are in the run's message and its outputSchema,
   * and lens-deliver.ts delivers each after the verdict is applied.
   */
  lenses?: LensRide[]
  /** The call's facts the lenses read (lens-plan.ts), frozen for delivery. */
  lensFacts?: LensCallFacts | null
  /** F3: a lens flow's own run (Triage off): it commits its lens's section. */
  lensRun?: { ride: LensRide }
  /**
   * F4: the flow owner's connected apps this run may use (the step's
   * `connections`). Carried in the run token; the spec and tool routes
   * rebuild the tools from it (skill-run-connections.ts). Absent: none.
   */
  connections?: string[]
  /**
   * F4: the flow step this run is, so an outward call it makes is held as
   * the owner's card instead of refused (caller.ts decideAction `flowStep`).
   * Absent on a test run.
   */
  flowStep?: { flowId: string; actionId: string; flowRunId: string | null; manual?: true }
  /**
   * F4: an earlier step of this fire brought outside text in (its output is
   * in this run's instructions, fenced). The run's own outside reads are added
   * to it: one provenance notion (run-outside-reads.ts).
   */
  readOutsideBefore?: boolean
  /**
   * P9: the weekly post pass's rules, frozen at assembly from the week's
   * material (post-week.ts): a slow week's posts are ideas, the cadence
   * budget, the names no post may carry, and the moment keys a delivered
   * post marks used.
   */
  postWeek?: { slow: boolean; slots: number; blockedPhrases: string[]; blockedWords: string[]; momentIds: Record<string, string>; cadenceNote: string | null }
  /**
   * P9 (M2, "you asked, we shipped"): the people who asked for the shipped
   * work (marketing/asked-by.ts). The run's email drafts go only to them;
   * a draft to anyone else is refused.
   */
  askedBy?: { askers: Array<{ email: string; name: string | null; company: string | null }> }
  /** P9: the report document is private to the loop's owner (the newsletter draft). */
  privateReport?: boolean
}

/**
 * F4: did this run read outside text, counting what earlier steps of the fire
 * brought in (spec.readOutsideBefore)? One notion: the run's own reads judged
 * by outside-text.ts (run-outside-reads.ts), or-ed with the steps before it.
 */
export async function specReadOutside(
  supabase: SupabaseClient,
  spec: Pick<SkillRunSpec, 'readOutsideBefore' | 'workspaceId' | 'runAsUserId'>,
  reads: readonly ToolRead[] | undefined,
): Promise<boolean> {
  if (spec.readOutsideBefore === true) return true
  return runReadOutsideText(supabase, { workspaceId: spec.workspaceId, userId: spec.runAsUserId, reads })
}

/**
 * Discriminated result of assembleSkillRun:
 *   - 'spec': a runnable spec (the server runs it on eve).
 *   - 'delivered': a terminal outcome already delivered server-side (an empty
 *     state on unmet preconditions, or a hard failure). No run happens. This is
 *     why assembleSkillRun is NOT purely a spec builder — its precondition
 *     early-return has server-side delivery side effects (finding #21).
 */
export type AssembleResult =
  | { kind: 'spec'; spec: SkillRunSpec }
  | { kind: 'delivered'; result: RunSkillExecutionResult }

interface AssembleDeps {
  supabase: SupabaseClient
  workspaceId: string
  runAsUserId: string
  startedAt: number
  /** The fire's ledger row — the empty-state notification deep-links it. */
  work?: WorkHandle
  /** The flow this skill runs for, frozen on the spec's provenance (Sequence step 3). */
  flowId?: string | null
  /**
   * Names this fire's Strong escalation once (skillRunTier): stable across a
   * retried assembly, so a retry never counts against the cap twice.
   */
  escalationKey: string
  /** The run_skill step's id (a lens flow's own run names its ride with it). */
  actionId?: string
  /** F3: the lens flows riding this verdict run (lens-plan.ts), and the call's facts. */
  lenses?: LensRide[]
  lensFacts?: LensCallFacts | null
  /** F3: this lens flow's ride, when it runs on its own (Triage off). */
  lensRide?: LensRide
  /** F4: the fire's pre-generated flow_run id (a staged write's card names its run). */
  flowRunId?: string | null
  /** F4: a test_flow dry run (no flow step: it holds nothing). */
  dryRun?: boolean
  /** F4 review R1: a person's Test (the fire route): its cards are answered even with the loop off. */
  manual?: boolean
}

/**
 * Steps 1b–5 of the run: usage gate, skill load, preconditions, system prompt,
 * tools + mode ceiling, template-rendered user message. Runtime-agnostic —
 * produces a portable spec both engines consume. The ONE side effect is the
 * empty-state delivery on unmet preconditions (returned as kind:'delivered').
 */
async function assembleSkillRun(
  config: RunSkillActionConfig,
  ctx: Parameters<RunSkillExecutor>[1],
  deps: AssembleDeps,
): Promise<AssembleResult> {
  const { supabase, workspaceId, runAsUserId, startedAt } = deps
  const summaryUrl = `skill://${config.skill_id}`

  const failed = (message: string): RunSkillExecutionResult => ({
    status: 'failed',
    request_summary: { method: 'SKILL', url: summaryUrl, header_names: [], body_byte_length: 0 },
    response_status_code: 500,
    response_body_preview: null,
    error_message: message,
    duration_ms: Date.now() - startedAt,
    output_document_id: null,
  })

  // 1b. Usage-limit gate — same RPC as chat's checkUsageLimits, but a failed
  // RESULT instead of a thrown 429. An RPC error doesn't block, matching
  // checkUsageLimits.
  //
  // The RPC's row also carries is_paid_plan, which we reuse WITHOUT a second
  // query to clamp premium models down to the cheap default for unpaid plans
  // (mirrors chat's clampModelToPlan).
  //
  // Opted in to the ChatGPT free tier (migration 409): a person on their own
  // ChatGPT plan is allowed, and their run goes on the plan's model below.
  const { data: limitCheck, error: limitError } = await supabase.rpc('check_ai_usage_limit', {
    p_user_id: runAsUserId,
    p_chatgpt_plan: true,
  })
  if (!limitError && limitCheck && limitCheck.length > 0 && !limitCheck[0].allowed) {
    return {
      kind: 'delivered',
      result: failed(
        `AI usage limit exceeded (${limitCheck[0].reason ?? 'plan limit'}) — skill run skipped`,
      ),
    }
  }
  // Read the plan tier off the SAME row (no extra round-trip). An RPC error /
  // empty row leaves isPaidPlan at its safe default (true → no clamp), matching
  // the gate's fail-open posture above.
  const isPaidPlan = limitCheck && limitCheck.length > 0 ? limitCheck[0].is_paid_plan !== false : true
  // A person on their own ChatGPT plan (the free tier): the run goes on the
  // plan's model (`chatgpt-plan/<model>`, signed into the run token), which
  // the skill-runner runs through the plan proxy and every usage row below
  // logs at no cost.
  const onPlan = !limitError && isChatGptPlanUsage(limitCheck?.[0])

  // 2. Load the skill. Service role bypasses RLS, so scope explicitly:
  // workspace-owned or system, category 'skill' (same visibility rule as
  // findMissingSkillIds).
  const { data: recipe } = await supabase
    .from('recipe')
    .select('id, name, system_prompt, updated_at, agent_config, area')
    .eq('id', config.skill_id)
    .eq('category', 'skill')
    .or(`workspace_id.eq.${workspaceId},is_system.eq.true`)
    .maybeSingle<SkillRecipeRow>()
  if (!recipe) {
    return { kind: 'delivered', result: failed(`Skill ${config.skill_id} not found in workspace`) }
  }

  const agentConfig = recipe.agent_config
  // F4: earlier steps' outputs reach the model fenced: another service, or a
  // run that read one, wrote them (step-data.ts).
  const fencedSteps: Record<string, { output: string }> = {}
  for (const [id, v] of Object.entries(ctx.steps ?? {})) fencedSteps[id] = { output: wrapUntrusted(v.output, 'TOOL') ?? '' }
  const templateCtx = buildTemplateContext(ctx.entity, ctx.trigger, ctx.appBaseUrl, {
    workspaceId,
    capture: ctx.capture ?? null,
    steps: fencedSteps,
  })

  // 2b. Preconditions (GEN-145). A data-hungry skill declares the capabilities
  // it needs. If any is missing, don't run the model to produce a hollow report —
  // deliver an HONEST empty-state and return success-with-a-note. This delivery
  // happens SERVER-SIDE regardless of runtime (it's a terminal outcome; no run).
  const preconditionKeys = parsePreconditions(agentConfig?.preconditions)
  if (preconditionKeys.length > 0) {
    const pre = await checkPreconditions(supabase, preconditionKeys, { runAsUserId, workspaceId })
    if (!pre.met) {
      const emptyState = buildEmptyStateMessage(recipe.name, pre.unmet)
      const { data: preMember } = await supabase
        .from('member')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('user_id', runAsUserId)
        .maybeSingle()

      let preDocId: string | null = null
      // Only a report loop gets an empty-state document; a connector's loop
      // (F3) delivers nothing, and its notice says why.
      if (config.deliver?.document !== false && (config.deliver?.to ?? 'document') === 'document') {
        const dateStr = new Date().toISOString().slice(0, 10)
        const { data: preDoc } = await supabase
          .from('document')
          .insert({
            workspace_id: workspaceId,
            title: `${recipe.name} — ${dateStr}`,
            content: emptyState,
            created_by: preMember?.id || null,
            ...(preMember?.id ? { last_edited_by: preMember.id } : {}),
            status: 'active',
            // A skill report (document.kind 'report', migration 367): out of
            // the default document lists. Not indexed: it only says there was
            // nothing to do.
            frontmatter: { skill_id: config.skill_id, empty_state: true },
          })
          .select('id')
          .single()
        preDocId = preDoc?.id ?? null
      }
      if (config.deliver?.notification !== false && preMember?.id) {
        // Deep link the empty-state document when one was written, else the
        // fire's work item (the skip is a ledger row too).
        const workItemId = deps.work?.id ?? null
        const reason = pre.unmet.map((u) => u.message).join(' ').slice(0, 160)
        // A loop with a teammate names it on the row, and speaks as its bot
        // (bot-notice.ts botNoticeCopy). A skip left nothing for you, so it's
        // quiet: no banner (bots-v3.md "What counts as output"), kept in its
        // bot's Notices already read (bots-v4 Phase 4c: it targets the
        // empty-state document, so opening the item would never read it, and
        // unread it would pile up under the bot).
        // A run with no teammate speaks as its area's face, else the
        // Assistant (work/notify.ts withNoticeBot's fallback): with no
        // notifications page, a plain notice would have nowhere to live.
        const teammateId = await noticeTeammateFor(supabase, workspaceId, deps.work)
        const metadata = teammateId
          ? botNoticeMetadata({
              teammateId,
              teammateName: await noticeTeammateName(supabase, workspaceId, teammateId),
              sentence: skippedNoticeLine({ skillName: recipe.name, reason }),
              workItemId,
              captureId: ctx.capture?.id ?? null,
              quiet: true,
              area: deps.work?.area ?? null,
            })
          : {}
        const copy = botNoticeCopy(metadata, { title: `Flow skipped: ${recipe.name}`, body: reason })
        await createNotification({
          workspaceId,
          recipientId: preMember.id,
          type: 'flow_run_output',
          title: copy.title,
          body: copy.body,
          ...(Object.keys(metadata).length > 0 ? { metadata, isRead: true } : {}),
          ...(preDocId
            ? { targetType: 'document' as const, targetId: preDocId }
            : workItemId
              ? { targetType: 'work_item' as const, targetId: workItemId }
              : {}),
        })
      }

      return {
        kind: 'delivered',
        result: {
          status: 'success',
          request_summary: { method: 'SKILL', url: summaryUrl, header_names: [], body_byte_length: 0 },
          response_status_code: 200,
          response_body_preview: truncateBytes(emptyState, RESPONSE_BODY_PREVIEW_BYTES),
          error_message: null,
          duration_ms: Date.now() - startedAt,
          output_document_id: preDocId,
        },
      }
    }
  }

  // 3. System prompt: base prompt + the chat route's skill layering, with the
  // headless preamble in front of everything. Extracted to buildSkillSystemPrompt
  // so the eve internal rebuild produces a byte-identical prompt (one code path).
  // The skill's area brings its playbook (the same section the rebuild adds).
  // A run on the person's ChatGPT plan has no web (skill-run-rebuild.ts says why).
  const [basePrompt, expertise, words] = await Promise.all([
    buildSystemPrompt(runAsUserId, supabase, undefined, { workspaceId, ...(onPlan ? { webAccess: 'never' as const } : {}) }),
    backgroundExpertiseSection(supabase, {
      workspaceId,
      userId: runAsUserId,
      areas: areasForSkillRun({ area: recipe.area, enabledTools: agentConfig?.enabled_tools }),
    }),
    skillRunWordsSection(supabase, workspaceId),
  ])
  const systemPrompt = buildSkillSystemPrompt(
    recipe.name,
    recipe.system_prompt,
    agentConfig,
    basePrompt,
    expertise,
    words,
  )

  // 4. Tools + mode-derived ceiling.
  const skillCategories = agentConfig?.enabled_tools ?? []
  const skillDisabled = agentConfig?.disabled_tools ?? []
  const isVerdict = agentConfig?.output_contract === 'verdict'

  // The ceiling (mode-derived + the capture-read / verdict force-adds) is computed
  // by computeSkillCeiling so the eve internal rebuild derives the identical set
  // from {mode, hasCapture}. Its only fire-specific input is hasCapture, which the
  // signed token carries.
  const ceiling = computeSkillCeiling(agentConfig, config.mode === 'act' ? 'act' : 'report', !!ctx.capture)

  const activeTools = computeInitialActiveTools(
    skillCategories.length > 0 ? skillCategories : undefined,
    skillDisabled.length > 0 ? skillDisabled : undefined,
  )
    // Headless: no client exists to resolve the clarifying-question picker,
    // and a chat-native tool only runs in the main chat.
    .filter((name) => name !== 'ask_user' && !isChatNativeTool(name) && !isAttendedOnlyTool(name))
    // Report mode's ceiling excludes mutating CORE tools that
    // computeInitialActiveTools would otherwise surface from step one.
    // ALWAYS_ON_CAPABILITY_TOOL_NAMES (web_search) is exempt: web access is a
    // capability every run has, is read-only and provider-executed, and is
    // deliberately absent from every registry-derived ceiling — so a ceiling
    // test would strip it. Mirrors pickPermittedTools' exemption.
    .filter((name) => !ceiling || ceiling.has(name) || ALWAYS_ON_CAPABILITY_TOOL_NAMES.includes(name))

  // 5. Invocation message — the skill IS the playbook; instructions are the
  // flow author's extra steer, template-rendered against the fire.
  const instructions = config.instructions ? renderTemplate(config.instructions, templateCtx) : null
  // A capture_processed fire is ABOUT its capture: name it explicitly and
  // guarantee the read tools are reachable even when the skill's own categories
  // exclude captures (the ceiling already has them via computeSkillCeiling; here
  // we surface them from step one too).
  if (ctx.capture) {
    for (const name of CAPTURE_READ_TOOLS) {
      if (!activeTools.includes(name)) activeTools.push(name)
    }
  }
  // A verdict-class skill's ONLY write is submit_run_verdict — surface it from
  // step one (the ceiling already has it via computeSkillCeiling).
  if (isVerdict) {
    if (!activeTools.includes(VERDICT_TOOL_NAME)) activeTools.push(VERDICT_TOOL_NAME)
  }
  const triggerBlock = ctx.capture
    ? `This run fired because a meeting capture just finished processing: "${ctx.capture.title || 'Untitled'}" (capture id ${ctx.capture.id}). That capture is the subject of this run — read it first with get_capture_content (and get_capture_transcript if you need the raw words). Any mention of "the meeting" or "the call" in the instructions refers to it.`
    : null
  // eve commits the verdict as the session's structured result (verdict-schema.ts
  // outputSchema → eve's eve__reply tool, named final_output before eve 0.76).
  // The full triage policy (VERDICT_POLICY_GUIDANCE) rides on that surface; its
  // headline rule is repeated here so the model reads it before it starts
  // judging. The seeded verdict skills' own prompts and context_rules
  // (migrations 166, 194) say "call submit_run_verdict", a name eve does not
  // expose, so the message maps that name onto the real commit tool. Kept here
  // (not in the system prompt) so the eve rebuild and assembleSkillRun stay
  // byte-identical on the system prompt.
  const verdictBlock = isVerdict
    ? 'Where your instructions say submit_run_verdict: that is the eve__reply tool (this run’s final structured result). Call it EXACTLY ONCE when you have finished reviewing, with a decision for every proposal and any items that need the user. Default to dismiss; accept only real, new work that is explicitly the user’s. You do not apply anything yourself — the system applies your verdict and records what it did.'
    : null
  // GROUNDING (Workstream C): a verdict-class run gets a deterministic, compact
  // snapshot of the workspace (the user's open work, projects, recent meetings,
  // queue shape, near calendar) so its judgment isn't isolated to this one
  // conversation — the F3 fix. Built server-side, no extra model calls. Fail-soft
  // (empty string on any error). Only for verdict runs — prose skills are
  // unchanged.
  // The run's tier (auto model selection): the skill's own, Think by default.
  const route = await skillRunTier(supabase, {
    agentConfig,
    runAsUserId,
    workspaceId,
    isPaidPlan,
    key: deps.escalationKey,
  })

  const contextPack = isVerdict
    ? await buildContextPack({
        supabase,
        workspaceId,
        runAsUserId,
        captureId: ctx.capture?.id ?? null,
      }).catch(() => '')
    : ''

  // W-2 (One Accept Authority, D3) — resolve the workspace trust policy so the
  // frozen trust below inherits it where the flow leaves a field unset. Fail-open
  // (resolveTrustPolicy never throws). Only a verdict run applies a verdict, so
  // this only matters for verdict flows; resolving unconditionally keeps the
  // freeze path uniform (a prose flow's frozen trust is never read).
  const workspaceTrustPolicy = await resolveTrustPolicy(supabase, workspaceId)
  // F3 lens flows. A verdict run carries the lenses riding it; a lens skill
  // with no Triage to ride runs alone with the same section and schema.
  const riding = isVerdict && deps.lenses?.length ? sortRides(deps.lenses) : []
  const lensKey = !isVerdict && isLensKey(agentConfig?.lens) ? agentConfig.lens : null
  const ownRide = lensKey ? (deps.lensRide ?? (await ownLensRide(supabase, { workspaceId, runAsUserId, flowId: deps.flowId ?? null, actionId: deps.actionId ?? '', lens: lensKey }))) : null
  if (lensKey && !ownRide) {
    return { kind: 'delivered', result: failed("This lens loop's owner is not a member of the workspace") }
  }
  // A lens run the dispatcher didn't plan (Run now, a test, any other door)
  // is gated here exactly as the plan gates it (F3 review S1): a call to read,
  // its facts, and the lens's condition on them.
  let ownFacts: LensCallFacts | null = deps.lensFacts ?? null
  if (ownRide && !deps.lensRide) {
    if (!ctx.capture) return { kind: 'delivered', result: failed('A lens only runs after a call: this run has no call to read') }
    ownFacts = await loadCallFacts(supabase, workspaceId, ctx.capture.id)
    if (!ownFacts) return { kind: 'delivered', result: failed('The call this lens would read could not be loaded') }
    const skip = lensSkipReason(ownRide, ownFacts)
    if (skip) {
      return {
        kind: 'delivered',
        result: {
          status: 'success',
          request_summary: { method: 'SKILL', url: `skill://${config.skill_id}`, header_names: [], body_byte_length: 0 },
          response_status_code: 200,
          response_body_preview: skip,
          error_message: null,
          duration_ms: Date.now() - startedAt,
          output_document_id: null,
        },
      }
    }
  }
  const lensBlock = riding.length ? lensPromptBlock(riding) : ownRide ? lensPromptBlock([ownRide]) : ''
  // F3: a structured output connector (never on a verdict skill, whose output
  // is its verdict, nor a lens skill, which delivers its own section). The
  // destination comes from the flow's config.
  const connector = !isVerdict && !lensKey && isStructuredConnector(config.deliver?.to) ? config.deliver.to : undefined
  const connectorTarget = connector
    ? { docKey: config.deliver?.doc_key ?? null, surface: connector === 'post_drafts' ? (config.deliver?.surface ?? 'x') : null }
    : undefined
  // P9: material the server reads for the skill (agent_config.material), in
  // bounded queries and no model call; it rides the message, never the cached
  // system prompt.
  const material = await skillMaterial(supabase, {
    kind: agentConfig?.material,
    connector,
    workspaceId,
    runAsUserId,
    flowId: deps.flowId ?? null,
    surface: connectorTarget?.surface ?? 'x',
    slots: config.deliver?.slots,
    entity: ctx.entity,
  })
  const userMessage = [
    triggerBlock,
    contextPack || null,
    isVerdict
      ? 'Run your skill now and carry the triage through end-to-end.'
      : connector || ownRide
        ? 'Run your skill now and carry the job through end-to-end.'
        : 'Run your skill now and carry the job through end-to-end; write your final output as markdown.',
    instructions,
    verdictBlock,
    connector && connectorTarget ? connectorInstruction(connector, { ...connectorTarget, ...(material?.postWeek ? { weekly: true } : {}) }) : null,
    material?.block || null,
    // Lens sections last, in their stable order: the cached system prompt is untouched.
    lensBlock || null,
    ownRide ? `Your result is the \`${ownRide.lens}\` lens section itself (the structured result), not prose.` : null,
  ]
    .filter(Boolean)
    .join('\n\n')

  // Bare registry names; inherit-all (act with no categories → ceiling is
  // null) is the empty list.
  const ceilingList = ceiling ? [...ceiling] : []

  return {
    kind: 'spec',
    spec: {
      runAsUserId,
      workspaceId,
      skillId: config.skill_id,
      skillName: recipe.name,
      skillUpdatedAt: recipe.updated_at ?? null,
      systemPrompt,
      userMessage,
      ceiling: ceilingList,
      activeTools,
      // The tier's model (skillRunTier: Flash, or STRONG_MODEL when granted;
      // an unpaid plan never gets Strong). Nobody pins a model on a flow any
      // more: an old `config.model` is ignored.
      // On the person's ChatGPT plan, the plan's model, thinking by the same tier.
      model: onPlan ? planModelSlug(backgroundPlanSpec(route.tier).model) : tierModel(route.tier),
      modelRoute: onPlan ? { ...modelRouteMetadata(route), reasoning: backgroundPlanSpec(route.tier).reasoning } : modelRouteMetadata(route),
      mode: config.mode === 'act' ? 'act' : 'report',
      deliver: config.deliver,
      templateTitleDefault: renderTemplate(
        config.deliver?.document_title ?? '{skill} — {date}',
        templateCtx,
      ),
      outputContract: agentConfig?.output_contract === 'verdict' ? 'verdict' : 'prose',
      // W-B — FREEZE trust + provenance at assembly so the verdict applies with
      // the contract it was DISPATCHED with (no re-fetch → no TOCTOU on trust).
      // Same staleness posture as skill_updated_at.
      // W-2 — flow trust overrides the workspace policy where set, else inherits.
      trust: resolveTrust(config.trust, workspaceTrustPolicy),
      provenance: {
        skillName: recipe.name,
        captureTitle: ctx.capture?.title ?? null,
        captureId: ctx.capture?.id ?? null,
        flowId: deps.flowId ?? null,
      },
      ...(connector ? { outputConnector: connector, connectorTarget } : {}),
      ...(riding.length ? { lenses: riding, lensFacts: deps.lensFacts ?? null } : {}),
      ...(ownRide ? { lensRun: { ride: ownRide }, lensFacts: ownFacts } : {}),
      // F4: the owner's connections this step may use, the step itself, and
      // whether earlier steps brought outside text in.
      ...(config.connections?.length ? { connections: [...config.connections] } : {}),
      ...(deps.flowId && deps.actionId && !deps.dryRun ? { flowStep: { flowId: deps.flowId, actionId: deps.actionId, flowRunId: deps.flowRunId ?? null, ...(deps.manual ? { manual: true as const } : {}) } } : {}),
      ...(ctx.readOutsideText ? { readOutsideBefore: true } : {}),
      ...(material?.postWeek ? { postWeek: material.postWeek } : {}),
      ...(material?.askedBy ? { askedBy: material.askedBy } : {}),
      ...(material?.privateReport ? { privateReport: true } : {}),
    },
  }
}

/**
 * The material a skill asks the server for (agent_config.material, P9). Null
 * for a skill that asks for none, or a kind this run can't use. Never throws:
 * a failed read is an empty part of the material.
 */
async function skillMaterial(
  supabase: SupabaseClient,
  args: {
    kind: unknown
    connector: StructuredConnector | undefined
    workspaceId: string
    runAsUserId: string
    flowId: string | null
    surface: PostSurface
    slots: unknown
    entity: Parameters<RunSkillExecutor>[1]['entity']
  },
): Promise<{ block: string; postWeek?: SkillRunSpec['postWeek']; askedBy?: SkillRunSpec['askedBy']; privateReport?: boolean } | null> {
  if (args.kind === 'post_week' && args.connector === 'post_drafts') {
    const { data: member } = await supabase.from('member').select('id').eq('workspace_id', args.workspaceId).eq('user_id', args.runAsUserId).maybeSingle()
    const memberId = (member as { id?: unknown } | null)?.id
    if (typeof memberId !== 'string') return null
    const week = await loadPostWeekMaterial(supabase, { workspaceId: args.workspaceId, userId: args.runAsUserId, memberId, flowId: args.flowId, surface: args.surface, slots: args.slots })
    return {
      block: renderPostWeekBlock(week),
      postWeek: {
        slow: week.slow,
        slots: week.slots,
        blockedPhrases: week.blockedPhrases,
        blockedWords: week.blockedWords,
        momentIds: Object.fromEntries(week.moments.map((m) => [m.key, m.id])),
        cadenceNote: week.cadenceNote,
      },
    }
  }
  // The newsletter (P9, decision 9): the week, as a document the person copies out.
  if (args.kind === 'week_of_work' && !args.connector) {
    const { data: member } = await supabase.from('member').select('id').eq('workspace_id', args.workspaceId).eq('user_id', args.runAsUserId).maybeSingle()
    const memberId = (member as { id?: unknown } | null)?.id
    if (typeof memberId !== 'string') return null
    const week = await loadPostWeekMaterial(supabase, { workspaceId: args.workspaceId, userId: args.runAsUserId, memberId, flowId: null, surface: 'x' })
    return { block: renderNewsletterBlock(week), privateReport: true }
  }
  // M2 (P9): what shipped, and for the notes, who asked for it.
  if ((args.kind === 'asked_by' && args.connector === 'email_drafts') || (args.kind === 'shipped' && !args.connector)) {
    const shipped = shippedEntity(args.entity)
    if (!shipped) return { block: '## What shipped\nThis run fired with no shipped work to read. Return nothing.', ...(args.kind === 'asked_by' ? { askedBy: { askers: [] } } : {}) }
    if (args.kind === 'shipped') return { block: renderShippedBlock(shipped) }
    const asked = await loadAskedBy(supabase, { workspaceId: args.workspaceId, runAsUserId: args.runAsUserId, entity: shipped })
    return { block: renderAskedByBlock(asked), askedBy: { askers: asked.askers.map((a) => ({ email: a.email, name: a.name, company: a.company })) } }
  }
  return null
}

/** The flow's entity as shipped work (M2), or null on a fire with none. */
function shippedEntity(entity: Parameters<RunSkillExecutor>[1]['entity']): ShippedEntity | null {
  if (!entity) return null
  if (entity.kind === 'action') return { kind: 'action', id: entity.id, title: entity.title, identifier: entity.identifier }
  return { kind: entity.kind, id: entity.id, title: entity.name, description: entity.description }
}

/** A lens flow's own ride when the dispatcher didn't plan one (a test-fire): its owner, as a member. */
async function ownLensRide(
  supabase: SupabaseClient,
  args: { workspaceId: string; runAsUserId: string; flowId: string | null; actionId: string; lens: LensRide['lens'] },
): Promise<LensRide | null> {
  const { data } = await supabase.from('member').select('id, display_name').eq('workspace_id', args.workspaceId).eq('user_id', args.runAsUserId).maybeSingle()
  const row = data as { id?: string; display_name?: string | null } | null
  if (!row?.id) return null
  return { flowId: args.flowId ?? '', actionId: args.actionId, lens: args.lens, ownerUserId: args.runAsUserId, ownerMemberId: row.id, ownerName: row.display_name ?? null }
}

// ── Shared delivery (steps 6–7) ─────────────────────────────────────────────

/** The model output + usage an eve run produced. */
export interface SkillRunOutput {
  text: string
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  /** null when unknown. */
  costUsd: number | null
  /** Usage-log metadata extras (toolCalls/steps, runtime, web-search spend). */
  usageMetaExtra?: Record<string, unknown>
  /** Usage-log feature id ('flow_run_skill'). */
  feature: string
  /** Real elapsed compute time (server clock). */
  durationMs: number
  bodyByteLength: number
}

/**
 * Steps 6–7: usage log (before delivery so a delivery failure still bills),
 * then document + notification. Called by runSpecViaEve for a prose run. The
 * usage-metadata params keep the exact logged shape — it must NOT drop the
 * run's costUsd/toolCalls/steps (finding #15).
 */
export async function deliverSkillOutput(
  supabase: SupabaseClient,
  spec: SkillRunSpec,
  output: SkillRunOutput,
  startedAt: number,
  /**
   * Stable per-fire id (the Inngest event id on dispatch). Threaded so the document insert is idempotent: the
   * enclosing Inngest step runs LLM + delivery under retries:1, so a step retry
   * would otherwise insert a SECOND document + notification for the same fire.
   * When present, we look for an already-delivered document tied to this fire id
   * (stamped in the document's frontmatter jsonb) before inserting, and reuse it.
   * Absent (test-fire, older callers) → no dedup, unchanged behaviour.
   */
  fireId?: string | null,
  /** The fire's ledger row, muted when the flow opted out of notifications. */
  work?: WorkHandle,
  /**
   * The run read outside text (run-outside-reads.ts): its report is marked
   * outside-derived for good (document.outside_derived, F3 review R2), so a
   * later run that reads it counts as having read the outside text itself
   * (its canon edits are labelled so; its outward calls are gated).
   */
  readOutside = false,
): Promise<RunSkillExecutionResult> {
  const summaryUrl = `skill://${spec.skillId}`
  const request_summary: RequestSummary = {
    method: 'SKILL',
    url: summaryUrl,
    header_names: [],
    body_byte_length: output.bodyByteLength,
  }

  // 6. Usage accounting — before delivery.
  await logUsage(spec.runAsUserId, {
    provider: usageProviderLabel(spec.model),
    model: spec.model,
    feature: output.feature,
    inputTokens: output.usage.inputTokens ?? 0,
    outputTokens: output.usage.outputTokens ?? 0,
    durationMs: output.durationMs,
    costUsd: output.costUsd ?? undefined,
    metadata: {
      skill_id: spec.skillId,
      mode: spec.mode,
      ...(spec.modelRoute ? { model_route: spec.modelRoute } : {}),
      ...(output.usageMetaExtra ?? {}),
      // Cached input, priced at the cache rates by log_ai_usage (mig 199).
      ...usageCacheMetadata(output.usage),
    },
  })

  if (!output.text.trim()) {
    return {
      status: 'failed',
      request_summary,
      response_status_code: 500,
      response_body_preview: null,
      error_message: 'Skill run produced no output',
      duration_ms: Date.now() - startedAt,
      output_document_id: null,
    }
  }

  // 7. Delivery. Document + notification default ON; created_by = the run-as
  // user's member row (mirrors api/account/documents POST).
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', spec.workspaceId)
    .eq('user_id', spec.runAsUserId)
    .maybeSingle()

  let outputDocumentId: string | null = null
  // 'notification' (F3) is the notice alone: no document.
  if (spec.deliver?.document !== false && spec.deliver?.to !== 'notification') {
    // Idempotency guard: the enclosing Inngest step runs LLM + delivery under
    // retries:1, so a step retry re-runs this whole delivery. Keyed on the
    // stable per-fire id (stamped into frontmatter on the insert below), find an
    // already-delivered document for this fire and short-circuit — no second
    // document, no duplicate notification. NO migration: reuses the existing
    // document.frontmatter jsonb column (same dedup pattern as reference-ingest).
    if (fireId) {
      const { data: prior } = await supabase
        .from('document')
        .select('id')
        .eq('workspace_id', spec.workspaceId)
        .contains('frontmatter', { flow_fire_id: fireId, skill_id: spec.skillId })
        .limit(1)
        .maybeSingle()
      if (prior?.id) {
        if (work && !work.inert && work.id) {
          await placeRunSuggestions(supabase, { trackedJobId: work.id, documentId: prior.id })
        }
        return {
          status: 'success',
          request_summary,
          response_status_code: 200,
          response_body_preview: skillRunPreview(spec, output.text),
          error_message: null,
          duration_ms: Date.now() - startedAt,
          output_document_id: prior.id,
        }
      }
    }

    const dateStr = new Date().toISOString().slice(0, 10)
    const title =
      substituteTitleTokens(spec.templateTitleDefault, spec.skillName, dateStr).trim() ||
      `${spec.skillName} — ${dateStr}`

    const insert: Record<string, unknown> = {
      workspace_id: spec.workspaceId,
      title,
      content: output.text,
      created_by: member?.id || null,
      status: 'active',
      // The skill stamp makes it a report (document.kind 'report', migration
      // 367: out of the default document lists). The fire id lets a step
      // retry's re-delivery find this row and reuse it instead of inserting a
      // duplicate (see the guard above).
      frontmatter: fireId ? { flow_fire_id: fireId, skill_id: spec.skillId } : { skill_id: spec.skillId },
    }
    if (member?.id) insert.last_edited_by = member.id
    if (readOutside) insert.outside_derived = true
    // A newsletter draft is the person's own until they share it (P9 review nit).
    if (spec.privateReport && member?.id) insert.visibility = 'private'

    const { data: doc, error: docError } = await supabase
      .from('document')
      .insert(insert)
      .select('id')
      .single()
    if (docError || !doc) {
      return {
        status: 'failed',
        request_summary,
        response_status_code: 500,
        response_body_preview: skillRunPreview(spec, output.text),
        error_message: `Output document insert failed: ${docError?.message ?? 'unknown error'}`,
        duration_ms: Date.now() - startedAt,
        output_document_id: null,
      }
    }
    outputDocumentId = doc.id
    // Reports are indexed for search like any document (they were skipped
    // before documents phase 1). Best-effort: never fails the delivery.
    await indexReportBestEffort(supabase, doc.id, spec.runAsUserId, output.text, spec.workspaceId)
  }

  // Suggestions the run staged (suggest_changes) land in the document it
  // delivered, each placed where its marker is or under "Suggested changes"
  // (src/lib/suggestions/deliver.ts). Also on the retry path that reuses a
  // prior document: re-homing is idempotent.
  if (outputDocumentId && work && !work.inert && work.id) {
    await placeRunSuggestions(supabase, { trackedJobId: work.id, documentId: outputDocumentId })
  }

  // The "output ready" push is the ledger's: the fire's work item lands in
  // Needs you (`review: check`) with the document as its deliverable and sends
  // one work_needs_you. A flow that opted out of notifications mutes the item.
  if (spec.deliver?.notification === false) await work?.mute()

  return {
    status: 'success',
    request_summary,
    response_status_code: 200,
    response_body_preview: skillRunPreview(spec, output.text),
    error_message: null,
    duration_ms: Date.now() - startedAt,
    output_document_id: outputDocumentId,
  }
}

// ── Verdict delivery (Phase 2, Workstream B) ─────────────────────────────────

interface DeliverVerdictArgs {
  supabase: SupabaseClient
  spec: SkillRunSpec
  /**
   * The action config — trust falls back to resolveTrust(config.trust) when
   * the (older) spec has no frozen trust.
   */
  config?: RunSkillActionConfig
  runAsUserId: string
  workspaceId: string
  /** Stable per-fire id (the Inngest event id) for card retry-dedup. */
  fireId: string | null
  /** The fire's ledger row — the verdict digest deep-links it. */
  work?: WorkHandle
  /** Pre-generated flow_run id → stamped on cards as source_flow_run_id. */
  flowRunId: string | null
  /** Triggering capture title (for the card's provenance footer), when the run
   *  fired from a capture; null on schedule/entity fires. */
  captureTitle: string | null
  /** Automation depth of this run's writes (loop guard). Default 1. */
  originDepth?: number
  /** The verdict the model submitted, or null if it never called the tool. */
  verdict: RunVerdict | null
  /** F3: the `lenses` part of the committed result, raw (lens-deliver.ts validates it). */
  lensOutput?: unknown
  /** F3: what the run's calls read (the stream's record): the lenses' provenance. */
  toolReads?: ToolRead[]
  /** test_flow: lenses deliver nothing. */
  dryRun?: boolean
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  costUsd: number | null
  /** Exa web-search spend (eve action.result costDollars), metadata only; absent/null when none. */
  webSearchCostUsd?: number | null
  toolCalls: number
  steps: number
  durationMs: number
  actionId: string
  startedAt: number
  /**
   * WS-4c: the run aborted on a timeout AFTER the model committed its verdict.
   * The engine still applies the captured decisions, but stamps the ledger
   * summary as partial so the record stays honest about the truncation.
   */
  partial?: boolean
}

/**
 * Decide the grouped notification for a verdict run, or null for SILENCE.
 *
 * Silence-is-success (Liam: notification noise erodes trust): a run that
 * auto-applied/dismissed everything with zero cards and zero revokes sends
 * NOTHING. `deliverNotification` is an opt-OUT only — `false` suppresses even a
 * card-bearing run's notification. An explicit `true` is NOT a "force on empty"
 * signal: every seeded/edited config carries notification:true by default, so
 * treating true as forced would make silence unreachable and spam a daily
 * "Triage: 0 need you" on an empty queue. So we gate purely on whether the user
 * actually has something to see. (Full-review finding: the old `forced =
 * notification === true` made silence unreachable on every real config.)
 *
 * Pure — no I/O — so the silence rule is unit-testable.
 */
export function decideVerdictNotification(
  ledger: Pick<VerdictLedger, 'cards_surfaced' | 'cards_overflow' | 'revoked_count' | 'summary'>,
  skillName: string,
  deliverNotification: boolean | undefined,
): { title: string; body: string } | null {
  if (deliverNotification === false) return null // explicit opt-out
  const needsUser = ledger.cards_surfaced > 0 || ledger.revoked_count > 0
  if (!needsUser) return null // silence = success
  const bits: string[] = []
  if (ledger.cards_surfaced > 0) bits.push(`${ledger.cards_surfaced} to review`)
  if (ledger.cards_overflow > 0) bits.push(`+${ledger.cards_overflow} more in the capture`)
  if (ledger.revoked_count > 0) bits.push(`removed ${ledger.revoked_count} auto-accepted`)
  const body = bits.length ? bits.join(' · ') : ledger.summary.slice(0, 160)
  // Honest title: "N needs you" only with cards; a revoke-only run says what
  // actually happened instead of "0 needs you".
  const n = ledger.cards_surfaced
  const title =
    n > 0
      ? `${skillName}: ${n} need${n === 1 ? 's' : ''} you`
      : `${skillName}: removed ${ledger.revoked_count} auto-accepted`
  return { title, body }
}

/**
 * Deliver a verdict-class run: log usage, apply the verdict server-side (the
 * engine, never the model), attach the ledger to the ActionResult, and surface a
 * SINGLE grouped notification only when something needs the user (silence = the
 * success state). The output document defaults OFF for verdict runs — the ledger
 * + cards are the surface — unless deliver.document is explicitly true.
 */
export async function deliverVerdictRun(args: DeliverVerdictArgs): Promise<RunSkillExecutionResult> {
  const { supabase, spec, config, runAsUserId, workspaceId } = args
  const request_summary: RequestSummary = {
    method: 'SKILL',
    url: `skill://${spec.skillId}`,
    header_names: [],
    body_byte_length: byteLength(spec.userMessage),
  }

  // Usage accounting.
  await logUsage(runAsUserId, {
    provider: usageProviderLabel(spec.model),
    model: spec.model,
    feature: 'flow_run_skill',
    inputTokens: args.usage.inputTokens,
    outputTokens: args.usage.outputTokens,
    durationMs: args.durationMs,
    costUsd: args.costUsd ?? undefined,
    metadata: {
      skill_id: spec.skillId,
      mode: spec.mode,
      output_contract: 'verdict',
      ...(spec.modelRoute ? { model_route: spec.modelRoute } : {}),
      flow_action_id: args.actionId,
      toolCalls: args.toolCalls,
      steps: args.steps,
      ...(args.webSearchCostUsd != null ? { webSearchCostUsd: args.webSearchCostUsd } : {}),
      ...usageCacheMetadata(args.usage),
    },
  })

  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', runAsUserId)
    .maybeSingle()

  // No verdict (model ran out of steps before calling submit_run_verdict) — a
  // faithful no-op. Nothing applied, nothing surfaced. Record it honestly.
  if (!args.verdict || !member?.id) {
    const ledger: VerdictLedger = {
      summary: args.verdict?.summary ?? 'No verdict was submitted.',
      entries: [],
      cards_surfaced: 0,
      cards_overflow: 0,
      revoked_count: 0,
      verdict_missing: !args.verdict,
      // The lenses that rode got nothing: there was no committed read.
      ...(spec.lenses?.length ? { lenses: lensRidesFailed(spec.lenses, 'Triage committed no result for this call, so the lens got nothing') } : {}),
    }
    return {
      status: 'success',
      request_summary,
      response_status_code: 200,
      response_body_preview: truncateBytes(ledger.summary, RESPONSE_BODY_PREVIEW_BYTES),
      error_message: null,
      duration_ms: Date.now() - args.startedAt,
      output_document_id: null,
      verdict: ledger,
    }
  }

  // Apply the verdict — server code, CAS-guarded, fenced by workspace_id. Trust
  // comes from the FROZEN spec (W-B: the run applies the contract it was
  // dispatched with — no re-fetch, no TOCTOU); the server callers that pass
  // a config fall back to resolveTrust(config.trust) for an older spec with no
  // frozen trust. W-2: that fallback inherits the workspace trust policy where
  // the flow left a field unset (a frozen spec already baked inheritance in).
  const trust =
    spec.trust ?? resolveTrust(config?.trust, await resolveTrustPolicy(supabase, workspaceId))
  // Attribution (bots v3 1a): the fire's ledger row and its teammate, stamped on
  // every card and on the digest so they come through the teammate's bot.
  const workItemId = args.work && !args.work.inert ? args.work.id : null
  const teammateId = args.work && !args.work.inert ? args.work.aiTeamMemberId : null
  const ledger = await applyVerdict(args.verdict, {
    supabase,
    workspaceId,
    memberId: member.id,
    userId: runAsUserId,
    mode: spec.mode,
    trust,
    runKey: args.fireId,
    // The flow_run row is written AFTER this returns, but its id is pre-generated
    // at the dispatch site and threaded here so the card can back-link to its run.
    flowRunId: args.flowRunId,
    provenance: { skillName: spec.skillName, captureTitle: args.captureTitle },
    // The verdict's applies are the pipeline's own writes (the one judgment
    // authority), one automated hop deeper than the fire that ran this skill.
    origin: { actor: 'loop', depth: args.originDepth ?? 1 },
    // The auto-attempt gate's grounding / budget key (Sequence step 3), frozen
    // on the spec at assembly.
    captureId: spec.provenance?.captureId ?? null,
    flowId: spec.provenance?.flowId ?? null,
    teammateId,
    workItemId,
  })

  // F3: the lenses that rode this read, each through its own delivery, as its
  // flow's owner. The triage above is already applied: a lens never changes it.
  if (spec.lenses?.length) {
    ledger.lenses = await deliverLensSections(args.lensOutput, spec.lenses, {
      supabase,
      workspaceId,
      captureId: spec.provenance?.captureId ?? null,
      captureTitle: args.captureTitle,
      runKey: args.fireId,
      readOutside: await specReadOutside(supabase, spec, args.toolReads),
      facts: spec.lensFacts ?? null,
      skillName: spec.skillName,
      ...(args.dryRun ? { dryRun: true } : {}),
    })
  }

  // Sequence step 2: the verdict's applies and cards, as touches on the fire's
  // work item (fail-soft; a fire with no ledger row records nothing).
  await recordVerdictTouches(supabase, {
    workspaceId,
    workItemId,
    entries: ledger.entries,
  })

  // WS-4c: a salvaged run (timed out after the model committed its verdict)
  // stamps the ledger summary so the record is honest about the truncation. Only
  // decisions the model actually submitted were applied; `ledger.submitted` stays
  // the verbatim model output.
  if (args.partial) {
    ledger.summary = `${ledger.summary} [partial: run timed out]`
  }

  // Grouped notification ONLY when the user has something to do (see
  // decideVerdictNotification — silence-is-success is the whole point).
  const note = decideVerdictNotification(ledger, spec.skillName, spec.deliver?.notification)
  if (note) {
    // Deep link the fire's work item (the cards are its deliverable); a fire
    // with no ledger row falls back to the flow_run (legacy resolver path).
    // A run with a teammate names it on the row and speaks as its bot: the
    // title is the teammate's name, the body the sentence (bot-notice.ts).
    // A run with no teammate speaks as its area's face, else the Assistant.
    const noticeTeammate = teammateId ?? (await noticeTeammateFor(supabase, workspaceId, args.work))
    const metadata = noticeTeammate
      ? botNoticeMetadata({
          teammateId: noticeTeammate,
          teammateName: await noticeTeammateName(supabase, workspaceId, noticeTeammate),
          sentence: verdictNoticeLine({
            cardCount: ledger.cards_surfaced,
            overflowCount: ledger.cards_overflow,
            revokedCount: ledger.revoked_count,
            captureTitle: args.captureTitle,
          }),
          workItemId,
          captureId: spec.provenance?.captureId ?? null,
          cardCount: ledger.cards_surfaced,
          area: args.work && !args.work.inert ? args.work.area : null,
        })
      : {}
    const copy = botNoticeCopy(metadata, note)
    await createNotification({
      workspaceId,
      recipientId: member.id,
      type: 'flow_run_output',
      title: copy.title,
      body: copy.body,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(workItemId
        ? { targetType: 'work_item' as const, targetId: workItemId }
        : args.flowRunId
          ? { targetType: 'flow_run' as const, targetId: args.flowRunId }
          : {}),
    })
  }

  // Optional ledger document — OFF by default for verdict runs (opt-in).
  let outputDocumentId: string | null = null
  if (spec.deliver?.document === true) {
    const dateStr = new Date().toISOString().slice(0, 10)
    const title =
      substituteTitleTokens(spec.templateTitleDefault, spec.skillName, dateStr).trim() ||
      `${spec.skillName} — ${dateStr}`
    const { data: doc } = await supabase
      .from('document')
      .insert({
        workspace_id: workspaceId,
        title,
        content: renderVerdictLedgerMarkdown(spec.skillName, ledger),
        created_by: member.id,
        last_edited_by: member.id,
        status: 'active',
        // A skill report (document.kind 'report', migration 367).
        frontmatter: { skill_id: spec.skillId, verdict_ledger: true },
      })
      .select('id, content')
      .single()
    outputDocumentId = doc?.id ?? null
    if (doc?.id) await indexReportBestEffort(supabase, doc.id, spec.runAsUserId, (doc as { content?: string | null }).content ?? null, workspaceId)
  }

  return {
    status: 'success',
    request_summary,
    response_status_code: 200,
    response_body_preview: truncateBytes(ledger.summary, RESPONSE_BODY_PREVIEW_BYTES),
    error_message: null,
    duration_ms: Date.now() - args.startedAt,
    output_document_id: outputDocumentId,
    verdict: ledger,
  }
}

/** Render the ledger as a human-readable audit doc (opt-in delivery only). */
function renderVerdictLedgerMarkdown(skillName: string, ledger: VerdictLedger): string {
  const lines = [`# ${skillName}`, '', ledger.summary, '']
  if (ledger.entries.length) {
    lines.push('| Proposal | Decision | Outcome | Reason |', '|---|---|---|---|')
    for (const e of ledger.entries) {
      lines.push(
        `| ${e.proposal_id.slice(0, 8)} | ${e.decision} | ${e.outcome}${
          e.detail ? ` (${e.detail})` : ''
        } | ${(e.reason || '').replace(/\|/g, '\\|')} |`,
      )
    }
    lines.push('')
  }
  lines.push(
    `_${ledger.cards_surfaced} card(s) surfaced` +
      (ledger.cards_overflow ? `, ${ledger.cards_overflow} left in the capture` : '') +
      (ledger.revoked_count ? `, ${ledger.revoked_count} revoked` : '') +
      '._',
  )
  return lines.join('\n')
}

// ── Server spec runner (eve task session) ───────────────────────────────────

interface RunSpecViaEveArgs {
  supabase: SupabaseClient
  spec: SkillRunSpec
  runAsUserId: string
  workspaceId: string
  /** Stable per-fire id (the Inngest event id). */
  fireId: string | null
  /** Pre-generated flow_run id → stamped on cards + settled by the caller. */
  flowRunId: string | null
  /** Triggering capture title for the verdict card footer; null on schedule/entity fires. */
  captureTitle: string | null
  /** The flow action id (for usage metadata + verdict card provenance). */
  actionId: string
  /**
   * Automation depth of this run's writes (the dispatching fire's depth + 1;
   * loop guard, flow-functions.ts). Carried in the run token for the tool route
   * and stamped on the verdict's own applies. Default 1: one automated hop.
   */
  originDepth?: number
  /** Whether this fire has a triggering capture — carried in the signed run token
   *  so the server-side ceiling rebuild adds the capture-read tools. */
  hasCapture: boolean
  /** The wall for this run (serverTimeoutMsForSpec — the caller computes it so its
   *  own timeout message matches). */
  timeoutMs: number
  /** Action config for trust fallback on an older spec with no frozen trust. */
  config?: RunSkillActionConfig
  startedAt: number
  /** The fire's ledger row, fed one live step per tool call (names only). */
  work?: WorkHandle
  /** F1 test_flow: a dry run (the token's dryRun claim: the tool route runs no write). */
  dryRun?: boolean
}

/**
 * Run an assembled SkillRunSpec on the SERVER — a durable eve task session on
 * the `skill-runner` agent (runViaEve) — and deliver its output. The ONE
 * execution path: the executor calls it for every fire.
 *
 * The ceiling is the SECURITY boundary and it is structural on this path: the
 * signed run token carries only {skill, mode, hasCapture, contract}, the eve
 * resolver advertises only the rebuilt ceiling's tools, and the internal
 * skill-run tool route RE-DERIVES the ceiling from the verified token and
 * rejects anything outside it.
 *
 * WS-4c salvage lives here too: a verdict run whose session failed / aborted /
 * timed out AFTER the model committed its verdict is delivered through
 * deliverVerdictRun (stamped partial on a timeout) instead of being thrown away.
 * Any other failure propagates to the caller's catch.
 *
 * Bots v3 Phase 4: a run whose ledger row names its teammate (shouldParkSkillRun)
 * runs PARKED (runViaEve `park`: its parked session is kept). Delivery is exactly as
 * before and comes first, once; only then is the parked session's handle kept
 * (skill-run-session.ts), so the loop's bot can continue the chat that did the
 * work. Every other outcome cancels the session inside runViaEve.
 */
export async function runSpecViaEve(args: RunSpecViaEveArgs): Promise<RunSkillExecutionResult> {
  const { supabase, spec, runAsUserId, workspaceId, actionId, hasCapture, timeoutMs, startedAt, work } = args

  // The run token (tool tenancy, minted from the spec) and delivery/billing
  // (these args) must name the same workspace and run-as user. Both callers
  // pass matching values today; this makes a divergence fail instead of
  // splitting tool tenancy from billing tenancy.
  if (spec.workspaceId !== workspaceId || spec.runAsUserId !== runAsUserId) {
    throw new Error('run spec tenancy mismatch')
  }

  // Bots v3 Phase 4: a run its bot fronts parks its session for the follow-up chat.
  const park = shouldParkSkillRun(work)

  let eve: EveRunResult
  try {
    eve = await runViaEve({
      spec,
      hasCapture,
      timeoutMs,
      park,
      ...(args.dryRun ? { dryRun: true } : {}),
      originDepth: args.originDepth ?? 1,
      // The fire's ledger row, so the tool route can record the run's touches.
      ...(work && !work.inert && work.id ? { workItemId: work.id } : {}),
      // Live step text for the Activity panel (ACTIVITY-AND-REVIEW-DESIGN §3.3):
      // each step's tool calls as a phrase. Tool NAMES only — the recorder never
      // sees arguments. Fire-and-forget: a lost beat is a UI gap, not a failed run.
      onToolCalls: (names) => {
        const phrase = phraseForToolNames(names)
        if (phrase) void work?.step(phrase)
      },
    })
  } catch (err) {
    // A run stopped at its wall still spent its completed steps: bill them,
    // then let the caller report the timeout.
    if (err instanceof EveRunTimeoutError) await logTimedOutUsage(spec, actionId, Date.now() - startedAt, err)
    throw err
  }
  const durationMs = Date.now() - startedAt

  // A parked session whose handle isn't kept can never be continued: stop it
  // rather than leave it parked in eve storage for good.
  const dropParked = (sessionId: string) => cancelParkedSkillSession(spec, hasCapture, sessionId)

  let delivered: RunSkillExecutionResult
  try {
    delivered = await deliverEveRun(args, eve, durationMs)
  } catch (err) {
    if (eve.parked) await dropParked(eve.parked.sessionId)
    throw err
  }
  // F4 data passing: the run's output for the steps after it, and whether it
  // (or a step before it) read outside text: from the run's own stream.
  delivered = {
    ...delivered,
    step_output: delivered.step_output ?? (eve.text?.trim() ? eve.text : (delivered.response_body_preview ?? '')),
    ...((await specReadOutside(supabase, spec, eve.toolReads)) ? { read_outside_text: true } : {}),
  }
  // Delivered (once, above): now keep the parked session's handle. Never
  // throws; a lost handle leaves the item on the bot's own thread plus about,
  // and its session is stopped. A handle this one replaces (a second skill
  // step on the same row) is stopped too.
  if (eve.parked) {
    const kept =
      park && work && shouldParkSkillRun(work)
        ? await parkSkillRunSession(supabase, {
            work,
            workspaceId,
            parked: eve.parked,
            spec,
            hasCapture,
            onReplaced: dropParked,
          })
        : false
    if (!kept) await dropParked(eve.parked.sessionId)
  }
  return delivered
}

/** Deliver what an eve run produced: the verdict walk, a connector's output, or the prose document. Exactly once per run. */
function deliverEveRun(args: RunSpecViaEveArgs, eve: EveRunResult, durationMs: number): Promise<RunSkillExecutionResult> {
  const { supabase, spec, runAsUserId, workspaceId, fireId, flowRunId, captureTitle, actionId, config, startedAt, work } = args
  if (spec.lensRun) {
    return deliverLensRun({
      supabase,
      spec,
      fireId,
      captureTitle,
      actionId,
      startedAt,
      durationMs,
      eve,
      ...(args.dryRun ? { dryRun: true } : {}),
    })
  }
  if (spec.outputConnector) {
    return deliverConnectorRun({
      supabase,
      spec,
      fireId,
      captureTitle,
      actionId,
      startedAt,
      durationMs,
      work,
      eve,
      ...(args.dryRun ? { dryRun: true } : {}),
    })
  }
  if (spec.outputContract === 'verdict') {
    // The model's structured verdict (outputSchema) → the server-side apply walk.
    // A salvaged verdict (WS-4c) takes the same walk, flagged partial on a timeout.
    return deliverVerdictRun({
      supabase,
      spec,
      config,
      runAsUserId,
      workspaceId,
      fireId,
      flowRunId,
      captureTitle,
      originDepth: args.originDepth ?? 1,
      work,
      verdict: eve.verdict,
      lensOutput: eve.lensOutput,
      toolReads: eve.toolReads,
      ...(args.dryRun ? { dryRun: true } : {}),
      usage: eve.usage,
      costUsd: eve.costUsd,
      webSearchCostUsd: eve.webSearchCostUsd,
      toolCalls: eve.toolCalls,
      steps: eve.steps,
      durationMs,
      actionId,
      startedAt,
      ...(eve.salvaged ? { partial: eve.salvaged.partial } : {}),
    })
  }

  return deliverProse(args, eve, durationMs)
}

/** A prose run's report: delivered as a document, marked outside-derived when the run read outside text (R2). */
async function deliverProse(args: RunSpecViaEveArgs, eve: EveRunResult, durationMs: number): Promise<RunSkillExecutionResult> {
  const { supabase, spec, fireId, actionId, startedAt, work } = args
  const readOutside = await specReadOutside(supabase, spec, eve.toolReads)
  return deliverSkillOutput(
    supabase,
    spec,
    {
      text: eve.text,
      usage: eve.usage,
      costUsd: eve.costUsd,
      usageMetaExtra: {
        flow_action_id: actionId,
        toolCalls: eve.toolCalls,
        steps: eve.steps,
        runtime: 'eve',
        ...(eve.webSearchCostUsd != null ? { webSearchCostUsd: eve.webSearchCostUsd } : {}),
        ...(eve.stepCapped ? { stepCapped: true } : {}),
      },
      feature: 'flow_run_skill',
      durationMs,
      bodyByteLength: byteLength(spec.userMessage),
    },
    startedAt,
    fireId,
    work,
    readOutside,
  )
}

/**
 * Deliver a lens flow's own run (F3, Triage off): bill it, then hand its
 * committed section to lens-deliver.ts exactly as a ride on Triage would be.
 */
export async function deliverLensRun(args: {
  supabase: SupabaseClient
  spec: SkillRunSpec
  fireId: string | null
  captureTitle: string | null
  actionId: string
  startedAt: number
  durationMs: number
  eve: Pick<EveRunResult, 'structured' | 'toolReads' | 'usage' | 'costUsd' | 'webSearchCostUsd' | 'toolCalls' | 'steps' | 'stepCapped'>
  dryRun?: boolean
}): Promise<RunSkillExecutionResult> {
  const { spec, eve } = args
  const ride = spec.lensRun!.ride
  const request_summary: RequestSummary = { method: 'SKILL', url: `skill://${spec.skillId}`, header_names: [], body_byte_length: byteLength(spec.userMessage) }
  await logUsage(spec.runAsUserId, {
    provider: usageProviderLabel(spec.model),
    model: spec.model,
    feature: 'flow_run_skill',
    inputTokens: eve.usage.inputTokens ?? 0,
    outputTokens: eve.usage.outputTokens ?? 0,
    durationMs: args.durationMs,
    costUsd: eve.costUsd ?? undefined,
    metadata: {
      skill_id: spec.skillId,
      mode: spec.mode,
      lens: ride.lens,
      ...(spec.modelRoute ? { model_route: spec.modelRoute } : {}),
      flow_action_id: args.actionId,
      toolCalls: eve.toolCalls,
      steps: eve.steps,
      runtime: 'eve',
      ...(eve.webSearchCostUsd != null ? { webSearchCostUsd: eve.webSearchCostUsd } : {}),
      ...(eve.stepCapped ? { stepCapped: true } : {}),
      ...usageCacheMetadata(eve.usage),
    },
  })
  const [outcome] = await deliverLensSections({ [ride.lens]: eve.structured }, [ride], {
    supabase: args.supabase,
    workspaceId: spec.workspaceId,
    captureId: spec.provenance?.captureId ?? null,
    captureTitle: args.captureTitle,
    runKey: args.fireId,
    readOutside: await specReadOutside(args.supabase, spec, eve.toolReads),
    facts: spec.lensFacts ?? null,
    skillName: spec.skillName,
    ...(args.dryRun ? { dryRun: true } : {}),
  })
  // F4: a lens step's output is what it kept from this call (lens-runs.ts), the same as a ride's.
  const findings = outcome?.status === 'success' && !args.dryRun
    ? await lensFindingsText(args.supabase, { flowId: spec.provenance?.flowId ?? ride.flowId, captureId: spec.provenance?.captureId ?? null }).catch(() => '')
    : ''
  return {
    // Kept nothing: an empty output, so the steps that use it are skipped (runner.ts).
    ...(outcome?.status === 'success' && !args.dryRun ? { step_output: findings } : {}),
    status: outcome?.status === 'success' ? 'success' : 'failed',
    request_summary,
    response_status_code: outcome?.status === 'success' ? 200 : 500,
    response_body_preview: outcome?.delivered ? truncateBytes(outcome.delivered.summary, RESPONSE_BODY_PREVIEW_BYTES) : null,
    error_message: outcome?.error_message ?? (outcome ? null : 'The lens delivered nothing'),
    duration_ms: Date.now() - args.startedAt,
    output_document_id: null,
    delivered: outcome?.delivered ?? null,
  }
}

/**
 * Deliver a structured connector's run (F3: output-connectors.ts): bill it,
 * validate what it committed (junk refused item by item), and hand the rest
 * to deliver-connector.ts, which acts as the flow's owner. Whether the run
 * read outside text comes from the tools it called (run-outside-reads.ts),
 * never from the model. The ledger row gets no review: the cards, the edits'
 * digest line and the drafts in Mail are the surface.
 */
export async function deliverConnectorRun(args: {
  supabase: SupabaseClient
  spec: SkillRunSpec
  fireId: string | null
  captureTitle: string | null
  actionId: string
  startedAt: number
  durationMs: number
  work?: WorkHandle
  eve: Pick<EveRunResult, 'structured' | 'toolReads' | 'usage' | 'costUsd' | 'webSearchCostUsd' | 'toolCalls' | 'steps' | 'stepCapped'>
  dryRun?: boolean
}): Promise<RunSkillExecutionResult> {
  const { supabase, spec, eve } = args
  const connector = spec.outputConnector!
  const request_summary: RequestSummary = {
    method: 'SKILL',
    url: `skill://${spec.skillId}`,
    header_names: [],
    body_byte_length: byteLength(spec.userMessage),
  }
  await logUsage(spec.runAsUserId, {
    provider: usageProviderLabel(spec.model),
    model: spec.model,
    feature: 'flow_run_skill',
    inputTokens: eve.usage.inputTokens ?? 0,
    outputTokens: eve.usage.outputTokens ?? 0,
    durationMs: args.durationMs,
    costUsd: eve.costUsd ?? undefined,
    metadata: {
      skill_id: spec.skillId,
      mode: spec.mode,
      output_connector: connector,
      ...(spec.modelRoute ? { model_route: spec.modelRoute } : {}),
      flow_action_id: args.actionId,
      toolCalls: eve.toolCalls,
      steps: eve.steps,
      runtime: 'eve',
      ...(eve.webSearchCostUsd != null ? { webSearchCostUsd: eve.webSearchCostUsd } : {}),
      ...(eve.stepCapped ? { stepCapped: true } : {}),
      ...usageCacheMetadata(eve.usage),
    },
  })
  const failed = (message: string): RunSkillExecutionResult => ({
    status: 'failed',
    request_summary,
    response_status_code: 500,
    response_body_preview: null,
    error_message: message,
    duration_ms: Date.now() - args.startedAt,
    output_document_id: null,
  })

  // Posts drafted from a call are screened for its outside names too (review S3).
  const captureId = spec.provenance?.captureId ?? null
  const fromCall = connector === 'post_drafts' && captureId ? ((await loadCallFacts(supabase, spec.workspaceId, captureId).catch(() => null))?.outsideNames ?? []) : []
  // The weekly pass (P9): its recent calls' names and the brief's never-post list too, refused outright.
  const week = connector === 'post_drafts' ? spec.postWeek : undefined
  const blocked = week ? [...new Set([...fromCall, ...week.blockedPhrases])] : fromCall
  const parsed = parseConnectorOutput(connector, eve.structured, {
    surface: spec.connectorTarget?.surface ?? null,
    blockedPhrases: blocked,
    ...(week ? { postPass: { slowWeek: week.slow, maxPosts: week.slots, refuseNamed: true, blockedWords: week.blockedWords } } : {}),
  })
  if (!parsed.ok) return failed(parsed.error)
  // M2: "you asked, we shipped" writes only to the people who asked.
  if (connector === 'email_drafts' && spec.askedBy) {
    const kept = onlyToAskers(parsed.items as Array<{ to: string[]; cc: string[]; subject: string; body: string }>, spec.askedBy.askers)
    parsed.refused.push(...kept.refused)
    parsed.items.splice(0, parsed.items.length, ...(kept.items as typeof parsed.items))
  }

  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', spec.workspaceId)
    .eq('user_id', spec.runAsUserId)
    .maybeSingle()
  if (!member?.id) return failed('The loop\'s owner is no longer a member of this workspace')

  const work = args.work && !args.work.inert ? args.work : null
  const delivered = await deliverConnectorItems(connector, parsed.items as never, {
    supabase,
    workspaceId: spec.workspaceId,
    runAsUserId: spec.runAsUserId,
    memberId: member.id as string,
    runKey: args.fireId,
    flowId: spec.provenance?.flowId ?? null,
    captureId: spec.provenance?.captureId ?? null,
    captureTitle: args.captureTitle,
    skillName: spec.skillName,
    teammateId: work?.aiTeamMemberId ?? null,
    workItemId: work?.id ?? null,
    readOutside: await specReadOutside(supabase, spec, eve.toolReads),
    runStartedAt: new Date(args.startedAt).toISOString(),
    docKey: spec.connectorTarget?.docKey ?? null,
    ...(spec.askedBy ? { perFlowNotes: true } : {}),
    surface: spec.connectorTarget?.surface ?? null,
    ...(week ? { postCap: week.slots, momentIds: week.momentIds, cadenceNote: week.cadenceNote } : {}),
    ...(args.dryRun ? { dryRun: true } : {}),
  }, parsed.refused)

  if (spec.deliver?.notification === false) await args.work?.mute()
  return {
    status: 'success',
    request_summary,
    response_status_code: 200,
    response_body_preview: truncateBytes(delivered.summary, RESPONSE_BODY_PREVIEW_BYTES),
    error_message: null,
    duration_ms: Date.now() - args.startedAt,
    output_document_id: null,
    delivered,
  }
}

/** The usage row for a run stopped at its wall: what its completed steps spent. */
async function logTimedOutUsage(
  spec: SkillRunSpec,
  actionId: string,
  durationMs: number,
  err: EveRunTimeoutError,
): Promise<void> {
  const { usage, costUsd, webSearchCostUsd, toolCalls, steps } = err.spent
  await logUsage(spec.runAsUserId, {
    provider: usageProviderLabel(spec.model),
    model: spec.model,
    feature: 'flow_run_skill',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    durationMs,
    costUsd: costUsd ?? undefined,
    metadata: {
      skill_id: spec.skillId,
      mode: spec.mode,
      output_contract: spec.outputContract,
      ...(spec.modelRoute ? { model_route: spec.modelRoute } : {}),
      flow_action_id: actionId,
      toolCalls,
      steps,
      runtime: 'eve',
      timed_out: true,
      wall_ms: err.timeoutMs,
      ...(webSearchCostUsd != null ? { webSearchCostUsd } : {}),
      ...usageCacheMetadata(usage),
    },
  })
}

// ── The executor ────────────────────────────────────────────────────────────

/**
 * Build the real run_skill executor for one flow fire. Bind the flow's
 * workspace + run-as identity here; the runner then calls the executor once
 * per eligible run_skill action.
 *
 * Run-as identity: all reads/writes the skill performs are attributed to that
 * user. Dispatch fires pass flow.created_by — re-stamped by the PATCH route to
 * whoever last changed the flow, so a member can never ride another member's
 * identity. Test-fires pass the calling user.
 *
 * `fireId` is the Inngest event id (stable across step retries, unique across
 * fires) on the dispatch path, or a per-invocation id on the test-fire path.
 */
/**
 * Who a loop's notice speaks as: the run's teammate, else its area's face,
 * else the Assistant (work/notify.ts withNoticeBot's fallback), so a notice
 * always lives with a bot. Null for a sequence send (no bot,
 * KINDS_WITHOUT_BOT) or when no face can be read. Never throws.
 */
async function noticeTeammateFor(supabase: SupabaseClient, workspaceId: string, work: WorkHandle | null | undefined): Promise<string | null> {
  const live = work && !work.inert ? work : null
  if (live?.aiTeamMemberId) return live.aiTeamMemberId
  if (live && KINDS_WITHOUT_BOT.has(live.kind)) return null
  try {
    return await areaTeammateId(supabase, workspaceId, live?.area ?? null)
  } catch {
    return null
  }
}

export function createRunSkillExecutor(deps: {
  workspaceId: string
  /**
   * Epoch ms by which a server run's wall must fire — the enclosing function's
   * platform budget minus a tail reserve (flowRunDeadlineMs). Each run's wall is
   * min(its normal wall, time left), and a run that cannot fit its minimum wall
   * is failed before it starts: a function killed mid-run would leave the
   * durable eve session calling tools while the retry starts another. Absent →
   * the normal wall (test-fires on a request with its own budget).
   */
  deadlineMs?: number
  /** User the skill runs AS — null falls back to the workspace owner. */
  runAsUserId: string | null
  /** Originating flow (frozen on the spec's provenance). Absent on test-fire is fine. */
  flowId?: string | null
  /** Stable-per-fire id (Inngest event id): delivery and card retry-dedup key on it. */
  fireId?: string | null
  /**
   * The flow_run row's id, PRE-GENERATED by the dispatch site and used both here
   * (stamped onto attention cards as source_flow_run_id → the card's audit
   * back-link) and by the caller when it inserts the flow_run row. The flow_run
   * is written AFTER the executor returns, so without pre-generating the id the
   * card could never reference its run. Absent → cards get a null back-link
   * (still functional, just no provenance link). (Full-review finding: D2/D4
   * provenance was missing.)
   */
  flowRunId?: string | null
  /**
   * The fire's ledger row (ACTIVITY-AND-REVIEW-DESIGN §3): the executor feeds it
   * live step text from tool calls — names only, never inputs — and nothing
   * else; the dispatcher settles it from the action results.
   */
  work?: WorkHandle
  /**
   * Automation depth of the writes this run will make: the dispatching fire's
   * depth + 1 (flow-functions.ts loop guard). Absent → 1 (a capture / schedule
   * fire, or a test-fire, is depth 0 by definition).
   */
  originDepth?: number
  /**
   * F1 test_flow: a DRY run. The run token carries it and the skill-run tool
   * route answers every non-read call with an echo, writing nothing (not even
   * report mode's create_document / add_comment / suggest_changes).
   */
  dryRun?: boolean
  /** F4 review R1: a person's Test (the fire route): its cards are answered even with the loop off. */
  manual?: boolean
  /** F3: the lens flows riding this (Triage) fire, from the dispatcher's plan (lens-plan.ts). */
  lenses?: LensRide[]
  /** F3: this lens flow's ride when it runs on its own (Triage off). */
  lensRide?: LensRide
  /** F3: the call's facts, for the lenses' delivery. */
  lensFacts?: LensCallFacts | null
}): RunSkillExecutor {
  return async (action, ctx) => {
    const startedAt = Date.now()
    const config = action.config as RunSkillActionConfig
    const summaryUrl = `skill://${config.skill_id}`
    // WS-4c: the effective wall for THIS run — bumped for verdict-class runs once
    // the spec is assembled. Declared here so the outer catch's timeout message
    // reports the real limit.
    let effectiveTimeoutMs = EXECUTION_TIMEOUT_MS

    const failed = (message: string): RunSkillExecutionResult => ({
      status: 'failed',
      request_summary: { method: 'SKILL', url: summaryUrl, header_names: [], body_byte_length: 0 },
      response_status_code: 500,
      response_body_preview: null,
      error_message: message,
      duration_ms: Date.now() - startedAt,
      output_document_id: null,
    })

    try {
      const supabase = getServiceClient()
      const { workspaceId } = deps

      // 1. Resolve the run-as identity.
      let runAsUserId = deps.runAsUserId
      if (!runAsUserId) {
        const { data: owner } = await supabase
          .from('member')
          .select('user_id')
          .eq('workspace_id', workspaceId)
          .eq('role', 'owner')
          .limit(1)
          .maybeSingle()
        runAsUserId = owner?.user_id ?? null
      }
      if (!runAsUserId) {
        return failed('No run-as identity: flow has no creator and workspace has no owner')
      }

      // Assemble the run.
      const assembled = await assembleSkillRun(config, ctx, {
        supabase,
        workspaceId,
        runAsUserId,
        startedAt,
        work: deps.work,
        flowId: deps.flowId ?? null,
        flowRunId: deps.flowRunId ?? null,
        ...(deps.dryRun ? { dryRun: true } : {}),
        ...(deps.manual ? { manual: true } : {}),
        // The fire's own ids (the flow run, the Inngest event, the ledger row),
        // else the skill and the UTC hour: stable across a retried assembly.
        escalationKey: `skill:${deps.flowRunId ?? deps.fireId ?? deps.work?.id ?? `${config.skill_id}:${new Date(startedAt).toISOString().slice(0, 13)}`}:${action.id}`,
        actionId: action.id,
        ...(deps.lenses?.length ? { lenses: deps.lenses } : {}),
        ...(deps.lensRide ? { lensRide: deps.lensRide } : {}),
        ...(deps.lensFacts !== undefined ? { lensFacts: deps.lensFacts } : {}),
      })
      // A terminal outcome was already delivered (empty state / hard failure) —
      // no run happens.
      if (assembled.kind === 'delivered') return assembled.result
      const { spec } = assembled

      // ── Durable eve task session ─────────────────────────────────────────
      // The ONE execution path — runSpecViaEve: report/act/verdict ceilings
      // (STRUCTURAL — the eve resolver returns only ceiling tools, and the
      // internal tool route re-checks the ceiling server-side), WS-4c verdict
      // salvage, delivery. WS-4c: verdict runs get the longer wall — set
      // effectiveTimeoutMs first so the outer catch's timeout message reports
      // the real limit.
      effectiveTimeoutMs = serverTimeoutMsForSpec(spec)
      if (deps.deadlineMs !== undefined) {
        const wall = wallWithinDeadline(spec, deps.deadlineMs)
        if (wall === null) {
          return failed(
            `Not enough time left in this flow run to start the skill (${Math.max(0, deps.deadlineMs - Date.now())}ms left)`,
          )
        }
        effectiveTimeoutMs = wall
      }
      return await runSpecViaEve({
        supabase,
        spec,
        runAsUserId,
        workspaceId,
        fireId: deps.fireId ?? null,
        flowRunId: deps.flowRunId ?? null,
        captureTitle: ctx.capture?.title ?? null,
        actionId: action.id,
        hasCapture: !!ctx.capture,
        timeoutMs: effectiveTimeoutMs,
        config,
        startedAt,
        work: deps.work,
        originDepth: deps.originDepth ?? 1,
        ...(deps.dryRun ? { dryRun: true } : {}),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A failed session reports eve's reason as it is: a provider error that
      // mentions a timeout is not this run's wall.
      const timedOut = !(err instanceof EveSessionFailedError) && /abort|timeout/i.test(message)
      return failed(timedOut ? `Skill run timed out after ${effectiveTimeoutMs}ms` : message)
    }
  }
}

/** Index a delivered report for search; an embedding failure never fails the run. */
async function indexReportBestEffort(
  supabase: SupabaseClient,
  documentId: string,
  userId: string,
  content: string | null,
  workspaceId: string,
) {
  try {
    const { indexDocument } = await import('@/lib/ai/embeddings')
    await indexDocument(supabase, documentId, userId, null, content, workspaceId)
  } catch (err) {
    console.error('[run-skill] report re-index failed (non-fatal):', err)
  }
}
