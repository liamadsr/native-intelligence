// Stored files. Storage caps one object's size and a recording is larger, so a file (a blob) is kept as numbered
// parts under one key, `<workspace>/<key>/<n>` in the studio bucket, and studio_blob records how many there are and
// how long each is. Writing one is three steps: ask for upload links (one per part, recorded as a pending write),
// PUT each part, then commit (every part is checked to be there at its size before the row is written). Reading
// one gives a signed link per part, to be joined in order (files.ts joins them for the browser).
//
// Keys are always inside the caller's workspace: a key never carries a workspace id.
import { randomUUID } from 'node:crypto'
import { BlobKey, STUDIO_PART_BYTES, blobObject, blobParts, type BlobRead, type BlobWrite } from './job-contract'
import { must, type StudioContext } from './context'
import { conflictError, notFoundError, StudioError } from './errors'
import { allowedType } from './media-types'
import { supabaseStorage, type StudioStorage } from './storage'

export type StoredBlob = { key: string; bytes: number; parts: number; partBytes: number; contentType: string; sha256: string | null }

/** A pending write, kept until it is committed (studio_record, collection PENDING). */
export type PendingWrite = { bytes: number; partBytes: number; contentType: string; sha256: string | null; createdAt: string; token?: string }
/** The studio_record collection pending writes are kept in (sweep.ts clears old ones; migration 625 sums them). */
export const PENDING = 'blob-writes'

/** How long upload and read links last. */
export const READ_LINK_SECONDS = 3600

/** The storage a context writes to. */
export const storageOf = (ctx: StudioContext): StudioStorage => ctx.storage ?? supabaseStorage(ctx.supabase)

/** The key, checked (a relative path without `..`), or a 400. */
export function checkBlobKey(key: unknown): string {
  const parsed = BlobKey.safeParse(key)
  if (!parsed.success) throw new StudioError('That is not a file key.', 400, 'INVALID')
  return parsed.data
}

type BlobRow = { key: string; bytes: number | string; parts: number; part_bytes: number | string; content_type: string; sha256: string | null }
const fromRow = (row: BlobRow): StoredBlob => ({
  key: row.key,
  bytes: Number(row.bytes),
  parts: row.parts,
  partBytes: Number(row.part_bytes),
  contentType: row.content_type,
  sha256: row.sha256,
})

/** The committed blob under a key, or null. */
export async function getBlob(ctx: StudioContext, key: string): Promise<StoredBlob | null> {
  const row = must(
    await ctx.supabase.from('studio_blob').select('key, bytes, parts, part_bytes, content_type, sha256').eq('workspace_id', ctx.workspaceId).eq('key', checkBlobKey(key)).maybeSingle(),
    'read that file',
  ) as BlobRow | null
  return row ? fromRow(row) : null
}

/** What a workspace's Studio may hold by default: 50 GB (STUDIO_WORKSPACE_BYTES sets another limit). */
export const DEFAULT_WORKSPACE_BYTES = 50 * 1024 ** 3

/** The byte limit of one workspace's Studio, from STUDIO_WORKSPACE_BYTES (a positive whole number), else 50 GB. */
export function workspaceByteLimit(env: Record<string, string | undefined> = process.env): number {
  const set = Number(env.STUDIO_WORKSPACE_BYTES ?? '')
  return Number.isSafeInteger(set) && set > 0 ? set : DEFAULT_WORKSPACE_BYTES
}

