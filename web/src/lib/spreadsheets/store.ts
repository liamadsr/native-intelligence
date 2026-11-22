/**
 * Spreadsheets in the database (migration 675). Every function takes the
 * caller's own client, so the table's row policies decide who reads and
 * writes: a workspace spreadsheet is every member's, a private one its
 * maker's. A spreadsheet somebody may not read is "not found" to them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sheetNameProblem } from './a1'
import { loadModel, newModel } from './engine-server'
import {
  DEFAULT_SPREADSHEET_TITLE,
  MAX_WORKBOOK_BASE64,
  SPREADSHEET_COLUMNS,
  SPREADSHEET_SUMMARY_COLUMNS,
  type SpreadsheetEditSource,
  type SpreadsheetExtras,
  type SpreadsheetRecord,
  type SpreadsheetSummary,
  type SpreadsheetVisibility,
} from './types'
import { listSheets, saveWorkbook, workbookDigest } from './workbook'

export type StoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'invalid' | 'not_found' | 'conflict' | 'failed'; message: string; current?: SpreadsheetSummary }

const refuse = (reason: 'invalid' | 'not_found' | 'conflict' | 'failed', message: string) =>
  ({ ok: false as const, reason, message })

export function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const title = value.replace(/\s+/g, ' ').trim()
  if (!title || title.length > 300) return null
  return title
}

export function isVisibility(value: unknown): value is SpreadsheetVisibility {
  return value === 'workspace' || value === 'private'
}

/**
 * What a saved workbook says about itself: its sheet names and its words.
 * Loading it is also the check that the bytes ARE a workbook; null when they
 * are not.
 */
export function describeWorkbook(workbook: string): { sheetNames: string[]; digest: string } | null {
  try {
    const model = loadModel(workbook)
    try {
      model.evaluate()
      return { sheetNames: listSheets(model).map((s) => s.name), digest: workbookDigest(model) }
    } finally {
      model.free()
    }
  } catch {
    return null
  }
}

/** A new workbook: one sheet, named as given. */
export function blankWorkbook(sheetName = 'Sheet1'): string {
  const model = newModel()
  try {
    if (sheetName !== 'Sheet1' && !sheetNameProblem(sheetName)) model.renameSheet(0, sheetName)
    return saveWorkbook(model)
  } finally {
    model.free()
  }
}

