/**
 * Deterministic spec rebuild for the eve `work-agent` internal spec route
 * (Loops v3 work proposals — docs/loop-engine/WORK-PROPOSALS-DESIGN.md).
 *
 * Given a verified run token's claims (agentRunId + tenancy), reconstruct EXACTLY
 * what the eve work-agent resolvers need — the run-as base system prompt, the
 * model, the ceiling-filtered workspace tool surface, and the per-user gateway
 * telemetry — from live DB state keyed by the verified token. There is no
 * cross-instance store, so this works across separate Vercel function instances
 * (the same rationale as the coding/skill spec routes).
 *
 * WHY A SEPARATE SPEC SOURCE (not the coding rebuild): a work run is `kind =
 * 'workspace'` — it has no repo, no persona recipe, no GitHub token. Its tool
 * surface is the registry tools whose `sideEffect` classification (TOOL_CATEGORIES
 * in @/lib/ai/tool-registry) is in WORK_RUN_ADMITTED_SIDE_EFFECTS — read and
 * internal-write. Every external-write, automation-write and delete tool is out,
 * including any tool added later until someone classifies it as admitted (the
 * field is required). See the block above WORK_RUN_EXCLUDED_TOOLS in ./types.ts.
 * computeWorkRunCeiling is the SINGLE source of that ceiling: this rebuild
 * advertises it and the internal work-run tool route enforces it, from the same
 * function, so the two can never drift.
 *
 * The run-agnostic base prompt (buildSystemPrompt for the run-as user) IS the
 * whole system prompt here — the standing "execute one approved piece of work"
 * contract lives in the mount's instructions.md, and the per-run task rides as
 * the session's first MESSAGE (the JSON brief), exactly like onboarding-research.
 */
import { canonRegistrySection } from '@/lib/documents/canon-registry'
import { getServiceClient } from '@/lib/admin'
import { buildSystemPrompt } from '@/lib/ai/system-prompt'
import { withToolGuide } from '@/lib/ai/tool-guides'
import { ALL_TOOL_NAMES, ATTENDED_ONLY_TOOL_NAMES, getToolDefinition, getToolNamesForCategories, getToolSideEffect } from '@/lib/ai/tool-registry'
import { resolveWorkspaceEdition, computeEditionToolCeiling, featureGatedRecipeExclusions } from '@/lib/editions'
import { workspaceWordsSection } from '@/lib/customers/business-words'
import { isFeatureGatedRecipe } from '@/lib/library/feature-gate'
import { resolveTeammateChatBounds, resolveTeammateChatCeiling } from '@/lib/chat/chat-ceiling'
import { registryToolInputSchemas, type ToolInputJsonSchema } from '@/lib/ai/tool-schemas'
import { gatewayTelemetryValues, type GatewayTelemetryValues } from '@/lib/ai/gateway-telemetry'
import { chatModelPolicy, gatewayModelSlug, helperModelEntry, isHelperModelKey, type ChatModelPolicy } from '@/lib/ai/models'
import { isModelTier, tierModel, tierPolicy, type ModelTier } from '@/lib/ai/model-route'
import { WORK_RUN_EXCLUDED_TOOLS, DRAFTING_EXCLUDED_TOOLS } from './types'
import { chatBoundForWorkRun } from './chat-bound'
import { narrowToTeammate, type TeammateToolBounds } from './teammate-bounds'
import { composeWorkRunSystemPrompt, loadAgentPersona } from '@/lib/ai/agent-run-context'
import type { AgentRunTokenClaims } from './agent-run-token'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveFollowThrough } from '@/lib/chat/follow-through'
import { workRunExpertiseSection } from '@/lib/packs/background'
import { aboutThePersonSection } from '@/lib/memory/about-the-person'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'
import { backgroundPlanSpec, type ChatGptPlanSpec } from '@/lib/chatgpt/plan-models'

