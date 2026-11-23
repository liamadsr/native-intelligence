/**
 * The tags on one record, read and set on the CALLER'S client: row-level
 * security decides everything (migration 700). A record the caller cannot
 * read is "not found"; someone else's personal tag is invisible, so it is
 * never listed, never matched, and never removed by a replace. A write the
 * policies refuse (a view-only grantee adding a workspace tag) is "forbidden".
 *
 * Server-only (it takes a Supabase client); the browser calls the route
 * (api/account/tags/on/[kind]/[id]) through lib/tags/client.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { TAGGABLE, type TagKind } from './kinds'

export interface RecordTag {
  id: string
  name: string
  color: string
  personal: boolean
}

export type TagResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 500; error: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

interface LabelRow {
  id: string
  name: string
  color: string
  owner_user_id: string | null
  workspace_id?: string
}

function toTag(l: LabelRow): RecordTag {
  return { id: l.id, name: l.name, color: l.color, personal: l.owner_user_id !== null }
}

/** RLS refusals come back as 42501 (insert) or as no row touched (delete). */
function refused(code: string | undefined): boolean {
  return code === '42501'
}

/** The record's workspace, if the caller can read it. */
async function recordWorkspace(supabase: SupabaseClient, kind: TagKind, id: string): Promise<TagResult<string>> {
  if (!isUuid(id)) return { ok: false, status: 400, error: 'Invalid record id' }
  const { data, error } = await supabase.from(TAGGABLE[kind].table).select('workspace_id').eq('id', id).maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  const ws = (data as { workspace_id?: string | null } | null)?.workspace_id
  if (!ws) return { ok: false, status: 404, error: `${TAGGABLE[kind].noun[0]} not found` }
  return { ok: true, value: ws }
}

export async function listRecordTags(supabase: SupabaseClient, kind: TagKind, id: string): Promise<TagResult<RecordTag[]>> {
  const ws = await recordWorkspace(supabase, kind, id)
  if (!ws.ok) return ws
  const d = TAGGABLE[kind]
  const { data, error } = await supabase
    .from(d.join)
    .select('label:label(id, name, color, owner_user_id)')
    .eq(d.column, id)
  if (error) return { ok: false, status: 500, error: error.message }
  const tags = ((data ?? []) as unknown as Array<{ label: LabelRow | null }>)
    .map((r) => r.label)
    .filter((l): l is LabelRow => Boolean(l))
    .map(toTag)
    .sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, value: tags }
}

/** The tags among `labelIds` the caller can use on a record in `workspaceId`. */
async function usableLabels(supabase: SupabaseClient, workspaceId: string, labelIds: string[]): Promise<TagResult<LabelRow[]>> {
  if (labelIds.length === 0) return { ok: true, value: [] }
  if (!labelIds.every(isUuid)) return { ok: false, status: 400, error: 'Invalid tag id' }
  const { data, error } = await supabase
    .from('label')
    .select('id, name, color, owner_user_id, workspace_id')
    .in('id', labelIds)
    .eq('workspace_id', workspaceId)
  if (error) return { ok: false, status: 500, error: error.message }
  const rows = (data ?? []) as LabelRow[]
  if (rows.length !== new Set(labelIds).size) return { ok: false, status: 404, error: 'Tag not found' }
  return { ok: true, value: rows }
}

export async function addRecordTags(
  supabase: SupabaseClient,
  kind: TagKind,
  id: string,
  labelIds: string[],
): Promise<TagResult<RecordTag[]>> {
  const ws = await recordWorkspace(supabase, kind, id)
  if (!ws.ok) return ws
  const labels = await usableLabels(supabase, ws.value, labelIds)
  if (!labels.ok) return labels
  if (labels.value.length === 0) return { ok: true, value: [] }
  const d = TAGGABLE[kind]
  const { error } = await supabase
    .from(d.join)
    .upsert(
      labels.value.map((l) => ({ [d.column]: id, label_id: l.id })),
      { onConflict: `${d.column},label_id`, ignoreDuplicates: true },
    )
  if (error) {
    if (refused(error.code)) return { ok: false, status: 403, error: 'You cannot tag this record' }
    return { ok: false, status: 500, error: error.message }
  }
  return { ok: true, value: labels.value.map(toTag) }
}

export async function removeRecordTags(
  supabase: SupabaseClient,
  kind: TagKind,
  id: string,
  labelIds: string[],
): Promise<TagResult<number>> {
  const ws = await recordWorkspace(supabase, kind, id)
  if (!ws.ok) return ws
  if (labelIds.length === 0) return { ok: true, value: 0 }
  if (!labelIds.every(isUuid)) return { ok: false, status: 400, error: 'Invalid tag id' }
  const d = TAGGABLE[kind]
  const { data, error } = await supabase.from(d.join).delete().eq(d.column, id).in('label_id', labelIds).select('label_id')
  if (error) {
    if (refused(error.code)) return { ok: false, status: 403, error: 'You cannot untag this record' }
    return { ok: false, status: 500, error: error.message }
  }
  return { ok: true, value: (data ?? []).length }
}

/**
 * Make the caller's visible tags on a record exactly `labelIds`. Tags the
 * caller cannot see (another person's personal ones) are left as they are.
 */
export async function setRecordTags(
  supabase: SupabaseClient,
  kind: TagKind,
  id: string,
  labelIds: string[],
): Promise<TagResult<RecordTag[]>> {
  const current = await listRecordTags(supabase, kind, id)
  if (!current.ok) return current
  const want = new Set(labelIds)
  const have = new Set(current.value.map((t) => t.id))
  const add = [...want].filter((x) => !have.has(x))
  const remove = [...have].filter((x) => !want.has(x))
  if (add.length > 0) {
    const r = await addRecordTags(supabase, kind, id, add)
    if (!r.ok) return r
  }
  if (remove.length > 0) {
    const r = await removeRecordTags(supabase, kind, id, remove)
    if (!r.ok) return r
  }
  return listRecordTags(supabase, kind, id)
}
