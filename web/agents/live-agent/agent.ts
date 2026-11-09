import { defineAgent, defineDynamic } from 'eve'
import { chatGptPlanProxy, fetchLiveAgentSpec, modelSelectionFromSpec, runTokenFromAuth, type ModelSelection } from './lib/spec-client.js'
import { planAwareSessionModelEvents, validChatGptPlan } from './lib/chatgpt-plan-model.js'
import { COMPACTION_THRESHOLD_PERCENT } from './lib/model-policy.js'

/**
 * Live-agent — the live meeting agent on eve (LIVE-AGENT-DESIGN.md, WS-1).
 *
 * ONE one-shot session per live-agent TURN: every transcript window's copilot turn,
 * every paired notes turn, and every batch / Reprocess / eval pass is its own
 * short, stateless session created by `POST /api/ai/live-agent`. No history, no
 * cross-turn state — the capture's own rows are the system of record, re-sent in
 * each turn's message. INTERNAL-ONLY (server-to-server); see channels/eve.ts.
 *
 * Everything that varies per turn is resolved from the turn's spec, rebuilt
 * server-side from the verified run token (GET /api/internal/live-agent/spec):
 *   - the system prompt  → instructions/live-turn.ts (the route's exact 7 layers)
 *   - the tools          → tools/workspace_tools.ts (+ ask_user / say_to_user):
 *                          proxies to /api/internal/live-agent/tool, clamped to
 *                          the turn type's STRUCTURAL ceiling
 *   - the model          → the resolver below
 *
 * Mounted via the `agents:` map in next.config.mjs → /eve/live-agent/v1/*.
 *
 * Model: WHICH model is the spec's (recipe override → the workspace's
 * 'live_agent' default), addressed as a Gateway catalog slug like every other
 * Native Intelligence eve agent; valid per-user telemetry turns it into the object selection
 * form so Gateway BYOK/cost attribution reaches every generation. Resolved at
 * session.started — a live session IS one turn; step.started hands the same
 * choice back (a step resolver must return one).
 *
 * FAILS CLOSED without a spec. A turn whose spec can't be fetched has no system
 * prompt and no workspace tools: run anyway, it would bill a blind generation
 * that writes nothing — and on a batch run the route's safety net would then
 * stamp a "brief capture" fallback summary over a real meeting. So the resolver
 * THROWS, which fails the session before its first model call (eve 0.79.1: a
 * throwing model resolver fails the turn terminally — docs/guides/
 * dynamic-capabilities, "Every matching handler must return a concrete model";
 * harness/step/context.js failModelSelection). The route sees
 * session.failed with no step run, logs no usage, and answers with its error.
 * The spec is refused when the token is bad, the capture is gone / private to
 * another member, a batch names a capture the caller doesn't own, or the caller
 * has no member row in the workspace (see live-agent-spec.ts).
 *
 * No token `limits`: the cloud route has no token budget today. The per-turn
 * STEP ceiling (20 live / 50 batch) is enforced by the route when it counts
 * step.completed events. `sessionTimeoutMs`: eve 0.67+ parks every session
 * after its turn (no task mode), for 30 days by default; a live turn's session
 * is read within the route's 600 s maxDuration and never continued, so it ends
 * 15 minutes after creation.
 */
export default defineAgent({
  // The person's own ChatGPT plan (the free tier, spec.chatgptPlan): every
  // step runs on the plan model through the app's plan proxy, never the
  // Gateway (lib/chatgpt-plan-model.ts planAwareSessionModelEvents; a live
  // session is one turn, so there is no later turn to move).
  model: defineDynamic({
    events: planAwareSessionModelEvents<ModelSelection>({
      runToken: runTokenFromAuth,
      proxy: chatGptPlanProxy,
      choose: async (runToken) => {
        const spec = await fetchLiveAgentSpec(runToken)
        if (spec?.chatgptPlan !== undefined) {
          const plan = validChatGptPlan(spec.chatgptPlan)
          if (!plan) {
            throw new Error("[live-agent] the turn's spec names a ChatGPT plan this agent can't read — refusing to run it on Native Intelligence's models")
          }
          return { plan }
        }
        const selection = modelSelectionFromSpec(spec)
        if (!selection) {
          throw new Error('[live-agent] no turn spec for this session — refusing to run the turn blind')
        }
        return { selection }
      },
    }),
  }),
  limits: { sessionTimeoutMs: 15 * 60 * 1_000 },
  // eve's default (0.9), set explicitly: COMPACTION_WINDOW_TOKENS is derived
  // from it (lib/model-policy.ts, which also says why the window carries the
  // target). The summary stays on the run's own model and hosts.
  compaction: { thresholdPercent: COMPACTION_THRESHOLD_PERCENT },
})
