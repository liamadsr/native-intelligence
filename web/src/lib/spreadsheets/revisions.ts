/**
 * A spreadsheet's history (spreadsheet_revision, migration 675): one entry a
 * change, the workbook as it became, written by the database's trigger (one
 * person's run of saves within ten minutes is one entry). Read with the
 * caller's own client: its row policy shows the history of what they read.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendStructure, readExtras } from './extras'
import { getSpreadsheet, saveSpreadsheet, type StoreResult } from './store'
import type { SpreadsheetSummary } from './types'

export interface RevisionSummary {
  id: string
  spreadsheet_id: string
  revision: number
  title: string
  sheet_names: string[]
  author_id: string | null
  author_kind: 'human' | 'agent' | 'system'
  change_summary: string | null
  created_at: string
  updated_at: string
  /** The author's name, when the member can be read. */
  author_name: string | null
}

export interface RevisionRecord extends RevisionSummary {
  workbook: string | null
}

const SUMMARY = 'id, spreadsheet_id, revision, title, sheet_names, author_id, author_kind, change_summary, created_at, updated_at'

async function authorNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const wanted = [...new Set(ids.filter(Boolean))]
  if (!wanted.length) return names
  const { data } = await supabase.from('member').select('id, display_name').in('id', wanted)
  for (const row of (data ?? []) as Array<{ id: string; display_name?: string | null }>) {
    const name = (row.display_name ?? '').trim()
    if (name) names.set(row.id, name)
  }
  return names
}

export async function listRevisions(supabase: SupabaseClient, spreadsheetId: string, limit = 100): Promise<RevisionSummary[]> {
  const { data, error } = await supabase
    .from('spreadsheet_revision')
    .select(SUMMARY)
    .eq('spreadsheet_id', spreadsheetId)
    .order('revision', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200))
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as unknown as Array<Omit<RevisionSummary, 'author_name'>>
  const names = await authorNames(supabase, rows.map((r) => r.author_id ?? ''))
  // A list never carries a workbook, whatever the client returned.
  return rows.map((r) => {
    const { workbook: _workbook, ...entry } = r as typeof r & { workbook?: unknown }
    return { ...entry, author_name: r.author_id ? (names.get(r.author_id) ?? null) : null }
  })
}

export async function getRevision(supabase: SupabaseClient, spreadsheetId: string, revisionId: string): Promise<RevisionRecord | null> {
  const { data, error } = await supabase
    .from('spreadsheet_revision')
    .select(`${SUMMARY}, workbook`)
    .eq('spreadsheet_id', spreadsheetId)
    .eq('id', revisionId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const row = data as unknown as Omit<RevisionRecord, 'author_name'>
  const names = await authorNames(supabase, [row.author_id ?? ''])
  return { ...row, author_name: row.author_id ? (names.get(row.author_id) ?? null) : null }
}

/** Save an old version's workbook as the spreadsheet's current one. */
export async function restoreRevision(
  supabase: SupabaseClient,
  input: { workspaceId: string; memberId: string; spreadsheetId: string; revisionId: string; baseRevision: number },
): Promise<StoreResult<SpreadsheetSummary>> {
  const current = await getSpreadsheet(supabase, input.workspaceId, input.spreadsheetId)
  if (!current) return { ok: false, reason: 'not_found', message: 'Spreadsheet not found.' }
  const revision = await getRevision(supabase, input.spreadsheetId, input.revisionId)
  if (!revision || !revision.workbook) return { ok: false, reason: 'not_found', message: 'That version is not there.' }
  // Restoring an old workbook moves everything: a `reset` entry tells any editor
  // based on an older revision that its unsaved edits cannot be placed by the log.
  const extras = readExtras(current.extras)
  const { structure, structureFloor } = appendStructure(extras.structure, extras.structureFloor, [
    { base: input.baseRevision, sheetId: 0, type: 'reset' },
  ])
  return saveSpreadsheet(supabase, input.spreadsheetId, {
    workspaceId: input.workspaceId,
    memberId: input.memberId,
    baseRevision: input.baseRevision,
    workbook: revision.workbook,
    extras: { ...extras, structure, structureFloor },
    summary: `Restored the version of ${revision.created_at.slice(0, 10)}`,
  })
}
