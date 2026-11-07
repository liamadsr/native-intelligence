/**
 * Deterministic spec rebuild for the eve `run_skill` internal spec route.
 *
 * Given a verified run token's claims, reconstruct EXACTLY what the eve resolvers
 * need — the system prompt, the tool ceiling, and one {name, description} entry
 * per ceiling tool — from live DB state, using the SAME prompt-layering
 * (buildSkillSystemPrompt) and ceiling (computeSkillCeiling) helpers
 * assembleSkillRun uses. Because both paths call the same helpers over the same
 * skill row, the rebuild is byte-identical to dispatch-time assembly for the
 * system prompt and set-identical for the ceiling (asserted in the parity test).
 *
 * This runs in the Next runtime (the internal route), where the Next-coupled
 * buildSystemPrompt and the pure tool-registry are available — the eve Nitro
 * runtime never imports them.
 *
 * The userMessage is NOT rebuilt here: it is fire-ephemeral (capture title,
 * rendered instructions, verdict grounding snapshot) and rides as the eve task
 * MESSAGE instead.
 */
import { connectionToolSpecs, runConnectionTools } from './skill-run-connections'
import { canonRegistrySection } from '@/lib/documents/canon-registry'
import { getServiceClient } from '@/lib/admin'
import { buildSystemPrompt } from '@/lib/ai/system-prompt'
import { withToolGuide } from '@/lib/ai/tool-guides'
import { isWebSearchAvailable } from '@/lib/ai/tools/web-search'
import { NON_CHAT_TOOL_NAMES, getToolDefinition } from '@/lib/ai/tool-registry'
import { registryToolInputSchemas, type ToolInputJsonSchema } from '@/lib/ai/tool-schemas'
import { gatewayTelemetryValues, type GatewayTelemetryValues } from '@/lib/ai/gateway-telemetry'
import { ALLOWED_MODELS, STRONG_MODEL, chatModelPolicy, gatewayModelSlug, type ChatModelId, type ChatModelPolicy } from '@/lib/ai/models'
import { tierLevel, type ModelTier } from '@/lib/ai/model-route'
import { buildSkillSystemPrompt, computeSkillCeiling, skillRunWordsSection } from './run-skill'
import { resolveSkillRunChatCeiling, skillRunChatBotName, skillRunChatInstructions } from './skill-run-chat-ceiling'
import type { RunTokenClaims } from './skill-run-token'
import { areasForSkillRun, backgroundExpertiseSection } from '@/lib/packs/background'
import { backgroundPlanSpec, planModelFromSlug, type ChatGptPlanSpec } from '@/lib/chatgpt/plan-models'

interface SkillRowForRebuild {
  name: string
  system_prompt: string | null
  /** The skill's area (migration 316): its run gets that area's playbook. */
  area?: string | null
  agent_config: {
    enabled_tools?: string[]
    disabled_tools?: string[]
    context_rules?: string[]
    response_style?: { format?: string; tone?: string; always_cite_sources?: boolean }
    output_contract?: 'verdict' | 'prose'
    /** The skill's tier (run-skill.ts SkillRecipeRow): absent is Think. */
    model_tier?: 'fast' | 'think' | 'strong'
  } | null
}

