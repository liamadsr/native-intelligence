import { defineAgent, defineDynamic } from 'eve'
import { chatGptPlanProxy, fetchEveSpec, isLaterTurnRunToken, runTokenFromAuth, validGatewayTelemetry } from './lib/spec-client.js'
import { planAwareSessionModelEvents, validChatGptPlan } from './lib/chatgpt-plan-model.js'
import { COMPACTION_THRESHOLD_PERCENT, selectionWithPolicy, validModelPolicy, withCompactionWindowFor, type ModelSelection } from './lib/model-policy.js'

/**
 * Thrown by the model resolver when the run's spec can't be fetched. Without a
 * spec the session has only the standing contract (instructions.md): no
 * workspace prompt (instructions/persona.ts) and no workspace tools
 * (tools/workspace_tools.ts), yet finish_work and request_user_input still
 * work. Run anyway, it bills a blind generation that can settle the run
 * "completed" with a summary of work it never did (filing the work_run_ready
 * notification), or park it on a question asked without context. A throwing
 * model resolver fails the session before its first model call (eve 0.79.1: "A
 * missing, invalid, or throwing selection fails the turn before model-dependent
 * work begins", docs/guides/dynamic-capabilities.md; harness/step/context.js
 * failModelSelection makes it terminal: turn.failed with `terminal: true`, then
 * session.failed). run-work-eve.ts settles the run
 * failed with this message. eve may run this handler again when a parked turn
 * resumes; a resume or follow-up chat mints a fresh run token, and the spec
 * route serves the run in any status, so that re-run still finds its spec.
 */
const NO_SPEC = '[work-agent] no run spec for this session (its prompt and tools could not be loaded) — refusing to run the work blind'

/** Thrown when the spec names a ChatGPT plan this agent can't read: never fall back to a model Native Intelligence pays for. */
const BAD_PLAN = "[work-agent] the run's spec names a ChatGPT plan this agent can't read — refusing to run it on Native Intelligence's models"

/**
 * Work-agent — the executor for approved work proposals (Loops v3,
 * docs/loop-engine/WORK-PROPOSALS-DESIGN.md).
 *
 * Runs ONE user-approved piece of workspace WORK as a durable eve session:
 * draft an email, prepare a document, update the board. It is INTERNAL-ONLY
 * (server-to-server dispatch from the Next app), never browser-driven; see
 * channels/eve.ts and lib/auth.ts.
 *
 * Everything that varies per run is resolved dynamically from the run's spec
 * (rebuilt server-side from the agent_run row, fetched over the internal work-run
 * spec route):
 *   - the system prompt         → the run-as user's base workspace prompt +
 *                                 instructions/persona.ts, layered on the standing
 *                                 contract in instructions.md.
 *   - the ceiling-filtered tools → tools/workspace_tools.ts (proxies to the Next
 *                                 internal work-run tool route; the ceiling is
 *                                 the registry tools classified read /
 *                                 internal-write by their required sideEffect
 *                                 — computeWorkRunCeiling; structural,
 *                                 enforced server-side twice).
 *   - the model                 → the dynamic model resolver below.
 *
 * Mounted as a dedicated top-level agent via the `agents:` map in next.config.mjs
 * → routes at /eve/work-agent/v1/*.
 *
 * Model: the run's tier (auto model selection: agent_run.model_tier, Think
 * when unset, Strong on STRONG_MODEL), carried on the spec. FAILS CLOSED without a spec (see NO_SPEC above). Resolved at
 * session.started (prompt caches are per model — never switch
 * mid-session), carrying per-user Gateway attribution; turn.started and
 * step.started hand the same choice back (a step resolver must return one).
 *
 * Spend guard: nobody is watching a work run to grant more budget (at the token
 * limit eve 0.78+ holds the turn on a session-limit prompt), so cap output per
 * session — generous for a substantive draft/doc, not a runaway.
 */
export default defineAgent({
  // The person's own ChatGPT plan (the free tier, spec.chatgptPlan): every
  // step runs on the plan model through the app's plan proxy, never the
  // Gateway; a resume or follow-up chat moves a session onto the plan once its
  // person is on it (lib/chatgpt-plan-model.ts planAwareSessionModelEvents).
  model: defineDynamic({
    events: planAwareSessionModelEvents<ModelSelection>({
      runToken: runTokenFromAuth,
      proxy: chatGptPlanProxy,
      isLaterTurn: isLaterTurnRunToken,
      choose: async (runToken) => {
        const spec = await fetchEveSpec(runToken)
        if (!spec?.model) throw new Error(NO_SPEC)
        if (spec.chatgptPlan !== undefined) {
          const plan = validChatGptPlan(spec.chatgptPlan)
          if (!plan) throw new Error(BAD_PLAN)
          return { plan }
        }
        // spec.model is already provider-qualified by the rebuild; mirror the
        // skill-runner's defensive prefixing for a bare id.
        const modelId = spec.model.includes('/') ? spec.model : `anthropic/${spec.model}`

        // Per-user Gateway attribution (Phase A). Valid telemetry → OBJECT model
        // selection so providerOptions.gateway reaches every step generation via
        // eve's 'gateway-auto' merge. Absent/malformed → plain string.
        // The spec's modelPolicy (DeepSeek: thinking on, private hosts) adds its
        // reasoning, window, provider options and host routing beside it. The
        // window is capped at COMPACTION_WINDOW_TOKENS, the safety ceiling, so a
        // 1M model compacts at 540K like chat, not 900K (lib/model-policy.ts).
        return {
          selection: selectionWithPolicy(
            modelId,
            validGatewayTelemetry(spec.gatewayTelemetry),
            withCompactionWindowFor(modelId, validModelPolicy(spec.modelPolicy)),
          ),
        }
      },
    }),
  }),
  limits: {
    // Output is the runaway axis. 64k comfortably covers a long doc or a detailed
    // email draft + board updates without letting a run away.
    maxOutputTokensPerSession: 64_000,
  },
  // eve's default (0.9), set explicitly: COMPACTION_WINDOW_TOKENS is derived
  // from it (lib/model-policy.ts, which also says why the window carries the
  // target). The summary stays on the run's own model and hosts.
  compaction: { thresholdPercent: COMPACTION_THRESHOLD_PERCENT },
})
