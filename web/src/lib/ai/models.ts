/**
 * Central model configuration for all AI features.
 *
 * Every route that calls an LLM should reference constants from here
 * rather than hardcoding model IDs. This makes it easy to upgrade
 * models across the entire app in one place.
 */
import { CHATGPT_PLAN_PROVIDER, planModelFromSlug, planModelOfStep, planModelSlug } from '@/lib/chatgpt/plan-models'

/**
 * The model nearly every AI surface runs on: DeepSeek V4 Flash, the cheapest
 * model in CHAT_MODELS. Nobody picks a model (Liam, 2026-10-15): each surface
 * has a fixed model (SURFACE_MODELS in src/lib/ai/model-defaults.ts), and the
 * main chat's thread runs MAIN_MODEL.
 */
export const DEFAULT_MODEL = 'deepseek-v4-flash'

/**
 * The main chat's own model (Liam, 2026-10-27, for cost; Opus 5.5 the day
 * before): Claude Haiku 5.5 on the AI Gateway (anthropic/claude-haiku-5.5,
 * 1M window). Every main-chat turn runs it
 * (the person's own, a server turn, a relay, a Slack message, a teammate
 * chat), except a device ask (Flash, a quick answer someone waits on) and a
 * person on their own ChatGPT plan (their plan's model, never a Gateway one).
 * It picks the model of each helper it starts from HELPER_MODELS below.
 * ONE constant: moving to another model is this line, its CHAT_MODELS entry,
 * its ai_model_costs row, and each agent's KNOWN_CONTEXT_WINDOWS mirror.
 */
export const MAIN_MODEL = 'claude-haiku-5-5'

/**
 * The Strong tier: the newest Claude Sonnet the AI Gateway lists with tool
 * support (anthropic/claude-sonnet-5.5, checked against
 * https://ai-gateway.vercel.sh/v1/models on 2026-10-15). Coding runs, PDF
 * ingest and strong helpers run on it; the home thread never does. ONE
 * constant: moving to a newer Sonnet is this line, its CHAT_MODELS entry, its
 * ai_model_costs row, and each agent's KNOWN_CONTEXT_WINDOWS mirror.
 */
export const STRONG_MODEL = 'claude-sonnet-5-5'

/**
 * Historical alias — loops and background jobs used to have their own default
 * while chat stayed on Haiku. Every surface now shares DEFAULT_MODEL; the alias
 * is kept so existing imports keep working.
 */
export const DEFAULT_SKILL_RUN_MODEL = DEFAULT_MODEL

/**
 * The models the app runs: MAIN_MODEL, the tiers' models (Flash, and
 * STRONG_MODEL), the helper roster's (HELPER_MODELS: Haiku 5.5 and two OpenAI
 * models), plus what the eval judges and old usage rows name (Haiku 4.5,
 * Sonnet 4.5, Pro). Nobody picks from it in the UI; the evals judge picker
 * still lists it.
 *
 * The OpenAI entries are GPT-5.6, never the GPT-6 models a ChatGPT plan runs
 * (PLAN_MODELS in src/lib/chatgpt/plan-models.ts): a step named
 * `openai/<plan model>` is read as the person's own plan and billed nothing
 * (planModelOfStep), so a Gateway step on one of those would go unbilled.
 * plan-models.test.ts pins that no CHAT_MODELS slug is a plan model.
 *
 * `id` is the app-internal id — stable, stored on conversations / ai_usage_logs /
 * ai_model_costs and accepted by the direct-provider kill-switch path. It is NOT
 * necessarily what the Vercel AI Gateway calls the model.
 *
 * `gatewayId` is the Gateway CATALOG SLUG (`provider/model` as listed by
 * GET https://ai-gateway.vercel.sh/v1/models/catalog). Anthropic slugs use dotted
 * versions with no date suffix (`claude-haiku-4.5`, not
 * `claude-haiku-4-5-20251001`). The Gateway accepts the dated id for INFERENCE
 * (it canonicalises it), but eve ≥0.47 resolves every dynamic model selection
 * against the catalog BY SLUG to learn its context window — an id that is not a
 * catalog slug fails the turn with "AI Gateway did not provide context window
 * metadata" (prod outage 2026-09-02). So every Gateway-bound slug must come from
 * `gatewayModelSlug()`, never from a hand-built `${provider}/${id}` string.
 */
