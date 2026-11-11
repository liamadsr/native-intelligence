/**
 * THE CROSS-KIND FEED's server half: reads the activity log (entity_activity,
 * migration 488) for one viewer under one filter (./feed-model.ts), re-applies
 * every private kind's visibility, labels what's left and groups it per
 * record. The one reader behind GET /api/account/feed.
 *
 * SESSION CLIENT ONLY. The log's own RLS (migration 489) already lets a row
 * through only when the viewer can read its record and the record its detail
 * names; this file fences again, so the feed never rests on one rule alone:
 * a row about someone else's private document, a DM the viewer isn't in or
 * another member's capture must never reach them, nor its label. So before
 * anything is answered:
 *   1. the private graph kinds are fenced for the viewer
 *      (hiddenPrivateRefs: team chat, calendar events, decisions), and
 *   2. every record a row names (the record itself, and the one that
 *      mentions or is linked) is labelled through the viewer's own RLS
 *      (resolveEntityLabels): one they can't read (a private capture or doc, a
 *      contact hidden from them) has no label, and its rows are dropped,
 *      never shown as a placeholder. A record that's gone drops the same way.
 * The log's detail holds ids only, never text, so a label can come only
 * from those two reads.
 *
 * Rows the history backfill wrote (migration 516, `backfilled`) are in
 * History and Recent like any other, but never in the Inbox.
 *
 * Flat cost, whatever the page: one read of the log (indexed for each
 * filter), for `linked_to` one fence and one label read of the record named
 * (it must be readable) and at most two reads of its edges, one fence read
 * per private kind present, one label read per kind, one read of member
 * names, and at most one read each of task states, deal stages and message
 * channels.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { hiddenPrivateRefs } from '@/lib/knowledge/entity-fences'
import { resolveEntityLabels } from '@/lib/knowledge/graph-map/source'
import { isActivityEntityType, type ActivityEntityType } from '@/lib/knowledge/entity-registry'
import { messageChannels } from '@/lib/entity-links/references'
import {
  encodeFeedCursor,
  isInboxFilter,
  type FeedAction,
  type FeedEntry,
  type FeedEvent,
  type FeedFilter,
  type FeedRecordEvent,
  type FeedResponse,
} from './feed-model'

/** A row of the log as read. */
export interface ActivityRow {
  id: string
  entity_type: string
  entity_id: string
  action: FeedAction
  actor_kind: 'member' | 'agent' | 'system'
  actor_member_id: string | null
  subject_member_id: string | null
  detail: Record<string, unknown> | null
  created_at: string
}

const ROW_SELECT = 'id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail, created_at'

/** Rows read per grouped page, per entry asked for (one record often has several events). */
const GROUP_OVERREAD = 4
/** The most rows one answer reads. */
export const FEED_SCAN_MAX = 400
/** The most edges `linked_to` follows. */
const LINKED_MAX = 200

export interface FeedViewer {
  workspaceId: string
  userId: string
  memberId: string
}

const key = (type: string, id: string) => `${type}:${id}`
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** The record a row's detail names besides its own (who mentioned it, what it was linked to). */
export function otherRef(row: Pick<ActivityRow, 'action' | 'detail' | 'entity_type' | 'entity_id'>): { type: string; id: string } | null {
  const d = row.detail ?? {}
  const ref =
    row.action === 'mentioned'
      ? { type: str(d.source_type), id: str(d.source_id) }
      : row.action === 'linked'
        ? { type: str(d.other_type), id: str(d.other_id) }
        : null
  if (!ref?.type || !ref.id) return null
  // A member's mention is on the source itself: nothing else to name.
  if (ref.type === row.entity_type && ref.id === row.entity_id) return null
  return { type: ref.type, id: ref.id }
}

