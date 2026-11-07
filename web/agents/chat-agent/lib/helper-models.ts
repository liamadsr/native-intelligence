/**
 * The quick helpers' models (Liam, 2026-10-26): the main chat's agent (Haiku
 * 5.5) picks each helper task's model from the roster, HELPER_MODELS in
 * src/lib/ai/models.ts, and each roster key runs in its own declared
 * subagent (subagents/helper*, HELPER_AGENT_BY_MODEL in ./helpers.ts), whose
 * model resolver and persona come from here.
 *
 * Nothing about a model is copied here: the chat spec carries every roster
 * model's call (`helperModels`: its Gateway slug, policy and identity line,
 * built by src/lib/chat/chat-run-rebuild.ts from HELPER_MODELS), and a
 * helper's session reads its own key's entry, shape-guarded. On a spec
 * outage, or an entry that doesn't validate, the helper runs on Flash with
 * thinking on (FLASH_FALLBACK_SELECTION), the cheap model that is always
 * there, as the main chat used to: a resolver must return a concrete
 * selection, never throw (a throw ends the session, see ./chat-model.ts).
 *
 * The person's ChatGPT plan (the free tier, ./chatgpt-plan-model.ts): the
 * app sends every task of a plan turn to the plain helper, which runs the
 * plan's lighter model (./chat-model.ts helperChatModel). Should another
 * helper ever start on one, it gets the plan's turn guard, which the Gateway
 * serves from no host: it fails, and Dial8 pays nothing.
 */
import { defineDynamic } from 'eve'
import { FALLBACK_CHATGPT_PLAN_ROUTE, chatGptPlanForTurn, planTurnSelection } from './chatgpt-plan-model.js'
import { selectionWithPolicy, validModelPolicy } from './model-policy.js'
import { CHAT_COMPACTION_WINDOW_TOKENS, withChatCompactionWindowFor } from './compaction-window.js'
import { fetchChatSpec, runTokenFromAuth, turnCtxFromAuth, validGatewayTelemetry, type ChatSpec, type ModelSelection } from './spec-client.js'
import { setTurnModelRoute } from './turn-model-route.js'
import { PREMIUM_HELPER_MODEL_KEYS, type HelperModelKey } from './helpers.js'

/**
 * Flash, thinking on, on the private hosts that think: a plain helper's
 * fallback, and every roster helper's on a spec outage. Mirrors
 * FLASH_CHAT_POLICY in src/lib/ai/models.ts (lib/__tests__/model-turn-fresh.test.ts
 * pins it), with its window capped at the chat compaction window.
 */
export const FLASH_FALLBACK_SELECTION: ModelSelection = {
  model: 'deepseek/deepseek-v4-flash',
  reasoning: 'high',
  modelContextWindowTokens: CHAT_COMPACTION_WINDOW_TOKENS,
  modelOptions: {
    providerOptions: {
      deepseek: { thinking: { type: 'enabled' } },
      gateway: { only: ['wafer', 'alibaba'], sort: 'ttft' },
    },
  },
}

/** One roster model's call, as the spec carries it, shape-guarded. */
export interface HelperModelSpec {
  model: string
  modelPolicy: unknown
  identityNote: string | null
  tier: 'fast' | 'think' | 'strong'
}

const TIERS: ReadonlySet<string> = new Set(['fast', 'think', 'strong'])
/** A Gateway slug: `provider/model`, short, no spaces. */
const SLUG_RE = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._-]*$/
/** An identity line as modelIdentityNote writes it. */
const IDENTITY_PREFIX = 'Active model: '

/** The spec's entry for `key`, or null when absent or malformed. */
export function helperModelSpec(spec: Pick<ChatSpec, 'helperModels'> | null, key: HelperModelKey): HelperModelSpec | null {
  const all = spec?.helperModels
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null
  const entry = (all as Record<string, unknown>)[key]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const e = entry as Record<string, unknown>
  if (typeof e.model !== 'string' || e.model.length > 120 || !SLUG_RE.test(e.model)) return null
  // The tier decides only the usage row; a premium key is always `strong`.
  const tier = PREMIUM_HELPER_MODEL_KEYS.has(key) ? 'strong' : typeof e.tier === 'string' && TIERS.has(e.tier) ? (e.tier as HelperModelSpec['tier']) : 'fast'
  const identityNote =
    typeof e.identityNote === 'string' && e.identityNote.startsWith(IDENTITY_PREFIX) && e.identityNote.length < 1000 && !e.identityNote.includes('\n')
      ? e.identityNote
      : null
  return { model: e.model, modelPolicy: e.modelPolicy, identityNote, tier }
}

