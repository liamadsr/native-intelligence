/**
 * The main chat's model resolver, one per role: the root agent's (../agent.ts)
 * and its declared `helper` subagent's (../subagents/helper/agent.ts, A4 quick
 * helpers). Both read the same spec. The root runs the spec's model (MAIN_MODEL,
 * Haiku 5.5, src/lib/ai/models.ts); the plain helper runs the roster's `flash`
 * entry (the spec's `helperModels.flash`: DeepSeek V4 Flash, thinking on, on
 * its private hosts; ./helper-models.ts), never the thread's model. On the
 * person's ChatGPT plan (./chatgpt-plan-model.ts) the root runs the plan's
 * model and the helper the plan's lighter one. The other roster helpers have
 * their own resolver (./helper-models.ts helperModelFor).
 *
 * A static declared subagent may carry a dynamic model (eve 0.66.3); a
 * `defineDynamic` SUBAGENT may not, so the helper's agent.ts stays a plain
 * defineAgent whose `model` is this value. The per-turn selection state below
 * is durable SESSION state, so a helper's child session keeps its own.
 */
import { defineDynamic } from 'eve'
import { browserDispatchSelection } from './browser-dispatch-model.js'
import { browserPermissionHandoffSelection, resetBrowserPermissionHandoff } from './browser-permission-handoff.js'
import { CHAT_COMPACTION_WINDOW_TOKENS } from './compaction-window.js'
import {
  FALLBACK_CHATGPT_PLAN_ROUTE,
  chatGptPlanForTurn,
  planSearchStepSelection,
  planStepModelId,
  planTurnSelection,
  turnChatGptPlan,
  type ChatGptPlan,
} from './chatgpt-plan-model.js'
import { setTurnModelRoute } from './turn-model-route.js'
import { turnModelSelection } from './turn-model-selection.js'
import { FLASH_FALLBACK_SELECTION, helperModelRoute, helperModelSelection, helperModelSpec } from './helper-models.js'
import {
  chatGptPlanProxy,
  fetchChatSpec,
  modelSelectionFromSpec,
  runTokenFromAuth,
  turnCtxFromAuth,
  type ChatSpec,
  type ModelSelection,
} from './spec-client.js'

/**
 * The selection the main chat falls back to when the spec carries no usable model.
 *
 * Mirrors the thread's own model (MAIN_MODEL, Haiku 5.5, src/lib/ai/models.ts)
 * with its chat policy, DEFAULT_CHAT_POLICY: no reasoning parameter (adaptive
 * thinking), and its context window capped at CHAT_COMPACTION_WINDOW_TOKENS as
 * modelSelectionFromSpec caps it. Without the window eve would download the
 * Gateway catalog per session. No Gateway attribution: that rides the spec
 * that failed to arrive. A turn on the person's ChatGPT plan never falls here:
 * the run token says so (chatGptPlanForTurn). Update all three together;
 * lib/__tests__/model-turn-fresh.test.ts fails when they drift.
 *
 * The plain helper's fallback is Flash (FLASH_FALLBACK_SELECTION,
 * ./helper-models.ts): a helper never falls to the thread's model.
 *
 * Under eve 0.47.7 the resolver MUST return a concrete selection —
 * there is no compiled `fallback` key and no null-return escape hatch — so this
 * constant is the in-resolver replacement for what the framework used to
 * supply. See the failure-semantics block in the resolver below.
 */
export const FALLBACK_SELECTION: ModelSelection = {
  model: 'anthropic/claude-haiku-5.5',
  modelContextWindowTokens: CHAT_COMPACTION_WINDOW_TOKENS,
}

/** The usage row's model_route when the spec failed to arrive: Fast, fixed. */
const FALLBACK_ROUTE = { tier: 'fast', by: 'fixed', signals: ['spec_unavailable'], reasoning: 'adaptive' }

/**
 * Whether a run token's turn runs Flash, not the thread's Haiku: a device ask
 * (`surface: 'device_ask'`, a quick answer someone waits on) or a guest's turn
 * (`guestId`, src/lib/guests/guest-spec.ts). Read WITHOUT the secret, as
 * chatgptPlanFromRunToken reads its claim: it only picks the spec-outage
 * fallback, and a forged claim can only make that fallback cheaper.
 */
export function flashTurnFromRunToken(runToken: string): boolean {
  const dot = runToken.indexOf('.')
  if (dot <= 0) return false
  try {
    const claims = JSON.parse(Buffer.from(runToken.slice(0, dot), 'base64url').toString('utf8')) as { surface?: unknown; guestId?: unknown } | null
    return !!claims && (claims.surface === 'device_ask' || (typeof claims.guestId === 'string' && claims.guestId !== ''))
  } catch {
    return false
  }
}