/** The records linked to `ref`, either way (the viewer's RLS on entity_link). */
async function linkedRefs(supabase: SupabaseClient, workspaceId: string, ref: { type: string; id: string }) {
  const [out, inn] = await Promise.all([
    supabase
      .from('entity_link')
      .select('target_type, target_id')
      .eq('workspace_id', workspaceId)
      .eq('source_type', ref.type)
      .eq('source_id', ref.id)
      .neq('source_type', 'claim')
      .limit(LINKED_MAX),
    supabase
      .from('entity_link')
      .select('source_type, source_id')
      .eq('workspace_id', workspaceId)
      .eq('target_type', ref.type)
      .eq('target_id', ref.id)
      .neq('source_type', 'claim')
      .limit(LINKED_MAX),
  ])
  if (out.error) throw new Error(out.error.message)
  if (inn.error) throw new Error(inn.error.message)
  const refs = new Map<string, { type: string; id: string }>()
  for (const r of (out.data ?? []) as Array<{ target_type: string; target_id: string }>) {
    if (isActivityEntityType(r.target_type)) refs.set(key(r.target_type, r.target_id), { type: r.target_type, id: r.target_id })
  }
  for (const r of (inn.data ?? []) as Array<{ source_type: string; source_id: string }>) {
    if (isActivityEntityType(r.source_type)) refs.set(key(r.source_type, r.source_id), { type: r.source_type, id: r.source_id })
  }
  refs.delete(key(ref.type, ref.id))
  return [...refs.values()]
}

/** Whether the viewer can read one record: past the private-kind fences, and labelled through their RLS. */
async function canRead(supabase: SupabaseClient, viewer: FeedViewer, ref: { type: string; id: string }): Promise<boolean> {
  const hidden = await hiddenPrivateRefs(supabase, [ref], viewer.userId, viewer.workspaceId)
  if (hidden.has(key(ref.type, ref.id))) return false
  const labels = await resolveEntityLabels(supabase, viewer.workspaceId, new Map([[ref.type, new Set([ref.id])]]))
  return labels.has(key(ref.type, ref.id))
}

/** Read the log's rows for a filter, newest first. */
async function readRows(
  supabase: SupabaseClient,
  viewer: FeedViewer,
  filter: FeedFilter,
): Promise<{ rows: ActivityRow[]; read: number; want: number; last?: ActivityRow } | { error: string }> {
  const want = filter.group === 'entity' ? Math.min(filter.limit * GROUP_OVERREAD, FEED_SCAN_MAX) : Math.min(filter.limit + 1, FEED_SCAN_MAX)

  // `linked_to` first: the records linked to the one named, then their rows.
  let linked: Set<string> | null = null
  let linkedIds: string[] = []
  if (filter.linkedTo) {
    try {
      // The record named must be one the viewer can read: otherwise the
      // answer would say what a private record is linked to.
      if (!(await canRead(supabase, viewer, filter.linkedTo))) return { rows: [], read: 0, want }
      const refs = await linkedRefs(supabase, viewer.workspaceId, filter.linkedTo)
      if (!refs.length) return { rows: [], read: 0, want }
      linked = new Set(refs.map((r) => key(r.type, r.id)))
      linkedIds = [...new Set(refs.map((r) => r.id))]
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'link read failed' }
    }
  }

  let q = supabase.from('entity_activity').select(ROW_SELECT).eq('workspace_id', viewer.workspaceId)
  if (filter.entity) q = q.eq('entity_type', filter.entity.type).eq('entity_id', filter.entity.id)
  if (filter.kinds?.length) q = q.in('entity_type', filter.kinds)
  if (linkedIds.length) q = q.in('entity_id', linkedIds)

  if (isInboxFilter(filter)) {
    const actions: FeedAction[] = []
    if (filter.assignedToMe) actions.push('assigned')
    if (filter.mentionedMe) actions.push('mentioned')
    // A record shared with the viewer alone (migration 513: a member grant's subject).
    if (filter.sharedWithMe) actions.push('shared')
    // Never a backfilled row (migration 516): history written after the
    // fact is the record's History, not news for anyone's Inbox.
    q = q.eq('subject_member_id', viewer.memberId).in('action', actions).eq('backfilled', false)
  }

  if (filter.actor === 'me') q = q.eq('actor_kind', 'member').eq('actor_member_id', viewer.memberId)
  else if (filter.actor === 'agent') q = q.eq('actor_kind', 'agent')
  else if (filter.actor) q = q.eq('actor_member_id', filter.actor)

  if (filter.since) q = q.gte('created_at', filter.since)
  // The next page: at or before the cursor's time, then (in order) past its
  // row. Rows written together share a time (one statement's rows), so the
  // ones at that very time already shown are skipped here, by id, as the
  // order has them.
  if (filter.cursor) q = q.lte('created_at', filter.cursor.at)

  const { data, error } = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(want)
  if (error) return { error: error.message }
  const cursor = filter.cursor
  const raw = (data ?? []) as unknown as ActivityRow[]
  const all = raw.filter((r) => !cursor || r.created_at !== cursor.at || r.id < cursor.id)
  const rows = linked ? all.filter((r) => linked.has(key(r.entity_type, r.entity_id))) : all
  return { rows, read: raw.length, want, last: all[all.length - 1] }
}