/** The selection for a validated entry: its slug, its policy (window capped), the spec's attribution. */
export function helperModelSelection(entry: HelperModelSpec, gatewayTelemetry: unknown): ModelSelection {
  return selectionWithPolicy(entry.model, validGatewayTelemetry(gatewayTelemetry), withChatCompactionWindowFor(entry.model, validModelPolicy(entry.modelPolicy)))
}

/** A roster key as a rule name (`flash-thinking` → `helper_flash_thinking`). */
function signalFor(key: HelperModelKey): string {
  return key === 'sonnet' ? 'strong_helper' : `helper_${key.replace(/-/g, '_')}`
}

/** The usage row's model_route for a roster helper's turn. */
export function helperModelRoute(key: HelperModelKey, entry: HelperModelSpec | null) {
  const policy = entry ? validModelPolicy(entry.modelPolicy) : null
  return {
    tier: entry?.tier ?? (PREMIUM_HELPER_MODEL_KEYS.has(key) ? 'strong' : 'fast'),
    by: 'rule',
    signals: entry ? [signalFor(key)] : [signalFor(key), 'spec_unavailable'],
    reasoning: entry ? (policy?.reasoning ?? 'adaptive') : 'high',
    model: key,
  }
}

/**
 * The model resolver of the declared helper that runs `key` (every roster
 * key but `flash`, whose plain helper keeps the main chat's resolver in the
 * helper role: ./chat-model.ts). Never throws and never returns null.
 */
export function helperModelFor(key: HelperModelKey) {
  return defineDynamic({
    events: {
      'turn.started': async (_event, ctx) => {
        const runToken = runTokenFromAuth(ctx.session.auth)
        const spec = await fetchChatSpec(runToken, turnCtxFromAuth(ctx.session.auth)).catch(() => null)
        const plan = chatGptPlanForTurn(spec, runToken)
        // Fail closed (see the header): the plan's turn guard. No step
        // resolver: one must return a model on every step, and a plan turn
        // never starts this helper.
        if (plan) {
          setTurnModelRoute(spec?.modelRoute ?? FALLBACK_CHATGPT_PLAN_ROUTE)
          return planTurnSelection(plan)
        }
        const entry = helperModelSpec(spec, key)
        setTurnModelRoute(helperModelRoute(key, entry))
        return entry ? helperModelSelection(entry, spec?.gatewayTelemetry) : FLASH_FALLBACK_SELECTION
      },
    },
  })
}

/**
 * The conversation's system prompt with `note` as its identity line in
 * place of the thread's: the spec prompt opens with an "Active model:" line
 * and a blank line (chat-run-rebuild.ts); without one, the note is
 * prepended. A null note leaves the prompt as it is.
 */
export function withIdentity(systemPrompt: string, note: string | null): string {
  if (!note) return systemPrompt
  if (systemPrompt.startsWith(IDENTITY_PREFIX)) {
    const end = systemPrompt.indexOf('\n\n')
    return end >= 0 ? `${note}${systemPrompt.slice(end)}` : note
  }
  return `${note}\n\n${systemPrompt}`
}

/**
 * The persona of the declared helper that runs `key`: the conversation's
 * stable prompt, as the main chat builds it (../instructions/persona.ts),
 * with ONE change: its identity line names this helper's model, not the
 * thread's. Prompt caches are per model anyway, so the different first line
 * costs nothing. A turn on the person's ChatGPT plan keeps the prompt as it is.
 */
export function helperPersonaFor(key: HelperModelKey) {
  return async (spec: ChatSpec | null): Promise<string> => {
    if (!spec?.systemPrompt) {
      // Thrown only to be logged: this turn runs without the persona either way, as the root's.
      throw new Error('chat spec fetch failed — this turn runs without the conversation prompt')
    }
    if (spec.chatgptPlan != null) return spec.systemPrompt
    return withIdentity(spec.systemPrompt, helperModelSpec(spec, key)?.identityNote ?? null)
  }
}
