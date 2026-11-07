/**
 * EDITION DEFAULT AGENTS — which meeting persona drives a capture when the user
 * has not picked one.
 *
 * Today a capture with no selected agent runs the built-in `ASSISTANT_PERSONA`
 * (batch, server-side) or the seeded Interactive Assistant (live, client-side).
 * That is right for a generalist workspace and wrong for a motion-specific one:
 * a sales team's calls ARE the pipeline, and the note-taker that adapts to "any
 * conversation" is not the note-taker that qualifies a deal.
 *
 * So an edition may DECLARE a default persona per mode (`defaultAgents` in
 * src/lib/editions/manifest.ts), and this module turns that declaration into an
 * actual `recipe` row. Two layers, in precedence order:
 *
 *   1. WORKSPACE OVERRIDE — `settings.default_agents.{live,batch}` (a slug).
 *      Read-only for now: no UI and no route writes it, but the resolver honors
 *      it so the eventual settings surface is a writer and nothing else.
 *      Present-and-`null` is a deliberate "no agent" and SHORT-CIRCUITS the
 *      edition default; absent means "follow the edition". Those must stay
 *      distinguishable or a workspace could never opt out of its edition's
 *      opinion.
 *
 *   2. EDITION DEFAULT — `editionDefaultAgentSlug(edition, mode)`.
 *
 * FAIL-OPEN AT EVERY STEP (manifest invariants 1 and 2). No edition default, no
 * override, an unseeded environment, an unreadable workspace, a thrown query —
 * every one of them returns `null`, which every caller treats as "today's
 * behavior". A default agent is a PREFERENCE, and a preference must never be
 * able to block extraction. This is also why the recipe lookup is scoped to
 * SYSTEM rows (`is_system = true` AND `workspace_id IS NULL`): a workspace-local
 * recipe that happens to share a seeded slug must not be able to hijack the
 * edition's default, and the manifest's slugs name seeded rows only.
 *
 * NOT a gate. The returned recipe is used exactly as if the client had passed
 * `recipe_id` — same persona layering, same `agent_config` narrowing, same
 * model. An EXPLICIT recipe_id always wins and never reaches this module: an
 * eval run targets a specific agent, and silently substituting the edition's
 * would make every sales-workspace eval grade the wrong thing.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  editionDefaultAgentSlug,
  resolveWorkspaceEdition,
  resolveWorkspaceEditionFromSettings,
  type EditionAgentMode,
} from '@/lib/editions'
import type { AgentToolSelection } from '@/lib/live-agent/read-tool-names'

/**
 * The recipe fields a default agent contributes — exactly the three the
 * live-agent route selects for an explicitly-chosen `recipe_id`, plus the `id`
 * so callers can persist/log which persona actually ran.
 */
export interface DefaultRecipe {
  id: string
  system_prompt: string | null
  agent_config: AgentToolSelection | null
  model: string | null
}

/**
 * A workspace's per-mode default-agent override, normalized.
 *
 * Tri-state, mirroring `FeatureOverrides`: an absent key follows the edition, a
 * slug forces that agent, and an explicit `null` forces "no agent at all"
 * (today's built-in behavior) even in an edition that has an opinion.
 */
export interface DefaultAgentOverrides {
  live?: string | null
  batch?: string | null
}

/**
 * Coerce an unknown `settings.default_agents` blob into valid overrides.
 *
 * Same defensive contract as `normalizeFeatureOverrides`: garbage degrades to
 * "no override" rather than throwing. A key present with an explicit `null` is
 * PRESERVED (it is the opt-out), while a key holding a number, an object, or an
 * empty string is dropped — those express no intent.
 */
export function normalizeDefaultAgentOverrides(raw: unknown): DefaultAgentOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const src = raw as Record<string, unknown>
  const out: DefaultAgentOverrides = {}
  for (const mode of ['live', 'batch'] as const) {
    if (!(mode in src)) continue
    const value = src[mode]
    if (value === null) out[mode] = null
    else if (typeof value === 'string' && value.trim()) out[mode] = value.trim()
  }
  return out
}

/**
 * The SLUG that should drive this capture, from an already-read settings blob.
 * PURE — no I/O. `null` means "today's behavior".
 *
 * Split out so the live-agent route, which already does ONE read of
 * `workspace.settings` per turn for the trust/claims/edition policies, can
 * answer this from the same row instead of adding a fourth round-trip to a
 * route that fires every ~3 seconds during a recording.
 */
