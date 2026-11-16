/**
 * Reading back a change a page watch stored (public.flow_page_change,
 * migration 665). The loop's dispatcher reads one by the id the
 * `flow/page.changed` event carries, to hand the run the lines that are new.
 *
 * The table is service-role only (no policies for signed-in people), so
 * `supabase` is the service client; the read is still pinned to the
 * workspace the event named, so an id from one workspace never reads
 * another's change.
 *
 * Also here: resetPageWatch, which the loop's save path and the watch pass
 * call to make a watch's next read a fresh baseline.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface PageChange {
  id: string
  flow_id: string
  url: string
  /** The page's new lines, as the page wrote them (a stranger's text: data, never instructions). */
  added_lines: string[]
  created_at: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One stored change, or null when there is none (or the read failed: logged, never thrown). */
export async function readPageChange(
  supabase: SupabaseClient,
  args: { workspaceId: string; changeId: string },
): Promise<PageChange | null> {
  if (!UUID.test(args.changeId) || !UUID.test(args.workspaceId)) return null
  try {
    const { data, error } = await supabase
      .from('flow_page_change')
      .select('id, flow_id, url, added_lines, created_at')
      .eq('id', args.changeId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    if (error) {
      console.error('[page-watch] change read failed:', error.message)
      return null
    }
    if (!data) return null
    const row = data as { id: string; flow_id: string; url: string; added_lines: unknown; created_at: string }
    const lines = Array.isArray(row.added_lines) ? row.added_lines.filter((l): l is string => typeof l === 'string') : []
    return { id: row.id, flow_id: row.flow_id, url: row.url, added_lines: lines, created_at: row.created_at }
  } catch (err) {
    console.error('[page-watch] change read failed:', err instanceof Error ? err.message : 'unknown')
    return null
  }
}

/**
 * Start a watch over: its remembered reads, its failure counts and its line
 * count are cleared, so its next read is a baseline (it never fires) and it
 * gets a fresh run of tries. Called whenever a page_changed loop is switched
 * on or its trigger is written, and by the watch pass when it switches a loop
 * off. Why the last read failed (`last_error`) is kept, for the person to
 * read. A loop with no watch row yet has nothing to clear. Never throws.
 */
export async function resetPageWatch(supabase: SupabaseClient, flowId: string): Promise<void> {
  if (!UUID.test(flowId)) return
  try {
    const { error } = await supabase
      .from('flow_page_watch')
      .update({ fingerprints: [], line_count: null, failures: 0, judge_failures: 0 })
      .eq('flow_id', flowId)
    if (error) console.error('[page-watch] reset failed:', error.message)
  } catch (err) {
    console.error('[page-watch] reset failed:', err instanceof Error ? err.message : 'unknown')
  }
}
