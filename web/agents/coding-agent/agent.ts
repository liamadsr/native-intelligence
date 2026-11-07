import { defineAgent, defineDynamic } from 'eve'
import { fetchEveSpec, runTokenFromAuth, validGatewayTelemetry } from './lib/spec-client.js'
import { codingModelSelection } from './lib/model-selection.js'

/**
 * Model used when the spec can't be fetched (unknown/expired token, route down).
 * Mirrors SURFACE_MODELS.coding_runs (STRONG_MODEL) in src/lib/ai/model-defaults.ts —
 * update both together.
 *
 * Since eve 0.47.7 the resolver MUST return a concrete selection: `defineDynamic`
 * accepts no `fallback` key, and a null return throws
 * `DynamicModelSelectionError`, which still fails the session terminally in eve
 * 0.79.1 (harness/step/context.js failModelSelection: MODEL_SELECTION_FAILED,
 * `terminal`). See the full citation block in agents/chat-agent/lib/chat-model.ts.
 */
const DEFAULT_CODING_MODEL = 'anthropic/claude-sonnet-5.5'

/**
 * Coding agent — Phase 3 of the eve migration (docs/plans/eve-phase3-coding-runs.md).
 *
 * The ONLY cloud coding-run runtime, for action-origin and flow-origin runs
 * alike. The eve agent IS
 * the coder: the harness bash/read_file/write_file/glob/grep tools stay LIVE and bind to an
 * authored sandbox (sandbox.ts) that clones the repo, brokers the GitHub
 * credential, and applies the network policy. There is no coding CLI and no
 * bypassPermissions — the safety boundary is sandbox isolation + the scoped
 * terminal tools (finish_run / post_progress) + the token cap.
 *
 * It is INTERNAL-ONLY (server-to-server dispatch from the Next app's Inngest
 * agentRunExecute), never browser-driven; see channels/eve.ts and lib/auth.ts.
 *
 * Everything that varies per run is resolved dynamically from the run's spec
 * (rebuilt server-side from DB state, fetched over the internal spec route):
 *   - the system prompt + task  → instructions/persona.ts (defineInstructions)
 *   - the model                 → the dynamic model resolver below
 *   - the repo / branch / env   → sandbox.ts's defineSandbox() selector
 *
 * Mounted as a dedicated top-level agent via the `agents:` map in next.config.mjs
 * → routes at /eve/coding-agent/v1/*.
 *
 * Model: the run's own model (project/agent-resolved) drives per-run. Falls back
 * to the coding_runs surface default when the spec can't be fetched. Resolved at session.started
 * (prompt caches are per model — never switch mid-session).
 *
 * Spend guard: a headless coding run can't ask a human whether to keep spending
 * (at the token limit eve 0.78+ holds the turn on a session-limit prompt that
 * nobody here answers, so the run reads as unfinished and is settled failed:
 * src/lib/agent-run/run-agent-eve.ts). Coding runs
 * are long — many bash/edit turns over a real repo — so the cap is generous
 * (~400k output tokens/session). It is the runaway BOUND, not the expected size:
 * the legacy path bounded a run by wall-clock; here the token cap plays that role
 * (harness bash has no documented output/time cap — see the design doc §grounding).
 */
export default defineAgent({
  model: defineDynamic({
    // NOTE (eve 0.47.7): no `fallback` key exists any more, and a null return is
    // no longer a soft-degrade — see DEFAULT_CODING_MODEL above and the detailed
    // ground-truth block in agents/chat-agent/agent.ts.
    events: {
      'session.started': async (_event, ctx) => {
        const runToken = runTokenFromAuth(ctx.session.auth)
        const spec = await fetchEveSpec(runToken)
        // spec.model may be a bare id ('claude-opus-4-8') or provider-qualified.
        // Mirror the gateway path: prefix 'anthropic/' when unqualified.
        // No usable model in the spec → return the default explicitly (returning
        // null would now fail the session terminally).
        if (!spec?.model) return codingModelSelection(DEFAULT_CODING_MODEL, null)
        const modelId = spec.model.includes('/') ? spec.model : `anthropic/${spec.model}`

        // Always the OBJECT selection: the compaction window is capped
        // (lib/model-selection.ts: Sonnet 5.5's 1M would compact near 900K).
        // Per-user Gateway attribution (Phase A): valid telemetry rides
        // providerOptions.gateway to every step generation via eve's
        // 'gateway-auto' merge; absent/malformed → none.
        return codingModelSelection(modelId, validGatewayTelemetry(spec.gatewayTelemetry))
      },
    },
  }),
  limits: {
    // Output is the runaway axis. 400k covers a long, multi-file coding run
    // without letting a loop run away — the token-budget analog of the legacy
    // path's wall-clock timeout.
    maxOutputTokensPerSession: 400_000,
  },
})