export const CHAT_MODELS = [
  {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    gatewayId: 'anthropic/claude-haiku-4.5',
    label: 'Haiku 4.5',
    description: 'Fast & efficient',
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    gatewayId: 'anthropic/claude-sonnet-4.5',
    label: 'Sonnet 4.5',
    description: 'Most capable',
  },
  {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    gatewayId: 'anthropic/claude-sonnet-5.5',
    label: 'Sonnet 5.5',
    description: 'Strong tier: coding and complex work',
  },
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    gatewayId: 'anthropic/claude-opus-5.5',
    label: 'Opus 5.5',
    description: 'The main chat: the strongest model',
  },
  {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    gatewayId: 'anthropic/claude-haiku-5.5',
    label: 'Haiku 5.5',
    description: 'Fast, cheap Claude for helpers',
  },
  {
    id: 'gpt-5.6-terra',
    provider: 'openai',
    gatewayId: 'openai/gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'Strong OpenAI model for helpers',
  },
  {
    id: 'gpt-5.6-luna',
    provider: 'openai',
    gatewayId: 'openai/gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'Cheap OpenAI model for helpers',
  },
  {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    gatewayId: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: 'Cheapest option',
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    gatewayId: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'Strong coding, low cost',
  },
] as const

/** All model IDs the system accepts. Used for validation. */
export const ALLOWED_MODELS: Set<string> = new Set(CHAT_MODELS.map((m) => m.id))

/** An app model id from CHAT_MODELS. */
export type ChatModelId = (typeof CHAT_MODELS)[number]['id']

/**
 * The two reasoning levels the tiers use, lowest first (src/lib/ai/model-route.ts):
 * 'light' is the Fast tier, 'standard' the Think tier. There is no slider any
 * more, and Max (`xhigh`, which can take minutes) is never picked. DeepSeek
 * thinks at both (Liam, 2026-10-31: with thinking off it wrote its reasoning
 * into the reply a guest was texted), so on DeepSeek, as on the Claude 5.5
 * models, the two levels differ only in the turn's usage row.
 */