export interface RebuiltEveSpec {
  systemPrompt: string
  /**
   * The Gateway-qualified model slug `${provider}/${id}` (e.g.
   * 'deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-4-5-...'), provider-
   * qualified HERE server-side, mirroring the chat spec path (chat-run-rebuild.ts).
   * The eve skill-runner agent passes this through verbatim — it must NOT prefix a
   * bare id with 'anthropic/', which would misroute a Kimi/DeepSeek id. (The
   * bare id still travels the token as claims.model and drives SkillRunSpec.model /
   * usage logging on assembleSkillRun; only this eve-facing field is qualified.)
   */
  model: string
  mode: 'report' | 'act'
  outputContract: 'verdict' | 'prose'
  /**
   * Bare ceiling tool names, or `null` for inherit-all — the SAME sentinel
   * computeSkillCeiling returns and pickPermittedTools(null) honors on the
   * gateway path. `null` must NOT be collapsed to `[]`: `[]` means "zero tools",
   * while inherit-all means "every workspace tool" (see ceilingTools below).
   */
  ceiling: string[] | null
  /**
   * One {name, description, inputSchema?} per tool the resolver should
   * advertise. On the eve path the dynamic resolver builds one proxy PER entry,
   * so this is the actual tool surface the session sees — and it must enumerate
   * the FULL workspace registry when `ceiling` is null, exactly the surface the
   * gateway path grants via pickPermittedTools(null) => the whole createTools()
   * map. `inputSchema` is the tool's REAL input schema as plain JSON Schema (the
   * shape streamText advertises on the gateway path) so proxies steer the model
   * with real parameter names/types; absent when extraction fails (proxy falls
   * back to its permissive pass-through).
   */
  ceilingTools: Array<{ name: string; description: string; inputSchema?: ToolInputJsonSchema }>
  /**
   * Per-user Gateway attribution (Phase A). The eve skill-runner agent's model
   * resolver rebuilds `providerOptions.gateway` from this so eve-path skill spend
   * is attributed per user/feature, matching the gateway path's inline tagging in
   * run-skill.ts. Present ONLY when GATEWAY_USER_TAGGING is on; absent when off.
   */
  gatewayTelemetry?: GatewayTelemetryValues
  /**
   * Whether this run may use the web (the skill-runner's native web_search +
   * web_fetch). Decided HERE, server-side, from the app's USE_GATEWAY kill
   * switch (isWebSearchAvailable) — the same switch that governed web access on
   * the retired in-process gateway path. `false` → the system prompt carries no
   * web guidance AND the skill-runner's tools resolver replaces both web tools
   * with refusal stubs (agents/skill-runner/tools/workspace_tools.ts), so the
   * run never touches the web. The agent fails closed: anything but `true`
   * (including a spec it could not fetch) means no web.
   */
  webAccess: boolean
  /**
   * How the run's tier calls its model (tierPolicy): Think (Flash at
   * DeepSeek's own effort, on private hosts) unless the skill asks Fast, or
   * Strong when the token's model is STRONG_MODEL.
   */
  modelPolicy?: ChatModelPolicy
  /**
   * Bots v3 Phase 4: present only for a CHAT token (claims.chat), a follow-up
   * turn on a run's parked session. `instructions` is the turn-scoped system
   * text the skill-runner's chat-turn resolver returns (the run is over,
   * someone is here). The ceiling above is then the bot's attended chat
   * ceiling (skill-run-chat-ceiling.ts), not the run's.
   */
  /**
   * Present when the run is on the person's own ChatGPT plan (the free tier:
   * the token's model is `chatgpt-plan/<model>`, run-skill.ts): the
   * skill-runner runs every step on the plan model through the plan proxy,
   * never the Gateway, and `model` is OpenAI's slug for it (the session's
   * guard selection). No web: web search is Gateway-billed.
   */
  chatgptPlan?: ChatGptPlanSpec
  chatTurn?: {
    instructions: string
    /**
     * The tools the run's own session advertised that this chat may not use:
     * the run's ceiling (the full registry when inherit-all) minus the bot's
     * chat ceiling. eve keeps a session's tools under a turn's, so the
     * skill-runner shadows these with refusal stubs for the chat turn.
     */
    shadowTools: string[]
  }
}

/**
 * The names a run's own session advertised (its ceiling, or the full registry
 * when inherit-all, as below) that a chat turn's ceiling doesn't hold. Pure.
 */
export function runToolsOutsideChat(runCeiling: Set<string> | null, chatCeiling: ReadonlySet<string>): string[] {
  const runAdvertised = runCeiling ? [...runCeiling] : NON_CHAT_TOOL_NAMES
  return [...new Set(runAdvertised)].filter((name) => name !== 'submit_run_verdict' && !chatCeiling.has(name))
}

/**
 * Rebuild the eve-facing spec from verified token claims. Returns null when the
 * skill row can't be found in the claimed workspace (a stale/edited/deleted skill
 * — the internal route then 404s and the run fails, exactly like a gateway run
 * whose skill vanished).
 */