/** A custom field change's keys (migration 497's detail.fields), at most 20. */
function changedFieldKeys(row: Pick<ActivityRow, 'action' | 'detail'>): string[] {
  const fields = row.action === 'updated' ? row.detail?.fields : null
  return Array.isArray(fields) ? fields.filter((k): k is string => typeof k === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(k)).slice(0, 20) : []
}

/** How many changed fields a line names before "and N more". */
const FIELDS_NAMED = 2

/** The names behind the ids a set of rows names: members, task states, deal stages, custom fields. */
async function readNames(supabase: SupabaseClient, workspaceId: string, rows: readonly ActivityRow[]) {
  const memberIds = new Set<string>()
  const stateIds = new Set<string>()
  const stageIds = new Set<string>()
  const fieldKeys = new Set<string>()
  // A table's columns are its own (migration 520): a row's field is named through its table.
  const dataRowIds = new Set<string>()
  for (const r of rows) {
    if (r.actor_member_id) memberIds.add(r.actor_member_id)
    if (r.subject_member_id) memberIds.add(r.subject_member_id)
    const d = r.detail ?? {}
    if (r.action === 'assigned') {
      for (const v of [d.from, d.to]) if (str(v)) memberIds.add(v as string)
    }
    if (r.action === 'status_changed' && r.entity_type === 'action') for (const v of [d.from, d.to]) if (str(v)) stateIds.add(v as string)
    if (r.action === 'status_changed' && r.entity_type === 'deal') for (const v of [d.from, d.to]) if (str(v)) stageIds.add(v as string)
    for (const k of changedFieldKeys(r)) fieldKeys.add(k)
    if (r.entity_type === 'data_row' && changedFieldKeys(r).length) dataRowIds.add(r.entity_id)
  }
  const read = async (table: string, ids: Set<string>, column: string, scoped: boolean) => {
    if (!ids.size) return new Map<string, string>()
    let q = supabase.from(table).select(`id, ${column}`).in('id', [...ids])
    if (scoped) q = q.eq('workspace_id', workspaceId)
    const { data } = await q
    return new Map(((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => [String(r.id), String(r[column] ?? '')]))
  }
  // A field's name is per kind (`entity_type:key`), and a table's column per
  // table (`data_row:table_id:key`): the workspace's own definitions, through the viewer's RLS.
  const readFields = async () => {
    if (!fieldKeys.size) return new Map<string, string>()
    const { data } = await supabase
      .from('custom_field_definition')
      .select('entity_type, key, label, table_id')
      .eq('workspace_id', workspaceId)
      .in('key', [...fieldKeys])
    return new Map(
      ((data ?? []) as Array<{ entity_type: string; key: string; label: string; table_id: string | null }>).map((f) => [
        fieldName(f.entity_type, f.key, f.table_id),
        f.label,
      ]),
    )
  }
  const [members, states, stages, fields, rowTables] = await Promise.all([
    read('member', memberIds, 'display_name', true),
    read('workflow_state', stateIds, 'name', false),
    read('deal_stage', stageIds, 'name', false),
    readFields(),
    read('data_row', dataRowIds, 'table_id', true),
  ])
  return { members, states, stages, fields, rowTables }
}

type Names = Awaited<ReturnType<typeof readNames>>

/** Where a field's name is kept in Names.fields. */
const fieldName = (entityType: string, key: string, tableId: string | null | undefined) =>
  tableId ? `${entityType}:${tableId}:${key}` : `${entityType}:${key}`

function wordsFor(row: ActivityRow, names: Names): { from: string | null; to: string | null } {
  // A share (513) says its level: 'edit' or 'view'.
  if (row.action === 'shared') {
    const level = str(row.detail?.level)
    return { from: null, to: level === 'edit' || level === 'view' ? level : null }
  }
  if (row.action === 'updated') {
    // The fields still defined, by name; one since deleted is just not named.
    const labels = changedFieldKeys(row)
      .map((k) => names.fields.get(fieldName(row.entity_type, k, row.entity_type === 'data_row' ? names.rowTables.get(row.entity_id) : null)))
      .filter((l): l is string => !!l)
    if (!labels.length) return { from: null, to: null }
    const named = labels.slice(0, FIELDS_NAMED).join(', ')
    const rest = labels.length - FIELDS_NAMED
    return { from: null, to: rest > 0 ? `${named} and ${rest} more` : named }
  }
  const d = row.detail ?? {}
  const pick = (v: unknown): string | null => {
    const s = str(v)
    if (!s) return null
    if (row.action === 'assigned') return names.members.get(s) ?? null
    if (row.action === 'status_changed') {
      if (row.entity_type === 'action') return names.states.get(s) ?? null
      if (row.entity_type === 'deal') return names.stages.get(s) ?? null
      // A project's or initiative's status, a document's, a loop's on/off: the words themselves.
      return s
    }
    return null
  }
  return { from: pick(d.from), to: pick(d.to) }
}

/**
 * The feed for `viewer` under `filter`. Never returns a row about a record
 * the viewer can't read.
 */
export async function loadFeed(supabase: SupabaseClient, viewer: FeedViewer, filter: FeedFilter): Promise<FeedResponse | { error: string }> {
  const read = await readRows(supabase, viewer, filter)
  if ('error' in read) return read

  // The Inbox never holds the viewer's own doing (assigning themselves).
  const inbox = isInboxFilter(filter)
  const rows = read.rows.filter((r) => isActivityEntityType(r.entity_type) && !(inbox && r.actor_kind === 'member' && r.actor_member_id === viewer.memberId))

  // Every record the rows name: their own, and the one that mentions or is linked.
  const refs = new Map<string, { type: string; id: string }>()
  for (const r of rows) {
    refs.set(key(r.entity_type, r.entity_id), { type: r.entity_type, id: r.entity_id })
    const other = otherRef(r)
    if (other) refs.set(key(other.type, other.id), other)
  }

  let hidden: Set<string>
  let labels: Map<string, string>
  try {
    hidden = await hiddenPrivateRefs(supabase, [...refs.values()], viewer.userId, viewer.workspaceId)
    const byType = new Map<string, Set<string>>()
    for (const [k, r] of refs) {
      if (hidden.has(k)) continue
      ;(byType.get(r.type) ?? byType.set(r.type, new Set()).get(r.type)!).add(r.id)
    }
    labels = await resolveEntityLabels(supabase, viewer.workspaceId, byType)
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'label read failed' }
  }
  const visible = (type: string, id: string) => !hidden.has(key(type, id)) && labels.has(key(type, id))

  const kept = rows.filter((r) => {
    if (!visible(r.entity_type, r.entity_id)) return false
    const other = otherRef(r)
    return !other || visible(other.type, other.id)
  })

  // The team-chat messages named (a row's own, or the one that mentions): each one's channel.
  const messageIds = new Set<string>()
  for (const r of kept) {
    if (r.entity_type === 'team_chat_message') messageIds.add(r.entity_id)
    const other = otherRef(r)
    if (other?.type === 'team_chat_message') messageIds.add(other.id)
  }
  const [names, contexts] = await Promise.all([
    readNames(supabase, viewer.workspaceId, kept),
    messageChannels(supabase, [...messageIds]),
  ])

  const toEvent = (r: ActivityRow): FeedEvent => {
    const other = otherRef(r)
    const words = wordsFor(r, names)
    return {
      id: r.id,
      action: r.action,
      at: r.created_at,
      actor: {
        kind: r.actor_kind,
        member_id: r.actor_member_id,
        name: r.actor_member_id ? (names.members.get(r.actor_member_id) ?? null) : null,
        me: !!r.actor_member_id && r.actor_member_id === viewer.memberId,
      },
      subject: r.subject_member_id
        ? { member_id: r.subject_member_id, name: names.members.get(r.subject_member_id) ?? null, me: r.subject_member_id === viewer.memberId }
        : null,
      from: words.from,
      to: words.to,
      relation: r.action === 'linked' ? str(r.detail?.relation) : null,
      other: other
        ? { ...other, label: labels.get(key(other.type, other.id))!, context: other.type === 'team_chat_message' ? (contexts.get(other.id) ?? null) : null }
        : null,
    }
  }
  const contextOf = (type: string, id: string) => (type === 'team_chat_message' ? (contexts.get(id) ?? null) : null)

  // Where the next page starts: past the last row this one read, when it read a full window.
  const lastRead = read.last

  if (filter.group === 'none') {
    const page = kept.slice(0, filter.limit)
    const events: FeedRecordEvent[] = page.map((r) => ({
      ...toEvent(r),
      type: r.entity_type as ActivityEntityType,
      entity_id: r.entity_id,
      label: labels.get(key(r.entity_type, r.entity_id))!,
      context: contextOf(r.entity_type, r.entity_id),
    }))
    const more = kept.length > filter.limit || read.read >= read.want
    const cursorRow = kept.length > filter.limit ? page[page.length - 1] : lastRead
    return { events, next_cursor: more && cursorRow ? encodeFeedCursor({ at: cursorRow.created_at, id: cursorRow.id }) : null }
  }

  // One entry per record, its newest event (rows come newest first).
  const entries = new Map<string, { entry: FeedEntry; row: ActivityRow }>()
  for (const r of kept) {
    const k = key(r.entity_type, r.entity_id)
    const seen = entries.get(k)
    if (seen) {
      seen.entry.count += 1
      continue
    }
    entries.set(k, {
      row: r,
      entry: {
        type: r.entity_type as ActivityEntityType,
        id: r.entity_id,
        label: labels.get(k)!,
        context: contextOf(r.entity_type, r.entity_id),
        last: toEvent(r),
        count: 1,
      },
    })
  }
  const all = [...entries.values()]
  const page = all.slice(0, filter.limit)
  // Every record newer than the last one kept was read in this window, so the
  // next page starts just past it; a record shown may come again with older
  // events (mergeFeedEntries keeps the first).
  const cut = all.length > filter.limit ? page[page.length - 1]?.row : read.read >= read.want ? lastRead : null
  return {
    entries: page.map((e) => e.entry),
    next_cursor: cut ? encodeFeedCursor({ at: cut.created_at, id: cut.id }) : null,
  }
}
