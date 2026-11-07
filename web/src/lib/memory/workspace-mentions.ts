/**
 * The workspace walls, held deterministically (decision 2): a fact about the
 * person follows them into EVERY workspace, so one that names a contact, a
 * company or a project of the workspace it was said in is not a profile fact.
 * "Liam prefers short updates for Acme" is about Acme's work: it stays in
 * that workspace as a personal area line.
 *
 * One SQL function (workspace_entity_mentioned, migration 328) scans the
 * workspace's contact, company and project names of at least 4 characters for
 * one inside the text, case-insensitively, and returns the first it finds.
 * Throws when it can't tell: the callers decide what an unknown means (the
 * `remember` tool refuses; the capture pass skips the item).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The workspace contact, company or project name the text mentions, or null. */
export async function mentionsWorkspaceEntities(supabase: SupabaseClient, text: string, workspaceId: string): Promise<string | null> {
  if (!text.trim() || !workspaceId) return null
  const { data, error } = await supabase.rpc('workspace_entity_mentioned', { p_workspace_id: workspaceId, p_text: text.slice(0, 2_000) })
  if (error) throw new Error(`workspace mention check: ${error.message}`)
  return typeof data === 'string' && data ? data : null
}