/** Bytes as a person reads them: "12.3 GB", "640 MB". */
const readable = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`)

/**
 * What a workspace's Studio holds now: its stored files plus the writes still pending. One indexed aggregate
 * (studio_workspace_bytes, migration 625); before that migration is applied, the same sum read row by row.
 */
export async function workspaceBytes(ctx: StudioContext): Promise<number> {
  const { data, error } = await ctx.supabase.rpc('studio_workspace_bytes', { p_workspace: ctx.workspaceId })
  if (!error) return Number(data) || 0
  if (error.code !== 'PGRST202' && error.code !== '42883') must({ data: null, error }, 'check the space left')
  let total = 0
  for (let from = 0; ; from += 1000) {
    const rows = must(await ctx.supabase.from('studio_blob').select('bytes').eq('workspace_id', ctx.workspaceId).order('key').range(from, from + 999), 'check the space left') as { bytes: number | string }[] | null
    for (const row of rows ?? []) total += Number(row.bytes) || 0
    if ((rows?.length ?? 0) < 1000) break
  }
  const pending = must(await ctx.supabase.from('studio_record').select('value').eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).limit(5000), 'check the space left') as { value: PendingWrite }[] | null
  for (const row of pending ?? []) total += Number(row.value?.bytes) || 0
  return total
}

/** The refusal (413) for a write of `bytes` that would take the workspace (holding `used` without it) past its limit. */
function quotaError(used: number, limit: number, bytes: number): StudioError {
  return new StudioError(
    `This workspace's Studio holds ${readable(used)} of its ${readable(limit)}, and this file needs ${readable(bytes)} more. Remove media or exports you no longer need, then try again.`,
    413,
    'QUOTA',
  )
}

/** Refuse (413) a write of `bytes` that would take the workspace past its limit, with what it holds and the limit. */
export async function checkSpace(ctx: StudioContext, bytes: number): Promise<void> {
  const limit = workspaceByteLimit()
  const used = await workspaceBytes(ctx)
  if (used + bytes > limit) throw quotaError(used, limit, bytes)
}

/**
 * Hold space for a write before checking it: the pending write is recorded first (it counts in workspaceBytes), then
 * the workspace's total, this write included, must be within the limit, else the record is taken back and the write
 * refused (413). Two writes at once each see the other, so together they never pass the limit (at worst both are
 * refused and tried again). `token` marks this write's record, so taking it back never removes a newer one.
 */
async function reserveSpace(ctx: StudioContext, key: string, pending: Omit<PendingWrite, 'token'>): Promise<void> {
  const token = randomUUID()
  must(
    await ctx.supabase.from('studio_record').upsert({ workspace_id: ctx.workspaceId, collection: PENDING, key, value: { ...pending, token }, updated_at: new Date().toISOString() }, { onConflict: 'workspace_id,collection,key' }),
    'prepare the upload',
  )
  const limit = workspaceByteLimit()
  let used: number
  try {
    used = await workspaceBytes(ctx)
  } catch (error) {
    await takeBack(ctx, key, token)
    throw error
  }
  if (used <= limit) return
  await takeBack(ctx, key, token)
  throw quotaError(used - pending.bytes, limit, pending.bytes)
}

/** Remove this write's own pending record (best effort: the sweep clears what is left). */
async function takeBack(ctx: StudioContext, key: string, token: string): Promise<void> {
  const { error } = await ctx.supabase.from('studio_record').delete().eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).eq('key', key).eq('value->>token', token)
  if (error) console.error('[studio] taking back a pending write failed:', error.message?.slice(0, 300))
}

/** Upload links for a file of `bytes`, one per part; commitBlob records it once every part is up. */
export async function createBlobWrite(
  ctx: StudioContext,
  input: { key: string; bytes: number; contentType: string; sha256?: string | null; partBytes?: number },
): Promise<BlobWrite> {
  const key = checkBlobKey(input.key)
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) throw new StudioError('A file size is a whole number of bytes.')
  const partBytes = input.partBytes ?? STUDIO_PART_BYTES
  // Only a media type the Studio serves inline is kept (media-types.ts); anything else is stored as opaque bytes.
  const contentType = allowedType(input.contentType)
  await reserveSpace(ctx, key, { bytes: input.bytes, partBytes, contentType, sha256: input.sha256 ?? null, createdAt: new Date().toISOString() })
  const parts = blobParts(input.bytes, partBytes)
  const storage = storageOf(ctx)
  // One part keeps its real type (served straight from storage); parts of a larger file are opaque bytes.
  const partType = parts.length === 1 ? contentType : 'application/octet-stream'
  const signed = await Promise.all(parts.map((part) => storage.signUpload(blobObject(ctx.workspaceId, key, part.index), partType)))
  return { key, partBytes, parts: parts.map((part, i) => ({ ...part, url: signed[i]!.url, headers: signed[i]!.headers })) }
}