export function resolveDefaultAgentSlugFromSettings(
  settings: unknown,
  mode: EditionAgentMode,
): string | null {
  const overrides = normalizeDefaultAgentOverrides(
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>).default_agents
      : null,
  )
  // Checked BEFORE the edition default, and `in` rather than a truthiness test:
  // an explicit `null` is the workspace opting out of its edition's opinion.
  if (mode in overrides) return overrides[mode] ?? null
  return editionDefaultAgentSlug(resolveWorkspaceEditionFromSettings(settings).edition, mode)
}

/**
 * Load the SYSTEM recipe row for a slug. `null` when nothing matches — an
 * environment that has not run the seeding migration, or a slug retired from
 * the manifest without its row being dropped.
 *
 * Scoped to `is_system = true` AND `workspace_id IS NULL` so a workspace-local
 * recipe cannot shadow a seeded default by reusing its slug.
 */
export async function loadSystemRecipeBySlug(
  supabase: SupabaseClient,
  slug: string,
): Promise<DefaultRecipe | null> {
  try {
    const { data } = await supabase
      .from('recipe')
      .select('id, system_prompt, agent_config, model')
      .eq('slug', slug)
      .eq('is_system', true)
      .is('workspace_id', null)
      .limit(1)
      .maybeSingle()
    if (!data) return null
    return {
      id: data.id as string,
      system_prompt: (data.system_prompt as string | null) ?? null,
      agent_config: (data.agent_config as AgentToolSelection | null) ?? null,
      model: (data.model as string | null) ?? null,
    }
  } catch {
    return null
  }
}

export interface ResolveDefaultRecipeArgs {
  supabase: SupabaseClient
  workspaceId: string
  mode: EditionAgentMode
  /**
   * An already-read `workspace.settings` blob. Pass it when the caller has one
   * (the live-agent route reads it once per turn) to skip the extra query;
   * omit it and the workspace is read here.
   */
  settings?: unknown
}

/**
 * THE ENTRY POINT. Resolve the default meeting agent for a capture, or `null`
 * for "today's behavior".
 *
 * Never throws. Call it ONLY when the caller has no explicit `recipe_id` — an
 * explicit selection (the agent dropdown, an eval run's target) always wins and
 * must never be overridden by an edition preference.
 */
export async function resolveDefaultRecipeForCapture({
  supabase,
  workspaceId,
  mode,
  settings,
}: ResolveDefaultRecipeArgs): Promise<DefaultRecipe | null> {
  try {
    const slug =
      settings !== undefined
        ? resolveDefaultAgentSlugFromSettings(settings, mode)
        : await resolveSlugByFetching(supabase, workspaceId, mode)
    if (!slug) return null
    return await loadSystemRecipeBySlug(supabase, slug)
  } catch {
    return null
  }
}

/**
 * The fetching half, for callers with no settings blob in hand. Reads the
 * workspace ONCE: `resolveWorkspaceEdition` is itself fail-open, and the
 * override lives on the same row it already read — but its `ResolvedEdition`
 * deliberately exposes only edition state, so the raw blob is re-read here
 * rather than widening that type for one consumer. Callers on a hot path pass
 * `settings` and take neither read.
 */
async function resolveSlugByFetching(
  supabase: SupabaseClient,
  workspaceId: string,
  mode: EditionAgentMode,
): Promise<string | null> {
  const { data } = await supabase
    .from('workspace')
    .select('settings')
    .eq('id', workspaceId)
    .maybeSingle()
  if (data) return resolveDefaultAgentSlugFromSettings(data.settings, mode)
  // No row read (RLS, missing workspace): fall back to the edition resolver's
  // own fail-open path so a readable-but-different client still gets an answer.
  const resolved = await resolveWorkspaceEdition(supabase, workspaceId)
  return editionDefaultAgentSlug(resolved.edition, mode)
}