/**
 * The advertised/permitted work-run tool set: every registry tool whose
 * `sideEffect` is in WORK_RUN_ADMITTED_SIDE_EFFECTS (read, internal-write).
 * Zero-argument, synchronous and DB-free — it runs inside the internal tool
 * route on every call and inside the eve spec rebuild. It subtracts
 * WORK_RUN_EXCLUDED_TOOLS, which is DERIVED from the same classification (any
 * entry outside the admitted classes, so an unknown class or a duplicate name
 * with one non-admitted entry fails closed). A Set (prototype-pollution-safe
 * membership) — the tool route imports THIS same computation so the advertised
 * surface and the enforced ceiling are one thing. `search_tools` is not a
 * registry tool; it is added by the tool route's own harness like the skill
 * path, never advertised as a proxy.
 */
export function computeWorkRunCeiling(): Set<string> {
  const excluded = new Set(WORK_RUN_EXCLUDED_TOOLS)
  const ceiling = new Set<string>()
  for (const name of ALL_TOOL_NAMES) {
    if (!excluded.has(name)) ceiling.add(name)
  }
  return ceiling
}

/**
 * The DRAFTING ceiling — read + artifact writes only (plan A.3): the profile an
 * ATTEMPTED run gets, picked by `agent_run.origin` (ceilingForWorkRun). Same
 * construction as computeWorkRunCeiling, from DRAFTING_EXCLUDED_TOOLS, and
 * always a subset of it.
 */
export function computeDraftingCeiling(): Set<string> {
  const excluded = new Set(DRAFTING_EXCLUDED_TOOLS)
  const ceiling = new Set<string>()
  for (const name of ALL_TOOL_NAMES) {
    if (!excluded.has(name)) ceiling.add(name)
  }
  return ceiling
}

/**
 * A teammate's own bounds on UNATTENDED work (ai_team_member, migration 280)
 * and the narrowing that applies them now live in ./teammate-bounds.ts (pure,
 * shared with the bots v2 teammate chat's ceiling); re-exported here so the
 * work-run callers and tests keep importing them from this module.
 */
export { narrowToTeammate, type TeammateToolBounds } from './teammate-bounds'

/** A run a person started: `user`, or a row from before the column. */
function personStarted(origin: string | null | undefined): boolean {
  return !origin || origin === 'user'
}

/**
 * The classes a work run may use at all, from its row's `origin`: reads and
 * internal writes for a run a person started (computeWorkRunCeiling), the
 * drafting profile (reads and artifact writes) for every other origin, an
 * attempted run among them (computeDraftingCeiling). ceilingForWorkRun starts
 * from it, and a skill picked in the run's chat is capped to it
 * (skillChatTurnTools): a skill never gives a run more than the run itself
 * may do.
 */
export function workRunClassProfile(origin: string | null | undefined): Set<string> {
  return personStarted(origin) ? computeWorkRunCeiling() : computeDraftingCeiling()
}

/**
 * The ceiling a work run gets, from its row's `origin` (plan A.3, Sequence step
 * 3). A run a person started (`user`, or a row that predates the column) keeps
 * today's work-run ceiling. EVERY other origin gets the drafting ceiling:
 * `attempt` by decision, and anything else by default, so an origin nobody has
 * decided on (a future `delegation` child before step 13 says otherwise) fails
 * CLOSED to the narrower profile.
 *
 * An unattended run done by a teammate is narrowed further to that teammate's
 * bounds (B PR 4, teamToolBounds): only the classes it may call, and only the
 * tools on its allowlist when it has one. A person-started run is not: the
 * columns bound what a teammate does on its own, and a person's Start keeps the
 * person's ceiling. The spec rebuild advertises this set and the tool route
 * enforces it, from the same call.
 *
 * Work a person handed over from the main chat is narrowed once more, to what
 * that chat could call (`chatCeiling`, the row's chat_ceiling; see
 * ./chat-bound.ts): a persona chat without email tools cannot get the
 * Correspondent to read or draft email for it, and neither can any teammate
 * that run hands work to (the child inherits the bound, chatCeilingForChild).
 */