/** Forget a pending write under a key (its record only; the parts it may have sent are the committed file's own). */
export async function dropPendingWrite(ctx: StudioContext, key: string): Promise<void> {
  must(await ctx.supabase.from('studio_record').delete().eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).eq('key', checkBlobKey(key)), 'record the upload')
}

/** Record an uploaded file once every part is in storage at its size. Committing twice is fine. */
export async function commitBlob(ctx: StudioContext, key: string): Promise<StoredBlob> {
  key = checkBlobKey(key)
  const pendingRow = must(
    await ctx.supabase.from('studio_record').select('value').eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).eq('key', key).maybeSingle(),
    'check the upload',
  ) as { value: PendingWrite } | null
  if (!pendingRow) {
    const existing = await getBlob(ctx, key)
    if (existing) return existing
    throw notFoundError('Nothing was uploaded under that key.')
  }
  const pending = pendingRow.value
  const parts = blobParts(pending.bytes, pending.partBytes)
  const storage = storageOf(ctx)
  const listed = await storage.list(`${ctx.workspaceId}/${key}`)
  const sizes = new Map(listed.map((item) => [item.name, item.size]))
  for (const part of parts) {
    const size = sizes.get(String(part.index))
    if (size === undefined) throw conflictError(`The upload is not complete: part ${part.index + 1} of ${parts.length} is missing.`, 'UPLOAD_INCOMPLETE')
    if (size !== part.bytes) throw conflictError(`The upload is not complete: part ${part.index + 1} of ${parts.length} has ${size} bytes, not ${part.bytes}.`, 'UPLOAD_INCOMPLETE')
  }
  // Parts left from an earlier, longer file under the same key.
  const stale = listed.filter((item) => /^\d+$/.test(item.name) && Number(item.name) >= parts.length).map((item) => `${ctx.workspaceId}/${key}/${item.name}`)
  if (stale.length) await storage.remove(stale).catch(() => undefined)
  const row = {
    workspace_id: ctx.workspaceId,
    key,
    bytes: pending.bytes,
    parts: parts.length,
    part_bytes: pending.partBytes,
    // Checked again: a write prepared before the allowlist may name any type.
    content_type: allowedType(pending.contentType),
    sha256: pending.sha256,
  }
  must(await ctx.supabase.from('studio_blob').upsert(row, { onConflict: 'workspace_id,key' }), 'record the upload')
  must(await ctx.supabase.from('studio_record').delete().eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).eq('key', key), 'record the upload')
  return fromRow({ ...row, part_bytes: row.part_bytes, content_type: row.content_type })
}

/** Signed links to a committed blob's parts, in order. */
export async function blobPartUrls(ctx: StudioContext, blob: StoredBlob, seconds = READ_LINK_SECONDS, download?: string): Promise<string[]> {
  const paths = Array.from({ length: blob.parts }, (_, index) => blobObject(ctx.workspaceId, blob.key, index))
  return storageOf(ctx).signRead(paths, seconds, download)
}

/** A committed blob as the worker reads it: a link per part. 404 when there is none. */
export async function readBlob(ctx: StudioContext, key: string, seconds = READ_LINK_SECONDS): Promise<BlobRead> {
  const blob = await getBlob(ctx, key)
  if (!blob) throw notFoundError('There is no file under that key.')
  const urls = await blobPartUrls(ctx, blob, seconds)
  const shape = blobParts(blob.bytes, blob.partBytes)
  return { key: blob.key, bytes: blob.bytes, contentType: blob.contentType, sha256: blob.sha256, parts: shape.map((part, i) => ({ ...part, url: urls[i]! })) }
}

/** Remove a blob: its parts and its row (and any pending write under the key). Missing is fine. */
export async function deleteBlob(ctx: StudioContext, key: string): Promise<void> {
  key = checkBlobKey(key)
  const blob = await getBlob(ctx, key)
  const storage = storageOf(ctx)
  const listed = await storage.list(`${ctx.workspaceId}/${key}`).catch(() => [])
  const names = new Set(listed.map((item) => item.name))
  for (let index = 0; index < (blob?.parts ?? 0); index++) names.add(String(index))
  await storage.remove([...names].map((name) => `${ctx.workspaceId}/${key}/${name}`))
  must(await ctx.supabase.from('studio_blob').delete().eq('workspace_id', ctx.workspaceId).eq('key', key), 'remove that file')
  must(await ctx.supabase.from('studio_record').delete().eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).eq('key', key), 'remove that file')
}