export async function listSpreadsheets(
  supabase: SupabaseClient,
  workspaceId: string,
  options: { archived?: boolean; limit?: number } = {},
): Promise<SpreadsheetSummary[]> {
  const { data, error } = await supabase
    .from('spreadsheet')
    .select(SPREADSHEET_SUMMARY_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('status', options.archived ? 'archived' : 'active')
    .order('updated_at', { ascending: false })
    .limit(Math.min(Math.max(options.limit ?? 200, 1), 500))
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as SpreadsheetSummary[]
}

export async function getSpreadsheet(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<SpreadsheetRecord | null> {
  const { data, error } = await supabase
    .from('spreadsheet')
    .select(SPREADSHEET_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as unknown as SpreadsheetRecord | null) ?? null
}

export async function getSpreadsheetSummary(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<SpreadsheetSummary | null> {
  const { data, error } = await supabase
    .from('spreadsheet')
    .select(SPREADSHEET_SUMMARY_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as unknown as SpreadsheetSummary | null) ?? null
}

export interface CreateSpreadsheetInput {
  workspaceId: string
  memberId: string
  title?: unknown
  visibility?: unknown
  /** A workbook to start from (an import, a copy). A blank one when absent. */
  workbook?: string
  extras?: SpreadsheetExtras
  editSource?: SpreadsheetEditSource
}

export async function createSpreadsheet(
  supabase: SupabaseClient,
  input: CreateSpreadsheetInput,
): Promise<StoreResult<SpreadsheetRecord>> {
  const title = input.title === undefined || input.title === '' ? DEFAULT_SPREADSHEET_TITLE : cleanTitle(input.title)
  if (!title) return refuse('invalid', 'A spreadsheet name is 1 to 300 characters.')
  if (input.visibility !== undefined && !isVisibility(input.visibility)) {
    return refuse('invalid', 'A spreadsheet is for the workspace or private.')
  }
  const workbook = input.workbook ?? blankWorkbook()
  if (workbook.length > MAX_WORKBOOK_BASE64) return refuse('invalid', 'That workbook is too large to store.')
  const described = describeWorkbook(workbook)
  if (!described) return refuse('invalid', 'That is not a workbook this app can open.')
  const { data, error } = await supabase
    .from('spreadsheet')
    .insert({
      workspace_id: input.workspaceId,
      title,
      created_by: input.memberId,
      last_edited_by: input.memberId,
      visibility: input.visibility ?? 'workspace',
      workbook,
      extras: input.extras ?? {},
      edit_source: input.editSource ?? 'human',
      sheet_names: described.sheetNames,
      digest: described.digest,
    })
    .select(SPREADSHEET_COLUMNS)
    .single()
  if (error || !data) return refuse('failed', error?.message ?? 'Could not create the spreadsheet.')
  return { ok: true, value: data as unknown as SpreadsheetRecord }
}

export interface SaveSpreadsheetInput {
  workspaceId: string
  memberId: string
  /** The revision the writer loaded. A different one in the database refuses the save. */
  baseRevision: number
  workbook?: string
  extras?: SpreadsheetExtras
  title?: unknown
  editSource?: SpreadsheetEditSource
  summary?: string | null
}

/**
 * Save the workbook, its extras or its title, all or nothing, against the
 * revision the writer read. `conflict` carries the row as it is now, so the
 * writer can say who got there first and reload.
 */
export async function saveSpreadsheet(
  supabase: SupabaseClient,
  id: string,
  input: SaveSpreadsheetInput,
): Promise<StoreResult<SpreadsheetSummary>> {
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 1) {
    return refuse('invalid', 'A save names the revision it was made from.')
  }
  const patch: Record<string, unknown> = {
    last_edited_by: input.memberId,
    edit_source: input.editSource ?? 'human',
    edit_summary: input.summary ?? null,
  }
  if (input.title !== undefined) {
    const title = cleanTitle(input.title)
    if (!title) return refuse('invalid', 'A spreadsheet name is 1 to 300 characters.')
    patch.title = title
  }
  if (input.extras !== undefined) {
    if (!input.extras || typeof input.extras !== 'object' || Array.isArray(input.extras)) {
      return refuse('invalid', 'Extras are an object.')
    }
    patch.extras = input.extras
  }
  if (input.workbook !== undefined) {
    if (typeof input.workbook !== 'string' || !input.workbook) return refuse('invalid', 'A save carries the workbook.')
    if (input.workbook.length > MAX_WORKBOOK_BASE64) return refuse('invalid', 'That workbook is too large to store.')
    const described = describeWorkbook(input.workbook)
    if (!described) return refuse('invalid', 'That is not a workbook this app can open.')
    patch.workbook = input.workbook
    patch.sheet_names = described.sheetNames
    patch.digest = described.digest
  }
  const { data, error } = await supabase
    .from('spreadsheet')
    .update(patch)
    .eq('workspace_id', input.workspaceId)
    .eq('id', id)
    .eq('revision', input.baseRevision)
    .select(SPREADSHEET_SUMMARY_COLUMNS)
  if (error) return refuse('failed', error.message)
  const saved = (data ?? [])[0] as unknown as SpreadsheetSummary | undefined
  if (saved) return { ok: true, value: saved }
  const current = await getSpreadsheetSummary(supabase, input.workspaceId, id)
  if (!current) return refuse('not_found', 'Spreadsheet not found.')
  return {
    ok: false,
    reason: 'conflict',
    message: 'Someone else changed this spreadsheet since you opened it.',
    current,
  }
}

/** Rename, archive or restore, and change who sees it. None of these needs the revision. */
export async function updateSpreadsheetMeta(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  memberId: string,
  patch: { title?: unknown; visibility?: unknown; status?: unknown },
): Promise<StoreResult<SpreadsheetSummary>> {
  const current = await getSpreadsheetSummary(supabase, workspaceId, id)
  if (!current) return refuse('not_found', 'Spreadsheet not found.')
  const next: Record<string, unknown> = {}
  if (patch.title !== undefined) {
    const title = cleanTitle(patch.title)
    if (!title) return refuse('invalid', 'A spreadsheet name is 1 to 300 characters.')
    next.title = title
    next.last_edited_by = memberId
  }
  if (patch.visibility !== undefined) {
    if (!isVisibility(patch.visibility)) return refuse('invalid', 'A spreadsheet is for the workspace or private.')
    // Only its maker makes it private, or opens it up again: to anyone else a private one does not exist.
    if (patch.visibility !== current.visibility && current.created_by !== memberId) {
      return refuse('invalid', 'Only the person who made a spreadsheet changes who sees it.')
    }
    next.visibility = patch.visibility
  }
  if (patch.status !== undefined) {
    if (patch.status !== 'active' && patch.status !== 'archived') return refuse('invalid', 'A spreadsheet is active or archived.')
    next.status = patch.status
  }
  if (!Object.keys(next).length) return { ok: true, value: current }
  const { data, error } = await supabase
    .from('spreadsheet')
    .update(next)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .select(SPREADSHEET_SUMMARY_COLUMNS)
  if (error) return refuse('failed', error.message)
  const saved = (data ?? [])[0] as unknown as SpreadsheetSummary | undefined
  if (!saved) return refuse('not_found', 'Spreadsheet not found.')
  return { ok: true, value: saved }
}

export async function deleteSpreadsheet(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<StoreResult<{ id: string }>> {
  const { data, error } = await supabase
    .from('spreadsheet')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .select('id')
  if (error) return refuse('failed', error.message)
  if (!(data ?? []).length) return refuse('not_found', 'Spreadsheet not found, or not yours to delete.')
  return { ok: true, value: { id } }
}