export function ceilingForWorkRun(
  origin: string | null | undefined,
  teammate?: TeammateToolBounds | null,
  chatCeiling?: unknown,
): Set<string> {
  const profile = workRunClassProfile(origin)
  const base = !personStarted(origin) && teammate ? narrowToTeammate(profile, teammate) : profile
  const bound = chatBoundForWorkRun(origin, chatCeiling)
  if (!bound) return base
  const out = new Set<string>()
  for (const name of base) if (bound.has(name)) out.add(name)
  return out
}

/**
 * The ceiling of ONE turn on a work run's session, from its verified token:
 * the run's own (ceilingForWorkRun), and on a follow-up CHAT turn (the token's
 * `chat` claim, bots v3 Phase 5) also its bot's follow-through grants
 * (src/lib/chat/follow-through.ts: e.g. revise_email_draft for the drafting
 * pass's face). A chat turn is attended, so it may hold an attended-only tool
 * its bot is granted; the run itself (and a resume of it) never does. The spec
 * rebuild advertises this and the work-run tool route enforces it, from the
 * same call. A superset of the run's own, so the session's tools a chat turn
 * re-resolves are never fewer than the run had.
 *
 * The grants are capped as a teammate chat's are (composeTeammateChatCeiling):
 * by the workspace's edition, and, on work a chat handed over, by that chat's
 * bound (followThroughWithinChatBound), so a persona chat without email tools
 * can't reach revise_email_draft through the Correspondent it delegated to.
 *
 * A chat turn whose token carries a picked skill (bots v4, `skillId`: the
 * run chat's composer) may also get tools the skill selects, capped to the
 * RUN'S OWN CLASSES (workRunClassProfile: drafting for an attempted run, reads
 * and internal writes for a run a person started), to the run's bot's
 * attended chat ceiling and, on chat-handed work, to the chat's bound
 * (skillChatTurnTools). A skill never gives a run more than the run itself
 * may do: never an external-write, automation-write or delete tool, and on an
 * attempted run no board or CRM write either.
 */
export async function ceilingForWorkRunTurn(
  supabase: SupabaseClient,
  run: WorkRunRow,
  claims: Pick<AgentRunTokenClaims, 'workspaceId' | 'chat'> & Partial<Pick<AgentRunTokenClaims, 'userId' | 'skillId'>>,
): Promise<Set<string>> {
  const ceiling = ceilingForWorkRun(run.origin, run.teammate, run.chat_ceiling)
  if (claims.chat !== true) return ceiling
  const bound = chatBoundForWorkRun(run.origin, run.chat_ceiling)
  const grants = await resolveFollowThrough(supabase, { workspaceId: claims.workspaceId, teammateId: run.ai_team_member_id })
  if (grants.size > 0) {
    const edition = computeEditionToolCeiling((await resolveWorkspaceEdition(supabase, claims.workspaceId)).edition)
    for (const name of grants) {
      if (!ATTENDED_ONLY_TOOL_NAMES.has(name)) continue
      if (edition && !edition.has(name)) continue
      if (bound && !followThroughWithinChatBound(name, bound)) continue
      ceiling.add(name)
    }
  }
  if (claims.skillId && claims.userId && run.ai_team_member_id) {
    const skillTools = await skillChatTurnTools(supabase, {
      workspaceId: claims.workspaceId,
      userId: claims.userId,
      teammateId: run.ai_team_member_id,
      skillId: claims.skillId,
      origin: run.origin ?? null,
    })
    for (const name of skillTools) {
      if (bound && !bound.has(name)) continue
      ceiling.add(name)
    }
  }
  return ceiling
}

const REGISTRY_TOOL_NAMES: ReadonlySet<string> = new Set(ALL_TOOL_NAMES)

