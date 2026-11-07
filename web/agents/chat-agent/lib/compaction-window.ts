/**
 * When the main chat compacts: one target, two triggers.
 *
 * ── The target ──────────────────────────────────────────────────────────────
 * CHAT_COMPACTION_TARGET_TOKENS is the context size, the last model call's
 * whole input (system prompt, tool schemas and history, cached input
 * included), past which a chat-agent conversation is summarized. Every number
 * below derives from it.
 *
 * Why 150K. The 2026-10-15 PROD audit: a conversation's model calls grew to
 * ~185K input each and nothing compacted it until the person stopped for ten
 * minutes, with 2-9 calls per turn and turns of up to ~10 minutes. DeepSeek V4
 * Flash takes 1M tokens, but every call re-reads the whole context, so latency
 * and cost grow with it long before the window matters. A summarized chat
 * starts again at about 50-60K (the prompt and tools are ~35-45K of that), so
 * 150K leaves ~100K of working room: three to six tool-heavy turns between
 * compactions, a summary call of ~$0.01, and no call much past 150K.
 *
 * ── Trigger 1: at a turn boundary (the app) ─────────────────────────────────
 * src/lib/chat/idle-compaction.ts compacts a conversation whose last model
 * call was at least the target once it has been quiet IDLE_COMPACTION_QUIET_MS
 * (3 minutes): between turns, while the person reads, never inside a turn. Its
 * IDLE_COMPACTION_MIN_INPUT_TOKENS mirrors the target (the Next side can't
 * import agent code; lib/__tests__/compaction-window.test.ts pins the pair).
 *
 * ── Trigger 2: inside a turn (eve) ──────────────────────────────────────────
 * eve checks before EVERY model call, mid-turn included, and compacts at
 * `compaction.thresholdPercent` (0.9, set in agent.ts) of the window a model
 * selection hands it (eve 0.79.1 harness/model-call/model.js
 * updateCompactionThresholdForModelReference, harness/compaction/engine.js
 * shouldCompact, on the last call's provider-reported input plus an estimate
 * of what was added since). That
 * window is used for nothing else: eve never caps input or validates a request
 * against it; it also sizes the summary prompt's transcript budget and the
 * recent messages kept (harness/compaction/engine.js). eve first trims older
 * tool results to 2K characters (toolResultCapHeuristic, no model call) and
 * summarizes only when that is not enough.
 *
 * A mid-turn compaction rewrites the history the turn's next calls would have
 * read from cache, and can summarize this turn's own earlier tool results, so
 * eve's threshold sits above the target: CHAT_MIDTURN_COMPACTION_TOKENS, the
 * target plus half again (one heavy turn's growth). A conversation that keeps
 * going without a 3-minute pause still never passes it; one that pauses
 * compacts at the boundary first.
 *
 * Before this, the window was the shared 600K ceiling (lib/model-policy.ts
 * COMPACTION_WINDOW_TOKENS, still what work-agent, skill-runner and live-agent
 * use): a 1M model compacted at 540K, and no chat ever got there.
 *
 * ── Why a window, and not eve's other compaction knobs (eve 0.79.1) ─────────
 * `compaction.thresholdPercent` is one static fraction of whatever window the
 * selection carries, and the person picks the model per turn (200K to 1M
 * windows), so no single fraction gives one absolute target; the selection's
 * window is the only per-selection number eve takes. So the fraction stays
 * eve's 0.9, now set explicitly (agent.ts), and the window carries the target.
 *
 * `compaction.model` (a cheaper summary model) is NOT used: it is a static
 * model whose provider options come from the agent's static `modelOptions`
 * (compiler/normalize-agent-config.js), which a dynamic-model agent cannot
 * set, and eve calls it with that reference's provider options
 * (harness/compaction/step.js maybeCompact). The summary would lose the
 * selection's AI Gateway host list (`gateway.only`: the zero-data-retention,
 * no-training hosts), its per-user attribution and BYOK, on a call that reads
 * the whole conversation. The summary stays on the turn's own model and hosts.
 */
import { COMPACTION_THRESHOLD_PERCENT, compactionWindow, KNOWN_CONTEXT_WINDOWS, type ModelPolicy } from './model-policy.js'

/** The context size (a model call's whole input) past which a chat compacts. The one knob. */
export const CHAT_COMPACTION_TARGET_TOKENS = 150_000

/** eve's share of the window it compacts at: agent.ts sets `compaction.thresholdPercent` to this. */
export const EVE_COMPACTION_THRESHOLD_PERCENT = COMPACTION_THRESHOLD_PERCENT

/** eve's in-turn threshold: the target plus half again, so a turn boundary compacts first. */
export const CHAT_MIDTURN_COMPACTION_TOKENS = Math.round(CHAT_COMPACTION_TARGET_TOKENS * 1.5)

/**
 * The window handed to eve so its threshold (90% of it) is
 * CHAT_MIDTURN_COMPACTION_TOKENS: 250K. Never more than a model's real window
 * (chatCompactionWindow).
 */
export const CHAT_COMPACTION_WINDOW_TOKENS = Math.ceil(CHAT_MIDTURN_COMPACTION_TOKENS / EVE_COMPACTION_THRESHOLD_PERCENT)

/**
 * The window to hand eve for a model whose real window is
 * `contextWindowTokens`: the smaller of it and CHAT_COMPACTION_WINDOW_TOKENS,
 * so a smaller model (200K) keeps 90% of its own. Unknown stays unknown (eve
 * then uses its catalog window, or its 100K default).
 */
export function chatCompactionWindow(contextWindowTokens?: number): number | undefined {
  const real = compactionWindow(contextWindowTokens)
  return real === undefined ? undefined : Math.min(real, CHAT_COMPACTION_WINDOW_TOKENS)
}

/**
 * The chat policy for `model` with the chat's window: the policy's own window
 * when it carries one, else the model's known real window
 * (KNOWN_CONTEXT_WINDOWS), capped by chatCompactionWindow. A model of unknown
 * window keeps eve's own: handing eve 250K for a smaller model would push its
 * threshold past what the model accepts.
 */
export function withChatCompactionWindowFor(model: string, policy: ModelPolicy | null): ModelPolicy | null {
  const window = chatCompactionWindow(policy?.contextWindowTokens ?? KNOWN_CONTEXT_WINDOWS[model])
  return window ? { ...policy, contextWindowTokens: window } : policy
}

/** eve's in-turn threshold for a model whose real window is `contextWindowTokens` (undefined when unknown). */
export function chatMidturnThreshold(contextWindowTokens?: number): number | undefined {
  const window = chatCompactionWindow(contextWindowTokens)
  return window === undefined ? undefined : Math.max(1, Math.floor(window * EVE_COMPACTION_THRESHOLD_PERCENT))
}
