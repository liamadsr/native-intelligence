/**
 * The import journal (migration 704): work_import and work_import_item.
 *
 * Written on the SERVICE client only (a client writes neither table); every
 * read here is fenced to the import's own person by the caller passing their
 * user id, as row security fences a client read. The records an import makes
 * are never written here: that is apply.ts, on the person's own client.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ImportPlan, ImportSource, ImportStatus, ItemKind, ItemOutcome, ItemRecord, PlanNote, UndoOutcome } from './types'

export interface WorkImport {
  id: string
  workspace_id: string
  user_id: string
  member_id: string | null
  source: ImportSource
  label: string | null
  status: ImportStatus
  destination: Record<string, unknown>
  counts: Record<string, number>
  notes: PlanNote[]
  summary: string | null
  error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
  undone_at: string | null
}

export interface WorkImportItem {
  id: string
  import_id: string
  workspace_id: string
  seq: number
  ref: string
  kind: ItemKind
  external_id: string | null
  record: ItemRecord
  matched_id: string | null
  outcome: ItemOutcome
  entity_id: string | null
  error: string | null
  applied_at: string | null
  undone_at: string | null
  undo_outcome: UndoOutcome | null
}

export const IMPORT_SELECT = 'id, workspace_id, user_id, member_id, source, label, status, destination, counts, notes, summary, error, created_at, updated_at, started_at, finished_at, undone_at'
export const ITEM_SELECT = 'id, import_id, workspace_id, seq, ref, kind, external_id, record, matched_id, outcome, entity_id, error, applied_at, undone_at, undo_outcome'

/** Items written or read per request. */
const CHUNK = 500

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message)
}

export interface StageInput {
  workspaceId: string
  userId: string
  memberId: string | null
  source: ImportSource
  label: string | null
  destination: Record<string, unknown>
  plan: ImportPlan
}

/**
 * A staged import: the import row and every planned item, in order. Each item
 * that makes a record we can name ourselves gets its id now (entity_id while
 * still pending), so apply inserts it with that id and a re-run after a
 * failure finds it instead of making it twice.
 */
export async function stageImport(svc: SupabaseClient, input: StageInput): Promise<WorkImport> {
  const { data, error } = await svc
    .from('work_import')
    .insert({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      member_id: input.memberId,
      source: input.source,
      label: input.label?.slice(0, 200) ?? null,
      status: 'staged',
      destination: input.destination,
      counts: input.plan.counts,
      notes: input.plan.notes.slice(0, 50),
    })
    .select(IMPORT_SELECT)
    .single()
  fail(error)
  const imp = data as WorkImport
  const rows = input.plan.items.map((item, seq) => ({
    import_id: imp.id,
    workspace_id: input.workspaceId,
    seq,
    ref: item.ref,
    kind: item.record.kind,
    external_id: item.external_id,
    record: item.record,
    matched_id: item.matched_id ?? null,
    outcome: 'pending',
    entity_id: PRE_ASSIGNED.has(item.record.kind) ? randomUUID() : null,
  }))
  try {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error: e } = await svc.from('work_import_item').insert(rows.slice(i, i + CHUNK))
      fail(e)
    }
  } catch (err) {
    // A half-staged import is no preview: take it back.
    await svc.from('work_import').delete().eq('id', imp.id)
    throw err
  }
  return imp
}

/** The kinds apply inserts with an id of our choosing (a table's id is its RPC's; an asset has no record). */
export const PRE_ASSIGNED: ReadonlySet<ItemKind> = new Set(['label', 'project', 'workflow_state', 'action', 'drive_folder', 'document'])

/** One import, when it is this person's, in this workspace. */
export async function loadImport(svc: SupabaseClient, id: string, who: { userId: string; workspaceId: string }): Promise<WorkImport | null> {
  const { data, error } = await svc.from('work_import').select(IMPORT_SELECT).eq('id', id).eq('user_id', who.userId).eq('workspace_id', who.workspaceId).maybeSingle()
  fail(error)
  return (data as WorkImport | null) ?? null
}

/** This person's recent imports here, newest first. */
export async function listImports(svc: SupabaseClient, who: { userId: string; workspaceId: string }, limit = 20): Promise<WorkImport[]> {
  const { data, error } = await svc
    .from('work_import')
    .select(IMPORT_SELECT)
    .eq('user_id', who.userId)
    .eq('workspace_id', who.workspaceId)
    .neq('status', 'discarded')
    .order('created_at', { ascending: false })
    .limit(limit)
  fail(error)
  return (data ?? []) as WorkImport[]
}

/** An import's items in order (all of them, page by page). */
export async function loadItems(svc: SupabaseClient, importId: string, opts: { limit?: number } = {}): Promise<WorkImportItem[]> {
  const out: WorkImportItem[] = []
  const max = opts.limit ?? Infinity
  for (let from = 0; out.length < max; from += CHUNK) {
    const { data, error } = await svc
      .from('work_import_item')
      .select(ITEM_SELECT)
      .eq('import_id', importId)
      .order('seq', { ascending: true })
      .range(from, from + Math.min(CHUNK, max - out.length) - 1)
    fail(error)
    const page = (data ?? []) as WorkImportItem[]
    out.push(...page)
    if (page.length < CHUNK) break
  }
  return out
}

export type ItemPatch = Partial<Pick<WorkImportItem, 'outcome' | 'entity_id' | 'matched_id' | 'error' | 'applied_at' | 'undone_at' | 'undo_outcome'>>

export async function updateItem(svc: SupabaseClient, id: string, patch: ItemPatch): Promise<void> {
  const { error } = await svc.from('work_import_item').update(patch).eq('id', id)
  fail(error)
}

/** Several items moved to the same outcome at once. */
export async function updateItems(svc: SupabaseClient, ids: readonly string[], patch: ItemPatch): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { error } = await svc.from('work_import_item').update(patch).in('id', ids.slice(i, i + CHUNK))
    fail(error)
  }
}

export async function updateImport(svc: SupabaseClient, id: string, patch: Partial<Pick<WorkImport, 'status' | 'counts' | 'summary' | 'error' | 'started_at' | 'finished_at' | 'undone_at'>>): Promise<void> {
  const { error } = await svc.from('work_import').update(patch).eq('id', id)
  fail(error)
}

/**
 * Move an import from one status to another only if it is still in one of
 * `from`: two clicks of Import (or Undo) never run it twice. True when this
 * call moved it.
 */
export async function claimImport(svc: SupabaseClient, id: string, from: readonly ImportStatus[], to: ImportStatus, extra: Partial<Pick<WorkImport, 'started_at' | 'error'>> = {}): Promise<boolean> {
  const { data, error } = await svc.from('work_import').update({ status: to, ...extra }).eq('id', id).in('status', [...from]).select('id')
  fail(error)
  return (data ?? []).length > 0
}

/**
 * The source ids of `kind` that an earlier import of this workspace (done,
 * failed part-way or running) made and still has (never undone, or kept by
 * its undo because someone changed it), so a second import skips them.
 */
export async function alreadyImported(svc: SupabaseClient, workspaceId: string, kind: ItemKind, externalIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < externalIds.length; i += CHUNK) {
    const { data, error } = await svc
      .from('work_import_item')
      .select('external_id')
      .eq('workspace_id', workspaceId)
      .eq('kind', kind)
      .eq('outcome', 'created')
      .or('undone_at.is.null,undo_outcome.eq.kept')
      .in('external_id', externalIds.slice(i, i + CHUNK))
    fail(error)
    for (const r of (data ?? []) as Array<{ external_id: string | null }>) if (r.external_id) out.add(r.external_id)
  }
  return out
}