/**
 * The tools a skill picked in a work run's chat adds to that turn (bots v4).
 * Each one must be ALL of:
 *   - one the skill selects: a tool of its chosen categories, minus its
 *     disabled tools. Nothing else: no core tools (computeToolCeiling seeds
 *     those, and ignores disabled_tools for them, so it is not used here),
 *     and nothing for a skill that selects no categories (in chat a skill
 *     steers; it doesn't pick tools);
 *   - in the RUN'S OWN CLASSES (workRunClassProfile, from the run's
 *     `origin`): drafting (reads and artifact writes) for an attempted run,
 *     reads and internal writes for a run a person started. A skill never
 *     gives a run more than the run itself may do: a run's tool calls have no
 *     approval step, so never an external-write, automation-write or delete
 *     tool, even for a bot whose own chat may call one, and on an attempted
 *     run (whose prompt says its tools are limited to reading and drafting)
 *     no board or CRM write;
 *   - in the run's bot's ATTENDED chat ceiling (resolveTeammateChatCeiling:
 *     the edition ∩ the bot's persona, narrowed by its bounds, plus its
 *     follow-through grants, for the person chatting: the private-team rule
 *     holds).
 * Registry tools only, never search_tools or ask_user. It fails closed: no
 * tools for a skill the person can't use here (another workspace's,
 * feature-gated), a bot that's gone or out of their reach, or a failed read.
 * ceilingForWorkRunTurn narrows the result again to a delegating chat's bound.
 * In practice a skill on a work run steers: what it may add, the run's own
 * ceiling (its class profile, narrowed by the same bot's bounds the chat
 * ceiling applies) mostly holds already. The cap makes sure it never could
 * be more.
 */
export async function skillChatTurnTools(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    teammateId: string
    skillId: string
    /** The run's `origin`: its class profile caps what the skill adds (workRunClassProfile). */
    origin: string | null
  },
): Promise<Set<string>> {
  const none = new Set<string>()
  try {
    const { data } = await supabase
      .from('recipe')
      .select('id, agent_config, workspace_id, is_system')
      .eq('id', args.skillId)
      .eq('category', 'skill')
      .maybeSingle()
    const skill = data as { id: string; agent_config: unknown; workspace_id: string | null; is_system: boolean | null } | null
    if (!skill || (skill.is_system !== true && skill.workspace_id !== args.workspaceId)) return none
    const cfg = skill.agent_config as { enabled_tools?: unknown; disabled_tools?: unknown } | null
    const categories = Array.isArray(cfg?.enabled_tools) ? cfg.enabled_tools.filter((c): c is string => typeof c === 'string') : []
    if (categories.length === 0) return none
    const disabled = new Set(Array.isArray(cfg?.disabled_tools) ? cfg.disabled_tools.filter((t): t is string => typeof t === 'string') : [])
    if (isFeatureGatedRecipe(skill.id, featureGatedRecipeExclusions(await resolveWorkspaceEdition(supabase, args.workspaceId)))) return none

    const bounds = await resolveTeammateChatBounds(supabase, args.workspaceId, args.teammateId, args.userId)
    if (!bounds) return none
    const botCeiling = await resolveTeammateChatCeiling(supabase, { workspaceId: args.workspaceId, teammateId: args.teammateId, bounds })
    const runClasses = workRunClassProfile(args.origin)

    const out = new Set<string>()
    for (const name of getToolNamesForCategories(categories)) {
      if (disabled.has(name)) continue
      if (name === 'search_tools' || name === 'ask_user') continue
      if (!REGISTRY_TOOL_NAMES.has(name)) continue
      if (!runClasses.has(name)) continue
      if (botCeiling.has(name)) out.add(name)
    }
    return out
  } catch {
    return none
  }
}

/**
 * The drafting tool whose presence in a chat bound shows the delegating chat
 * could do what a follow-through grant revises. The bound (snapshotChatCeiling)
 * records drafting tools only, never an attended-only one, so a grant is read
 * through this: revise_email_draft rewrites what create_email_draft made. A
 * grant with no counterpart here (settle_card, undo_extraction_pass) is
 * withheld on chat-bounded work: fail closed.
 */
const FOLLOW_THROUGH_BOUND_PROXY: Readonly<Record<string, string>> = {
  revise_email_draft: 'create_email_draft',
}

/** Whether follow-through grant `name` stays within a delegating chat's bound. Pure. */
export function followThroughWithinChatBound(name: string, bound: ReadonlySet<string>): boolean {
  const proxy = FOLLOW_THROUGH_BOUND_PROXY[name]
  return !!proxy && bound.has(proxy)
}

