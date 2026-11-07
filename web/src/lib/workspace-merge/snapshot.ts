/**
 * The snapshot the merge route stores before calling merge_workspace: every
 * table of the source workspace as JSON, paged, in the private
 * `workspace-merges` bucket (migration 407), plus a manifest. The merge itself
 * is all-or-nothing; the snapshot is what makes a wrong RULE recoverable by
 * hand without restoring the whole database (the plan's third safety net).
 *
 * Pages are cut by BYTES along the primary key (keyset), not by row count:
 * on PROD a 5,000-row page of `claim_chunks` or `capture_chunks` is ~95 MB of
 * JSON, twice the bucket's file limit, while a row written during the
 * snapshot would shift an OFFSET page and be skipped or doubled. The database
 * side (`export_workspace_rows(p_workspace, p_table, p_after, p_max_bytes)`,
 * migration 407) returns `{ rows, count, bytes, cursor, done }`; the loop
 * follows `cursor` until `done`, then checks the rows written against the
 * manifest's count. Vectors, search vectors and credential material stay out.
 *
 *   <source workspace id>/<snapshot id>/<table>.<page>.json
 *   <source workspace id>/<snapshot id>/manifest.json
 */
import { randomUUID } from 'node:crypto'

export const SNAPSHOT_BUCKET = 'workspace-merges'
/** JSON bytes a page aims for (the database cuts the page once the running total passes it). */
export const SNAPSHOT_PAGE_BYTES = 20 * 1024 * 1024
/** The bucket's file_size_limit (migration 407): a page over it would be refused by storage. */
export const SNAPSHOT_FILE_LIMIT = 50 * 1024 * 1024
/** A table that needs more pages than this is not a workspace, it is a bug. */
const MAX_PAGES_PER_TABLE = 100_000

export interface SnapshotTable {
  table: string
  rows: number
}

export interface ExportPage {
  rows: unknown[]
  count: number
  bytes: number
  cursor: Record<string, unknown> | null
  done: boolean
}

export interface SnapshotTableSummary extends SnapshotTable {
  /** Rows actually written to the bucket (≥ the manifest's count, or the snapshot failed). */
  written: number
  pages: number
}

export interface SnapshotSummary {
  bucket: string
  prefix: string
  snapshot_id: string
  manifest_path: string
  page_bytes: number
  tables: SnapshotTableSummary[]
  total_rows: number
  total_pages: number
  started_at: string
  finished_at: string
}

/** `<prefix>/<table>.<page>.json`, the page number zero-padded so files sort. Pure. */
export function snapshotObjectPath(prefix: string, table: string, page: number): string {
  return `${prefix}/${table}.${String(page).padStart(4, '0')}.json`
}

/** Every object a summary names (pages, then the manifest), for a cleanup. Pure. */
export function snapshotObjectPaths(summary: Pick<SnapshotSummary, 'prefix' | 'tables' | 'manifest_path'>): string[] {
  const out: string[] = []
  for (const t of summary.tables) {
    for (let page = 0; page < t.pages; page += 1) out.push(snapshotObjectPath(summary.prefix, t.table, page))
  }
  out.push(summary.manifest_path)
  return out
}

type StorageResult = { data: unknown; error: { message: string } | null }

/** The slice of a Supabase service client the exporter uses, so tests can hand in a fake. */
export interface SnapshotClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<StorageResult>
  storage: {
    getBucket: (id: string) => PromiseLike<StorageResult>
    createBucket: (
      id: string,
      opts: { public: boolean; fileSizeLimit?: number; allowedMimeTypes?: string[] },
    ) => PromiseLike<StorageResult>
    from: (bucket: string) => {
      upload: (path: string, body: string, opts: { contentType: string; upsert: boolean }) => PromiseLike<StorageResult>
      remove: (paths: string[]) => PromiseLike<StorageResult>
    }
  }
}

export type SnapshotStep = 'bucket' | 'manifest' | 'rows' | 'oversized' | 'upload' | 'incomplete'

export class SnapshotError extends Error {
  constructor(message: string, readonly step: SnapshotStep) {
    super(message)
    this.name = 'SnapshotError'
  }
}

/** The bucket exists in every environment (DEV, PROD, a preview) even before 407 ran there. */
async function ensureBucket(client: SnapshotClient): Promise<void> {
  const existing = await client.storage.getBucket(SNAPSHOT_BUCKET)
  if (!existing.error && existing.data) return
  const created = await client.storage.createBucket(SNAPSHOT_BUCKET, {
    public: false,
    fileSizeLimit: SNAPSHOT_FILE_LIMIT,
    allowedMimeTypes: ['application/json'],
  })
  if (created.error) {
    // Another call may have created it a moment ago.
    const again = await client.storage.getBucket(SNAPSHOT_BUCKET)
    if (again.error || !again.data) throw new SnapshotError(`bucket: ${created.error.message}`, 'bucket')
  }
}

function readManifest(data: unknown): SnapshotTable[] {
  if (!Array.isArray(data)) throw new SnapshotError('manifest: not a list of tables', 'manifest')
  const tables: SnapshotTable[] = []
  for (const entry of data as unknown[]) {
    const e = entry as { table?: unknown; rows?: unknown }
    if (!e || typeof e.table !== 'string' || typeof e.rows !== 'number' || !Number.isFinite(e.rows)) {
      throw new SnapshotError('manifest: a table entry is malformed', 'manifest')
    }
    tables.push({ table: e.table, rows: e.rows })
  }
  // A workspace always has itself; a manifest without it did not look at this workspace.
  if (!tables.some((t) => t.table === 'workspace' && t.rows >= 1)) {
    throw new SnapshotError('manifest: the workspace row is missing', 'manifest')
  }
  return tables
}

