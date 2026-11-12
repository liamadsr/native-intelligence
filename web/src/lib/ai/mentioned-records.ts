/**
 * `## Mentioned records`: the actions, docs, projects, initiatives and Studio
 * videos the person @-mentioned this turn (docs/plans/slash-search.md), one line each
 * with the tool that reads it, so "what's left on @GEN-42" needs no search.
 *
 * The ids are client-supplied and the chat spec's client is service-role, so
 * every read is fenced here: to the turn's workspace, to well-formed ids (at
 * most MAX_PER_KIND of each), and a private doc to its creator (document
 * visibility, migration 369). An id that fails any of that is left out
 * silently. A Studio video only for a member who may use the Studio (not a
 * guest: requireStudio's rule), and never one in the trash. Titles are the workspace's own text but can come from outside
 * (an email turned into an action), so the list is fenced as data.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { wrapUntrusted } from '@/lib/email/untrusted'

/** Records of one kind a turn names, at most. */
export const MAX_PER_KIND = 10

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The ids worth reading: strings shaped like ids, each once, capped. */
export function mentionedIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && UUID.test(id)))].slice(0, MAX_PER_KIND)
}

export interface MentionedRecordIds {
  actionIds?: unknown
  documentIds?: unknown
  projectIds?: unknown
  initiativeIds?: unknown
  studioVideoIds?: unknown
}

export const MENTIONED_RECORDS_PREAMBLE =
  'The user @-mentioned these in their message: treat them as its subject. ' +
  'Each line names the tool that reads it in full; read it before answering about its details rather than guessing.'

/** A title as a line shows it: one line, capped, quoted. */
const quote = (s: string | null | undefined) => `"${(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Untitled'}"`

/** One mentioned record, as a line naming it and the tool that reads it. */
export interface MentionedRecordLine {
  kind: 'action' | 'document' | 'project' | 'initiative' | 'studio_video'
  id: string
  line: string
}

/**
 * The mentioned records that can be read, in kind order (actions, docs,
 * projects, initiatives), each as its line. `privateDocs` false (a run whose
 * tools can't read private data): only the workspace's shared docs.
 */
export async function gatherMentionedRecords(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; privateDocs?: boolean } & MentionedRecordIds,
): Promise<MentionedRecordLine[]> {
  const { workspaceId, userId, privateDocs = true } = args
  const actionIds = mentionedIds(args.actionIds)
  const documentIds = mentionedIds(args.documentIds)
  const projectIds = mentionedIds(args.projectIds)
  const initiativeIds = mentionedIds(args.initiativeIds)
  const studioVideoIds = mentionedIds(args.studioVideoIds)
  if (!actionIds.length && !documentIds.length && !projectIds.length && !initiativeIds.length && !studioVideoIds.length) return []

  const none = Promise.resolve({ data: [] as unknown[] })
  const [actions, documents, projects, initiatives, videos] = await Promise.all([
    actionIds.length
      ? supabase
          .from('actions')
          .select('id, title, identifier, workflow_state:workflow_state!status_id(name)')
          .eq('workspace_id', workspaceId)
          .in('id', actionIds)
      : none,
    documentIds.length ? readVisibleDocuments(supabase, { workspaceId, userId, ids: documentIds, privateDocs }) : none,
    projectIds.length ? supabase.from('projects').select('id, name, status').eq('workspace_id', workspaceId).in('id', projectIds) : none,
    initiativeIds.length
      ? supabase.from('initiative').select('id, name, status').eq('workspace_id', workspaceId).in('id', initiativeIds)
      : none,
    studioVideoIds.length ? readStudioVideos(supabase, { workspaceId, userId, ids: studioVideoIds }) : none,
  ])

  const lines: MentionedRecordLine[] = []
  for (const a of (actions.data ?? []) as { id: string; title: string | null; identifier: string | null; workflow_state: { name: string | null } | null }[]) {
    const status = a.workflow_state?.name ? ` (${a.workflow_state.name})` : ''
    lines.push({
      kind: 'action',
      id: a.id,
      line: `Action ${a.identifier ? `${a.identifier} ` : ''}${quote(a.title)}${status}: get_action(action_id: ${a.id})`,
    })
  }
  for (const d of (documents.data ?? []) as { id: string; title: string | null }[]) {
    lines.push({ kind: 'document', id: d.id, line: `Doc ${quote(d.title)}: get_document(document_id: ${d.id})` })
  }
  for (const p of (projects.data ?? []) as { id: string; name: string | null; status: string | null }[]) {
    lines.push({
      kind: 'project',
      id: p.id,
      line: `Project ${quote(p.name)}${p.status ? ` (${p.status})` : ''}: get_project_context(project_id: ${p.id})`,
    })
  }
  for (const i of (initiatives.data ?? []) as { id: string; name: string | null; status: string | null }[]) {
    lines.push({
      kind: 'initiative',
      id: i.id,
      line: `Initiative ${quote(i.name)}${i.status ? ` (${i.status})` : ''}: get_initiative(initiative_id: ${i.id})`,
    })
  }
  for (const v of (videos.data ?? []) as { id: string; title: string | null; status: string | null }[]) {
    lines.push({
      kind: 'studio_video',
      id: v.id,
      line: `Studio video ${quote(v.title)}${v.status ? ` (${v.status})` : ''}: get_studio_video(video_id: ${v.id})`,
    })
  }
  return lines
}

/** The main chat's §6h block: the preamble, then the lines fenced as data; null when nothing reads. */
export async function buildMentionedRecordsBlock(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string } & MentionedRecordIds,
): Promise<string | null> {
  const lines = await gatherMentionedRecords(supabase, args)
  if (!lines.length) return null
  return ['## Mentioned records', MENTIONED_RECORDS_PREAMBLE, '', wrapUntrusted(lines.map((l) => `- ${l.line}`).join('\n'), 'WORKSPACE')].join('\n')
}

/** Docs the caller may read: the workspace's shared ones, and (with `privateDocs`) their own private ones. */
async function readVisibleDocuments(
  supabase: SupabaseClient,
  { workspaceId, userId, ids, privateDocs }: { workspaceId: string; userId: string; ids: string[]; privateDocs: boolean },
): Promise<{ data: unknown[] | null }> {
  if (!privateDocs) return supabase.from('document').select('id, title').eq('workspace_id', workspaceId).in('id', ids).eq('visibility', 'workspace')
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
  const memberId = (member as { id: string } | null)?.id
  let query = supabase.from('document').select('id, title').eq('workspace_id', workspaceId).in('id', ids)
  query = memberId ? query.or(`visibility.eq.workspace,created_by.eq.${memberId}`) : query.eq('visibility', 'workspace')
  return query
}

/**
 * Studio videos the caller may read: a member of the workspace who is not a guest, and not in the trash. The
 * Studio's tables are service-role only (migration 620), as the client here is.
 */
async function readStudioVideos(
  supabase: SupabaseClient,
  { workspaceId, userId, ids }: { workspaceId: string; userId: string; ids: string[] },
): Promise<{ data: unknown[] | null }> {
  const { data: member } = await supabase.from('member').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
  const role = (member as { role?: string | null } | null)?.role
  if (!member || role === 'guest') return { data: [] }
  return supabase.from('studio_video').select('id, title, status').eq('workspace_id', workspaceId).in('id', ids).is('archived_at', null)
}