/**
 * What the main chat records on work it delegates (agent_run.chat_ceiling):
 * the drafting tools its own ceiling admits (null = no limit), sorted. Only
 * drafting tools matter, since a chat root and its handoffs run on the drafting
 * ceiling; a drafting tool added later is outside an older snapshot (narrower,
 * never wider).
 */
export function snapshotChatCeiling(chatCeiling: ReadonlySet<string> | null): string[] {
  return [...computeDraftingCeiling()].filter((name) => !chatCeiling || chatCeiling.has(name)).sort()
}

/**
 * The only writes a helper the SERVER started may make (agent_run.server_helper:
 * a meeting prep, or a helper a home turn started while the person was away;
 * Liam, 2026-10-15: "read and draft only"). The drafting ceiling also admits
 * in-place artifact writes (update_document publishes, edit_capture_content,
 * confirm_claim…), which a spoofed sender could steer an unwatched run into.
 * These three only add something for the person to review.
 */
export const SERVER_HELPER_WRITE_TOOLS: readonly string[] = Object.freeze(['create_email_draft', 'create_document', 'propose_document_edit'])

/**
 * The chat bound a server-started helper's run is recorded with
 * (agent_run.chat_ceiling): the drafting ceiling's READS plus
 * SERVER_HELPER_WRITE_TOOLS, sorted. ceilingForWorkRun intersects the run's
 * profile with it on every dispatch, and a teammate handoff inherits it
 * (chatCeilingForChild), so nothing under the run gets more.
 */
export function serverHelperChatCeiling(): string[] {
  const writes = new Set(SERVER_HELPER_WRITE_TOOLS)
  return [...computeDraftingCeiling()].filter((name) => writes.has(name) || getToolSideEffect(name) === 'read').sort()
}

/**
 * The loop-guard depth a work run's status writes carry (flows/types.ts
 * StatusChangeOrigin; the dispatcher skips every flow at depth >= 2 by default).
 * A run a person started is one automated hop from the click: 1, as before. An
 * ATTEMPTED run is two: the capture fire is 0, the triage verdict that chose
 * the attempt ran at 1 (the gate attempts only from a first-hop verdict,
 * auto-attempt.ts), and the attempt is one hop past it. Any other origin takes
 * the deeper base too (deeper is stricter). The row's `origin_depth` — the
 * delegation chain depth, 0 for every root — adds on top, so a delegated child
 * sits one hop below its parent.
 *
 * Under the drafting ceiling an attempted run holds no tool that emits a status
 * change, so today this number is a second fence, not the first.
 */
export function statusChangeDepthForWorkRun(row: {
  origin?: string | null
  origin_depth?: number | null
}): number {
  const base = !row.origin || row.origin === 'user' ? 1 : 2
  const chain = typeof row.origin_depth === 'number' && Number.isInteger(row.origin_depth) && row.origin_depth > 0
    ? row.origin_depth
    : 0
  return base + chain
}

/**
 * The run facts the spec and the tool route both read: kind, origin, depth,
 * the chat bound, and the teammate with its tool bounds (embedded; null when
 * the run has no teammate, or the teammate is gone).
 */
export const WORK_RUN_ROW_SELECT =
  'id, kind, status, origin, origin_depth, chat_ceiling, ai_team_member_id, server_helper, teammate:ai_team_member_id(allowed_side_effects, tool_allowlist)'

export interface WorkRunRow {
  id: string
  kind: string | null
  status?: string | null
  origin?: string | null
  origin_depth?: number | null
  chat_ceiling?: string[] | null
  ai_team_member_id?: string | null
  /** A server-started helper's kind (migrations 337, 443): 'meeting_prep', 'home_turn' or 'check_in', else null. */
  server_helper?: string | null
  teammate?: TeammateToolBounds | null
}

