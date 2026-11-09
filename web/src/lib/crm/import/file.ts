/**
 * A contact file the owner sent (roadmap track G1): a spreadsheet (CSV or
 * Excel) or phone contacts (vCard), from a chat upload or a texted
 * attachment (both land in the person's own chat-uploads folder), read into
 * records the importer takes.
 *
 *   readContactFile   bytes + name → a sheet with its column mapping, or
 *                     cards. The export of a tool it knows (QuickBooks,
 *                     Stripe, Square…: ./sources/export-layouts.ts) maps
 *                     itself and imports as that app. The old binary .xls
 *                     and anything else is refused with what to send instead.
 *   loadOwnUpload     the bytes of a file in the caller's own chat-uploads
 *                     folder, and nothing else (the same guard as
 *                     read_chat_file: a crafted path never reads another
 *                     person's files).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isOwnChatUploadPath, MAX_CHAT_UPLOAD_BYTES } from '@/lib/chat/upload-allowlist'
import { IMPORT_SOURCE_LABEL, type ImportContactRecord, type ImportRelationship, type ImportSource } from './record'
import { detectExportLayout, type ExportLayout } from './sources/export-layouts'
import { autoMapColumns, parseCsv, readXlsx, rowsToRecords, unmappedColumns, type ColumnMapping, type Sheet } from './sources/spreadsheet'
import { looksLikeVcard, MAX_CARDS, parseVcards } from './sources/vcard'

/** The file extensions an import reads. */
export const CONTACT_FILE_EXTENSIONS = ['csv', 'tsv', 'txt', 'xlsx', 'vcf', 'vcard'] as const

export type ContactFile =
  | { ok: true; format: 'spreadsheet'; source: ImportSource; sheet: Sheet; mappings: ColumnMapping[]; layout: ExportLayout | null }
  | { ok: true; format: 'vcard'; source: ImportSource; cards: ImportContactRecord[] }
  | { ok: false; error: string }

/**
 * A text file's characters: UTF-16 by its byte-order mark (Excel's "Unicode
 * text"), UTF-8 when it is valid UTF-8, else Windows-1252 (Excel's plain
 * "CSV" on Windows), so "José" survives either way.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Read a contact file. `columns` overrides the header mapping (header → field). */
export async function readContactFile(bytes: Uint8Array, fileName: string, columns: Record<string, string> = {}): Promise<ContactFile> {
  const ext = fileExtension(fileName)
  try {
    if (ext === 'xls') return { ok: false, error: 'That is the old Excel format (.xls). Ask them to save it as .xlsx or CSV ("Save As" in Excel) and send it again.' }
    if (ext === 'xlsx') return spreadsheet(await readXlsx(bytes), fileName, columns)
    const text = decodeText(bytes)
    if (ext === 'vcf' || ext === 'vcard' || looksLikeVcard(text)) {
      const cards = parseVcards(text)
      if (cards.length === 0) return { ok: false, error: 'That contacts file has no cards in it.' }
      return { ok: true, format: 'vcard', source: 'vcard', cards }
    }
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt' || ext === '') {
      const sheet = parseCsv(text, ext === 'tsv' ? '\t' : undefined)
      if (sheet.rows.length === 0) return { ok: false, error: 'That file has a header row but no rows under it.' }
      return spreadsheet(sheet, fileName, columns)
    }
    return { ok: false, error: `A .${ext} file can't be imported. Send a CSV, an Excel file (.xlsx) or contacts (.vcf).` }
  } catch (err) {
    return { ok: false, error: `That file could not be read: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** A sheet, as a known tool's export (its app the source) or anyone's own spreadsheet. */
function spreadsheet(sheet: Sheet, fileName: string, columns: Record<string, string>): ContactFile {
  const layout = detectExportLayout(sheet.headers, fileName.split('/').pop() ?? fileName)
  return { ok: true, format: 'spreadsheet', source: layout?.app ?? 'spreadsheet', sheet, mappings: autoMapColumns(sheet, columns, layout), layout }
}

/**
 * The records a read file imports. Unmapped columns are left out. With no
 * `relationship` given: a known tool's export takes its own default (a
 * billing or field-service tool's people are customers, a CRM's or a mailing
 * list's are not all), anyone's own spreadsheet is their customers (an
 * owner's list almost always is), and phone contacts are mixed.
 */
export function contactFileRecords(file: Extract<ContactFile, { ok: true }>, relationship?: ImportRelationship): ImportContactRecord[] {
  if (file.format === 'vcard') return file.cards.map((card) => (relationship ? { ...card, relationship } : card))
  const fallback = file.layout ? (file.layout.relationship ?? undefined) : 'customer'
  return rowsToRecords(file.sheet, file.mappings, { relationship: relationship ?? fallback, skipRow: file.layout?.skipRow, cell: file.layout?.cell })
}

/** What the agent shows (and asks about) before importing. */
export function contactFilePreview(file: Extract<ContactFile, { ok: true }>) {
  if (file.format === 'vcard') {
    return {
      format: 'vcard' as const,
      app: null,
      rows: file.cards.length,
      truncated: file.cards.length >= MAX_CARDS,
      sample: file.cards.slice(0, 3).map((c) => ({ name: c.fullName, emails: c.emails, phones: c.phones })),
      unmapped: [] as Array<{ header: string; samples: string[] }>,
    }
  }
  const column = (m: ColumnMapping) => `#${file.mappings.indexOf(m) + 1}`
  return {
    format: 'spreadsheet' as const,
    /** The tool it is an export of ("Stripe"), when it is one: every column is mapped. */
    app: file.layout ? IMPORT_SOURCE_LABEL[file.layout.app] : null,
    rows: file.layout?.skipRow ? file.sheet.rows.filter((row) => !file.layout!.skipRow!(row)).length : file.sheet.rows.length,
    // Past MAX_SHEET_ROWS the rest is left out: say so to the owner.
    truncated: file.sheet.truncated === true,
    columns: file.mappings.map((m) => ({ column: column(m), header: m.header, field: m.target ?? 'unmapped', samples: m.samples })),
    unmapped: unmappedColumns(file.mappings).map((m) => ({ column: column(m), header: m.header, samples: m.samples })),
  }
}

/** A file in the caller's own chat-uploads folder, as bytes. */
export async function loadOwnUpload(supabase: SupabaseClient, userId: string, storagePath: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  if (!isOwnChatUploadPath(userId, storagePath)) return { ok: false, error: 'storage_path must be a file they sent you (in their chat-uploads folder).' }
  const { data, error } = await supabase.storage.from('attachments').download(storagePath)
  if (error || !data) return { ok: false, error: error?.message || 'The file could not be downloaded.' }
  const buffer = new Uint8Array(await data.arrayBuffer())
  if (buffer.byteLength > MAX_CHAT_UPLOAD_BYTES) return { ok: false, error: 'That file is over 10 MB. Ask for a smaller export (or one sheet of it).' }
  return { ok: true, bytes: buffer }
}
