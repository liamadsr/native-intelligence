/**
 * `## Mentioned records`: the actions, docs, projects, initiatives, deals,
 * flows, files, calendar events and Studio videos the person @-mentioned this turn
 * (docs/plans/slash-search.md), one line each with the tool that reads it, so
 * "what's left on @GEN-42" needs no search.
 *
 * The ids are client-supplied and the chat spec's client is service-role, so
 * every read is fenced here: to the turn's workspace, to well-formed ids (at
 * most MAX_PER_KIND of each), a private doc to its creator (document
 * visibility, migration 369), a file by the attachments rule
 * (src/lib/attachments/visibility.ts), a calendar event to its owner, and a
 * Studio video only for a member who may use the Studio (not a guest:
 * requireStudio's rule), never one in the trash. An id that fails any of that
 * is left out silently. Titles are the workspace's own text but can come from outside
 * (an email turned into an action), so the list is fenced as data.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { filterVisibleAttachments, type AttachmentFenceRow } from '@/lib/attachments/visibility'
import { MENTIONED_RECORDS_CONTEXT_KEY, MENTION_RECORD_KEYS, UNKEYED_MENTION_TYPES, type MentionRecordKind } from '@/lib/search/menu-search'
import { tidyMentionRefs, type MentionRef, type MentionableType } from '@/lib/entity-links/mentionable'
import { visibleMentionTargets } from '@/lib/entity-links/mentions'
import { LABEL_TABLE } from '@/lib/knowledge/entity-registry'
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
  studioVideoIds?: unknown
  /** The mentioned records with no id key (mentionedRefsOf): campaigns, tables, rows, channels, decisions, Studio projects. */
  refs?: readonly MentionRef[]
}

/** The ids a main-chat turn's system context names, under the run chat's names. */
export function mentionedRecordIdsOf(systemContext: Record<string, unknown> | null | undefined): MentionedRecordIds {
  const out: Record<string, unknown> = {}
  if (!systemContext) return out
  for (const keys of Object.values(MENTION_RECORD_KEYS)) {
    if (systemContext[keys.context] !== undefined) out[keys.run] = systemContext[keys.context]
  }
  const refs = mentionedRefsOf(systemContext)
  if (refs.length) out.refs = refs
  return out as MentionedRecordIds
}

/**
 * The mentioned records with no id key of their own, as the turn's system
 * context carries them (`mentionedRecords`: `[{ type, id, label }]`): tidied
 * (well-formed, mentionable, distinct, capped) and kept to the kinds that
 * travel this way. The label is the client's and is never read: each line
 * says the record's own name, read here.
 */
export function mentionedRefsOf(systemContext: Record<string, unknown> | null | undefined): MentionRef[] {
  if (!systemContext) return []
  return tidyMentionRefs(systemContext[MENTIONED_RECORDS_CONTEXT_KEY]).filter((r) => UNKEYED_MENTION_TYPES.includes(r.type))
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
  kind: MentionRecordKind | MentionableType
  id: string
  line: string
}

/**
 * The mentioned records that can be read, in kind order (actions, docs,
 * projects, initiatives, deals, flows, files, events, Studio videos), each as its line.
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
  const studioVideoIds = mentionedIds(args.studioVideoIds)
  // With `privateDocs` false none of these is read: each is fenced for a person, and such a run reads as no one.
  const refs = privateDocs ? (args.refs ?? []) : []
  const all = [actionIds, documentIds, projectIds, initiativeIds, dealIds, flowIds, fileIds, eventIds, studioVideoIds]
  if (all.every((ids) => !ids.length) && !refs.length) return []
  const refLines = refs.length ? gatherRefLines(supabase, { workspaceId, userId, refs }) : Promise.resolve([] as MentionedRecordLine[])

  const none = Promise.resolve({ data: [] as unknown[] })
  const [actions, documents, projects, initiatives, deals, flows, files, events, videos] = await Promise.all([
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
  for (const d of (deals.data ?? []) as { id: string; title: string | null; stage: string | null; from_form?: boolean }[]) {
    lines.push({
      kind: 'deal',
      id: d.id,
      // A form's deal is named by a stranger: said so, beside its name, inside the block's fence.
      line: `Deal ${d.from_form ? `from a form (its name is what a stranger typed) ${quote(d.title)}` : quote(d.title)}${d.stage ? ` (${d.stage})` : ''}: get_deal(deal_id: ${d.id})`,
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
  for (const v of (videos.data ?? []) as { id: string; title: string | null; status: string | null }[]) {
    lines.push({
      kind: 'studio_video',
      id: v.id,
      line: `Studio video ${quote(v.title)}${v.status ? ` (${v.status})` : ''}: get_studio_video(video_id: ${v.id})`,
    })
  }
  lines.push(...(await refLines))
  return lines
}

/** What each kind that travels as a ref is called on its line, and how the agent reads it in full. */
const REF_LINES: Partial<Record<MentionableType, { noun: string; read: (id: string) => string }>> = {
  team: { noun: 'Team', read: (id) => `id ${id}` },
  knowledge_package: { noun: 'Knowledge package', read: (id) => `get_package(package_id: ${id})` },
  campaign: { noun: 'Campaign', read: (id) => `id ${id}: list_campaigns shows it in full` },
  data_table: { noun: 'Table', read: (id) => `get_table(table_id: ${id})` },
  spreadsheet: { noun: 'Spreadsheet', read: (id) => `read_spreadsheet(id: ${id})` },
  data_row: { noun: 'Table row', read: (id) => `id ${id}: query_rows on its table reads its fields` },
  canvas: { noun: 'Canvas', read: (id) => `read_canvas(canvas_id: ${id})` },
  team_chat_channel: { noun: 'Team chat channel', read: (id) => `id ${id}` },
  decision: { noun: 'Decision', read: (id) => `id ${id}: list_decisions shows it with its capture` },
  studio_project: { noun: 'Studio project', read: (id) => `id ${id}: list_studio_projects shows it in full` },
  sequence: { noun: 'Sequence', read: (id) => `get_sequence(sequence_id: ${id})` },
  prospect_list: { noun: 'Prospect list', read: (id) => `id ${id}: list_prospect_lists shows it in full` },
  // Owner-only (decision 1): each is fenced to the person the turn runs as
  // (visibleMentionTargets, on user_id), so only their own mail/chat is read.
  email_thread: { noun: 'Email thread', read: (id) => `id ${id}: read_email reads this thread (your own mail)` },
  conversation: { noun: 'Agent chat', read: (id) => `id ${id}: your own earlier chat with the agent (its title is above; no tool re-reads a past chat)` },
  // A team has no read tool of its own, so a mentioned team carries no line (gatherRefLines drops a ref with no spec).
}

