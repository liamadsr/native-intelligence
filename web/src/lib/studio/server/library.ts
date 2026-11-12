// The editor's Browser, in a workspace: two fixed places instead of folders on a Mac.
//
//   library   the Studio library (studio_asset): every video, image and sound, newest first. Adding one joins it to
//             the open video as it is.
//   files     the workspace's own Files (attachments uploaded to captures, actions and projects): the ones the person
//             may see, through the same two fences as the Files page (lib/attachments/workspace-files.ts: the
//             attachments RLS on the person's own client, then each file's record labelled through their RLS).
//             Adding one copies its bytes into a Studio upload and queues an import job, which makes it a library
//             asset (the same file twice is the same asset).
//
// Answers keep the shapes the Browser panel reads (places, entries, info). Server only.
import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EditorAsset } from '../engine/contracts'
import type { EditorJob } from '../engine/api'
import { resolveEntityLabels } from '@/lib/knowledge/graph-map/source'
import { fileParentOf } from '@/lib/attachments/workspace-files'
import { putBlobBytes, uploadKey } from './blobs'
import { isUuid, must, type StudioContext } from './context'
import { notFoundError, StudioError } from './errors'
import { fileUrl, queueJob, toEditorJob, waitForJob } from './jobs'

export type BrowserKind = 'folder' | 'video' | 'image' | 'audio' | 'font' | 'document' | 'other'
export type BrowserPlaceId = 'library' | 'files'
export type BrowserPlace = { id: BrowserPlaceId; name: string; path: string; available: boolean }
export type BrowserEntry = { name: string; path: string; kind: BrowserKind; size?: number; modified?: number; thumbnail?: boolean; placeId?: string; placeName?: string }
export type BrowserInfo = { kind: BrowserKind; size: number; modified?: number; width?: number; height?: number; durationSeconds?: number; hasAudio?: boolean; codec?: string }

/** The two places, always in this order. `path` is empty: there are no folders to show. */
export const PLACES: BrowserPlace[] = [
  { id: 'library', name: 'Studio library', path: '', available: true },
  { id: 'files', name: 'Workspace files', path: '', available: true },
]

/** The place a request names, or a 404. */
export function placeOf(value: unknown): BrowserPlace {
  const place = PLACES.find((p) => p.id === value)
  if (!place) throw notFoundError('That place is not in the Browser.')
  return place
}

/** A kind filter from the query (only the kinds a place can hold), or null for all. */
export function kindFilter(value: unknown): 'video' | 'image' | 'audio' | 'other' | null {
  if (value === 'video' || value === 'image' || value === 'audio') return value
  // Fonts and documents are not addable here: a filter on them shows nothing.
  if (value === 'font' || value === 'document') return 'other'
  return null
}

/** Most entries a listing returns. */
const LIST_LIMIT = 500
/** Largest workspace file copied into the Studio (attachments are capped well under this). */
export const FILE_IMPORT_MAX_BYTES = 200 * 1024 * 1024
/** How long adding a workspace file waits for its import before answering the job instead. */
const IMPORT_WAIT_MS = 45_000

const likeLiteral = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

// ---- the Studio library ------------------------------------------------------------------------------------

type AssetRow = { meta: EditorAsset; created_at: string }

/** A library asset as a Browser entry (its id is its path). */
export function assetEntry(asset: EditorAsset, createdAt?: string): BrowserEntry {
  return {
    name: asset.name,
    path: asset.id,
    kind: asset.kind,
    size: asset.bytes,
    ...(createdAt ? { modified: Date.parse(createdAt) } : {}),
    // Images draw their own thumbnail; a video or a sound shows its icon (no poster is stored for a library asset).
    thumbnail: asset.kind === 'image',
  }
}

/** The library, newest first, optionally narrowed to a kind and a part of the name. */
export async function libraryEntries(ctx: StudioContext, options: { q?: string; kind?: string | null } = {}): Promise<BrowserEntry[]> {
  const kind = kindFilter(options.kind)
  if (kind === 'other') return []
  let read = ctx.supabase.from('studio_asset').select('meta, created_at').eq('workspace_id', ctx.workspaceId)
  if (kind) read = read.eq('kind', kind)
  const q = options.q?.trim().slice(0, 200)
  if (q) read = read.ilike('name', `%${likeLiteral(q)}%`)
  const rows = must(await read.order('created_at', { ascending: false }).limit(LIST_LIMIT), 'read the media library') as AssetRow[] | null
  return (rows ?? []).map((row) => assetEntry(row.meta, row.created_at))
}

/** Library images, newest first (the Background panel's "Your images"). */
export async function libraryAssets(ctx: StudioContext, kind?: string | null): Promise<EditorAsset[]> {
  const only = kindFilter(kind)
  if (only === 'other') return []
  let read = ctx.supabase.from('studio_asset').select('meta, created_at').eq('workspace_id', ctx.workspaceId)
  if (only) read = read.eq('kind', only)
  const rows = must(await read.order('created_at', { ascending: false }).limit(LIST_LIMIT), 'read the media library') as AssetRow[] | null
  return (rows ?? []).map((row) => row.meta)
}

