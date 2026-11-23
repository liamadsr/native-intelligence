/**
 * RECENT's direct reads (docs/plans/recent-panel.md): what the person did
 * themselves to records the activity log (entity_activity, 488) doesn't
 * hold, read from each kind's own table. The home panel merges these with the
 * feed's two lists (the Inbox and actor=me), which keep coming from
 * GET /api/account/feed. The one reader behind GET /api/account/recents.
 *
 * SESSION CLIENT ONLY, as feed.ts: every read goes through the viewer's own
 * RLS, and each source's rows are about the viewer's own doing
 * (`user_id = me`), so nothing here widens who sees a record:
 *   Files   their Drive uploads (attachments, `drive_upload`, 709): the
 *           attachment's own policies (493, 708/709's restrictive Drive
 *           fence) decide; a file since deleted drops.
 *   Agents  their coding jobs (local_agent_session, 410: own rows only),
 *           titled by what they asked for.
 * Fail-soft per source: one that can't be read is left out (and logged), the
 * others still answer. Flat cost: one indexed read per source, in parallel.
 *
 * Opening something is not a doing (decision 2 in the plan): no source reads opens.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { firstLineTitle, type RecentSourceEntry } from './recents-model'

export interface RecentsViewer {
  workspaceId: string
  userId: string
  memberId: string
}

/** The most rows one source answers. */
export const RECENTS_SOURCE_MAX = 50

type Source = (supabase: SupabaseClient, viewer: RecentsViewer) => Promise<RecentSourceEntry[]>

const clean = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')

/** Their Drive uploads, newest first. */
export const driveUploads: Source = async (supabase, viewer) => {
  const { data, error } = await supabase
    .from('attachments')
    .select('id, file_name, created_at')
    .eq('workspace_id', viewer.workspaceId)
    .eq('user_id', viewer.userId)
    .eq('drive_upload', true)
    .order('created_at', { ascending: false })
    .limit(RECENTS_SOURCE_MAX)
  if (error) throw new Error(`drive uploads: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; file_name: string | null; created_at: string }>).map((r) => ({
    type: 'attachment',
    id: r.id,
    label: clean(r.file_name) || 'Untitled file',
    context: null,
    at: r.created_at,
  }))
}

/** Their coding jobs, by when they last moved. */
export const codeJobs: Source = async (supabase, viewer) => {
  const { data, error } = await supabase
    .from('local_agent_session')
    .select('id, request, created_at, updated_at')
    .eq('workspace_id', viewer.workspaceId)
    .eq('user_id', viewer.userId)
    .order('created_at', { ascending: false })
    .limit(RECENTS_SOURCE_MAX)
  if (error) throw new Error(`code jobs: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; request: string | null; created_at: string; updated_at: string | null }>).map((r) => ({
    type: 'code_job',
    id: r.id,
    label: firstLineTitle(r.request),
    context: 'Code',
    at: r.updated_at && r.updated_at > r.created_at ? r.updated_at : r.created_at,
  }))
}

export const RECENTS_SOURCES: Readonly<Record<string, Source>> = { driveUploads, codeJobs }

/** Every source's rows for `viewer`, each source fail-soft. */
export async function loadRecentSources(
  supabase: SupabaseClient,
  viewer: RecentsViewer,
  sources: Readonly<Record<string, Source>> = RECENTS_SOURCES,
): Promise<RecentSourceEntry[]> {
  const answers = await Promise.all(
    Object.entries(sources).map(async ([name, read]) => {
      try {
        return await read(supabase, viewer)
      } catch (err) {
        console.error(`[recents] ${name} read failed:`, err instanceof Error ? err.message : err)
        return []
      }
    }),
  )
  return answers.flat()
}