function readPage(table: string, page: number, data: unknown): ExportPage {
  const p = data as Partial<ExportPage> | null
  if (!p || !Array.isArray(p.rows) || typeof p.done !== 'boolean') {
    throw new SnapshotError(`${table} page ${page}: unexpected page shape`, 'rows')
  }
  return {
    rows: p.rows,
    count: typeof p.count === 'number' ? p.count : p.rows.length,
    bytes: typeof p.bytes === 'number' ? p.bytes : 0,
    cursor: p.cursor && typeof p.cursor === 'object' ? (p.cursor as Record<string, unknown>) : null,
    done: p.done,
  }
}

/**
 * Export every table of `workspaceId` into the bucket. Throws SnapshotError on
 * the first failure, so the merge never runs without a complete snapshot.
 */
export async function snapshotWorkspace(
  client: SnapshotClient,
  workspaceId: string,
  opts: { snapshotId?: string; pageBytes?: number; fileLimit?: number } = {},
): Promise<SnapshotSummary> {
  const snapshotId = opts.snapshotId ?? randomUUID()
  const pageBytes = opts.pageBytes ?? SNAPSHOT_PAGE_BYTES
  const fileLimit = opts.fileLimit ?? SNAPSHOT_FILE_LIMIT
  const prefix = `${workspaceId}/${snapshotId}`
  const startedAt = new Date().toISOString()

  await ensureBucket(client)

  const manifest = await client.rpc('export_workspace_manifest', { p_workspace: workspaceId })
  if (manifest.error) throw new SnapshotError(`manifest: ${manifest.error.message}`, 'manifest')
  const tables = readManifest(manifest.data)

  const bucket = client.storage.from(SNAPSHOT_BUCKET)
  const out: SnapshotTableSummary[] = []
  let totalRows = 0
  let totalPages = 0

  for (const t of tables) {
    let cursor: Record<string, unknown> | null = null
    let page = 0
    let written = 0
    for (;;) {
      if (page >= MAX_PAGES_PER_TABLE) throw new SnapshotError(`${t.table}: more than ${MAX_PAGES_PER_TABLE} pages`, 'rows')
      const res = await client.rpc('export_workspace_rows', {
        p_workspace: workspaceId,
        p_table: t.table,
        p_after: cursor,
        p_max_bytes: pageBytes,
      })
      if (res.error) throw new SnapshotError(`${t.table} page ${page}: ${res.error.message}`, 'rows')
      const p = readPage(t.table, page, res.data)

      if (p.rows.length > 0) {
        const body = JSON.stringify(p.rows)
        const bytes = Buffer.byteLength(body)
        if (bytes > fileLimit) {
          throw new SnapshotError(`${t.table} page ${page}: ${bytes} bytes is over the ${fileLimit}-byte file limit`, 'oversized')
        }
        const uploaded = await bucket.upload(snapshotObjectPath(prefix, t.table, page), body, {
          contentType: 'application/json',
          upsert: true,
        })
        if (uploaded.error) throw new SnapshotError(`${t.table} page ${page}: ${uploaded.error.message}`, 'upload')
        written += p.rows.length
        page += 1
      } else if (!p.done) {
        throw new SnapshotError(`${t.table} page ${page}: an empty page that is not the last`, 'rows')
      }

      if (p.done) break
      if (!p.cursor) throw new SnapshotError(`${t.table} page ${page}: no cursor to continue from`, 'rows')
      cursor = p.cursor
    }
    // Rows added since the manifest are fine (keyset paging picks them up); rows missing are not.
    if (written < t.rows) {
      throw new SnapshotError(`${t.table}: ${written} rows exported, ${t.rows} counted`, 'incomplete')
    }
    out.push({ table: t.table, rows: t.rows, written, pages: page })
    totalRows += written
    totalPages += page
  }

  const summary: SnapshotSummary = {
    bucket: SNAPSHOT_BUCKET,
    prefix,
    snapshot_id: snapshotId,
    manifest_path: `${prefix}/manifest.json`,
    page_bytes: pageBytes,
    tables: out,
    total_rows: totalRows,
    total_pages: totalPages,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  }
  const manifestUpload = await bucket.upload(summary.manifest_path, JSON.stringify(summary), {
    contentType: 'application/json',
    upsert: true,
  })
  if (manifestUpload.error) throw new SnapshotError(`manifest: ${manifestUpload.error.message}`, 'upload')
  return summary
}

/**
 * Remove a snapshot whose merge did not happen (the engine refused, or timed
 * out and rolled back): a copy of a workspace that still exists is just
 * storage. Best effort: returns how many objects were asked to go.
 */
export async function removeSnapshot(client: SnapshotClient, summary: Pick<SnapshotSummary, 'prefix' | 'tables' | 'manifest_path'>): Promise<number> {
  const paths = snapshotObjectPaths(summary)
  const bucket = client.storage.from(SNAPSHOT_BUCKET)
  let removed = 0
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100)
    const res = await bucket.remove(chunk)
    if (res.error) {
      console.error('[workspace-merge] snapshot cleanup failed', res.error.message)
      break
    }
    removed += chunk.length
  }
  return removed
}
