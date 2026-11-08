import { defineAgent } from 'eve'
import { chatModel } from './lib/chat-model.js'
import { EVE_COMPACTION_THRESHOLD_PERCENT } from './lib/compaction-window.js'
import { isMacHost } from './lib/host.js'
import { macModel } from './lib/mac-model.js'

/**
 * chat-agent — Phase 4 of the eve migration (docs/plans/eve-phase4-chat.md).
 *
 * The user-facing MAIN CHAT, run as a DURABLE eve session — the only cloud chat
 * runtime (the legacy `/api/ai/chat` streamText route is gone). Driven from the
 * browser by the EveChatTransport (src/lib/chat/eve/eve-chat-transport.ts),
 * and headless by /api/device/ask as a one-shot session (one turn, read to its
 * boundary: src/lib/chat/device-ask-eve.ts) that relays the device's own token.
 *
 * Everything that varies per conversation is resolved DYNAMICALLY from the chat
 * spec (rebuilt server-side from live DB state, fetched over the internal spec
 * route with the durable chat-run token the transport minted):
 *   - the stable system prompt    → instructions/persona.ts (defineInstructions)
 *   - the per-turn context        → instructions/turn-context.ts (a user-role
 *                                   message before each user message)
 *   - the ceiling-filtered tools  → tools/workspace_tools.ts (proxies to the Next
 *                                   internal tool route; the ceiling is structural)
 *   - the model                   → the dynamic model resolver (lib/chat-model.ts)
 *
 * Mounted as a dedicated top-level agent via the `agents:` map in next.config.mjs
 * → routes at /eve/chat-agent/v1/*. Its channel authenticates the
 * app's Supabase session (or a device token) and enforces the session-ownership
 * ACL (channels/eve.ts), because it is USER-FACING — unlike the headless
 * skill-runner. No internal-secret entry: a server secret never skips the ACL.
 *
 * Model: the conversation's plan-clamped model, resolved PER TURN (turn.started)
 * so the picker works mid-conversation. The original port resolved on
 * session.started — which eve fires ONCE for the durable session — so the model
 * was pinned to whatever was selected on turn 1 and mid-conversation switches were
 * silently ignored (the same regression the instructions resolver had; see
 * instructions/persona.ts). The browser sends the current picker value on every
 * turn (base64url ctx → the spec route → rebuildChatSpec clamps + qualifies it
 * fresh), so turn.started is the resolver that actually consumes it.
 *
 * Prompt caching is NOT harmed by resolving per turn: when the model is unchanged
 * turn-to-turn the resolver returns the byte-identical model id, so the cache
 * lineage is the same and prefix hits still land — resolving per turn is a
 * no-op for caching in the common case. An actual USER-INITIATED switch re-ingests
 * the conversation at uncached prices on the new model; that is an accepted
 * tradeoff — the picker UI promises switching, and switches are user-initiated and
 * rare (not per-turn churn).
 *
 * NO maxOutputTokensPerSession spend guard: unlike the headless research /
 * skill-runner sessions (which run unattended and can't ask a human whether to
 * keep spending), main chat is INTERACTIVE and plan-clamped per turn — the user
 * is present, billing is metered upstream, and a cap would truncate a long,
 * legitimately-requested reply. Usage is metered SERVER-SIDE per turn by
 * hooks/usage-meter.ts (→ /api/internal/chat/usage), never from the browser.
 *
 * NO input budget either (`maxInputTokensPerSession: false`). Left unset, eve
 * gives every root session 40M provider-reported input tokens for its whole
 * life (DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION, cached input included).
 * Compaction keeps each call small (lib/compaction-window.ts) but never resets
 * that sum, and the main chat is one session for good: at ~100K a call it ran
 * out after a few hundred calls and parked the turn on a session-limit prompt
 * (10-27). The plan clamp and the meter above are the main chat's bounds. A
 * session-limit prompt that still arrives (the Mac body below, or one parked
 * before this) is a Continue / Stop card in the chat (session-limit-card.tsx).
 */
export default isMacHost()
  ? /**
     * The Mac body (contract C2, lib/host.ts): the same agent on the person's
     * Mac, built into the desktop bundle. Its model is the local agent's
     * (agents/local-agent/lib/model.ts, imported unchanged): the Native Intelligence model
     * relay with the session token (C1's spec names the same model), a model
     * on the Mac when the desktop chose one, or the dev key, resolved per
     * model step with its window (lib/mac-model.ts says why). Spend caps: a
     * Mac job runs unattended between messages, so the runaway bound stays;
     * at a cap eve holds the turn, and the relay meters and caps too.
     */
    defineAgent({
      model: macModel,
      limits: {
        maxOutputTokensPerSession: 150_000,
        maxTokenCostUsdPerSession: 5,
      },
      compaction: { thresholdPercent: EVE_COMPACTION_THRESHOLD_PERCENT },
    })
  : defineAgent({
      // The plan-clamped, per-turn model resolver (lib/chat-model.ts), shared with
      // the declared `helper` subagent (subagents/helper/agent.ts).
      model: chatModel,
      // No lifetime input budget: see "NO input budget" above.
      limits: { maxInputTokensPerSession: false },
      // eve's default (0.9), set explicitly: the chat's compaction windows are
      // derived from it (lib/compaction-window.ts, which also says why the window,
      // not this fraction or a separate compaction.model, carries the target).
      compaction: { thresholdPercent: EVE_COMPACTION_THRESHOLD_PERCENT },
    })
