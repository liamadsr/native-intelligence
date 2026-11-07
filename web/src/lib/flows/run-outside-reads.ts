/**
 * Did a loop's skill run read untrusted outside text? (F3: the provenance of
 * a skill or lens run's canon edits.)
 *
 * A canon edit's outside-text label (src/lib/documents/canon-sources.ts)
 * goes by what a run READ, never by what the model cites. A work run notes its outside reads on its
 * agent_run row (migration 374). A loop's skill run has no such row, so its
 * record is its own event stream, read by the server: every tool call's
 * result arrives as an `action.result` event (the call's name and output),
 * which the stream tap judges as it goes (run-skill-eve.ts, classifyToolRead)
 * and keeps as small ToolRead records. The model can't hide a call or add one.
 *
 * The judgment is the ONE definition in src/lib/safety/outside-text.ts, the
 * same a work run's tracking uses: fail closed on any tool not on its
 * internal allow-list, an internal result that carries an outside fence, a
 * search hit on mail or files, and mail from someone the person doesn't know.
 * A subagent's result counts as outside (what it read is not on this
 * stream). A run with no record (a caller that passed none) counts as
 * outside too.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyToolRead, knownOrOwnSenders, readsOutsideText, type ToolRead } from '@/lib/safety/outside-text'

export { classifyToolRead, type ToolRead }
export { toolReadOf } from '@/lib/safety/outside-text'

/** The record a subagent's result leaves: outside, whatever it says. */
export const SUBAGENT_READ: ToolRead = { tool: 'agent', outside: true }

/**
 * Whether a loop run whose stream left these reads read outside text, with
 * the mail senders checked against the run-as person's known senders and own
 * mailboxes. `undefined` (no record) fails closed. Never throws.
 */
export async function runReadOutsideText(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; reads: readonly ToolRead[] | undefined },
): Promise<boolean> {
  if (!args.reads) return true
  return readsOutsideText(args.reads, (addresses) => knownOrOwnSenders(supabase, { workspaceId: args.workspaceId, userId: args.userId, addresses }))
}