/** The main chat's spec-outage fallback for this token: Haiku 5.5, or Flash for a device ask or a guest's turn. */
function fallbackFor(runToken: string): ModelSelection {
  return flashTurnFromRunToken(runToken) ? FLASH_FALLBACK_SELECTION : FALLBACK_SELECTION
}

/**
 * A role's Gateway selection from the spec, with its usage route: the root's
 * is the spec's model (null when it carries none: the caller falls back); the
 * plain helper's, the roster's `flash` entry, else Flash's fallback.
 */
function roleSelection(role: 'main' | 'helper', spec: ChatSpec | null): { selection: ModelSelection; route: unknown } | null {
  if (role === 'helper') {
    const entry = helperModelSpec(spec, 'flash')
    return { selection: entry ? helperModelSelection(entry, spec?.gatewayTelemetry) : FLASH_FALLBACK_SELECTION, route: helperModelRoute('flash', entry) }
  }
  const selection = modelSelectionFromSpec(spec)
  return selection ? { selection, route: spec?.modelRoute ?? null } : null
}

// Serializable per-turn selection survives memo expiry and process changes.
// A later model step must never silently switch Max to Light on a spec outage.
// (./turn-model-selection.ts: the tool dispatch reads the turn's model there.)

function eventTurnId(event: unknown): string {
  if (!event || typeof event !== 'object' || !('data' in event)) return ''
  const data = event.data
  return data && typeof data === 'object' && 'turnId' in data && typeof data.turnId === 'string' ? data.turnId : ''
}

/**
 * A step on the person's ChatGPT plan (./chatgpt-plan-model.ts): the live
 * plan model, or the browser permission handoff's local reply (named as the
 * plan model, so the meter keeps the turn on the plan). Never the browser
 * dispatch adapter, a Gateway model. The plan model is the search one, so
 * the chat's `web_search` is OpenAI's own on the person's plan, as Exa is on
 * a Gateway turn; the usage meter reports its `openai/<model>` steps under
 * the plan's name (planReportModelId).
 */
function planStep(plan: ChatGptPlan, runToken: string, role: 'main' | 'helper', event: unknown, messages: readonly unknown[]) {
  const named = { ...planTurnSelection(plan), model: planStepModelId(role === 'helper' ? plan.helperModel : plan.model) }
  return browserPermissionHandoffSelection(named, eventTurnId(event), event, messages) ?? planSearchStepSelection(plan, chatGptPlanProxy(runToken), role)
}

/**
 * The resolver for the main chat (`main`) or its quick helper (`helper`): the
 * same spec, the same choices, except that a turn on the person's ChatGPT
 * plan runs a helper on the plan's lighter model. eve's resolve context names
 * no parent session, so the role is fixed per agent.
 */