/**
 * The lines for the records that travel as refs: each fenced for the person
 * (visibleMentionTargets: its workspace, and its kind's own read rule, as a
 * written mention is fenced), then named by its own label as a model reads it
 * (LABEL_TABLE: never a stranger's words for a form's row).
 */
async function gatherRefLines(
  supabase: SupabaseClient,
  { workspaceId, userId, refs }: { workspaceId: string; userId: string; refs: readonly MentionRef[] },
  specs: Partial<Record<MentionableType, { noun: string; read: (id: string) => string }>> = REF_LINES,
): Promise<MentionedRecordLine[]> {
  const perKind = new Map<string, number>()
  const capped = refs.filter((r) => {
    const n = (perKind.get(r.type) ?? 0) + 1
    perKind.set(r.type, n)
    return n <= MAX_PER_KIND && !!specs[r.type]
  })
  const visible = await visibleMentionTargets(supabase, { workspaceId, userId }, capped)
  const byType = new Map<MentionableType, string[]>()
  for (const r of visible) (byType.get(r.type) ?? byType.set(r.type, []).get(r.type)!).push(r.id)
  const labels = new Map<string, string>()
  await Promise.all(
    [...byType].map(async ([type, ids]) => {
      const spec = LABEL_TABLE[type]
      if (!spec) return
      const { data, error } = await supabase.from(spec.table).select(`id, ${spec.columns}`).in('id', ids)
      if (error) return
      for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
        if (typeof row.id === 'string') labels.set(`${type}:${row.id}`, spec.label(row))
      }
    }),
  )
  return visible.flatMap((r) => {
    const spec = specs[r.type]
    const label = labels.get(`${r.type}:${r.id}`)
    // No label read: the row is gone (or the read failed), so it is left out.
    return spec && label !== undefined ? [{ kind: r.type, id: r.id, line: `${spec.noun} ${quote(label)}: ${spec.read(r.id)}` }] : []
  })
}

/** How the agent reads each kind a message can mention, for a surface that names its mentions as refs (team chat). */
const ANY_REF_LINES: Partial<Record<MentionableType, { noun: string; read: (id: string) => string }>> = {
  ...REF_LINES,
  action: { noun: 'Action', read: (id) => `get_action(action_id: ${id})` },
  document: { noun: 'Doc', read: (id) => `get_document(document_id: ${id})` },
  project: { noun: 'Project', read: (id) => `get_project_context(project_id: ${id})` },
  initiative: { noun: 'Initiative', read: (id) => `get_initiative(initiative_id: ${id})` },
  capture: { noun: 'Capture', read: (id) => `get_capture_content(capture_id: ${id})` },
  contact: { noun: 'Contact', read: (id) => `get_contact(contact_id: ${id})` },
  company: { noun: 'Company', read: (id) => `get_company_overview(company_id: ${id})` },
  flow: { noun: 'Flow', read: (id) => `id ${id}: list_flows shows it in full` },
  attachment: { noun: 'File', read: (id) => `get_attachment_content(attachment_id: ${id})` },
  calendar_event: { noun: 'Calendar event', read: (id) => `id ${id}: get_calendar_events shows it` },
  studio_video: { noun: 'Studio video', read: (id) => `get_studio_video(video_id: ${id})` },
  canvas: { noun: 'Canvas', read: (id) => `read_canvas(canvas_id: ${id})` },
}

/**
 * `Mentioned records` for a message whose mentions are refs of ANY kind (a
 * team-chat message's `record_mentions`): each fenced for the person the turn
 * runs as, named by its own label, with the tool that reads it; fenced as
 * data. Null when nothing reads. The refs' labels are never used.
 */
export async function buildMentionedRefsBlock(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; refs: unknown },
): Promise<string | null> {
  const refs = tidyMentionRefs(args.refs).filter((r) => !!ANY_REF_LINES[r.type])
  if (!refs.length) return null
  const lines = await gatherRefLines(supabase, { workspaceId: args.workspaceId, userId: args.userId, refs }, ANY_REF_LINES)
  if (!lines.length) return null
  return ['Mentioned records', MENTIONED_RECORDS_PREAMBLE, '', wrapUntrusted(lines.map((l) => `- ${l.line}`).join('\n'), 'WORKSPACE')].join('\n')
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
  const { data: rowData } = await supabase.from('data_row').select('id, title, table_id, custom_fields, from_form').eq('workspace_id', workspaceId).in('id', ids).is('archived_at', null)
  const rows = (rowData ?? []) as Array<{ id: string; title: string | null; table_id: string; custom_fields: Record<string, unknown> | null; from_form?: boolean | null }>
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
      .map((r) => ({ id: r.id, title: r.title, stage: typeof r.custom_fields?.stage === 'string' ? r.custom_fields.stage : null, from_form: r.from_form === true })),
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