/** One library asset by id, or 404. */
export async function libraryAsset(ctx: StudioContext, id: string): Promise<EditorAsset> {
  if (!id || id.length > 200) throw notFoundError('That media is not in the library.')
  const row = must(await ctx.supabase.from('studio_asset').select('meta').eq('workspace_id', ctx.workspaceId).eq('id', id).maybeSingle(), 'read the media library') as { meta: EditorAsset } | null
  if (!row) throw notFoundError('That media is not in the library.')
  return row.meta
}

/** What the Browser's preview shows of a library asset. */
export function assetInfo(asset: EditorAsset): BrowserInfo {
  return {
    kind: asset.kind,
    size: asset.bytes,
    ...(asset.width ? { width: asset.width, height: asset.height } : {}),
    ...(asset.durationSeconds ? { durationSeconds: asset.durationSeconds } : {}),
    hasAudio: asset.hasAudio,
    codec: asset.file.split('.').at(-1),
  }
}

// ---- workspace files ---------------------------------------------------------------------------------------

/** An attachment row, as far as this file reads it. */
export type AttachmentRow = {
  id: string
  workspace_id: string
  file_name: string
  file_size_bytes: number | null
  mime_type: string | null
  file_extension: string | null
  storage_bucket: string | null
  storage_path: string | null
  thumbnail_path: string | null
  note_id: string | null
  action_id: string | null
  project_id: string | null
  created_at: string
}
const FILE_FIELDS = 'id, workspace_id, file_name, file_size_bytes, mime_type, file_extension, storage_bucket, storage_path, thumbnail_path, note_id, action_id, project_id, created_at'

const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v', 'mkv'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp'])