export const THINKING_LEVELS = ['light', 'standard'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/**
 * The AI SDK `reasoning` values chat sends: CallSettings.reasoning without
 * 'provider-default', each one eve's resolveRuntimeModelSelection accepts.
 */
export type ChatReasoning = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/**
 * How chat calls each model: window, thinking, and which Gateway hosts may serve it.
 * Rides the eve chat spec as `modelPolicy` (src/lib/chat/chat-run-rebuild.ts); the
 * chat-agent's model resolver shape-guards each field and maps it onto the eve
 * model selection (agents/chat-agent/lib/spec-client.ts). JSON only: it crosses
 * the wire and lands in eve's durable model reference.
 */
export interface ChatModelPolicy {
  /**
   * eve's modelContextWindowTokens. It skips eve's per-session Gateway catalog
   * lookup and sets the compaction threshold (90% of it). The model's real
   * window: the eve agents cap what they hand eve at a 600K safety ceiling
   * (COMPACTION_WINDOW_TOKENS in each agent's lib/model-policy.ts), so a 1M
   * model compacts at 540K tokens; a smaller window keeps its own 90%. Must not exceed the
   * smallest window any host allowed to serve the model accepts as chat calls
   * it: the hosts in `gateway.only`, or every catalog host when there is none.
   */
  contextWindowTokens: number
  /** Top-level AI SDK reasoning setting, forwarded on every model step. */
  reasoning?: ChatReasoning
  /**
   * Provider options. eve's compaction call gets these but NOT `reasoning`, and
   * a reasoning option here wins over the top-level `reasoning`.
   */
  providerOptions?: Record<string, Record<string, unknown>>
  /** AI Gateway routing, merged into providerOptions.gateway beside the telemetry. */
  gateway?: { only?: string[]; order?: string[]; sort?: 'ttft' | 'tps' | 'cost' }
}

/**
 * DeepSeek thinks before every answer unless told not to. The `deepseek` key
 * works on every host serving it (a host-named key, e.g. `alibaba`, is ignored).
 * The provider option wins over the top-level `reasoning`, so a policy carries
 * exactly one of these, never both.
 */
const DEEPSEEK_NO_THINKING = { deepseek: { thinking: { type: 'disabled' } } }
const DEEPSEEK_THINKING = { deepseek: { thinking: { type: 'enabled' } } }

/**
 * How chat calls `modelId` at `level`. No window exceeds the smallest one a
 * host allowed to serve that model accepts as chat calls it.
 *
 * DeepSeek, checked 2026-09-29 against /v1/models/<slug>/endpoints: every host
 * listed is zero-data-retention + no-training, has a ≥1M window, and honors
 * thinking-off. Excluded: azure (inverts thinking-off: it thinks when told not
 * to, in both encodings), deepinfra for Pro (64K window), digitalocean for
 * Flash (262K window), and every host without both privacy flags (novita and
 * gmicloud train on prompts; DeepSeek's own API carries neither flag). `sort:
 * 'ttft'` ranks the allowed hosts by live first-token latency and steps around
 * a degraded one; a fixed `order` would fall back only on failure.
 *
 * DeepSeek in chat thinks at both levels (Liam, 2026-10-31): Flash with
 * thinking off reasoned in its reply text, and a guest was texted "She's
 * reading my '...' as evasive. Let me address...". It sends `reasoning: 'high'`
 * and the provider option with thinking enabled, so compaction thinks too.
 * Only the surfaces outside chat whose output cap or clock can't hold the
 * reasoning still turn it off ({@link deepseekSurfacePolicy}).
 * Probed 2026-09-30 with thinking on: Pro reasoned fully on both its hosts.
 * Flash on baseten cut its reasoning at ~4096 tokens (wrong answers at every
 * level) and once ended the stream early, and deepinfra streams too slowly for
 * thinking (~45 tok/s), so Flash thinks only on wafer and alibaba.
 *
 * Claude 4.5 (the eval judges' models; chat no longer runs them): 200K. The
 * catalog lists 1M for Sonnet 4.5, but that is Anthropic's context-1m beta,
 * which nothing here sends. Light sends no `reasoning`; Standard 'minimal'.
 *
 * STRONG_MODEL (Sonnet 5.5): a 1M window with no beta, and the same policy at
 * both levels, no `reasoning` at all. Sonnet 5.5 refuses `thinking: {type:
 * 'disabled'}` with a 400; sent no thinking parameter it runs adaptive
 * thinking at its default effort, which is what a strong helper or a coding
 * run wants. MAIN_MODEL (Haiku 5.5) and Opus 5.5 are called the same way: a
 * 1M window (the AI Gateway catalog, 2026-10-26), adaptive thinking, the same
 * at both levels. On the main thread that means the Fast and Think tiers
 * differ only in their usage rows: the model decides how hard to think.
 *
 * GPT-5.6 Terra and Luna (helpers only): OpenAI reasoning models, `low` at
 * Light and `medium` at Standard, as the ChatGPT plan's models are called.
 * The catalog lists ~1.05M; 1M stays under every host's window.
 */
export function chatModelPolicy(modelId: ChatModelId, level: ThinkingLevel): ChatModelPolicy {
  const thinking = level === 'standard'
  switch (modelId) {
    case 'claude-haiku-4-5-20251001':
    case 'claude-sonnet-4-5-20250929':
      return thinking ? { contextWindowTokens: 200_000, reasoning: 'minimal' } : { contextWindowTokens: 200_000 }
    case 'claude-sonnet-5-5':
    case 'claude-opus-5-5':
    case 'claude-haiku-5-5':
      return { contextWindowTokens: 1_000_000 }
    case 'gpt-5.6-terra':
    case 'gpt-5.6-luna':
      return { contextWindowTokens: 1_000_000, reasoning: thinking ? 'medium' : 'low' }
    case 'deepseek-v4-flash':
    case 'deepseek-v4-pro':
      return deepseekPolicy(modelId, true)
  }
}

/** DeepSeek called with its thinking on or off, on the hosts that honor it (see chatModelPolicy). */
function deepseekPolicy(modelId: 'deepseek-v4-flash' | 'deepseek-v4-pro', thinking: boolean): ChatModelPolicy {
  if (modelId === 'deepseek-v4-pro') {
    return {
      contextWindowTokens: 1_000_000,
      reasoning: thinking ? 'high' : 'none',
      providerOptions: thinking ? DEEPSEEK_THINKING : DEEPSEEK_NO_THINKING,
      gateway: { only: ['baseten', 'alibaba'], sort: 'ttft' },
    }
  }
  return thinking
    ? {
        contextWindowTokens: 1_000_000,
        reasoning: 'high',
        providerOptions: DEEPSEEK_THINKING,
        gateway: { only: ['wafer', 'alibaba'], sort: 'ttft' },
      }
    : {
        contextWindowTokens: 1_000_000,
        reasoning: 'none',
        providerOptions: DEEPSEEK_NO_THINKING,
        gateway: { only: ['baseten', 'wafer', 'deepinfra', 'alibaba'], sort: 'ttft' },
      }
}

function isChatModelId(id: string): id is ChatModelId {
  return ALLOWED_MODELS.has(id)
}

/**
 * The policy a main-chat turn runs when nothing else decides: MAIN_MODEL at
 * Light. The chat-agent's spec-failure fallback (FALLBACK_SELECTION in
 * agents/chat-agent/lib/chat-model.ts) is this policy, pinned by
 * agents/chat-agent/lib/__tests__/model-turn-fresh.test.ts.
 */
export const DEFAULT_CHAT_POLICY: ChatModelPolicy = chatModelPolicy(MAIN_MODEL, 'light')

/**
 * Flash at Light (thinking on, like every chat call to DeepSeek): a device
 * ask's policy, and a plain (`flash`) helper's spec-failure fallback
 * (FLASH_FALLBACK_SELECTION in agents/chat-agent/lib/helper-models.ts).
 */
export const FLASH_CHAT_POLICY: ChatModelPolicy = chatModelPolicy('deepseek-v4-flash', 'light')

/** Whether DeepSeek thinks on a surface other than chat (see deepseekSurfacePolicy). */
export type DeepSeekThinking = 'off' | 'on'

/**
 * How a surface other than chat calls DeepSeek, which thinks before every
 * answer unless told not to (chat always lets it: chatModelPolicy):
 *   - 'off' only where the reasoning can't fit: a one-shot whose output cap or
 *     clock can't hold ~5-8K tokens of it (a chat title, a 1,000-token
 *     summary, a 60 s judge), a live-meeting turn the meeting is waiting on,
 *     onboarding research the person watches run;
 *   - 'on' at DeepSeek's own default effort everywhere else. Chat's quality
 *     check (2026-09-30) found thinking off makes multi-step tool work stop
 *     early, and with it off Flash writes its reasoning into its answer.
 * Either way on chat's private hosts (zero-retention, no-training), with the
 * hosts that cut Flash's reasoning short left out when it thinks. Takes an app
 * id or a Gateway slug. Any other model gets undefined: its call is unchanged.
 */
export function deepseekSurfacePolicy(model: string, thinking: DeepSeekThinking): ChatModelPolicy | undefined {
  const id = isChatModelId(model) ? model : appModelIdForGatewaySlug(model)
  if (id !== 'deepseek-v4-flash' && id !== 'deepseek-v4-pro') return undefined
  return deepseekPolicy(id, thinking === 'on')
}

/**
 * Returns the Gateway provider prefix for a model id (e.g. 'anthropic',
 * 'moonshotai', 'deepseek'). Used to build the Gateway slug
 * `${provider}/${id}`. Unknown ids fall back to 'anthropic' — the historical
 * default before multi-provider support.
 */
export function getModelProvider(id: string): string {
  return CHAT_MODELS.find((m) => m.id === id)?.provider ?? 'anthropic'
}

/**
 * The Vercel AI Gateway CATALOG SLUG for an app model id — the ONLY correct way
 * to build a Gateway-bound model string. Known ids map to their `gatewayId`;
 * an unknown id degrades to `${provider}/${id}` (the historical behaviour) so
 * a stray id still routes rather than throwing. See the CHAT_MODELS doc for why
 * the dated Anthropic ids must not reach the Gateway as slugs.
 *
 * Accepts an already-qualified slug (contains '/') and returns it unchanged,
 * so callers holding a slug can pass it through without a branch.
 */
export function gatewayModelSlug(id: string): string {
  if (id.includes('/')) return id
  const entry = CHAT_MODELS.find((m) => m.id === id)
  return entry?.gatewayId ?? `${getModelProvider(id)}/${id}`
}

/**
 * The app model id (what ai_usage_logs / ai_model_costs key on) for a Gateway
 * slug an eve step actually ran — the inverse of gatewayModelSlug. A known
 * catalog slug maps to its CHAT_MODELS `id` ('anthropic/claude-haiku-4.5' →
 * 'claude-haiku-4-5-20251001'); a known app id passes through; any other
 * `provider/model` slug degrades to its bare model part (the historical
 * `${provider}/${id}` shape). Empty / non-string → null.
 */
export function appModelIdFromGatewaySlug(slug: unknown): string | null {
  if (typeof slug !== 'string') return null
  const trimmed = slug.trim()
  if (!trimmed) return null
  // A step on the person's ChatGPT plan keeps (or gets back) its
  // `chatgpt-plan/` name, so usageProviderLabel bills it to the plan (nothing
  // to Native Intelligence). eve names a step on the plan's search model `openai/<model>`.
  const planModel = planModelOfStep(trimmed)
  if (planModel) return planModelSlug(planModel)
  const bySlug = CHAT_MODELS.find((m) => m.gatewayId === trimmed)
  if (bySlug) return bySlug.id
  if (ALLOWED_MODELS.has(trimmed)) return trimmed
  const slash = trimmed.indexOf('/')
  const bare = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
  return bare || null
}

/**
 * The inverse of {@link gatewayModelSlug} for the catalog: the app model id
 * whose Gateway slug is `slug` (e.g. 'anthropic/claude-haiku-4.5' →
 * 'claude-haiku-4-5-20251001'), or null when no CHAT_MODELS entry has it. Used
 * to bill the model an eve step ACTUALLY ran on (its `step.started.data.modelId`
 * is the Gateway slug), which usage rows record as the app id. Unlike
 * {@link appModelIdFromGatewaySlug} it never degrades a non-catalog slug to its
 * bare model part: the device ask falls back to the REQUESTED model then.
 */
export function appModelIdForGatewaySlug(slug: string): string | null {
  return CHAT_MODELS.find((m) => m.gatewayId === slug)?.id ?? null
}

/**
 * Gateway-qualified slug of DEFAULT_MODEL. Declared after gatewayModelSlug so
 * the lookup is resolved at module load.
 */
export const DEFAULT_SKILL_RUN_MODEL_SLUG = gatewayModelSlug(DEFAULT_SKILL_RUN_MODEL)

/**
 * Provider label for ai_usage_logs rows. Anthropic maps to the legacy
 * 'claude' literal — the log_ai_usage RPC's prompt-cache discount branch
 * matches `p_provider = 'claude'` exactly, and dashboard history buckets
 * under it. Non-Anthropic providers log their gateway provider id verbatim.
 */
export function usageProviderLabel(modelId: string): string {
  // `chatgpt-plan/<model>` (or `openai/<model>` as eve names a plan search
  // step): the person's own ChatGPT plan; logUsage bills nothing.
  if (planModelOfStep(modelId)) return CHATGPT_PLAN_PROVIDER
  const provider = getModelProvider(modelId)
  return provider === 'anthropic' ? 'claude' : provider
}

/**
 * A short system-prompt note stating which model is actually running, so the
 * assistant answers "which model are you" from routing truth instead of its base
 * training's self-identity. Non-Anthropic models routed through the Gateway
 * (Kimi, DeepSeek) frequently self-report as Claude even when routing is provably
 * correct (verified: Kimi K3 claims to be Claude) — this line overrides that.
 *
 * ── History-proof wording (strengthened after a live E2E failure) ────────────
 * The model resolves PER TURN, so a single conversation can span several models
 * (haiku → deepseek → kimi → haiku). In that live test, turn 4 (back on haiku)
 * hallucinated "Claude 3.5 Sonnet" DESPITE this note being present: a small model,
 * facing a history that already contained three DIFFERENT prior identity answers,
 * ignored the softer single-sentence line. So the copy now (a) pins the note to
 * the CURRENT reply, (b) warns that earlier in-conversation identity statements
 * may be outdated because different turns ran on different models, and (c) forbids
 * answering from training data OR from an earlier turn's quoted identity.
 *
 * ── Callers must PREPEND this FIRST ──────────────────────────────────────────
 * Wording alone was not enough: a second live round showed Kimi K3 STILL echo the
 * previous turn's identity verbatim when the note sat at the END of the long
 * (~11-layer + skills) prompt. Weaker OSS models under-attend to a trailing note
 * and over-attend to recent conversation. Position is the remaining lever, and it
 * is free — so every caller injects this as the FIRST line of the system prompt,
 * ahead of all layered context, for maximum salience.
 *
 * Takes the CLAMPED bare model id (what will actually run). Unknown ids degrade
 * gracefully: the bare id doubles as its own label and getModelProvider falls
 * back to 'anthropic', so the line is still well-formed.
 *
 * Prompt-cache safe at ANY position (including first): the note varies ONLY with
 * the model id, and provider prompt caches are per-model anyway, so it adds zero
 * extra cache invalidation. Callers keep its POSITION stable across turns
 * (prepend first) so the cached prefix stays byte-identical within a model.
 *
 * `named` names a model outside CHAT_MODELS (a ChatGPT plan model, which is
 * no Gateway slug), with `via` saying how it runs.
 */
export function modelIdentityNote(modelId: string, named?: { label: string; slug: string; via?: string }): string {
  const label = named?.label ?? CHAT_MODELS.find((m) => m.id === modelId)?.label ?? modelId
  const slug = named?.slug ?? gatewayModelSlug(modelId)
  return (
    `Active model: ${label} (\`${slug}\`)${named?.via ? `, ${named.via}` : ''}. ` +
    `This is the model generating the CURRENT reply; different turns in this ` +
    `conversation may have run on different models, so any earlier statement in ` +
    `this thread about which model is answering may be outdated. ` +
    `When asked which AI model is answering, answer with the active model named ` +
    `above — never a model name from your training data and never one quoted from ` +
    `an earlier turn.`
  )
}

/**
 * Models that require a paid plan. Free/trial users are clamped to the default
 * (cheap) model so a $1 trial can't be spent in two Sonnet requests (P1-6), and
 * so they get no Strong tier at all (src/lib/ai/model-escalation-budget.ts).
 */
export const PREMIUM_MODELS: Set<string> = new Set(['claude-sonnet-4-5-20250929', STRONG_MODEL])

// ── The helper roster (Liam, 2026-10-26) ─────────────────────────────────────

/**
 * The models the main chat's agent (MAIN_MODEL) may hand a helper task to,
 * by the key it passes as `model` on `helpers` (quick, in-turn) and
 * `start_helper` (background). The agent picks: these keys, what each runs on
 * and what it is for are written into its system prompt
 * (renderHelperModelRoster) and named in both tools' schemas. Leaving `model`
 * out lets the rules pick (routeHelperTask in src/lib/ai/model-route.ts).
 *
 * The agent mirrors the keys (agents/chat-agent/lib/helpers.ts
 * HELPER_MODEL_KEYS, one declared subagent per key); a drift test pins them.
 */
export const HELPER_MODEL_KEYS = ['flash', 'flash-thinking', 'haiku', 'gpt-luna', 'sonnet', 'gpt-terra', 'opus'] as const
export type HelperModelKey = (typeof HELPER_MODEL_KEYS)[number]

export function isHelperModelKey(v: unknown): v is HelperModelKey {
  return typeof v === 'string' && (HELPER_MODEL_KEYS as readonly string[]).includes(v)
}

export interface HelperModelEntry {
  key: HelperModelKey
  /** The app model id it runs on. */
  model: ChatModelId
  /** The level it is called at (chatModelPolicy). */
  level: ThinkingLevel
  /**
   * The tier it counts as (model_route, agent_run.model_tier). A `strong`
   * entry is premium: a paid plan only, within the person's daily cap
   * (src/lib/ai/model-escalation-budget.ts); refused, the task runs on
   * HELPER_MODEL_FALLBACK.
   */
  tier: 'fast' | 'think' | 'strong'
  /** What it runs on, for the roster. */
  runsOn: string
  /** List price per 1M tokens, input / output, USD (AI Gateway, 2026-10-26). */
  price: string
  /** What to use it for, for the roster. */
  bestFor: string
}

export const HELPER_MODELS: readonly HelperModelEntry[] = [
  {
    key: 'flash',
    model: 'deepseek-v4-flash',
    level: 'light',
    tier: 'fast',
    runsOn: 'DeepSeek V4 Flash, thinking on',
    price: '0.08 / 0.18 (plus thinking tokens)',
    bestFor: 'Lookups, reading and summarizing, routine mail, calendar and CRM work, simple drafts.',
  },
  {
    key: 'flash-thinking',
    model: 'deepseek-v4-flash',
    level: 'standard',
    tier: 'think',
    runsOn: 'DeepSeek V4 Flash, thinking on',
    price: '0.08 / 0.18 (plus thinking tokens)',
    bestFor: 'Multi-step research and tool work on a budget: many lookups, reading many threads, careful but routine analysis. Slower than flash.',
  },
  {
    key: 'haiku',
    model: 'claude-haiku-5-5',
    level: 'light',
    tier: 'fast',
    runsOn: "Claude Haiku 5.5, the main chat's own model",
    price: '0.10 / 0.50 (0.50 / 2.50 past 100K input)',
    bestFor: 'Quick, reliable tool use and extraction; short drafts in a polished voice; following a precise format.',
  },
  {
    key: 'gpt-luna',
    model: 'gpt-5.6-luna',
    level: 'light',
    tier: 'fast',
    runsOn: 'OpenAI GPT-5.6 Luna, low reasoning',
    price: '0.20 / 1.20',
    bestFor: 'High-volume classification, tagging and extraction; a cheap second opinion from another model family.',
  },
  {
    key: 'sonnet',
    model: STRONG_MODEL,
    level: 'standard',
    tier: 'strong',
    runsOn: 'Claude Sonnet 5.5',
    price: '2 / 10',
    bestFor: 'Code, SQL, stack traces and diffs; synthesis across many sources; long, careful writing.',
  },
  {
    key: 'gpt-terra',
    model: 'gpt-5.6-terra',
    level: 'standard',
    tier: 'strong',
    runsOn: 'OpenAI GPT-5.6 Terra, medium reasoning',
    price: '2 / 12',
    bestFor: 'Strong general analysis and planning; a strong second opinion from another model family.',
  },
  {
    key: 'opus',
    model: 'claude-opus-5-5',
    level: 'standard',
    tier: 'strong',
    runsOn: 'Claude Opus 5.5',
    price: '4 / 20',
    bestFor: 'Only the hardest parallel work: ambiguous, high-stakes judgment across many documents. The most expensive.',
  },
]

/** A premium task refused (the plan, the daily cap, the kill switch, a server start) runs on this. */
export const HELPER_MODEL_FALLBACK: HelperModelKey = 'flash-thinking'

/** The roster entry for a key. */
export function helperModelEntry(key: HelperModelKey): HelperModelEntry {
  const entry = HELPER_MODELS.find((m) => m.key === key)
  if (!entry) throw new Error(`unknown helper model ${key}`)
  return entry
}

/** Whether a key is premium (paid plans only, within the daily cap). */
export function isPremiumHelperModel(key: HelperModelKey): boolean {
  return helperModelEntry(key).tier === 'strong'
}

/**
 * The key a rules-decided tier runs on, when the agent named no model: Fast
 * is `flash`, Think `flash-thinking`, Strong `sonnet` (STRONG_MODEL), exactly
 * the models each tier ran on before the roster.
 */
export function helperModelForTier(tier: 'fast' | 'think' | 'strong'): HelperModelKey {
  return tier === 'strong' ? 'sonnet' : tier === 'think' ? 'flash-thinking' : 'flash'
}

/**
 * What a helper session needs to run on its model, as the chat spec carries
 * it (ChatSpec.helperModels): the Gateway slug, how it is called, and its
 * identity line (the conversation's prompt opens with the thread's).
 */
export interface HelperModelSpec {
  model: string
  modelPolicy: ChatModelPolicy
  identityNote: string
  tier: 'fast' | 'think' | 'strong'
}

/** Every roster entry as the chat spec carries it, by key. */
export function helperModelSpecs(): Record<HelperModelKey, HelperModelSpec> {
  const out = {} as Record<HelperModelKey, HelperModelSpec>
  for (const entry of HELPER_MODELS) {
    out[entry.key] = {
      model: gatewayModelSlug(entry.model),
      modelPolicy: chatModelPolicy(entry.model, entry.level),
      identityNote: modelIdentityNote(entry.model),
      tier: entry.tier,
    }
  }
  return out
}

/**
 * The roster as the main chat's system prompt carries it: stable text (no
 * dates, no counts), right after the identity line, so the agent sees what
 * it can hand a task to every time it starts one.
 */
export function renderHelperModelRoster(dailyCap: number): string {
  const rows = HELPER_MODELS.map((m) => `| \`${m.key}\` | ${m.runsOn} | ${m.price} | ${m.bestFor} |`)
  const premium = HELPER_MODELS.filter((m) => m.tier === 'strong').map((m) => `\`${m.key}\``)
  return [
    '## Models for helpers',
    '',
    'For the main agent (a helper does its own task itself): you run on a fast, inexpensive model (Claude Haiku 5.5), so you do most of the work yourself. ' +
      'A helper pays for a big batch that splits cleanly (`helpers`, several in parallel in this turn), a long job that runs while you keep talking (`start_helper`), ' +
      'or work that needs a stronger model than yours. Choose each task\'s model with its `model` field. ' +
      'Every helper has the same tools and limits whatever its model; only the model differs.',
    '',
    'Which model for which job:',
    '- Writing copy (an email or a reply, a post, a doc section): do it yourself. A large batch of drafts: `haiku` helpers in parallel, or `flash` for plain routine mail.',
    '- Lookups, reading many threads or captures, summarizing, meeting prep: yourself for a few; for many, `flash`, or `flash-thinking` when it takes many steps.',
    '- Tagging, sorting or extracting across many records: `gpt-luna`.',
    '- Code, SQL, a stack trace, synthesis across many sources: `sonnet`. A change to a code repository is a coding run (`start_cloud_coding_run`, or `start_local_agent` on their Mac), never a helper.',
    '- Hard, high-stakes judgment across many documents, or anything you are not sure you can get right: `sonnet` or `gpt-terra`; `opus` only for the hardest.',
    '',
    '| model | runs on | USD per 1M tokens (in / out) | use it for |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `- ${premium.join(', ')} are premium: paid plans only, and at most ${dailyCap} premium helpers a day per person. ` +
      `Past that, or on an unpaid plan, the task runs on \`${HELPER_MODEL_FALLBACK}\` instead; each result names the model it ran on.`,
    '- Leave `model` out and the app picks from the task itself.',
    '- When a task is beyond you, hand it to a stronger model rather than guess: a careful answer from `sonnet` costs less than a wrong one.',
  ].join('\n')
}

/**
 * Resolves a model ID: returns it if it's in the allowed set, otherwise falls
 * back to `fallback` (DEFAULT_MODEL unless the caller names one).
 */
export function resolveModel(model?: string | null, fallback: string = DEFAULT_MODEL): string {
  return model && ALLOWED_MODELS.has(model) ? model : fallback
}

/**
 * Clamp a requested model to what the plan tier permits. Free/trial users
 * (isPaidPlan === false) can't use premium models — they get `fallback`
 * (DEFAULT_MODEL, the cheapest tier, unless the caller passes its surface
 * default). Pure function so it's usable client- and server-side.
 */
export function clampModelToPlan(model: string, isPaidPlan: boolean, fallback: string = DEFAULT_MODEL): string {
  if (!isPaidPlan && PREMIUM_MODELS.has(model)) return fallback
  return model
}
