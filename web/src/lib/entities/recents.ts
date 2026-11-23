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
 *   The rest  migration 713's my_recent_work (an invoker function: their own
 *           RLS): each team chat channel they wrote, replied, reacted or
 *           voted in (one row per channel), the documents whose body they
 *           edited, their spreadsheets, canvases and agent chats; then fenced
 *           (hiddenPrivateRefs) and labelled (resolveEntityLabels) again.
 * Fail-soft per source: one that can't be read is left out (and logged), the
 * others still answer. Flat cost: one indexed read per source, in parallel.
 *
 * Opening something is not a doing (decision 2 in the plan): no source reads opens.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { hiddenPrivateRefs } from '@/lib/knowledge/entity-fences'
import { resolveEntityLabels } from '@/lib/knowledge/graph-map/source'
import { dmOtherMember } from '@/lib/team-chat/types'
import { firstLineTitle, type RecentKind, type RecentSourceEntry } from './recents-model'

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

/** How far back the direct reads look. */
export const RECENTS_SINCE_DAYS = 30

const RECENT_WORK_KINDS = new Set(['team_chat_channel', 'document', 'spreadsheet', 'canvas', 'conversation'])

const k = (type: string, id: string) => `${type}:${id}`

/**
 * Migration 713's my_recent_work: their team chat channels (one row each, at
 * their latest message, thread reply, reaction or vote there), the documents
 * whose body they edited, their spreadsheets, canvases and agent chats. Read
 * under their own RLS (an invoker function), then fenced and labelled again
 * as the feed does: a record they can't read, or that has no label, drops.
 * Before 713 is applied the call fails, and this source is left out.
 */
export const myRecentWork: Source = async (supabase, viewer) => {
  const since = new Date(Date.now() - RECENTS_SINCE_DAYS * 86_400_000).toISOString()
  const { data, error } = await supabase.rpc('my_recent_work', { p_workspace: viewer.workspaceId, p_since: since, p_limit: RECENTS_SOURCE_MAX })
  if (error) throw new Error(`my_recent_work: ${error.message}`)
  const rows = ((data ?? []) as Array<{ kind: string; id: string; at: string }>).filter((r) => RECENT_WORK_KINDS.has(r.kind) && !!r.id && !!r.at)
  if (!rows.length) return []
  const refs = rows.map((r) => ({ type: r.kind, id: r.id }))
  const hidden = await hiddenPrivateRefs(supabase, refs, viewer.userId, viewer.workspaceId)
  const kept = rows.filter((r) => !hidden.has(k(r.kind, r.id)))

  // Channels are named as team chat names them (a DM by its other person); the rest by their registry label.
  const channelIds = kept.filter((r) => r.kind === 'team_chat_channel').map((r) => r.id)
  const byType = new Map<string, Set<string>>()
  for (const r of kept) {
    if (r.kind === 'team_chat_channel') continue
    ;(byType.get(r.kind) ?? byType.set(r.kind, new Set()).get(r.kind)!).add(r.id)
  }
  const [labels, channelNames] = await Promise.all([resolveEntityLabels(supabase, viewer.workspaceId, byType), channelLabels(supabase, viewer, channelIds)])

  const out: RecentSourceEntry[] = []
  for (const r of kept) {
    // An agent chat is the caller's own (713 reads only theirs, under their RLS): an untitled one still shows.
    const label =
      r.kind === 'team_chat_channel' ? channelNames.get(r.id) : (labels.get(k(r.kind, r.id)) ?? (r.kind === 'conversation' ? 'Untitled chat' : undefined))
    if (!label) continue
    out.push({ type: r.kind as RecentKind, id: r.id, label, context: null, at: r.at })
  }
  return out
}

/** Each readable channel's title: `#name`, a DM's other person (a note to self "… (you)"), a meeting's name. */
async function channelLabels(supabase: SupabaseClient, viewer: RecentsViewer, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!ids.length) return out
  const { data, error } = await supabase
    .from('team_chat_channel')
    .select('id, kind, name, dm_key')
    .eq('workspace_id', viewer.workspaceId)
    .in('id', ids)
  if (error) throw new Error(`channels: ${error.message}`)
  const channels = (data ?? []) as Array<{ id: string; kind: string; name: string | null; dm_key: string | null }>
  const others = new Map<string, string>()
  for (const c of channels) {
    if (c.kind !== 'dm') continue
    const other = dmOtherMember(c.dm_key, viewer.memberId)
    if (other) others.set(c.id, other)
  }
  const names = new Map<string, string>()
  if (others.size) {
    const { data: members, error: mErr } = await supabase
      .from('member')
      .select('id, display_name')
      .eq('workspace_id', viewer.workspaceId)
      .in('id', [...new Set(others.values())])
    if (mErr) throw new Error(`members: ${mErr.message}`)
    for (const m of (members ?? []) as Array<{ id: string; display_name: string | null }>) names.set(m.id, clean(m.display_name))
  }
  for (const c of channels) {
    if (c.kind === 'dm') {
      const other = others.get(c.id)
      const name = other ? names.get(other) : null
      if (!other || !name) continue
      out.set(c.id, other === viewer.memberId ? `${name} (you)` : name)
    } else if (c.kind === 'meeting') {
      out.set(c.id, clean(c.name) || 'Meeting chat')
    } else {
      const name = clean(c.name)
      if (name) out.set(c.id, `#${name}`)
    }
  }
  return out
}

export const RECENTS_SOURCES: Readonly<Record<string, Source>> = { driveUploads, codeJobs, myRecentWork }

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
