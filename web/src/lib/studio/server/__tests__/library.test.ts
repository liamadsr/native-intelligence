import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase } from './fake-supabase'

// The second fence: which records the person's RLS labels. Tests say which ones are readable.
const readable = new Set<string>()
vi.mock('@/lib/knowledge/graph-map/source', () => ({
  resolveEntityLabels: vi.fn(async (_s: unknown, _w: string, byType: Map<string, Set<string>>) => {
    const out = new Map<string, string>()
    for (const [type, ids] of byType) for (const id of ids) if (readable.has(`${type}:${id}`)) out.set(`${type}:${id}`, `A ${type}`)
    return out
  }),
}))
const stored: string[] = []
vi.mock('../blobs', () => ({
  uploadKey: (id: string) => `uploads/${id}`,
  putBlobBytes: vi.fn(async (_ctx: unknown, key: string) => { stored.push(key); return { key } }),
}))
const queued: unknown[] = []
const jobFinish = { status: 'completed' as string, result: null as unknown }
vi.mock('../jobs', () => ({
  fileUrl: (workspaceId: string, key: string) => `/api/account/studio/file/${workspaceId}/${key}`,
  queueJob: vi.fn(async (_ctx: unknown, kind: string, input: unknown) => { queued.push({ kind, input }); return { id: 'job-1' } }),
  waitForJob: vi.fn(async () => ({ id: 'job-1', kind: 'import', status: jobFinish.status, result: jobFinish.result, error: null })),
  toEditorJob: (row: { id: string }) => ({ id: row.id, kind: 'import', status: 'running', progress: 0, logs: [] }),
}))

import { assetEntry, attachmentKind, fileEntries, importLibraryAsset, importWorkspaceFile, kindFilter, libraryEntries, placeOf, visibleFile, type AttachmentRow } from '../library'
import type { StudioContext } from '../context'
import type { EditorAsset } from '../../engine/contracts'

const WS = '11111111-2222-4333-8444-555555555555'
const OTHER_WS = '99999999-2222-4333-8444-555555555555'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const asset = (name: string, kind: EditorAsset['kind'], at: string): { workspace_id: string; id: string; name: string; kind: string; sha256: string; created_at: string; meta: EditorAsset } => {
  const hash = sha(name)
  const ext = kind === 'image' ? 'png' : kind === 'audio' ? 'm4a' : 'mp4'
  return { workspace_id: WS, id: hash, name, kind, sha256: hash, created_at: at, meta: { id: hash, name, kind, file: `assets/${hash}.${ext}`, sha256: hash, bytes: 1000, hasAudio: kind !== 'image', sourceCursorHidden: false } }
}
const file = (id: string, name: string, mime: string | null, parent: Partial<AttachmentRow>, workspace = WS): AttachmentRow => ({
  id, workspace_id: workspace, file_name: name, file_size_bytes: 2048, mime_type: mime, file_extension: name.split('.').at(-1)!, storage_bucket: null,
  storage_path: `user-x/${id}/${name}`, thumbnail_path: null, note_id: null, action_id: null, project_id: null, created_at: '2026-11-01T10:00:00Z', ...parent,
})
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const LIBRARY = [asset('Old intro.mp4', 'video', '2026-10-01T00:00:00Z'), asset('Logo.png', 'image', '2026-11-02T00:00:00Z'), asset('Theme.m4a', 'audio', '2026-11-01T00:00:00Z')]
const FILES = [
  file(uuid(1), 'Storefront.png', 'image/png', { project_id: 'p-1' }),
  file(uuid(2), 'Private capture still.jpg', 'image/jpeg', { note_id: 'c-private' }),
  file(uuid(3), 'Quote.pdf', 'application/pdf', { action_id: 'a-1' }),
  file(uuid(4), 'Loop.gif', 'image/gif', { action_id: 'a-1' }),
  file(uuid(5), 'Other workspace.png', 'image/png', { project_id: 'p-1' }, OTHER_WS),
  file(uuid(6), 'Orphan.png', 'image/png', {}),
]

