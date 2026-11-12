/**
 * `## Mentioned records`: the actions, docs, projects, initiatives, deals,
 * flows, files and calendar events the person @-mentioned this turn
 * (docs/plans/slash-search.md), one line each with the tool that reads it, so
 * "what's left on @GEN-42" needs no search.
 *
 * The ids are client-supplied and the chat spec's client is service-role, so
 * every read is fenced here: to the turn's workspace, to well-formed ids (at
 * most MAX_PER_KIND of each), a private doc to its creator (document
 * visibility, migration 369), a file by the attachments rule
 * (src/lib/attachments/visibility.ts), and a calendar event to its owner. An
 * id that fails any of that is left out
 * silently. Titles are the workspace's own text but can come from outside
 * (an email turned into an action), so the list is fenced as data.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { filterVisibleAttachments, type AttachmentFenceRow } from '@/lib/attachments/visibility'
import { MENTION_RECORD_KEYS, type MentionRecordKind } from '@/lib/search/menu-search'
import { visiblePrivateKindIds } from '@/lib/knowledge/entity-fences'

/** Records of one kind a turn names, at most. */
export const MAX_PER_KIND = 10

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The ids worth reading: strings shaped like ids, each once, capped. */
export function mentionedIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && UUID.test(id)))].slice(0, MAX_PER_KIND)
}

/** The ids of each record kind a turn names (MENTION_RECORD_KEYS' run-chat names), client-supplied. */
export interface MentionedRecordIds {
  actionIds?: unknown
  documentIds?: unknown
  projectIds?: unknown
  initiativeIds?: unknown
  dealIds?: unknown
  flowIds?: unknown
  fileIds?: unknown
  calendarEventIds?: unknown
}

/** The ids a main-chat turn's system context names, under the run chat's names. */
export function mentionedRecordIdsOf(systemContext: Record<string, unknown> | null | undefined): MentionedRecordIds {
  const out: Record<string, unknown> = {}
  if (!systemContext) return out
  for (const keys of Object.values(MENTION_RECORD_KEYS)) {
    if (systemContext[keys.context] !== undefined) out[keys.run] = systemContext[keys.context]
  }
  return out as MentionedRecordIds
}

/** Whether any record id is named. */
export function hasMentionedRecordIds(ids: MentionedRecordIds): boolean {
  return Object.values(ids).some((v) => Array.isArray(v) && v.length > 0)
}

export const MENTIONED_RECORDS_PREAMBLE =
  'The user @-mentioned these in their message: treat them as its subject. ' +
  'Each line names the tool that reads it in full; read it before answering about its details rather than guessing.'

/** A title as a line shows it: one line, capped, quoted. */
const quote = (s: string | null | undefined) => `"${(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Untitled'}"`

/** One mentioned record, as a line naming it and the tool that reads it. */
export interface MentionedRecordLine {
  kind: MentionRecordKind
  id: string
  line: string
}