/** What a workspace file is to the Studio: an image it can use, a video or a sound, or something else. */
export function attachmentKind(row: Pick<AttachmentRow, 'mime_type' | 'file_extension' | 'file_name'>): BrowserKind {
  const mime = (row.mime_type ?? '').toLowerCase()
  const ext = (row.file_extension || row.file_name.split('.').at(-1) || '').toLowerCase()
  // The Studio's import takes PNG, JPEG and WebP stills; a GIF, an SVG or a HEIC photo is not one it can use.
  if (IMAGE_EXT.has(ext) && (!mime || mime.startsWith('image/'))) return 'image'
  if (mime.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video'
  if (mime.startsWith('audio/') || AUDIO_EXT.has(ext)) return 'audio'
  if (mime.startsWith('image/')) return 'other'
  return 'document'
}

/** The rows of a page the person may see: those whose record (capture, action, project) their RLS labels. */
async function fenced(session: SupabaseClient, workspaceId: string, rows: AttachmentRow[]): Promise<AttachmentRow[]> {
  const byType = new Map<string, Set<string>>()
  for (const row of rows) {
    const parent = fileParentOf(row)
    if (!parent) continue
    const ids = byType.get(parent.type) ?? new Set<string>()
    ids.add(parent.id)
    byType.set(parent.type, ids)
  }
  const labels = byType.size ? await resolveEntityLabels(session, workspaceId, byType) : new Map<string, string>()
  return rows.filter((row) => {
    const parent = fileParentOf(row)
    return row.workspace_id === workspaceId && !!parent && labels.has(`${parent.type}:${parent.id}`)
  })
}

/** An attachment as a Browser entry. */
export function attachmentEntry(row: AttachmentRow): BrowserEntry {
  const kind = attachmentKind(row)
  return {
    name: row.file_name,
    path: row.id,
    kind,
    ...(row.file_size_bytes != null ? { size: Number(row.file_size_bytes) } : {}),
    modified: Date.parse(row.created_at),
    thumbnail: kind === 'image',
  }
}

/**
 * The workspace files the person may see that the Studio can use (images, and any video or sound), newest first.
 * `session` is the person's own client: the attachments RLS is the first fence.
 */
export async function fileEntries(session: SupabaseClient, workspaceId: string, options: { q?: string; kind?: string | null } = {}): Promise<BrowserEntry[]> {
  const kind = kindFilter(options.kind)
  if (kind === 'other') return []
  let read = session.from('attachments').select(FILE_FIELDS).eq('workspace_id', workspaceId)
  if (kind === 'image') read = read.like('mime_type', 'image/%')
  else if (kind) read = read.like('mime_type', `${kind}/%`)
  else read = read.or('mime_type.like.image/*,mime_type.like.video/*,mime_type.like.audio/*')
  const q = options.q?.trim().slice(0, 200)
  if (q) read = read.ilike('file_name', `%${likeLiteral(q)}%`)
  const { data, error } = await read.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(LIST_LIMIT)
  if (error) {
    console.error('[studio] reading workspace files failed:', error.message)
    throw new StudioError("Couldn't read the workspace's files just now. Try again.", 500, 'INTERNAL')
  }
  const visible = await fenced(session, workspaceId, (data ?? []) as AttachmentRow[])
  return visible.map(attachmentEntry).filter((entry) => entry.kind === 'image' || entry.kind === 'video' || entry.kind === 'audio').filter((entry) => !kind || entry.kind === kind)
}

/** One workspace file the person may see (both fences), or 404. */
export async function visibleFile(session: SupabaseClient, workspaceId: string, id: string): Promise<AttachmentRow> {
  if (!isUuid(id)) throw notFoundError('That file is not in this workspace.')
  const { data, error } = await session.from('attachments').select(FILE_FIELDS).eq('workspace_id', workspaceId).eq('id', id).maybeSingle()
  if (error) {
    console.error('[studio] reading a workspace file failed:', error.message)
    throw new StudioError("Couldn't read that file just now. Try again.", 500, 'INTERNAL')
  }
  const [row] = data ? await fenced(session, workspaceId, [data as AttachmentRow]) : []
  if (!row) throw notFoundError('That file is not in this workspace.')
  return row
}

/** What the Browser's preview shows of a workspace file. */
export function fileInfo(row: AttachmentRow): BrowserInfo {
  return { kind: attachmentKind(row), size: Number(row.file_size_bytes ?? 0), modified: Date.parse(row.created_at), ...(row.file_extension ? { codec: row.file_extension } : {}) }
}

/** A short-lived link to a workspace file (or its thumbnail), for the preview. */
export async function fileLink(ctx: StudioContext, row: AttachmentRow, thumbnail = false): Promise<string> {
  const path = (thumbnail && row.thumbnail_path) || row.storage_path
  if (!path) throw notFoundError('That file has nothing stored.')
  const { data, error } = await ctx.supabase.storage.from(row.storage_bucket || 'attachments').createSignedUrl(path, 300)
  if (error || !data?.signedUrl) {
    console.error('[studio] signing a workspace file failed:', error?.message)
    throw new StudioError("Couldn't open that file just now. Try again.", 500, 'INTERNAL')
  }
  return data.signedUrl
}

/** Where the browser reads a library asset from: the workspace's file route. */
export const assetLink = (ctx: StudioContext, asset: EditorAsset) => fileUrl(ctx.workspaceId, asset.file)

/** The library asset already made of these bytes, if any. */
async function assetBySha(ctx: StudioContext, sha256: string): Promise<EditorAsset | null> {
  const rows = must(await ctx.supabase.from('studio_asset').select('meta').eq('workspace_id', ctx.workspaceId).eq('sha256', sha256).limit(1), 'read the media library') as { meta: EditorAsset }[] | null
  return rows?.[0]?.meta ?? null
}

/**
 * Add a workspace file to the Studio library: checked through the person's own client (`session`), its bytes copied
 * from the attachments bucket into a Studio upload, then imported by the worker. Answers the asset once it is in the
 * library (at once when the same bytes already are), or the import job while it is still running.
 */
export async function importWorkspaceFile(ctx: StudioContext, session: SupabaseClient, id: string, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<{ asset: EditorAsset } | { job: EditorJob }> {
  const row = await visibleFile(session, ctx.workspaceId, id)
  const kind = attachmentKind(row)
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') throw new StudioError('Only images, video and sound can be added to a video.')
  if (!row.storage_path) throw notFoundError('That file has nothing stored.')
  if (Number(row.file_size_bytes ?? 0) > FILE_IMPORT_MAX_BYTES) throw new StudioError('That file is too large to add.', 413, 'TOO_LARGE')
  const { data, error } = await ctx.supabase.storage.from(row.storage_bucket || 'attachments').download(row.storage_path)
  if (error || !data) {
    console.error('[studio] reading a workspace file failed:', error?.message)
    throw new StudioError("Couldn't read that file just now. Try again.", 500, 'INTERNAL')
  }
  if (data.size > FILE_IMPORT_MAX_BYTES) throw new StudioError('That file is too large to add.', 413, 'TOO_LARGE')
  const bytes = new Uint8Array(await data.arrayBuffer())
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const existing = await assetBySha(ctx, sha256)
  if (existing) return { asset: existing }
  const key = uploadKey(randomUUID())
  await putBlobBytes(ctx, key, bytes, row.mime_type || data.type || 'application/octet-stream', sha256)
  const job = await queueJob(ctx, 'import', { uploadKey: key, name: row.file_name.slice(0, 250), provenance: { workspaceFile: row.id } })
  const done = await waitForJob(ctx, job.id, { timeoutMs: options.waitMs ?? IMPORT_WAIT_MS, everyMs: 700, signal: options.signal })
  if (done.status === 'completed' && done.result?.asset) return { asset: done.result.asset as EditorAsset }
  if (done.status === 'failed') throw new StudioError(done.error || 'That file could not be imported.')
  if (done.status === 'cancelled') throw new StudioError('The import was cancelled.')
  return { job: toEditorJob(done) }
}

/** Add a library asset to the open video: nothing to import, it is answered as it is. */
export async function importLibraryAsset(ctx: StudioContext, id: string): Promise<{ asset: EditorAsset }> {
  return { asset: await libraryAsset(ctx, id) }
}
