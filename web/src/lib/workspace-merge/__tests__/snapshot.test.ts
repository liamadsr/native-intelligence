/**
 * The paged snapshot of the source workspace that the merge route stores
 * before merge_workspace runs: keyset pages followed by cursor until done,
 * object paths, the manifest written last, the first failure stopping
 * everything (the merge never runs without a complete snapshot), the rows
 * written checked against the manifest, and the cleanup of a snapshot whose
 * merge did not happen.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  snapshotObjectPath,
  snapshotObjectPaths,
  snapshotWorkspace,
  removeSnapshot,
  SnapshotError,
  SNAPSHOT_BUCKET,
  SNAPSHOT_FILE_LIMIT,
  SNAPSHOT_PAGE_BYTES,
  type ExportPage,
  type SnapshotClient,
} from '../snapshot'

const WS = '11111111-1111-4111-8111-111111111111'

type Result = { data: unknown; error: { message: string } | null }

/** A table as the fake database holds it: pages served in order, each a full ExportPage. */
type FakeTable = ExportPage[]

function fakeClient(opts: {
  manifest?: Result
  tables?: Record<string, FakeTable>
  rowsError?: (table: string, call: number) => string | null
  bucketExists?: boolean
  createBucketError?: string
  uploadError?: (path: string) => string | null
  removeError?: string
}) {
  const calls: Record<string, number> = {}
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>): Promise<Result> => {
    if (fn === 'export_workspace_manifest') return opts.manifest ?? { data: [{ table: 'workspace', rows: 1 }], error: null }
    if (fn === 'export_workspace_rows') {
      const table = args.p_table as string
      const n = calls[table] ?? 0
      calls[table] = n + 1
      const err = opts.rowsError?.(table, n) ?? null
      if (err) return { data: null, error: { message: err } }
      const pages = opts.tables?.[table] ?? [{ rows: table === 'workspace' ? [{ id: WS }] : [], count: 0, bytes: 0, cursor: null, done: true }]
      return { data: pages[Math.min(n, pages.length - 1)], error: null }
    }
    throw new Error(`unexpected rpc ${fn}`)
  })
  const upload = vi.fn(async (path: string, _body: string, _opts: { contentType: string; upsert: boolean }) => {
    const err = opts.uploadError?.(path) ?? null
    return { data: err ? null : { path }, error: err ? { message: err } : null }
  })
  const remove = vi.fn(async (_paths: string[]) => ({ data: [], error: opts.removeError ? { message: opts.removeError } : null }))
  let exists = opts.bucketExists ?? true
  const getBucket = vi.fn(async () => (exists ? { data: { id: SNAPSHOT_BUCKET }, error: null } : { data: null, error: { message: 'not found' } }))
  const createBucket = vi.fn(async () => {
    if (opts.createBucketError) return { data: null, error: { message: opts.createBucketError } }
    exists = true
    return { data: { name: SNAPSHOT_BUCKET }, error: null }
  })
  const from = vi.fn(() => ({ upload, remove }))
  const client: SnapshotClient = { rpc, storage: { getBucket, createBucket, from } }
  return { client, rpc, upload, remove, getBucket, createBucket, from }
}

const page = (rows: unknown[], cursor: Record<string, unknown> | null, done: boolean): ExportPage => ({
  rows,
  count: rows.length,
  bytes: JSON.stringify(rows).length,
  cursor,
  done,
})

describe('snapshotObjectPath(s)', () => {
  it('zero-pads the page so files sort, and lists every object a summary names', () => {
    expect(snapshotObjectPath(`${WS}/snap`, 'actions', 0)).toBe(`${WS}/snap/actions.0000.json`)
    expect(snapshotObjectPath(`${WS}/snap`, 'actions', 12)).toBe(`${WS}/snap/actions.0012.json`)
    expect(
      snapshotObjectPaths({
        prefix: 'p',
        manifest_path: 'p/manifest.json',
        tables: [
          { table: 'a', rows: 3, written: 3, pages: 2 },
          { table: 'b', rows: 0, written: 0, pages: 0 },
        ],
      }),
    ).toEqual(['p/a.0000.json', 'p/a.0001.json', 'p/manifest.json'])
  })
})