function chatModelFor(role: 'main' | 'helper') {
  return defineDynamic({
    // NOTE (eve 0.47.7): there is NO `fallback` key any more — see the block on
    // the resolver below. The compiled-default safety net this config used to
    // lean on is gone, so the resolver itself must always return a concrete
    // model; FALLBACK_SELECTION above is the in-resolver replacement for it.
    events: {
      // Resolves the plan-clamped model ONCE PER TURN so a mid-conversation picker
      // switch takes effect (parity with the instructions resolver — persona.ts).
      'turn.started': async (event, ctx) => {
        resetBrowserPermissionHandoff(eventTurnId(event))
        const runToken = runTokenFromAuth(ctx.session.auth)
        const turnCtx = turnCtxFromAuth(ctx.session.auth)
        const spec = await fetchChatSpec(runToken, turnCtx)
        // The person's own ChatGPT plan (the free tier): the spec's, or, on a
        // spec outage, the run token's word for it. Never a Gateway model.
        const plan = chatGptPlanForTurn(spec, runToken)
        turnChatGptPlan.update(() => plan)
        if (plan) {
          const planSelection = planTurnSelection(plan)
          turnModelSelection.update(() => planSelection)
          setTurnModelRoute(spec?.modelRoute ?? FALLBACK_CHATGPT_PLAN_ROUTE)
          return planSelection
        }
        // Provider-qualification + per-turn Gateway attribution live in the pure,
        // unit-tested modelSelectionFromSpec (lib/spec-client.ts). null → no usable
        // model in this spec (fetch failed or spec carried no model). The plain
        // helper always gets one (roleSelection: Flash at worst).
        const chosen = roleSelection(role, spec)
        if (chosen === null) {
          // ── Failure semantics: RETURN the default — never throw, never null ────
          // GROUND TRUTH RE-VERIFIED FOR eve 0.47.7 (was 0.27.0). Both halves of
          // the old parity argument below are now FALSE; this branch was rewritten,
          // not just re-cited.
          //
          // 1. There is no compiled `fallback` any more. defineDynamic's input type
          //    is `{ build?, events }` only — dist/src/public/definitions/agent.d.ts
          //    `DefineDynamicAgent`. The old `fallback` key is a compile error, and
          //    with it went the "snap to the compiled default" safety net.
          // 2. A throw and a null return are no longer swallowed. In
          //    dist/src/context/dynamic-model-lifecycle.js, dispatchDynamicModelEvent
          //    now wraps the catch as `throw isDynamicModelSelectionError(e) ? e :
          //    new DynamicModelSelectionError(e)` — it RETHROWS rather than
          //    log-and-skip. And a null/undefined selection never reaches the
          //    context at all: resolveRuntimeModelSelection
          //    (dist/src/runtime/agent/resolve-model.js) opens with
          //    `if (e.selection === null || e.selection === void 0) throw Error(
          //    'Dynamic model resolver returned no model. Every matching dynamic
          //    model handler must return a concrete model selection.')`.
          //
          // Where that error lands is the reason this matters. Still true in eve
          // 0.79.1: harness/step/context.js failBoundaryEvent catches it via
          // isDynamicModelSelectionError and calls `failModelSelection`, which
          // logs "model selection failed terminally" and fails the turn with
          // code MODEL_SELECTION_FAILED and `terminal` set, so `turn.failed`
          // (`terminal: true`) is followed by `session.failed`: the session is
          // dead and no follow-up is possible on it.
          //
          // So a throw here would KILL the durable chat session on a
          // transient spec outage — the exact opposite of the soft-degrade this
          // branch was written to get. We therefore return FALLBACK_SELECTION
          // explicitly: the app's cheap default model with its chat policy. The
          // turn still runs, and the next turn self-heals when the spec route
          // recovers.
          //
          // Unchanged from 0.27.0: the resolve context still exposes only
          // session/channel/messages, not the previous model reference, so a
          // resolver still CANNOT re-return last turn's model to preserve it.
          // A device ask or a guest's turn falls to Flash, as its spec would
          // have run it (fallbackFor), never to the thread's Haiku.
          const fallback = fallbackFor(runToken)
          turnModelSelection.update(() => fallback)
          setTurnModelRoute(fallback === FALLBACK_SELECTION ? FALLBACK_ROUTE : { ...FALLBACK_ROUTE, reasoning: 'high' })
          return fallback
        }
        turnModelSelection.update(() => chosen.selection)
        setTurnModelRoute(chosen.route)
        return chosen.selection
      },
      // Eve accepts a live LanguageModel only at step scope. The cached spec
      // keeps the user's selection and privacy policy identical to this turn;
      // the adapter only intervenes when a browser tool stream runs away.
      //
      // A turn on the person's ChatGPT plan runs every step on the live plan
      // model, from the plan the turn saved (durable, ids only).
      'step.started': async (event, ctx) => {
        const runToken = runTokenFromAuth(ctx.session.auth)
        const savedPlan = turnChatGptPlan.get()
        if (savedPlan) return planStep(savedPlan, runToken, role, event, ctx.messages)
        const saved = turnModelSelection.get()
        if (saved) return browserPermissionHandoffSelection(saved, eventTurnId(event), event, ctx.messages) ?? browserDispatchSelection(saved, event, ctx.messages)
        const spec = await fetchChatSpec(runToken, turnCtxFromAuth(ctx.session.auth))
        const plan = chatGptPlanForTurn(spec, runToken)
        turnChatGptPlan.update(() => plan)
        if (plan) {
          turnModelSelection.update(() => planTurnSelection(plan))
          return planStep(plan, runToken, role, event, ctx.messages)
        }
        const selected = roleSelection(role, spec)?.selection ?? fallbackFor(runToken)
        turnModelSelection.update(() => selected)
        return browserPermissionHandoffSelection(selected, eventTurnId(event), event, ctx.messages) ?? browserDispatchSelection(selected, event, ctx.messages)
      },
    },
  })
}

/** The main chat's model (../agent.ts). */
export const chatModel = chatModelFor('main')

/** The plain helper's model (../subagents/helper/agent.ts): the roster's `flash`, with a plan turn on the plan's helper model. */
export const helperChatModel = chatModelFor('helper')