/**
 * The mentioned records that can be read, in kind order (actions, docs,
 * projects, initiatives, deals, flows, files, events), each as its line.
 * `privateDocs` false (a run whose tools can't read private data): only the
 * workspace's shared docs, only the files every member reads, and no
 * calendar event (each is its owner's alone).
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
  const dealIds = mentionedIds(args.dealIds)
  const flowIds = mentionedIds(args.flowIds)
  const fileIds = mentionedIds(args.fileIds)
  const eventIds = privateDocs ? mentionedIds(args.calendarEventIds) : []
  const all = [actionIds, documentIds, projectIds, initiativeIds, dealIds, flowIds, fileIds, eventIds]
  if (all.every((ids) => !ids.length)) return []

  const none = Promise.resolve({ data: [] as unknown[] })
  const [actions, documents, projects, initiatives, deals, flows, files, events] = await Promise.all([
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
    // A deal is a pipeline's row (Tables, phase 7): read only in a pipeline the person reads.
    dealIds.length ? readVisibleDeals(supabase, workspaceId, userId, dealIds, privateDocs) : none,
    flowIds.length ? supabase.from('flow').select('id, name, enabled').eq('workspace_id', workspaceId).in('id', flowIds) : none,
    fileIds.length ? readVisibleFiles(supabase, { workspaceId, userId: privateDocs ? userId : null, ids: fileIds }) : none,
    // The person's own events only (never another member's).
    eventIds.length
      ? supabase
          .from('local_calendar_event')
          .select('id, title, start_at, is_all_day')
          .eq('workspace_id', workspaceId)
          .eq('user_id', userId)
          .in('id', eventIds)
      : none,
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
  for (const d of (deals.data ?? []) as { id: string; title: string | null; stage: string | null }[]) {
    lines.push({
      kind: 'deal',
      id: d.id,
      line: `Deal ${quote(d.title)}${d.stage ? ` (${d.stage})` : ''}: get_deal(deal_id: ${d.id})`,
    })
  }
  for (const f of (flows.data ?? []) as { id: string; name: string | null; enabled: boolean | null }[]) {
    lines.push({ kind: 'flow', id: f.id, line: `Flow ${quote(f.name)} (${f.enabled ? 'on' : 'off'}), id ${f.id}: list_flows shows it in full` })
  }
  for (const f of (files.data ?? []) as { id: string; file_name: string | null }[]) {
    lines.push({ kind: 'attachment', id: f.id, line: `File ${quote(f.file_name)}: get_attachment_content(attachment_id: ${f.id})` })
  }
  for (const e of (events.data ?? []) as { id: string; title: string | null; start_at: string; is_all_day: boolean | null }[]) {
    const day = e.start_at.slice(0, 10)
    lines.push({
      kind: 'calendar_event',
      id: e.id,
      line: `Calendar event ${quote(e.title)} (starts ${e.is_all_day ? day : e.start_at}): get_calendar_events(start_date: ${day})`,
    })
  }
  return lines
}

/** Files the caller may read (src/lib/attachments/visibility.ts); no caller: only what every member reads. */
async function readVisibleFiles(
  supabase: SupabaseClient,
  { workspaceId, userId, ids }: { workspaceId: string; userId: string | null; ids: string[] },
): Promise<{ data: unknown[] | null }> {
  const { data, error } = await supabase
    .from('attachments')
    .select('id, file_name, user_id, note_id')
    .eq('workspace_id', workspaceId)
    .in('id', ids)
  if (error) return { data: [] }
  return { data: await filterVisibleAttachments(supabase, { workspaceId, userId }, (data ?? []) as AttachmentFenceRow[]) }
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

/**
 * Deals the caller may read: rows of a live pipeline (Tables, phase 7) whose
 * table they read (a private pipeline is its owner's and its grantees'; with
 * `privateDocs` false, only the workspace's).
 */
async function readVisibleDeals(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
  ids: string[],
  privateDocs: boolean,
): Promise<{ data: unknown[] | null }> {
  const { data: rowData } = await supabase.from('data_row').select('id, title, table_id, custom_fields').eq('workspace_id', workspaceId).in('id', ids).is('archived_at', null)
  const rows = (rowData ?? []) as Array<{ id: string; title: string | null; table_id: string; custom_fields: Record<string, unknown> | null }>
  if (!rows.length) return { data: [] }
  const { data: tableData } = await supabase
    .from('data_table')
    .select('id, visibility')
    .eq('workspace_id', workspaceId)
    .in('id', [...new Set(rows.map((r) => r.table_id))])
    .eq('table_kind', 'pipeline')
    .is('archived_at', null)
  const tables = new Map(((tableData ?? []) as Array<{ id: string; visibility: string }>).map((t) => [t.id, t.visibility]))
  const fenced = [...tables].filter(([, v]) => v !== 'workspace').map(([id]) => id)
  const seen = privateDocs && fenced.length ? await visiblePrivateKindIds(supabase, 'data_table', userId, fenced, workspaceId) : new Set<string>()
  return {
    data: rows
      .filter((r) => tables.get(r.table_id) === 'workspace' || seen.has(r.table_id))
      .map((r) => ({ id: r.id, title: r.title, stage: typeof r.custom_fields?.stage === 'string' ? r.custom_fields.stage : null })),
  }
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