export async function rebuildEveSpec(claims: RunTokenClaims): Promise<RebuiltEveSpec | null> {
  const supabase = getServiceClient()

  // Load the skill row with the SAME visibility rule assembleSkillRun uses
  // (workspace-owned OR system, category 'skill').
  const { data: recipe } = await supabase
    .from('recipe')
    .select('name, system_prompt, agent_config, area')
    .eq('id', claims.skillId)
    .eq('category', 'skill')
    .or(`workspace_id.eq.${claims.workspaceId},is_system.eq.true`)
    .maybeSingle<SkillRowForRebuild>()
  if (!recipe) return null

  const agentConfig = recipe.agent_config

  // Web access honors the USE_GATEWAY kill switch ('auto' semantics — exactly
  // the in-process gateway path's behavior before eve became the only server
  // runtime). The SAME decision gates the prompt guidance (webAccess 'auto'
  // below reads the same switch) and the eve web tools (spec.webAccess →
  // workspace_tools.ts), so the model is never told about tools it lacks, and
  // never holds web tools without the prompt-injection guidance.
  // A run on the person's own ChatGPT plan (the free tier) searches with
  // OpenAI's own web search on their plan (the skill-runner's plan steps run
  // on the search model, agents/skill-runner/lib/chatgpt-plan-model.ts), so
  // no Gateway switch takes it away.
  const planModel = planModelFromSlug(claims.model)
  const webAccess = planModel !== null || isWebSearchAvailable()

  // System prompt — the base prompt (run-as user) + the SAME skill layering.
  // The skill's area brings its playbook, exactly as assembleSkillRun adds it.
  const [basePrompt, expertise, canon, words] = await Promise.all([
    buildSystemPrompt(claims.runAsUserId, supabase, undefined, {
      workspaceId: claims.workspaceId,
      webAccess: planModel === null ? 'auto' : 'always',
    }),
    backgroundExpertiseSection(supabase, {
      workspaceId: claims.workspaceId,
      userId: claims.runAsUserId,
      areas: areasForSkillRun({ area: recipe.area, enabledTools: agentConfig?.enabled_tools }),
    }),
    // The canon registry (canon documents D1), as the run-as person reads it.
    canonRegistrySection(supabase, { workspaceId: claims.workspaceId, userId: claims.runAsUserId }),
    // The workspace's words (a loop's report to a service business says jobs), as assembleSkillRun adds them.
    skillRunWordsSection(supabase, claims.workspaceId),
  ])
  const systemPrompt = `${buildSkillSystemPrompt(
    recipe.name,
    recipe.system_prompt,
    agentConfig,
    basePrompt,
    expertise,
    words,
  )}${canon}`

  // Ceiling — the SAME mode-derived ceiling + capture/verdict force-adds. The
  // only fire-specific input, hasCapture, comes from the verified token. `null`
  // is inherit-all (act mode, no restriction) and is PRESERVED, not collapsed to
  // [] — the gateway path treats null as "every workspace tool" (pickPermittedTools),
  // so this path must too.
  //
  // A CHAT token (bots v3 Phase 4) takes the fronting bot's attended chat
  // ceiling instead — the SAME call the tool route enforces with — and never
  // inherit-all: a bot that's gone or out of reach advertises nothing.
  const chat = claims.chat ? { ...claims, chat: claims.chat } : null
  const ceilingSet = chat
    ? ((await resolveSkillRunChatCeiling(supabase, chat)) ?? new Set<string>())
    : computeSkillCeiling(agentConfig, claims.mode, claims.hasCapture)
  const ceiling = ceilingSet ? [...ceilingSet] : null
  const chatTurn = chat
    ? {
        instructions: skillRunChatInstructions(await skillRunChatBotName(supabase, chat)),
        shadowTools: runToolsOutsideChat(computeSkillCeiling(agentConfig, claims.mode, claims.hasCapture), ceilingSet ?? new Set()),
      }
    : null

  // The names the resolver advertises. inherit-all (null) enumerates the FULL
  // registry minus the chat-native tools (NON_CHAT_TOOL_NAMES: start_helper has
  // no executor outside the main chat), exactly what the skill tool route
  // permits for a null ceiling. Otherwise it's the ceiling
  // set verbatim. The verdict terminating tool isn't a registry tool (the eve
  // verdict path uses an outputSchema instead of a tool, so it's dropped from the
  // proxy list here — see the executor's runViaEve). Unknown names (defensive)
  // get a stub desc.
  // Schemas ride unconditionally here (no `?schemas=` split like the chat spec
  // route): the skill-runner's resolvers are all session-scoped, so this spec
  // is fetched a handful of times per RUN — not per step/turn — and the tools
  // resolver needs the schemas anyway.
  const advertisedNames = ceiling ?? NON_CHAT_TOOL_NAMES
  const toolSchemas = registryToolInputSchemas()
  const ceilingTools: RebuiltEveSpec['ceilingTools'] = advertisedNames
    .filter((name) => name !== 'submit_run_verdict')
    .map((name) => {
      const def = getToolDefinition(name)
      const inputSchema = toolSchemas.get(name)
      return {
        name,
        // A registry tool's usage notes ride its description (src/lib/ai/tool-guides.ts).
        description: def ? withToolGuide(name, def.description) : `Workspace tool: ${name}`,
        ...(inputSchema ? { inputSchema } : {}),
      }
    })
  // F4: the owner's connected apps this step may use (the token's
  // connections; never on a chat turn), as the tool route will run them.
  if (!chat && claims.connections?.length) {
    for (const t of connectionToolSpecs(await runConnectionTools(supabase, claims))) {
      ceilingTools.push({ name: t.name, description: t.description, ...(t.inputSchema ? { inputSchema: t.inputSchema as ToolInputJsonSchema } : {}) })
    }
  }

  // Per-user Gateway attribution (Phase A). Feature 'flow_run_skill' matches the
  // gateway path's logUsage (run-skill.ts); tagged runtime:eve + the skill id so
  // per-skill eve-path spend is attributable. `?? undefined` keeps the field
  // absent when the flag is off. The agent-side resolver shape-guards it.
  const gatewayTelemetry =
    gatewayTelemetryValues(claims.runAsUserId, 'flow_run_skill', {
      workspaceId: claims.workspaceId,
      runtime: 'eve',
      extraTags: [`skill:${claims.skillId}`],
    }) ?? undefined

  // The tier: the token's model says Strong (granted at assembly, run-skill.ts
  // skillRunTier); otherwise the skill's own model_tier, Think by default. The
  // model itself stays the token's, so billing names what ran.
  const tier: ModelTier = claims.model === STRONG_MODEL ? 'strong' : agentConfig?.model_tier === 'fast' ? 'fast' : 'think'
  const modelPolicy = ALLOWED_MODELS.has(claims.model) ? chatModelPolicy(claims.model as ChatModelId, tierLevel(tier)) : undefined

  // On the person's own ChatGPT plan: the plan model, thinking by the same
  // tier, with no Gateway attribution or host routing (no Gateway call is made).
  if (planModel) {
    return {
      systemPrompt,
      model: `openai/${planModel}`,
      mode: claims.mode,
      outputContract: claims.outputContract,
      ceiling,
      ceilingTools,
      webAccess,
      chatgptPlan: { ...backgroundPlanSpec(tier), model: planModel, helperModel: planModel },
      ...(chatTurn ? { chatTurn } : {}),
    }
  }

  return {
    systemPrompt,
    // Provider-qualify server-side (mirrors chat-run-rebuild.ts) so the eve agent
    // passes it through verbatim instead of blindly prefixing 'anthropic/' — which
    // would misroute a bare DeepSeek/Kimi id.
    model: gatewayModelSlug(claims.model),
    mode: claims.mode,
    outputContract: claims.outputContract,
    ceiling,
    ceilingTools,
    gatewayTelemetry,
    webAccess,
    ...(modelPolicy ? { modelPolicy } : {}),
    ...(chatTurn ? { chatTurn } : {}),
  }
}
