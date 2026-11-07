import { defineAgent, defineDynamic } from 'eve'
import { chatGptPlanProxy, fetchEveSpec, isChatRunToken, runTokenFromAuth, validGatewayTelemetry } from './lib/spec-client.js'
import { planAwareSessionModelEvents, validChatGptPlan } from './lib/chatgpt-plan-model.js'
import { COMPACTION_THRESHOLD_PERCENT, selectionWithPolicy, validModelPolicy, withCompactionWindowFor, type ModelSelection } from './lib/model-policy.js'

/**
 * Thrown by the model resolver when the run's spec can't be fetched. Without a
 * spec the session has no system prompt (instructions/persona.ts) and no
 * workspace tools (tools/workspace_tools.ts): run anyway, it bills a blind
 * generation that answers the bare task message from nothing, and the loop
 * engine delivers that as the skill's output (a "Morning Brief" document built
 * from no workspace data, recorded as a success). A throwing model resolver
 * fails the session before its first model call (eve 0.79.1: "A missing,
 * invalid, or throwing selection fails the turn before model-dependent work
 * begins", docs/guides/dynamic-capabilities.md, and harness/step/context.js
 * failModelSelection makes that failure terminal), with this message on its
 * session.failed event, which run-skill-eve.ts puts on the failed run. The
 * persona and tool resolvers can't do this for themselves: a throwing
 * instructions resolver is skipped, not fatal.
 */
const NO_SPEC = '[skill-runner] no run spec for this session (its prompt and tools could not be loaded) — refusing to run the skill blind'

/** Thrown when the spec names a ChatGPT plan this agent can't read: never fall back to a model Dial8 pays for. */
const BAD_PLAN = "[skill-runner] the run's spec names a ChatGPT plan this agent can't read — refusing to run it on Dial8's models"

/**
 * Skill-runner agent — Phase 2 of the eve migration (docs/plans/eve-migration-plan.md).
 *
 * Runs the loop engine's HEADLESS run_skill jobs (recipe rows, category 'skill')
 * as durable one-shot eve sessions (one turn, read to its boundary) — the eve
 * counterpart of run-skill.ts's gateway
 * `generateText` branch. It is INTERNAL-ONLY (server-to-server dispatch from the
 * Next app), never browser-driven; see channels/eve.ts and lib/auth.ts.
 *
 * Everything that varies per run is resolved dynamically from the run's spec
 * (rebuilt server-side from DB state, fetched over the internal spec route):
 *   - the system prompt        → instructions/persona.ts (defineInstructions)
 *   - the ceiling-filtered tools → tools/workspace_tools.ts (proxies to the Next
 *                                  internal tool route; the ceiling is structural)
 *   - the model                → the dynamic model resolver below
 *
 * Mounted as a dedicated top-level agent via the `agents:` map in next.config.mjs
 * → routes at /eve/skill-runner/v1/*.
 *
 * Model: the run's own model (recipe/config-resolved, gateway string id) drives
 * per-run. FAILS CLOSED without a spec (see NO_SPEC above). Resolved at
 * session.started (prompt caches are per model — never switch mid-session);
 * turn.started and step.started hand the same choice back (a step resolver
 * must return one).
 *
 * Step budget: 12 model steps, main's `stopWhen: isStepCount(12)`. eve has NO
 * step-count limit of its own (its session limits below are token/cost
 * budgets), so the cap is enforced twice: hooks/step-cap.ts cancels the turn
 * on the 13th step.started before that model call runs, and the server
 * (src/lib/flows/run-skill-eve.ts, SKILL_RUN_MAX_STEPS) stops reading there,
 * cancels, and delivers what the 12 steps produced. Both constants are pinned
 * equal by a test.
 *
 * Spend guard: a headless run can't ask a human whether to keep spending (at
 * the token limit eve 0.78+ holds the turn on a session-limit prompt nobody
 * answers; run-skill-eve.ts reads the held turn as the run's failure), so
 * cap output and input per session — generous for a report/verdict run, not a
 * runaway. No cost cap: under BYOK eve reports a step's cost as 0, so a dollar
 * limit would never trip there.
 */
export default defineAgent({
  // The person's own ChatGPT plan (the free tier, spec.chatgptPlan): every
  // step runs on the plan model through the app's plan proxy, never the
  // Gateway; a follow-up chat moves a session onto the plan once its person is
  // on it (lib/chatgpt-plan-model.ts planAwareSessionModelEvents).
  model: defineDynamic({
    events: planAwareSessionModelEvents<ModelSelection>({
      runToken: runTokenFromAuth,
      proxy: chatGptPlanProxy,
      isLaterTurn: isChatRunToken,
      choose: async (runToken) => {
        const spec = await fetchEveSpec(runToken)
        if (!spec?.model) throw new Error(NO_SPEC)
        if (spec.chatgptPlan !== undefined) {
          const plan = validChatGptPlan(spec.chatgptPlan)
          if (!plan) throw new Error(BAD_PLAN)
          return { plan }
        }
        // spec.model is already provider-qualified server-side (skill-run-rebuild.ts
        // returns `${provider}/${id}`, mirroring the chat path). The 'anthropic/'
        // prefix branch below is now a LEGACY fallback only — kept in case a bare id
        // ever arrives (matches agents/chat-agent).
        const modelId = spec.model.includes('/') ? spec.model : `anthropic/${spec.model}`

        // Per-user Gateway attribution (Phase A). Valid telemetry → OBJECT model
        // selection so providerOptions.gateway reaches every step generation via
        // eve's 'gateway-auto' merge. Absent/malformed → plain string as before.
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
    // Output is the runaway axis. 64k comfortably covers a long report or a
    // full verdict-ledger run without letting a loop run away.
    maxOutputTokensPerSession: 64_000,
    // Input is re-sent every step: 12 steps over a large context pack plus tool
    // results stays well under this; the framework default is 40M.
    maxInputTokensPerSession: 2_000_000,
  },
  // eve's default (0.9), set explicitly: COMPACTION_WINDOW_TOKENS is derived
  // from it (lib/model-policy.ts, which also says why the window carries the
  // target). The summary stays on the run's own model and hosts.
  compaction: { thresholdPercent: COMPACTION_THRESHOLD_PERCENT },
})