const ctxWith = (tables: Record<string, Record<string, unknown>[]>, storage?: { download?: () => Promise<{ data: Blob | null; error: unknown }> }) => {
  const { client } = fakeSupabase(tables)
  const supabase = Object.assign(client as object, {
    storage: { from: () => ({ download: storage?.download ?? (async () => ({ data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), error: null })), createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://storage.example/${p}` }, error: null }) }) },
  })
  return { supabase, workspaceId: WS, userId: 'u-1' } as unknown as StudioContext
}

beforeEach(() => {
  readable.clear()
  readable.add('project:p-1').add('action:a-1')
  stored.length = 0
  queued.length = 0
  jobFinish.status = 'completed'
  jobFinish.result = null
})

describe('places and kinds', () => {
  it('has exactly the two places', () => {
    expect(placeOf('library').name).toBe('Studio library')
    expect(placeOf('files').name).toBe('Workspace files')
    expect(() => placeOf('/Users')).toThrow(/not in the Browser/)
  })

  it('reads a filter only as a kind a place can hold', () => {
    expect(kindFilter('video')).toBe('video')
    expect(kindFilter('font')).toBe('other')
    expect(kindFilter(null)).toBeNull()
  })

  it('takes a workspace file as an image only when the Studio can import it', () => {
    expect(attachmentKind({ mime_type: 'image/png', file_extension: 'png', file_name: 'a.png' })).toBe('image')
    expect(attachmentKind({ mime_type: 'image/gif', file_extension: 'gif', file_name: 'a.gif' })).toBe('other')
    expect(attachmentKind({ mime_type: 'video/mp4', file_extension: 'mp4', file_name: 'a.mp4' })).toBe('video')
    expect(attachmentKind({ mime_type: null, file_extension: '', file_name: 'take.m4a' })).toBe('audio')
    expect(attachmentKind({ mime_type: 'application/pdf', file_extension: 'pdf', file_name: 'a.pdf' })).toBe('document')
  })
})

describe('the Studio library', () => {
  it('lists every asset newest first, by kind and by name', async () => {
    const ctx = ctxWith({ studio_asset: LIBRARY })
    expect((await libraryEntries(ctx)).map((e) => e.name)).toEqual(['Logo.png', 'Theme.m4a', 'Old intro.mp4'])
    expect((await libraryEntries(ctx, { kind: 'audio' })).map((e) => e.name)).toEqual(['Theme.m4a'])
    expect((await libraryEntries(ctx, { q: 'logo' })).map((e) => e.name)).toEqual(['Logo.png'])
    expect(await libraryEntries(ctx, { kind: 'document' })).toEqual([])
  })

  it('shows an entry the way the panel reads it, and adds an asset as it is', async () => {
    const logo = LIBRARY[1]!.meta
    expect(assetEntry(logo)).toMatchObject({ name: 'Logo.png', path: logo.id, kind: 'image', size: 1000, thumbnail: true })
    const ctx = ctxWith({ studio_asset: LIBRARY })
    expect(await importLibraryAsset(ctx, logo.id)).toEqual({ asset: logo })
    await expect(importLibraryAsset(ctx, 'not-there')).rejects.toThrow(/not in the library/)
  })
})

describe('workspace files', () => {
  it('lists only the files the person may see, and only what the Studio can use', async () => {
    const { client } = fakeSupabase({ attachments: FILES })
    const entries = await fileEntries(client, WS)
    // Private capture (its record unreadable), the PDF, the GIF, another workspace's file and an orphan are left out.
    expect(entries.map((e) => e.name)).toEqual(['Storefront.png'])
    readable.add('capture:c-private')
    expect((await fileEntries(client, WS, { kind: 'image' })).map((e) => e.name).sort()).toEqual(['Private capture still.jpg', 'Storefront.png'])
    expect(await fileEntries(client, WS, { kind: 'audio' })).toEqual([])
  })

  it('refuses one file outside the fences', async () => {
    const { client } = fakeSupabase({ attachments: FILES })
    await expect(visibleFile(client, WS, uuid(2))).rejects.toThrow(/not in this workspace/)
    await expect(visibleFile(client, WS, uuid(5))).rejects.toThrow(/not in this workspace/)
    await expect(visibleFile(client, WS, 'not-a-uuid')).rejects.toThrow(/not in this workspace/)
    expect((await visibleFile(client, WS, uuid(1))).file_name).toBe('Storefront.png')
  })

  it('imports a file the person may see: its bytes become an upload and an import job', async () => {
    const ctx = ctxWith({ studio_asset: [] })
    const { client: session } = fakeSupabase({ attachments: FILES })
    const made = LIBRARY[1]!.meta
    jobFinish.result = { asset: made }
    expect(await importWorkspaceFile(ctx, session, uuid(1))).toEqual({ asset: made })
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatch(/^uploads\//)
    expect(queued).toEqual([{ kind: 'import', input: { uploadKey: stored[0], name: 'Storefront.png', provenance: { workspaceFile: uuid(1) } } }])
  })

  it('answers the job while the import still runs', async () => {
    const ctx = ctxWith({ studio_asset: [] })
    const { client: session } = fakeSupabase({ attachments: FILES })
    jobFinish.status = 'running'
    expect(await importWorkspaceFile(ctx, session, uuid(1), { waitMs: 1 })).toMatchObject({ job: { id: 'job-1' } })
  })

  it('answers the asset already made of the same bytes without a new job', async () => {
    const bytes = new Uint8Array([7, 7, 7])
    const hash = createHash('sha256').update(bytes).digest('hex')
    const existing = { ...LIBRARY[1]!, sha256: hash, meta: { ...LIBRARY[1]!.meta, sha256: hash } }
    const ctx = ctxWith({ studio_asset: [existing] }, { download: async () => ({ data: new Blob([bytes]), error: null }) })
    const { client: session } = fakeSupabase({ attachments: FILES })
    expect(await importWorkspaceFile(ctx, session, uuid(1))).toEqual({ asset: existing.meta })
    expect(queued).toEqual([])
    expect(stored).toEqual([])
  })

  it('never imports a file outside the fences, or one the Studio cannot use', async () => {
    const ctx = ctxWith({ studio_asset: [] })
    const { client: session } = fakeSupabase({ attachments: FILES })
    await expect(importWorkspaceFile(ctx, session, uuid(2))).rejects.toThrow(/not in this workspace/)
    await expect(importWorkspaceFile(ctx, session, uuid(5))).rejects.toThrow(/not in this workspace/)
    await expect(importWorkspaceFile(ctx, session, uuid(3))).rejects.toThrow(/Only images, video and sound/)
    expect(stored).toEqual([])
    expect(queued).toEqual([])
  })
})