/** The eve-facing work-run spec — mirrors the skill-runner spec's eve view. */
export interface RebuiltWorkRunSpec {
  systemPrompt: string
  model: string
  /**
   * One {name, description, inputSchema?} per ceiling tool the resolver
   * advertises as a proxy. `inputSchema` is the tool's REAL input JSON Schema so
   * the model produces valid input first try; absent → the proxy falls back to a
   * permissive pass-through and the tool route validates against the real Zod
   * schema either way.
   */
  ceilingTools: Array<{ name: string; description: string; inputSchema?: ToolInputJsonSchema }>
  /**
   * Per-user Gateway attribution (Phase A). Present ONLY when the flag is on; the
   * agent-side resolver shape-guards it before it rides a model selection.
   */
  gatewayTelemetry?: GatewayTelemetryValues
  /**
   * How the tier's model is called (tierPolicy): Think is Flash at DeepSeek's
   * default effort on private hosts, Fast the same with thinking off, Strong
   * STRONG_MODEL with its own window.
   */
  modelPolicy?: ChatModelPolicy
  /** The run's tier (agent_run.model_tier, else Think), for the usage row's model_route. */
  modelTier?: ModelTier
  /**
   * Present when the run's person runs on their own ChatGPT plan (the free
   * tier): the work-agent then runs every step on the plan model through the
   * plan proxy, never the Gateway, and `model` is OpenAI's catalog slug for
   * it (the session's guard selection). The steps log as `chatgpt-plan/<model>`
   * (work-run-usage.ts), which bills nothing.
   */
  chatgptPlan?: ChatGptPlanSpec
}

/**
 * How the run started, as the last section of its system prompt (plan Part 5
 * row 9). The mount's standing contract (agents/work-agent/instructions.md) is
 * the same for every run and points here. Read from the row's `origin`, the
 * same fact the ceiling reads, with the same split (ceilingForWorkRun): `user`,
 * or a row with no origin (every work run before the column was a person's
 * Start), reads as a person's Start; every other origin reads as an unrequested
 * first pass, so an origin nobody has decided on is told the cautious thing.
 */
export function runStartSection(origin: string | null | undefined): string {
  if (!origin || origin === 'user') {
    return [
      '## How this run started',
      'A person reviewed this work and pressed Start. Do it end to end.',
    ].join('\n')
  }
  if (origin === 'chat') {
    return [
      '## How this run started',
      'A person asked their main assistant for this, and it handed the job to you as a background helper. Your result is reported back in their conversation with the assistant and waits for their review; nobody is watching you work.',
      '- Produce what the brief asks for and finish with `finish_work`, listing every deliverable. Your tools are limited to reading and drafting within your own bounds.',
      '- Keep the brief self-contained. Ask a question only if you cannot proceed; the person can answer it from the report.',
      '- A step of your plan becomes an action only when it needs a person, is a commitment for later, spans days or another owner, or the person asked for a task. Stage it as a suggestion for them to confirm (`suggest_changes`), never one per plan step.',
      '- Do not send, publish, or claim that a result has been delivered in the chat.',
    ].join('\n')
  }
  if (origin === 'delegation') {
    return [
      '## How this run started',
      'A teammate handed you this piece of their work (the task says who, and what they need back). They are waiting on your result, and a person will review it with theirs.',
      '- Produce what the brief asks for (usually a document) and finish with `finish_work`, listing it as a deliverable. Your tools are limited to reading and drafting.',
      '- Do not pause to ask questions: the teammate cannot answer them. Make a sensible assumption and say so in your summary.',
      '- Keep to the brief; the teammate does the rest of the work with your result.',
    ].join('\n')
  }
  return [
    '## How this run started',
    'Nobody has asked for this run yet. The workspace heard this work asked for (the brief\'s `source` says where) and started you on it unrequested, as a first pass. A person will review what you produce, and may use it, change it or throw it away.',
    '- Produce the draft the task calls for (a document or an email draft) and stop there. Your tools are limited to reading and drafting.',
    '- Do not pause to ask questions: nobody is waiting on this run. Make a sensible assumption and say so in your summary.',
    '- Keep it proportionate: a solid first pass, not an exhaustive one.',
    '- Open your summary by saying this was an unrequested first pass, and what the person should check before using it.',
  ].join('\n')
}