/**
 * THE END-OF-CALL HANDOFF RULE — which persona a `mode: 'batch'` run carries
 * when the capture was driven by a LIVE persona.
 *
 * The two modes are different personas by design (`EditionDefaultAgents`):
 * `sales-live` speaks to the rep mid-call, `sales-post-call` writes the finished
 * deal record. But the client's agent selection is a SINGLE value, and while
 * live mode is on the capture panel LOCKS it to the edition's live default. That
 * lock is the product's own choice, not the user's — so once the call ends, a
 * batch run that inherited it would grade the transcript with the mid-call
 * persona and never reach the post-call one the edition actually declared.
 *
 * The rule, in one line: a batch run drops an agent selection that is merely the
 * edition's LIVE default, and keeps everything else.
 *
 *   - Live default selected (the lock put it there) → resolve the edition's
 *     BATCH default from the loaded agents list; if that agent isn't in the list
 *     (unseeded environment, agents not loaded yet), return `null` so the caller
 *     sends NO `recipe_id` and the SERVER resolver picks the batch default. Both
 *     branches land on the same persona; the client one just shows the user
 *     which agent ran.
 *   - Anything else — a specialist the user picked from the dropdown, the
 *     edition's batch default already selected, or no selection at all — is
 *     returned unchanged. An explicit user pick is NEVER overridden.
 *
 * PURE and fail-open: no I/O, and every unknown input degrades to "leave the
 * selection alone", which is byte-identical to the behavior before this rule.
 */
export interface BatchHandoffAgentArgs {
  /** The currently selected agent id (the live lock's value during a live call). */
  selectedAgentId: string | null
  /** The edition's live default slug, or null when the edition has no opinion. */
  editionLiveAgentSlug: string | null
  /** The edition's batch default slug, or null when the edition has no opinion. */
  editionBatchAgentSlug: string | null
  /** The workspace's agents, as already loaded by the caller. */
  agents: ReadonlyArray<{ id: string; slug?: string | null }>
}

export function resolveBatchHandoffAgentId({
  selectedAgentId,
  editionLiveAgentSlug,
  editionBatchAgentSlug,
  agents,
}: BatchHandoffAgentArgs): string | null {
  // No selection, or an edition with no live opinion: nothing to hand off.
  if (!selectedAgentId || !editionLiveAgentSlug) return selectedAgentId
  // Is the selection the edition's LIVE default? Only then was it the lock's
  // doing rather than the user's, and only then may we replace it.
  const liveDefault = agents.find((a) => a.slug === editionLiveAgentSlug)
  if (!liveDefault || liveDefault.id !== selectedAgentId) return selectedAgentId
  // It is. Prefer the edition's batch default from the loaded list; otherwise
  // null → the caller omits recipe_id and the server resolves the same slug.
  if (!editionBatchAgentSlug) return null
  return agents.find((a) => a.slug === editionBatchAgentSlug)?.id ?? null
}

/**
 * SHOULD THE END-OF-CALL BATCH PASS RUN?
 *
 * Historically this was one condition: live mode OFF. Live mode ON meant the
 * summary had been written incrementally during the call, so a batch run would
 * only duplicate it.
 *
 * The product split (2026-09-14) makes that false in two ways:
 *
 *   1. ASSIST-ONLY live agents write NOTHING during the call — they help the
 *      person in the room and defer every note. If the batch pass does not run
 *      after them, the capture ends BLANK. This is the load-bearing case.
 *
 *   2. An edition that declares a BATCH default agent is declaring that a
 *      specific persona writes the finished record (`sales-post-call` writes the
 *      deal record). That declaration does not stop being true because live mode
 *      happened to be on — the live persona is a different agent doing a
 *      different job, and the edition named both.
 *
 * Either condition is sufficient; neither is necessary. PURE and defensive: the
 * caller reads `liveAgentAssistOnly` off an agents list that may not have loaded
 * yet, so an unknown value is treated as `false` and the result is exactly
 * today's behavior rather than a spurious second extraction.
 *
 * What it deliberately does NOT decide: WHICH persona that run carries. That is
 * the end-of-call handoff rule (`resolveBatchHandoffAgentId` / the provider's
 * `batchRecipeId`), which is unchanged — the live-lock persona is never inherited
 * by a batch run, and the server refuses an assist-only one outright.
 */
export interface ShouldRunPostLiveBatchArgs {
  /** Was live mode on for this capture? */
  liveMode: boolean
  /** Did the live agent that drove it declare `capture_mode: 'assist_only'`? */
  liveAgentAssistOnly?: boolean
  /** Does this workspace's edition (or override) name a BATCH default agent? */
  hasBatchDefault?: boolean
}

export function shouldRunPostLiveBatch({
  liveMode,
  liveAgentAssistOnly = false,
  hasBatchDefault = false,
}: ShouldRunPostLiveBatchArgs): boolean {
  // Live mode OFF: nothing was processed during the call, so the batch pass is
  // the ONLY extraction. Unconditional, exactly as before.
  if (!liveMode) return true
  // Live mode ON: run it only when something says the record still needs writing.
  return liveAgentAssistOnly || hasBatchDefault
}
