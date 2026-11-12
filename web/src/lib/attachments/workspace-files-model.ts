/**
 * The Files page's shapes (Liam, 11-11: "Drive: Docs, Knowledge, and a new
 * page that shows all available files that were uploaded anywhere in the app,
 * uploaded to captures or action items or projects"): what GET
 * /api/account/files takes and answers, and the categories its filter offers.
 * The read itself is ./workspace-files.ts (server); the page is
 * components/chat-cards/pages/files-card.tsx.
 *
 * Client-safe and pure.
 */

/** The `file_category` values an attachment is filed under (./constants.ts fileCategory). */
export const FILE_CATEGORIES = ['image', 'document'] as const
export type FileCategory = (typeof FILE_CATEGORIES)[number]

/** The filter's choices, in its order: every category there is (All is no category). */
export const FILE_CATEGORY_LABELS: Readonly<Record<FileCategory, string>> = {
  image: 'Images',
  document: 'Documents',
}

export function isFileCategory(value: unknown): value is FileCategory {
  return typeof value === 'string' && (FILE_CATEGORIES as readonly string[]).includes(value)
}

/** The record a file is attached to: a capture, an action or a project (the first of note_id, action_id, project_id). */
export type FileParentType = 'capture' | 'action' | 'project'

export interface FileParent {
  type: FileParentType
  id: string
  /** Its name, read through the viewer's own RLS (a record they can't read never gets here). */
  label: string
}

/** One file as the page lists it. */
export interface WorkspaceFile {
  id: string
  file_name: string
  file_size_bytes: number | null
  mime_type: string | null
  file_extension: string | null
  file_category: string | null
  storage_path: string | null
  thumbnail_path: string | null
  created_at: string
  parent: FileParent
}

/** A page of files, newest first; `next_offset` null at the end. */
export interface WorkspaceFilesPage {
  files: WorkspaceFile[]
  next_offset: number | null
}

export interface WorkspaceFilesQuery {
  limit: number
  offset: number
  category?: FileCategory
  /** A part of the file's name. */
  q?: string
}

export const FILES_PAGE_SIZE = 50
export const FILES_PAGE_MAX = 100
/** The deepest a page may start: past it, narrow the search instead. */
export const FILES_OFFSET_MAX = 10_000
const Q_MAX = 200

/** The query string's own words, checked: limit (1..100, 50), offset (0..10000), category, q. */
export function parseFilesQuery(params: URLSearchParams): { ok: true; query: WorkspaceFilesQuery } | { ok: false; error: string } {
  const int = (name: string, fallback: number, min: number, max: number): number | null => {
    const raw = params.get(name)
    if (raw === null || raw === '') return fallback
    if (!/^\d+$/.test(raw)) return null
    const n = Number(raw)
    return n < min || n > max ? null : n
  }
  const limit = int('limit', FILES_PAGE_SIZE, 1, FILES_PAGE_MAX)
  if (limit === null) return { ok: false, error: `limit must be a whole number from 1 to ${FILES_PAGE_MAX}` }
  const offset = int('offset', 0, 0, FILES_OFFSET_MAX)
  if (offset === null) return { ok: false, error: `offset must be a whole number from 0 to ${FILES_OFFSET_MAX}` }
  const category = params.get('category') || undefined
  if (category !== undefined && !isFileCategory(category)) return { ok: false, error: `category must be one of ${FILE_CATEGORIES.join(', ')}` }
  const q = (params.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, Q_MAX)
  return { ok: true, query: { limit, offset, ...(category ? { category } : {}), ...(q ? { q } : {}) } }
}

/** The URL for a page of files. */
export function filesUrl(query: Partial<WorkspaceFilesQuery>): string {
  const params = new URLSearchParams()
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset) params.set('offset', String(query.offset))
  if (query.category) params.set('category', query.category)
  if (query.q) params.set('q', query.q)
  const s = params.toString()
  return s ? `/api/account/files?${s}` : '/api/account/files'
}

/** "2.4 MB", "820 KB", "12 B"; empty when unknown. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}