describe('snapshotWorkspace', () => {
  it('follows each table’s cursor until done, uploads every page as JSON, and writes the manifest last', async () => {
    const f = fakeClient({
      manifest: {
        data: [
          { table: 'actions', rows: 3 },
          { table: 'capture', rows: 0 },
          { table: 'document', rows: 2 },
          { table: 'workspace', rows: 1 },
        ],
        error: null,
      },
      tables: {
        actions: [page([{ id: 'a1' }, { id: 'a2' }], { id: 'a2' }, false), page([{ id: 'a3' }], { id: 'a3' }, true)],
        capture: [page([], null, true)],
        document: [page([{ id: 'd1' }, { id: 'd2' }], { id: 'd2' }, false), page([], null, true)],
        workspace: [page([{ id: WS }], { id: WS }, true)],
      },
    })
    const summary = await snapshotWorkspace(f.client, WS, { snapshotId: 'snap', pageBytes: 4096 })

    expect(f.rpc).toHaveBeenCalledWith('export_workspace_manifest', { p_workspace: WS })
    expect(f.rpc.mock.calls.filter(([fn]) => fn === 'export_workspace_rows').map(([, a]) => a)).toEqual([
      { p_workspace: WS, p_table: 'actions', p_after: null, p_max_bytes: 4096 },
      { p_workspace: WS, p_table: 'actions', p_after: { id: 'a2' }, p_max_bytes: 4096 },
      { p_workspace: WS, p_table: 'capture', p_after: null, p_max_bytes: 4096 },
      { p_workspace: WS, p_table: 'document', p_after: null, p_max_bytes: 4096 },
      { p_workspace: WS, p_table: 'document', p_after: { id: 'd2' }, p_max_bytes: 4096 },
      { p_workspace: WS, p_table: 'workspace', p_after: null, p_max_bytes: 4096 },
    ])
    expect(f.from).toHaveBeenCalledWith(SNAPSHOT_BUCKET)
    const uploads = f.upload.mock.calls
    expect(uploads.map(([p]) => p)).toEqual([
      `${WS}/snap/actions.0000.json`,
      `${WS}/snap/actions.0001.json`,
      `${WS}/snap/document.0000.json`,
      `${WS}/snap/workspace.0000.json`,
      `${WS}/snap/manifest.json`,
    ])
    expect(JSON.parse(uploads[1][1])).toEqual([{ id: 'a3' }])
    expect(uploads[0][2]).toEqual({ contentType: 'application/json', upsert: true })

    expect(summary).toMatchObject({
      bucket: SNAPSHOT_BUCKET,
      prefix: `${WS}/snap`,
      snapshot_id: 'snap',
      manifest_path: `${WS}/snap/manifest.json`,
      page_bytes: 4096,
      tables: [
        { table: 'actions', rows: 3, written: 3, pages: 2 },
        { table: 'capture', rows: 0, written: 0, pages: 0 },
        { table: 'document', rows: 2, written: 2, pages: 1 },
        { table: 'workspace', rows: 1, written: 1, pages: 1 },
      ],
      total_rows: 6,
      total_pages: 4,
    })
    expect(JSON.parse(uploads[4][1])).toEqual(summary)
  })

  it('defaults to 20 MB pages under a 50 MB file limit', async () => {
    const f = fakeClient({})
    await snapshotWorkspace(f.client, WS, { snapshotId: 'snap' })
    expect(f.rpc).toHaveBeenCalledWith('export_workspace_rows', expect.objectContaining({ p_max_bytes: SNAPSHOT_PAGE_BYTES }))
    expect(SNAPSHOT_PAGE_BYTES).toBe(20 * 1024 * 1024)
    expect(SNAPSHOT_FILE_LIMIT).toBe(50 * 1024 * 1024)
  })

  it('rows written since the manifest are fine; rows missing are not', async () => {
    const more = fakeClient({
      manifest: { data: [{ table: 'actions', rows: 1 }, { table: 'workspace', rows: 1 }], error: null },
      tables: { actions: [page([{ id: 'a1' }, { id: 'a2' }], { id: 'a2' }, true)] },
    })
    const ok = await snapshotWorkspace(more.client, WS, { snapshotId: 'snap' })
    expect(ok.tables[0]).toEqual({ table: 'actions', rows: 1, written: 2, pages: 1 })

    const fewer = fakeClient({
      manifest: { data: [{ table: 'actions', rows: 3 }, { table: 'workspace', rows: 1 }], error: null },
      tables: { actions: [page([{ id: 'a1' }], { id: 'a1' }, true)] },
    })
    await expect(snapshotWorkspace(fewer.client, WS)).rejects.toMatchObject({ step: 'incomplete' })
    expect(fewer.upload.mock.calls.map(([p]) => p)).not.toContain(expect.stringContaining('manifest.json'))
  })

  it('refuses a manifest that is not a list, has a malformed entry, or lacks the workspace row', async () => {
    for (const data of [{ nope: true }, [{ table: 'actions' }], [{ table: 'actions', rows: 2 }], []]) {
      const f = fakeClient({ manifest: { data, error: null } })
      await expect(snapshotWorkspace(f.client, WS), JSON.stringify(data)).rejects.toMatchObject({ step: 'manifest' })
      expect(f.upload).not.toHaveBeenCalled()
    }
  })

  it('refuses a page it cannot read: a bad shape, an empty page that is not the last, a missing cursor', async () => {
    const shape = fakeClient({ tables: { workspace: [{ rows: 'nope' } as unknown as ExportPage] } })
    await expect(snapshotWorkspace(shape.client, WS)).rejects.toMatchObject({ step: 'rows', message: expect.stringContaining('unexpected page shape') })

    const empty = fakeClient({ tables: { workspace: [page([], null, false)] } })
    await expect(snapshotWorkspace(empty.client, WS)).rejects.toMatchObject({ step: 'rows', message: expect.stringContaining('not the last') })

    const noCursor = fakeClient({ tables: { workspace: [page([{ id: WS }], null, false)] } })
    await expect(snapshotWorkspace(noCursor.client, WS)).rejects.toMatchObject({ step: 'rows', message: expect.stringContaining('no cursor') })
  })

  it('a page over the file limit stops the snapshot before storage would refuse it', async () => {
    const f = fakeClient({ tables: { workspace: [page([{ id: WS, blob: 'x'.repeat(2000) }], { id: WS }, true)] } })
    await expect(snapshotWorkspace(f.client, WS, { fileLimit: 1024 })).rejects.toMatchObject({ step: 'oversized' })
    expect(f.upload).not.toHaveBeenCalled()
  })

  it('creates the private JSON-only bucket when it is missing, and leaves it alone when it exists', async () => {
    const missing = fakeClient({ bucketExists: false })
    await snapshotWorkspace(missing.client, WS, { snapshotId: 'snap' })
    expect(missing.createBucket).toHaveBeenCalledWith(SNAPSHOT_BUCKET, {
      public: false,
      fileSizeLimit: SNAPSHOT_FILE_LIMIT,
      allowedMimeTypes: ['application/json'],
    })

    const present = fakeClient({ bucketExists: true })
    await snapshotWorkspace(present.client, WS, { snapshotId: 'snap' })
    expect(present.createBucket).not.toHaveBeenCalled()
  })

  it('a bucket that cannot be created nor found stops before any export', async () => {
    const f = fakeClient({ bucketExists: false, createBucketError: 'denied' })
    await expect(snapshotWorkspace(f.client, WS)).rejects.toMatchObject({ name: 'SnapshotError', step: 'bucket' })
    expect(f.rpc).not.toHaveBeenCalled()
  })

  it('a failing page export or upload stops the snapshot: no manifest is written', async () => {
    const rows = fakeClient({
      manifest: { data: [{ table: 'actions', rows: 4 }, { table: 'workspace', rows: 1 }], error: null },
      tables: { actions: [page([{ id: 'a1' }], { id: 'a1' }, false)] },
      rowsError: (table, call) => (table === 'actions' && call === 1 ? 'boom' : null),
    })
    const err = await snapshotWorkspace(rows.client, WS, { snapshotId: 'snap' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SnapshotError)
    expect((err as SnapshotError).step).toBe('rows')
    expect((err as SnapshotError).message).toContain('actions page 1')
    expect(rows.upload.mock.calls.map(([p]) => p)).not.toContain(`${WS}/snap/manifest.json`)

    const up = fakeClient({ uploadError: (path) => (path.endsWith('workspace.0000.json') ? 'storage down' : null) })
    await expect(snapshotWorkspace(up.client, WS)).rejects.toMatchObject({ step: 'upload' })

    const man = fakeClient({ manifest: { data: null, error: { message: 'no' } } })
    await expect(snapshotWorkspace(man.client, WS)).rejects.toMatchObject({ step: 'manifest' })
    expect(man.upload).not.toHaveBeenCalled()
  })
})

describe('removeSnapshot', () => {
  const summary = {
    prefix: 'p',
    manifest_path: 'p/manifest.json',
    tables: [{ table: 'a', rows: 2, written: 2, pages: 2 }],
  }

  it('removes every page and the manifest, in chunks', async () => {
    const f = fakeClient({})
    expect(await removeSnapshot(f.client, summary)).toBe(3)
    expect(f.remove).toHaveBeenCalledWith(['p/a.0000.json', 'p/a.0001.json', 'p/manifest.json'])
  })

  it('is best effort: a storage error is logged, not thrown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = fakeClient({ removeError: 'down' })
    expect(await removeSnapshot(f.client, summary)).toBe(0)
  })
})
