/**
 * A finished export as a short-lived download link (download-links.ts): minted by a member for a finished export of
 * their workspace, served without a session as an attachment while it lasts and while its asker is still a member.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commitBlob, createBlobWrite } from '../blobs'
import { createBlankVideo } from '../blank'
import { DOWNLOAD_LINKS, LINK_PATH, LINK_SECONDS, mintFileLink, serveDownloadLink } from '../download-links'
import type { PartFetch } from '../files'
import { claimJob, completeJob } from '../jobs'
import { startExport } from '../media'
import { AVA, fakeContext, WS } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext({ member: [{ workspace_id: WS, user_id: AVA, role: 'member' }] })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })
const fetchPart: PartFetch = async () => new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(30).fill(7)), c.close()) })
const serve = (token: string, now?: number, method = 'GET') => serveDownloadLink(env.ctx.supabase, token, new Request(`http://localhost${LINK_PATH}${token}`, { method }), { fetchPart, storage: env.ctx.storage, ...(now ? { now } : {}) })

async function finishedExport() {
  const video = await createBlankVideo(env.ctx, { title: 'Spring launch', seconds: 2, fps: 30 })
  const { job } = await startExport(env.ctx, video)
  const claimed = await claimJob(deps(), 'w', ['export'])
  const key = `exports/${job.id}/${claimed!.attempts}/video.mp4`
  const write = await createBlobWrite(env.ctx, { key, bytes: 30, contentType: 'video/mp4' })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes).fill(7))
  await commitBlob(env.ctx, key)
  await completeJob(deps(), job.id, 'w', { key, bytes: 30, width: 1920, height: 1080, fps: 30, durationSeconds: 2 })
  return key
}
const tokenOf = (url: string) => url.slice(LINK_PATH.length)

describe('export download links', () => {
  it('serves a finished export as an attachment, without a session, until it expires', async () => {
    const now = Date.now()
    const link = await mintFileLink(env.ctx, { key: await finishedExport(), name: 'Spring launch.mp4' }, now)
    expect(link.url.startsWith(LINK_PATH)).toBe(true)
    expect(Date.parse(link.expiresAt) - now).toBe(LINK_SECONDS * 1000)
    const res = await serve(tokenOf(link.url), now + 1000)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="Spring launch.mp4"')
    expect((await res.arrayBuffer()).byteLength).toBe(30)
    expect((await serve(tokenOf(link.url), now + 1000, 'HEAD')).headers.get('content-length')).toBe('30')
    const late = await serve(tokenOf(link.url), now + (LINK_SECONDS + 1) * 1000)
    expect(late.status).toBe(410)
    expect(env.tables.studio_record!.some((row) => row.collection === DOWNLOAD_LINKS)).toBe(false)
  })

  it('refuses a made-up token, and a link whose asker left the workspace', async () => {
    expect((await serve('not-a-token')).status).toBe(404)
    expect((await serve('A'.repeat(32))).status).toBe(404)
    const link = await mintFileLink(env.ctx, { key: await finishedExport(), name: 'Spring launch.mp4' })
    env.tables.member!.length = 0
    expect((await serve(tokenOf(link.url))).status).toBe(404)
  })

  it('mints only for a file this workspace still keeps', async () => {
    await expect(mintFileLink(env.ctx, { key: 'exports/gone/1/video.mp4', name: 'x.mp4' })).rejects.toThrow('exports are kept for 30 days')
    await expect(mintFileLink(env.ctx, { key: '../escape' })).rejects.toThrow('That is not a file key.')
  })
})