/** Store bytes the app holds itself under a key (parts as needed) and record it. Space is held first (reserveSpace). */
export async function putBlobBytes(ctx: StudioContext, key: string, bytes: Uint8Array, stated: string, sha256: string | null = null): Promise<StoredBlob> {
  key = checkBlobKey(key)
  const contentType = allowedType(stated)
  await reserveSpace(ctx, key, { bytes: bytes.byteLength, partBytes: STUDIO_PART_BYTES, contentType, sha256, createdAt: new Date().toISOString() })
  const parts = blobParts(bytes.byteLength)
  const storage = storageOf(ctx)
  for (const part of parts) {
    const start = part.index * STUDIO_PART_BYTES
    await storage.upload(blobObject(ctx.workspaceId, key, part.index), bytes.subarray(start, start + part.bytes), parts.length === 1 ? contentType : 'application/octet-stream')
  }
  const row = { workspace_id: ctx.workspaceId, key, bytes: bytes.byteLength, parts: parts.length, part_bytes: STUDIO_PART_BYTES, content_type: contentType, sha256 }
  must(await ctx.supabase.from('studio_blob').upsert(row, { onConflict: 'workspace_id,key' }), 'store that file')
  await dropPendingWrite(ctx, key)
  return { key, bytes: bytes.byteLength, parts: parts.length, partBytes: STUDIO_PART_BYTES, contentType, sha256 }
}

// ---- the worker's writes ----------------------------------------------------------------------------------------

/** A library file's key: `assets/<sha256>.<ext>`, the name of its bytes. */
export const ASSET_KEY = /^assets\/([0-9a-f]{64})\.[a-z0-9]{1,8}$/

/** What the fence knows of the job a worker holds: its id, its kind, and the thumbnail job's given key. */
export type WritingJob = { id: string; kind: string; input?: Record<string, unknown> | null }

/**
 * Whether a key is one of the job's own: under its folders (`exports/<id>/`, `stills/<id>/`, `checks/<id>/`,
 * `listen/<id>/`, `ads/<id>/`), or the key a thumbnail job was given. Pure.
 */
export function jobOwnsKey(job: WritingJob, key: string): boolean {
  if (['exports', 'stills', 'checks', 'listen', 'ads'].some((folder) => key.startsWith(`${folder}/${job.id}/`))) return true
  return job.kind === 'thumbnail' && typeof job.input?.key === 'string' && job.input.key === key
}

/**
 * The fence on a worker's write (blobs/write and blobs/commit). A key no file is committed under may be written; a
 * committed one only when it is the job's own (jobOwnsKey: a re-run of the job writes there again). A library file
 * (`assets/<sha256>.<ext>`) is named by its bytes: its write must state that hash, and when it is committed already
 * the write is answered `exists` (the same key is the same bytes; nothing is sent again, so a re-run of an import
 * still works). Anything else is refused (409): a worker holding one job can't replace another's files.
 */
export async function workerWriteFence(ctx: StudioContext, job: WritingJob, key: string, write: { sha256?: string | null } | null = null): Promise<{ exists: StoredBlob | null }> {
  key = checkBlobKey(key)
  const asset = ASSET_KEY.exec(key)
  if (asset && write && write.sha256 !== asset[1]) throw conflictError('A library file is stored under the hash of its bytes: state that hash.', 'NOT_YOURS')
  const committed = await getBlob(ctx, key)
  if (!committed || jobOwnsKey(job, key)) return { exists: null }
  if (asset && committed.sha256 === asset[1]) return { exists: committed }
  throw conflictError("That file is stored already, and this job may not replace it.", 'NOT_YOURS')
}

/** The uploads key for a new browser upload. */
export const uploadKey = (id: string) => `uploads/${id}`
