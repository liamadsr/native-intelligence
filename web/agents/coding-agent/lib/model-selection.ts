/**
 * The coding agent's model selection, with its compaction window capped.
 *
 * The coding agent runs the Strong tier (Sonnet 5.5, a 1M window). Handed no
 * window, eve takes the Gateway catalog's 1M and compacts near 900K, five
 * times later than under Sonnet 4.5 (whose real window was 200K). A coding
 * run re-reads its whole history every step, so it is held to
 * CODING_COMPACTION_WINDOW_TOKENS (250K: eve compacts at 90%, about 225K,
 * close to the 4.5 behaviour). A model known to be smaller keeps its own.
 *
 * Self-contained: the eve bundler can't share code across agents (the other
 * agents' copies live in their lib/model-policy.ts).
 */
import type { GatewayTelemetry } from './spec-client.js'

export const CODING_COMPACTION_WINDOW_TOKENS = 250_000

/** Real windows of the models a coding run may name, by Gateway slug (src/lib/ai/models.ts). */
const KNOWN_WINDOWS: Readonly<Record<string, number>> = {
  'anthropic/claude-sonnet-5.5': 1_000_000,
  'anthropic/claude-sonnet-4.5': 200_000,
  'anthropic/claude-haiku-4.5': 200_000,
}

/** The window eve compacts against for `model`: the cap, or a smaller known window. */
export function codingCompactionWindow(model: string): number {
  const known = KNOWN_WINDOWS[model]
  return known ? Math.min(known, CODING_COMPACTION_WINDOW_TOKENS) : CODING_COMPACTION_WINDOW_TOKENS
}

export type CodingModelSelection = {
  model: string
  modelContextWindowTokens: number
  modelOptions?: { providerOptions: { gateway: GatewayTelemetry } }
}

/** The selection for `model`: the capped window, and the attribution when there is one. */
export function codingModelSelection(model: string, telemetry: GatewayTelemetry | null): CodingModelSelection {
  return {
    model,
    modelContextWindowTokens: codingCompactionWindow(model),
    ...(telemetry ? { modelOptions: { providerOptions: { gateway: telemetry } } } : {}),
  }
}
