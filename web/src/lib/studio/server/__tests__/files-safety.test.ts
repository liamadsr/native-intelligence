/**
 * A stored file is never a page on the app's origin: an upload's type comes from its name through the media
 * allowlist (never from the browser), the worker's stated types are held to the same list, and a file is served
 * inline only when its type is on it; anything else (HTML, SVG, script, a type planted in a row) is answered as
 * opaque bytes to be saved, and every answer carries a sandbox policy and nosniff. An upload whose import ends
 * without an asset is removed. Over the in-memory tables and bucket; made-up files.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commitBlob, createBlobWrite, getBlob } from '../blobs'
import { FILE_CSP, serveBlob, typeOfKey, type PartFetch } from '../files'
import { claimJob, completeJob, failJob } from '../jobs'
import { importUpload, startUpload } from '../media'
import { allowedType, inlineTypeOf, typeForName } from '../media-types'
import { fakeContext, WS } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })

/** The browser's (or worker's) part: PUT every part of a ticket. */
function putAll(ticket: { parts: { index: number; bytes: number; url: string }[] }, fill = 7) {
  for (const part of ticket.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes).fill(fill))
}
/** Serve parts straight from the fake bucket. */
const fetchPart: PartFetch = async (url, from, to) => {
  const bytes = env.storage.objects.get(url.replace('fake://read/', ''))!.bytes.subarray(from, to + 1)
  return new ReadableStream({ start: (c) => (c.enqueue(bytes), c.close()) })
}
const get = (range?: string) => new Request('http://localhost/x', { headers: range ? { range } : {} })

describe('the media allowlist', () => {
  it('takes types from names and keeps stated types only when they are media', () => {
    expect(typeForName('Walkthrough.MOV')).toBe('video/quicktime')
    expect(typeForName('page.html')).toBe('application/octet-stream')
    expect(typeForName('logo.svg')).toBe('application/octet-stream')
    expect(allowedType('Video/MP4; codecs=avc1')).toBe('video/mp4')
    for (const bad of ['text/html', 'image/svg+xml', 'text/javascript', 'application/xhtml+xml', 'application/json', 'application/pdf', '']) expect(allowedType(bad), bad).toBe('application/octet-stream')
    // A planted type wins over a harmless-looking key: it is not served inline.
    expect(inlineTypeOf('exports/j/1/video.mp4', 'text/html')).toBeNull()
    expect(inlineTypeOf('exports/j/1/video.mp4', 'application/octet-stream')).toBe('video/mp4')
    expect(typeOfKey('stills/j/0.svg', 'application/octet-stream')).toBe('application/octet-stream')
  })
})

describe('uploads', () => {
  it('stores an upload named x.mp4 that the browser calls text/html as video, and serves it as video', async () => {
    const ticket = await startUpload(env.ctx, { name: 'x.mp4', bytes: 12, contentType: 'text/html' })
    expect(ticket.parts[0]!.headers['content-type']).toBe('video/mp4')
    putAll(ticket)
    const blob = await commitBlob(env.ctx, ticket.uploadKey)
    expect(blob.contentType).toBe('video/mp4')
    const res = await serveBlob(env.ctx, blob, get(), { fetchPart })
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('content-type')).not.toContain('html')
    expect(res.headers.get('content-security-policy')).toBe(FILE_CSP)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it('stores an HTML upload as opaque bytes, served only as a download', async () => {
    const ticket = await startUpload(env.ctx, { name: 'page.html', bytes: 5, contentType: 'text/html' })
    putAll(ticket)
    const blob = await commitBlob(env.ctx, ticket.uploadKey)
    expect(blob.contentType).toBe('application/octet-stream')
    const res = await serveBlob(env.ctx, blob, get(), { fetchPart })
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
  })

  it('holds the worker’s stated types to the same list', async () => {
    const write = await createBlobWrite(env.ctx, { key: 'stills/j/0.png', bytes: 3, contentType: 'text/html' })
    expect(write.parts[0]!.headers['content-type']).toBe('application/octet-stream')
    putAll(write)
    expect((await commitBlob(env.ctx, 'stills/j/0.png')).contentType).toBe('application/octet-stream')
  })

  it('removes an upload when its import fails, as when it succeeds', async () => {
    const ticket = await startUpload(env.ctx, { name: 'clip.mp4', bytes: 9 })
    putAll(ticket)
    await importUpload(env.ctx, { uploadKey: ticket.uploadKey, name: 'clip.mp4' })
    const job = await claimJob(deps(), 'w', ['import'])
    await failJob(deps(), job!.id, 'w', 'Media does not match its file type')
    expect(await getBlob(env.ctx, ticket.uploadKey)).toBeNull()
    expect([...env.storage.objects.keys()].some((k) => k.includes(ticket.uploadKey))).toBe(false)

    // A result the app refuses fails the job, and its upload goes too.
    const again = await startUpload(env.ctx, { name: 'clip.mp4', bytes: 9 })
    putAll(again)
    await importUpload(env.ctx, { uploadKey: again.uploadKey, name: 'clip.mp4' })
    const second = await claimJob(deps(), 'w', ['import'])
    await expect(completeJob(deps(), second!.id, 'w', { asset: { nope: true } })).rejects.toMatchObject({ status: 422 })
    expect(await getBlob(env.ctx, again.uploadKey)).toBeNull()
  })
})

describe('serving a row that already holds a page type', () => {
  it('answers a planted text/html row as an attachment with the sandbox policy, ranges still working', async () => {
    const key = 'uploads/0d0d0d0d-1111-4222-8333-999999999999'
    env.storage.put(`${WS}/${key}/0`, new TextEncoder().encode('<script>alert(1)</script>'))
    env.tables.studio_blob = [{ workspace_id: WS, key, bytes: 25, parts: 1, part_bytes: 32, content_type: 'text/html', sha256: null }]
    const blob = (await getBlob(env.ctx, key))!
    const res = await serveBlob(env.ctx, blob, get(), { fetchPart })
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="0d0d0d0d-1111-4222-8333-999999999999"/)
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const ranged = await serveBlob(env.ctx, blob, get('bytes=1-6'), { fetchPart })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 1-6/25')
    expect(ranged.headers.get('content-type')).toBe('application/octet-stream')
    expect(new TextDecoder().decode(await ranged.arrayBuffer())).toBe('script')
  })

  it('never serves SVG inline', async () => {
    const key = 'stills/j/0.svg'
    env.storage.put(`${WS}/${key}/0`, new TextEncoder().encode('<svg/>'))
    env.tables.studio_blob = [{ workspace_id: WS, key, bytes: 6, parts: 1, part_bytes: 32, content_type: 'image/svg+xml', sha256: null }]
    const res = await serveBlob(env.ctx, (await getBlob(env.ctx, key))!, get(), { fetchPart })
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
  })
})
