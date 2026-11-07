/**
 * Has this loop skill run read outside text YET? (F4 review R2.)
 *
 * A skill run given the owner's connected apps reads them freely (plan §2.2)
 * until it has read outside text. After that, a call that could carry the
 * text out (a server outside the catalog, a URL in the input) is refused (a
 * read) or waits on the owner's card (a write): input-policy.ts rule 4.
 *
 * "Outside text" is P6's one notion (outside-text.ts). It is noted, durably
 * (skill_run_read, migration 383, keyed by the run token's runId), from both
 * places that see the run's reads:
 *   - the skill-run tool route, for every call it runs (classifyToolRead /
 *     readOutsideText with the person's known senders), before the result
 *     reaches the model;
 *   - the run's own stream (run-skill-eve.ts), for what the route never sees:
 *     eve's native web tools and subagents, noted when the model REQUESTS
 *     them (actions.requested), so the note lands before their result can
 *     reach the model, and every action.result judged outside.
 * Earlier steps of the fire count too: the token's readOutsideBefore claim.
 *
 * Every loop run notes its reads (one upsert, only when it reads outside
 * text). Two things read the flag: a run with connections (the egress rules
 * above), and a canon edit any run makes, which is labelled as resting on
 * outside text when it has (skillRunOutsideReads, canon-sources.ts). Fails
 * closed: no runId, or a failed read, counts as having read outside text.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Note that the run read outside text (idempotent; never throws). */
export async function noteRunReadOutside(
  supabase: SupabaseClient,
  ref: { runId: string | undefined; workspaceId: string; tool: string },
): Promise<void> {
  if (!ref.runId) return
  try {
    const { error } = await supabase
      .from('skill_run_read')
      .upsert({ run_id: ref.runId, workspace_id: ref.workspaceId, first_tool: ref.tool.slice(0, 200) }, { onConflict: 'run_id', ignoreDuplicates: true })
    if (error) console.warn('[skill-run-reads] could not note an outside read:', error.message)
  } catch (err) {
    console.warn('[skill-run-reads] could not note an outside read:', err instanceof Error ? err.message : String(err))
  }
}

/** Has the run read outside text (or did an earlier step)? Fails closed. */
export async function runHasReadOutside(
  supabase: SupabaseClient,
  claims: { runId?: string; readOutsideBefore?: true },
): Promise<boolean> {
  if (claims.readOutsideBefore === true) return true
  if (!claims.runId) return true
  try {
    const { data, error } = await supabase.from('skill_run_read').select('run_id').eq('run_id', claims.runId).maybeSingle()
    if (error) return true
    return !!data
  } catch {
    return true
  }
}

/** How long a canon edit waits before reading the run's record once more (a note still in flight). */
export const OUTSIDE_READ_RECHECK_MS = 250

/**
 * What outside text the run has read so far, for a canon edit's label: whether
 * any (runHasReadOutside's rule, failing closed), and the first tool that
 * brought some when it is on record. The stream notes an eve-native tool
 * (web_search, web_fetch, a subagent) when the model asks for it, without
 * waiting on the write, so an edit asked for in the same breath could read
 * the record before that note lands: with no row, it reads once more after
 * `recheckMs`. Never throws.
 */
export async function skillRunOutsideReads(
  supabase: SupabaseClient,
  claims: { runId?: string; readOutsideBefore?: true },
  recheckMs = OUTSIDE_READ_RECHECK_MS,
): Promise<{ read: boolean; tools: string[] }> {
  if (!claims.runId) return { read: true, tools: [] }
  const readRow = async (): Promise<{ read: boolean; tools: string[] } | null> => {
    const { data, error } = await supabase.from('skill_run_read').select('first_tool').eq('run_id', claims.runId as string).maybeSingle()
    if (error) return { read: true, tools: [] }
    if (!data) return null
    const first = (data as { first_tool?: unknown }).first_tool
    return { read: true, tools: typeof first === 'string' && first ? [first] : [] }
  }
  try {
    const now = await readRow()
    if (now) return now
    // An earlier step of the fire read outside text: no need to wait for this one's note.
    if (claims.readOutsideBefore === true) return { read: true, tools: [] }
    await new Promise((resolve) => setTimeout(resolve, recheckMs))
    return (await readRow()) ?? { read: false, tools: [] }
  } catch {
    return { read: true, tools: [] }
  }
}

/** Tool names whose request alone means outside text is coming (the route never sees their calls). */
export const NATIVE_OUTSIDE_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch', 'agent', 'bash'])
