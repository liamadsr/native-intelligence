export type SpreadsheetVisibility = 'workspace' | 'private'
export type SpreadsheetStatus = 'active' | 'archived'
export type SpreadsheetEditSource = 'human' | 'agent' | 'system'

/** A spreadsheet without its workbook: what lists, search and cards read. */
export interface SpreadsheetSummary {
  id: string
  workspace_id: string
  title: string
  created_by: string | null
  last_edited_by: string | null
  visibility: SpreadsheetVisibility
  status: SpreadsheetStatus
  revision: number
  sheet_names: string[]
  created_at: string
  updated_at: string
}

/** What the engine does not hold: charts, dropdowns, tables, view options. */
export type SpreadsheetExtras = Record<string, unknown>

export interface SpreadsheetRecord extends SpreadsheetSummary {
  /** The engine's saved workbook, base64. Null only for a row made by hand. */
  workbook: string | null
  extras: SpreadsheetExtras
}

export const SPREADSHEET_SUMMARY_COLUMNS =
  'id, workspace_id, title, created_by, last_edited_by, visibility, status, revision, sheet_names, created_at, updated_at'
export const SPREADSHEET_COLUMNS = `${SPREADSHEET_SUMMARY_COLUMNS}, workbook, extras`

export const DEFAULT_SPREADSHEET_TITLE = 'Untitled spreadsheet'
/** The database's ceiling (675) is 24 MB of base64; refuse a little under it with a sentence. */
export const MAX_WORKBOOK_BASE64 = 24 * 1024 * 1024
export const MAX_DIGEST_CHARS = 200_000