/**
 * Rebuild the eve-facing work-run spec from verified token claims. Returns null
 * when the run row can't be found in the claimed workspace or is not a workspace-
 * kind run (the internal route then 404s and the watcher settles the run failed).
 */
export async function rebuildWorkRunSpec(
  claims: AgentRunTokenClaims,
): Promise<RebuiltWorkRunSpec | null> {
  const supabase = getServiceClient()

  // Load the run, workspace-scoped by the token's tenancy. `kind` gates this
  // path — a coding run must never rebuild here (wrong tool surface, no repo).
  // The teammate doing the work (B PR 4) rides along: its persona goes into
  // the prompt, and its bounds narrow an unattended run's ceiling.
  // flow_id rides here only: the loop's skills give the run its area know-how.
  // helper_areas (migration 332): a background helper's thread areas.
  // helper_model (migration 439): the roster model a background helper runs
  // on. Read beside model_tier; before that migration is applied the column
  // is missing (42703), so the row is read again without it (the tier's model).
  type SpecRunRow = WorkRunRow & { flow_id?: string | null; helper_areas?: string[] | null; model_tier?: string | null; helper_model?: string | null }
  const readRun = (columns: string) =>
    supabase.from('agent_run').select(columns).eq('id', claims.agentRunId).eq('workspace_id', claims.workspaceId).maybeSingle<SpecRunRow>()
  const first = await readRun(`${WORK_RUN_ROW_SELECT}, flow_id, helper_areas, model_tier, helper_model`)
  const run = first.error?.code === '42703' || first.error?.code === 'PGRST204' ? (await readRun(`${WORK_RUN_ROW_SELECT}, flow_id, helper_areas, model_tier`)).data : first.data
  if (!run) return null
  if (run.kind !== 'workspace') return null

  // System prompt — the run-as user's base workspace prompt, then the
  // teammate's persona and skills (the same sections a coding run carries;
  // composeWorkRunSystemPrompt), then how the run started (runStartSection:
  // a person's Start, or an unrequested first pass). The standing work contract lives in the
  // mount's instructions.md; the task rides as the message. A teammate whose
  // persona cannot be read (its agent recipe gone) runs on the base prompt.
  // webAccess: 'always' — the work-agent's web_search/web_fetch are EVE's own
  // provider tools (agents/work-agent/tools/), routed through the Gateway on
  // eve's credentials, so this app's USE_GATEWAY switch cannot take them away.
  // The run's area know-how (a helper's thread areas first, then its loop's
  // skills' areas, or its teammate's tools; area notes ride along) sits after
  // the persona, then, for a chat-started helper only, what the person told
  // their assistant about themselves (profile facts ranked and capped by
  // selectProfileFacts, fenced: always-on-agent §4), before how the run started.
  // Whether the run's person runs on their own ChatGPT plan (the free tier),
  // read from live state on every rebuild, so every way a run starts (a
  // person's Start, a chat helper, a delegation, an attempt) and every later
  // turn (a resume, a follow-up chat) is routed the same way.
  // The workspace's words (src/lib/editions/words.ts) follow the persona: what
  // a run writes for the person (a draft, a report, a text) says a service
  // business's jobs and customers, as their chat does. Empty for an edition
  // that says nothing.
  const [basePrompt, persona, expertise, aboutPerson, canon, onPlan, words] = await Promise.all([
    buildSystemPrompt(claims.userId, supabase, undefined, { workspaceId: claims.workspaceId, webAccess: 'always' }),
    run.ai_team_member_id ? loadAgentPersona(supabase, run.ai_team_member_id, claims.workspaceId) : Promise.resolve(null),
    workRunExpertiseSection(supabase, {
      workspaceId: claims.workspaceId,
      userId: claims.userId,
      flowId: run.flow_id ?? null,
      toolAllowlist: run.teammate?.tool_allowlist ?? null,
      helperAreas: Array.isArray(run.helper_areas) ? run.helper_areas : null,
    }),
    // Only a helper the person started from their own chat (origin 'chat'):
    // never a loop's, a flow's or an automation's run, whose drafts other
    // members can see (review fix 6).
    run.origin === 'chat' ? aboutThePersonSection(supabase, claims.userId) : Promise.resolve(''),
    // The canon registry (canon documents D1): the run reads them by key
    // (read_canon); a helper never inherits a document from its parent.
    canonRegistrySection(supabase, { workspaceId: claims.workspaceId, userId: claims.userId }),
    chatgptPlanFor(claims.userId),
    resolveWorkspaceEdition(supabase, claims.workspaceId).then((resolved) => workspaceWordsSection(supabase, claims.workspaceId, resolved.edition)),
  ])
  const systemPrompt = [composeWorkRunSystemPrompt(basePrompt, persona), words, expertise, canon.trim(), aboutPerson, runStartSection(run.origin)]
    .filter((section) => section.length > 0)
    .join('\n\n')

  // Model — the run's roster model (agent_run.helper_model, migration 439:
  // the model a background helper started on, chosen by the main agent or the
  // rules, src/lib/chat/start-helper.ts), else its tier's (agent_run.model_tier,
  // migration 345), else Think: Flash at DeepSeek's own effort, as every work
  // run ran before auto model selection (multi-step tool work stops early with
  // thinking off, and nobody is waiting). Strong runs on STRONG_MODEL. As a
  // Gateway slug.
  // A check-in's helper (agent_run.server_helper 'check_in', migration 443)
  // runs light whatever its row says or lacks (docs/plans/now-file.md: the
  // tier is held in code): a light roster model, else Flash.
  const checkInHelper = run.server_helper === 'check_in'
  const storedModel = isHelperModelKey(run.helper_model) ? helperModelEntry(run.helper_model) : null
  const tier: ModelTier = checkInHelper ? 'fast' : isModelTier(run.model_tier) ? run.model_tier : 'think'
  const helperModel = checkInHelper ? (storedModel?.tier === 'fast' ? storedModel : helperModelEntry('flash')) : storedModel
  const model = gatewayModelSlug(helperModel ? helperModel.model : tierModel(tier))

  // Ceiling tools — the run's profile (an attempted run drafts; plan A.3),
  // narrowed to its teammate and to the delegating chat's bound, with real
  // input schemas. The tool route enforces the same set.
  // A follow-up chat turn adds its bot's follow-through grants (ceilingForWorkRunTurn).
  const ceiling = await ceilingForWorkRunTurn(supabase, run, claims)
  const toolSchemas = registryToolInputSchemas()
  const ceilingTools = [...ceiling].map((name) => {
    const def = getToolDefinition(name)
    const inputSchema = toolSchemas.get(name)
    return {
      name,
      // A registry tool's usage notes ride its description (src/lib/ai/tool-guides.ts).
      description: def ? withToolGuide(name, def.description) : `Workspace tool: ${name}`,
      ...(inputSchema ? { inputSchema } : {}),
    }
  })

  // Per-user Gateway attribution (Phase A). Feature 'work_run' tags eve-path work
  // spend per user/workspace; `?? undefined` keeps the field absent when off.
  const gatewayTelemetry =
    gatewayTelemetryValues(claims.userId, 'work_run', {
      workspaceId: claims.workspaceId,
      runtime: 'eve',
      extraTags: [`run:${claims.agentRunId}`],
    }) ?? undefined

  // On the person's own ChatGPT plan: the plan model (Luna, thinking by the
  // run's tier), with no Gateway attribution or host routing (no Gateway call
  // is made). `model` is OpenAI's slug for it, the session's guard selection.
  if (onPlan) {
    const chatgptPlan = backgroundPlanSpec(tier)
    return { systemPrompt, model: `openai/${chatgptPlan.model}`, ceilingTools, modelTier: tier, chatgptPlan }
  }

  const modelPolicy = helperModel ? chatModelPolicy(helperModel.model, helperModel.level) : tierPolicy(tier)

  return { systemPrompt, model, ceilingTools, gatewayTelemetry, modelPolicy, modelTier: tier }
}
