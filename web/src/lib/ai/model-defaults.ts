/**
 * The fixed model of every AI surface other than the main chat's turns.
 *
 * Nobody picks a model any more (Liam, 2026-10-15): Settings → AI Models, the
 * composer's picker, the flow model pin and the live-agent recipe's model are
 * gone, and `workspace.settings.ai_models` is no longer read (the data stays,
 * inert). What used to be ten per-workspace choices is one constant per
 * surface:
 *
 *   - Flash (DEFAULT_MODEL) wherever a person waits or the work is routine:
 *     the live agent, the desktop quick ask, drafts and titles, the knowledge
 *     graph. Loops, flows and background helpers run Flash too, at the tier
 *     their run carries (src/lib/ai/model-route.ts: Think by default).
 *   - STRONG_MODEL where the work needs it technically: coding runs (the
 *     coding agent runs Anthropic models) and document ingest (it sends the
 *     PDF itself, so the model must read PDFs).
 *
 * The main chat's model is the turn's tier (routeChatTurn), never a surface
 * constant: the home thread runs Fast or Think on Flash and never switches.
 *
 * The eve agents under /agents cannot import from src, so each keeps a literal
 * spec-fetch-failure fallback that mirrors its surface model here. When one
 * changes, update the matching agent constant too (the drift tests name them).
 */

import { DEFAULT_MODEL, STRONG_MODEL, gatewayModelSlug } from './models'

export const SURFACE_MODELS = {
  live_agent: DEFAULT_MODEL,
  device_ask: DEFAULT_MODEL,
  skill_runs: DEFAULT_MODEL,
  work_agent: DEFAULT_MODEL,
  knowledge: DEFAULT_MODEL,
  drafting: DEFAULT_MODEL,
  document_ingest: STRONG_MODEL,
  coding_runs: STRONG_MODEL,
} as const

export type ModelSurface = keyof typeof SURFACE_MODELS

/** The bare app model id a surface runs on. */
export function surfaceModel(surface: ModelSurface): string {
  return SURFACE_MODELS[surface]
}

/** The Gateway catalog slug a surface runs on. */
export function surfaceModelSlug(surface: ModelSurface): string {
  return gatewayModelSlug(SURFACE_MODELS[surface])
}
