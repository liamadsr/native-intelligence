/**
 * The Studio's hourly sweep (../sweep.ts) over the in-memory tables and bucket: what is only on the way somewhere
 * goes once it can't be wanted (an upload link never committed, an upload no job will use, old frames, old
 * exports, long-finished job rows), and nothing else does (the library, a recent upload, one an open job is about
 * to read, a pending write over a committed file). Bounded and idempotent. Made-up workspaces.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getBlob } from '../blobs'
import { handleFile } from '../http'
import { sweepStudio } from '../sweep'
import { fakeContext, OTHER_WS, WS } from './fake'

let env: ReturnType<typeof fakeContext>
const NOW = new Date('2031-06-01T12:00:00Z')
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3600_000).toISOString()
const UP = (n: number) => `uploads/0e0e0e0e-1111-4222-8333-${String(n).padStart(12, '0')}`

/** A committed file of `workspace` under `key`, stored `hoursAgo`. */
function file(key: string, hoursAgo: number, workspace = WS) {
  env.storage.put(`${workspace}/${key}/0`, Uint8Array.from([1, 2, 3]))
  ;(env.tables.studio_blob ??= []).push({ workspace_id: workspace, key, bytes: 3, parts: 1, part_bytes: 32, content_type: 'video/mp4', sha256: null, created_at: ago(hoursAgo) })
}
/** A job row. */
function job(kind: string, status: string, hoursAgo: number, input: Record<string, unknown> = {}, workspace = WS) {
  const id = crypto.randomUUID()
  ;(env.tables.studio_job ??= []).push({ id, workspace_id: workspace, kind, status, input, cancel_requested: false, attempts: 1, created_at: ago(hoursAgo), updated_at: ago(hoursAgo) })
  return id
}
const sweep = (limit?: number) => sweepStudio(env.ctx.supabase, { now: NOW, storage: env.storage, limit })
const has = (key: string, workspace = WS) => getBlob({ ...env.ctx, workspaceId: workspace }, key).then(Boolean)

beforeEach(() => {
  env = fakeContext()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('the Studio sweep', () => {
  it('removes what has had its time, keeps everything else, and does it once', async () => {
    file(`assets/${'a'.repeat(64)}.mp4`, 24 * 400)
    file('thumbs/v.jpg', 24 * 400)
    file(UP(1), 30)
    file(UP(2), 2)
    file(UP(3), 30)
    job('import', 'queued', 30, { uploadKey: UP(3) })
    file(UP(4), 2)
    job('slides', 'failed', 1, { uploadKey: UP(4) })
    file(UP(5), 30, OTHER_WS)
    file('stills/j1/0.png', 24 * 8)
    file('stills/j2/0.png', 24 * 2)
    file('exports/j1/1/video.mp4', 24 * 31)
    file('exports/j2/1/video.mp4', 24 * 29)
    // Upload links never committed: one alone (its parts go too), one over a committed file (only its record goes).
    env.storage.put(`${WS}/${UP(6)}/0`, Uint8Array.from([9]))
    ;(env.tables.studio_record ??= []).push(
      { workspace_id: WS, collection: 'blob-writes', key: UP(6), value: { bytes: 1, partBytes: 32, contentType: 'video/mp4', sha256: null, createdAt: ago(30) }, updated_at: ago(30) },
      { workspace_id: WS, collection: 'blob-writes', key: 'thumbs/v.jpg', value: { bytes: 3, partBytes: 32, contentType: 'image/jpeg', sha256: null, createdAt: ago(30) }, updated_at: ago(30) },
      { workspace_id: WS, collection: 'blob-writes', key: UP(7), value: { bytes: 1, partBytes: 32, contentType: 'video/mp4', sha256: null, createdAt: ago(1) }, updated_at: ago(1) },
    )
    const oldJob = job('export', 'completed', 24 * 91)
    const recentJob = job('export', 'completed', 24 * 89)
    const openJob = job('export', 'running', 24 * 100)

    expect(await sweep()).toEqual({ pendingWrites: 2, uploads: 3, stills: 1, exports: 1, jobs: 1, liveTracks: 0, recordings: 0 })
    expect(await has(`assets/${'a'.repeat(64)}.mp4`)).toBe(true)
    expect(await has('thumbs/v.jpg')).toBe(true)
    expect(env.storage.objects.has(`${WS}/thumbs/v.jpg/0`)).toBe(true)
    expect(await has(UP(1))).toBe(false)
    expect(env.storage.objects.has(`${WS}/${UP(1)}/0`)).toBe(false)
    expect(await has(UP(2))).toBe(true)
    expect(await has(UP(3))).toBe(true)
    expect(await has(UP(4))).toBe(false)
    expect(await has(UP(5), OTHER_WS)).toBe(false)
    expect(env.storage.objects.has(`${WS}/${UP(6)}/0`)).toBe(false)
    expect(env.tables.studio_record!.map((r) => r.key)).toEqual([UP(7)])
    expect(await has('stills/j1/0.png')).toBe(false)
    expect(await has('stills/j2/0.png')).toBe(true)
    expect(await has('exports/j1/1/video.mp4')).toBe(false)
    expect(await has('exports/j2/1/video.mp4')).toBe(true)
    expect(env.tables.studio_job!.map((j) => j.id)).not.toContain(oldJob)
    expect(env.tables.studio_job!.map((j) => j.id)).toEqual(expect.arrayContaining([recentJob, openJob]))

    // Idempotent: a second run finds nothing.
    expect(await sweep()).toEqual({ pendingWrites: 0, uploads: 0, stills: 0, exports: 0, jobs: 0, liveTracks: 0, recordings: 0 })
  })

  it('does a bounded amount a run, and the next run takes the rest', async () => {
    for (let i = 0; i < 5; i++) file(`stills/j${i}/0.png`, 24 * 8)
    expect((await sweep(3)).stills).toBe(3)
    expect((await sweep(3)).stills).toBe(2)
  })

  it('answers a swept export’s link with a sentence', async () => {
    const res = await handleFile(new Request('http://localhost/x'), [WS, 'exports', 'j1', '1', 'video.mp4'], async () => env.ctx)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/exports are kept for 30 days/)
  })
})
