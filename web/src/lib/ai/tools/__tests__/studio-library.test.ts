/**
 * The Studio parity tools over the Studio server's real functions on in-memory tables: bringing media in (a chat
 * upload pinned to the caller's own folder, a public link through the guarded fetch, never a page), transcripts,
 * looking at images, fonts, the presentation, storyboard versions, moving charges, continuity, and their registry
 * classes. Made-up media and links only.
 */
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown, storage: null as unknown, page: null as unknown }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/studio/server/storage', async (load) => ({ ...(await load<object>()), supabaseStorage: () => state.storage }))
vi.mock('@/lib/link-preview/safe-fetch', () => {
  class PublicFetchError extends Error {
    constructor(readonly reason: string) {
      super(reason)
    }
  }
  return {
    PublicFetchError,
    fetchPublicPage: vi.fn(async (url: string) => {
      if (url.includes('internal')) throw new PublicFetchError('not a public host')
      return state.page
    }),
  }
})

import { AVA, WS, fakeDb, fakeStorage } from '@/lib/studio/server/__tests__/fake'
import { getMutatingToolNames, getToolSideEffect, getToolWriteTarget, isReadShapedToolName } from '@/lib/ai/tool-registry'
import { createBlankVideo } from '@/lib/studio/server/blank'
import { forgetWorkers } from '@/lib/studio/server/capabilities'
import { createStudioLibraryTools, extensionOf, importAnswer, isMediaAnswer, linkFileName, transcriptWords, uploadKind } from '../studio-library'
import { IMPORT_EXTENSIONS, nameFor, sniffMedia } from '@/lib/studio/server/library'
import { kindOfName } from '../../../../../../studio-worker/src/media.ts'
import { createStudioTools, withPresentation } from '../studio'
import { createStudioMediaTools } from '../studio-media'

const GUEST = 'b2b2b2b2-1111-4222-8333-777777777777'
type Row = Record<string, unknown>
let tables: Record<string, Row[]>
const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })
const lib = (user = AVA) => createStudioLibraryTools(user, WS)

beforeEach(() => {
  tables = { member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'owner' }, { id: 'm-guest', workspace_id: WS, user_id: GUEST, role: 'guest' }] }
  state.db = fakeDb(tables).client as SupabaseClient
  state.storage = fakeStorage()
  state.page = null
  forgetWorkers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

const blank = () => createBlankVideo({ supabase: state.db as SupabaseClient, workspaceId: WS, userId: AVA, storage: state.storage as never }, { title: 'Made-up launch', seconds: 4, fps: 30 })

describe('the pure helpers', () => {
  it('know a file by its name and a link by its answer', () => {
    expect(extensionOf('a/b/clip.MOV?x=1')).toBe('mov')
    expect(uploadKind(`${AVA}/chat-uploads/x.png`)).toBe('image')
    expect(uploadKind('x.wav')).toBe('audio')
    expect(uploadKind('x.pdf')).toBeNull()
    expect(isMediaAnswer('video/mp4', 'https://example.com/v')).toBe(true)
    expect(isMediaAnswer('image/svg+xml', 'https://example.com/logo.svg')).toBe(false)
    expect(isMediaAnswer('text/html', 'https://example.com/page')).toBe(false)
    expect(isMediaAnswer('application/octet-stream', 'https://example.com/bed.mp3')).toBe(true)
    expect(linkFileName('https://cdn.example.com/sounds/soft%20bed.mp3')).toBe('soft bed.mp3')
    expect(linkFileName('https://cdn.example.com/', ' Bed (CC0, example.com) ')).toBe('Bed (CC0, example.com)')
  })

  it('take only the file kinds the worker\'s import reads (an .m4v is read as the MP4 it is)', () => {
    for (const [kind, extensions] of Object.entries(IMPORT_EXTENSIONS)) {
      for (const ext of extensions) expect(kindOfName(`x.${ext}`)?.kind, ext).toBe(kind)
    }
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov', 'webm', 'm4v', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']) {
      expect(kindOfName(`x.${ext}`)?.kind, ext).toBe(uploadKind(`x.${ext}`))
    }
    expect(uploadKind('clip.m4v')).toBe('video')
    expect(nameFor('clip.m4v', { kind: 'video', ext: 'mp4' })).toBe('clip.m4v')
  })

  it('answer an import and a transcript compactly', () => {
    const asset = { id: 'a'.repeat(64), name: 'logo.png', kind: 'image', width: 400, height: 200 } as never
    expect(importAnswer({ asset })).toMatchObject({ success: true, asset: { id: 'a'.repeat(64), kind: 'image', width: 400 } })
    expect(importAnswer({ job: { id: 'j1', status: 'running' } as never })).toMatchObject({ success: true, job_id: 'j1' })
    const words = [{ text: 'Hello', startMs: 100, endMs: 400 }, { text: 'there', startMs: 2100, endMs: 2500 }]
    expect(transcriptWords(words)).toEqual([['Hello', 0.1, 0.4], ['there', 2.1, 2.5]])
    expect(transcriptWords(words, 1)).toEqual([['there', 2.1, 2.5]])
  })
})

describe('bringing media in', () => {
  it('takes only the caller\'s own chat uploads of a usable kind, and one place at a time', async () => {
    expect(await call(lib(), 'import_studio_file', {})).toMatchObject({ success: false, code: 'INVALID' })
    expect(await call(lib(), 'import_studio_file', { storage_path: `${AVA}/chat-uploads/a.png`, attachment_id: 'x' })).toMatchObject({ success: false, code: 'INVALID' })
    expect(await call(lib(), 'import_studio_file', { storage_path: `${GUEST}/chat-uploads/0f0f0f0f-1111-4222-8333-999999999999.png` })).toMatchObject({ success: false, error: expect.stringMatching(/chat-uploads/) })
    expect(await call(lib(), 'import_studio_file', { attachment_id: '0f0f0f0f-1111-4222-8333-999999999999' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('keeps a private meeting\'s file out of the shared library', async () => {
    const file = '0f0f0f0f-1111-4222-8333-999999999999'
    tables.attachments = [{ id: file, workspace_id: WS, file_name: 'take.mp4', mime_type: 'video/mp4', file_extension: 'mp4', storage_bucket: 'attachments', storage_path: 'x/take.mp4', note_id: 'c1c1c1c1-1111-4222-8333-999999999999', file_size_bytes: 10 }]
    tables.captures = [{ id: 'c1c1c1c1-1111-4222-8333-999999999999', workspace_id: WS, visibility: 'private', user_id: AVA }]
    expect(await call(lib(), 'import_studio_file', { attachment_id: file })).toMatchObject({ success: false, code: 'PRIVATE_FILE' })
    // The same file on a meeting the whole workspace sees is not held back as private.
    tables.captures[0]!.visibility = 'workspace'
    expect(await call(lib(), 'import_studio_file', { attachment_id: file })).not.toMatchObject({ code: 'PRIVATE_FILE' })
  })

  it('downloads a link only when it answers a media file', async () => {
    expect(await call(lib(), 'import_studio_media_from_link', { url: 'https://internal.example.com/x.png' })).toMatchObject({ success: false, code: 'LINK_FAILED', error: expect.stringMatching(/not a public host/) })
    state.page = { url: 'https://example.com/page', status: 200, contentType: 'text/html', charset: null, body: new Uint8Array([60]), truncated: false }
    expect(await call(lib(), 'import_studio_media_from_link', { url: 'https://example.com/page' })).toMatchObject({ success: false, code: 'NOT_MEDIA' })
    state.page = { url: 'https://example.com/big.mp4', status: 200, contentType: 'video/mp4', charset: null, body: new Uint8Array([1]), truncated: true }
    expect(await call(lib(), 'import_studio_media_from_link', { url: 'https://example.com/big.mp4' })).toMatchObject({ success: false, code: 'TOO_LARGE' })
    state.page = { url: 'https://example.com/gone.mp4', status: 404, contentType: 'text/html', charset: null, body: new Uint8Array([1]), truncated: false }
    expect(await call(lib(), 'import_studio_media_from_link', { url: 'https://example.com/gone.mp4' })).toMatchObject({ success: false, code: 'LINK_FAILED' })
  })

  it('judges a link by its bytes, not its header: a page or a script served as an image is refused', async () => {
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>')
    state.page = { url: 'https://cdn.example.com/logo.png', status: 200, contentType: 'image/png', charset: null, body: html, truncated: false }
    expect(await call(lib(), 'import_studio_media_from_link', { url: 'https://cdn.example.com/logo.png' })).toMatchObject({ success: false, code: 'NOT_MEDIA' })
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    state.page = { url: 'https://cdn.example.com/x.png', status: 200, contentType: 'application/octet-stream', charset: null, body: svg, truncated: false }
    expect(await call(lib(), 'import_studio_media_from_link', { url: 'https://cdn.example.com/x.png' })).toMatchObject({ success: false, code: 'NOT_MEDIA' })
  })

  it('names a link without an extension by what its bytes are, so the import can read it', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    const mp4 = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypisom'), 0, 0, 2, 0])
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x84, ...new TextEncoder().encode('webm')])
    const wav = new TextEncoder().encode('RIFF\x24\x00\x00\x00WAVEfmt ')
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0])
    expect([png, mp4, webm, wav, mp3].map((b) => sniffMedia(b))).toEqual([
      { kind: 'image', ext: 'png' }, { kind: 'video', ext: 'mp4' }, { kind: 'video', ext: 'webm' }, { kind: 'audio', ext: 'wav' }, { kind: 'audio', ext: 'mp3' },
    ])
    expect(sniffMedia(new TextEncoder().encode('#EXTM3U\nhttp://169.254.169.254/'))).toBeNull()
    expect(nameFor(linkFileName('https://cdn.example.com/v/8f3a21'), { kind: 'video', ext: 'mp4' })).toBe('8f3a21.mp4')
    expect(nameFor('take.mov', { kind: 'video', ext: 'mp4' })).toBe('take.mov')
    expect(nameFor('logo.png', { kind: 'audio', ext: 'mp3' })).toBe('logo.png.mp3')
    // A malformed escape in the link keeps the name as written instead of failing after the download.
    expect(linkFileName('https://cdn.example.com/a%E0%A4%A.mp3')).toBe('a%E0%A4%A.mp3')
  })

  it('answers the asset the same bytes already made', async () => {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    const sha = createHash('sha256').update(body).digest('hex')
    const meta = { id: sha, name: 'logo.png', kind: 'image', file: `assets/${sha}.png`, sha256: sha, bytes: body.length, width: 10, height: 10, hasAudio: false, sourceCursorHidden: false }
    tables.studio_asset = [{ id: sha, workspace_id: WS, sha256: sha, meta, kind: 'image', name: 'logo.png', created_at: new Date().toISOString() }]
    state.page = { url: 'https://cdn.example.com/logo.png', status: 200, contentType: 'image/png', charset: null, body, truncated: false }
    expect(await call(lib(), 'import_studio_media_from_link', { url: 'https://cdn.example.com/logo.png' })).toMatchObject({ success: true, asset: { id: sha, kind: 'image' } })
  })

  it('refuses a guest', async () => {
    expect(await call(lib(GUEST), 'list_studio_fonts', {})).toMatchObject({ success: false, code: 'FORBIDDEN' })
  })
})

describe('transcripts and images', () => {
  it('name the missing media', async () => {
    expect(await call(lib(), 'transcribe_studio_asset', { asset_id: 'b'.repeat(64) })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(await call(lib(), 'get_studio_transcript', { asset_id: 'b'.repeat(64) })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(await call(lib(), 'get_studio_images', { asset_ids: ['b'.repeat(64)] })).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })
})

describe('the presentation', () => {
  it('changes only what is given, as one step with a version kept', async () => {
    const video = await blank()
    const studio = createStudioTools(AVA, WS)
    const out = await call(studio, 'set_studio_presentation', { video_id: video.id, background: { kind: 'gradient', color: '#112233', color2: '#445566' }, radius: 24, cursor: { style: 'glass' } })
    expect(out).toMatchObject({ success: true, presentation: { radius: 24, background: { kind: 'gradient', color: '#112233', color2: '#445566' } }, cursor: { style: 'glass' } })
    expect(await call(studio, 'set_studio_presentation', { video_id: video.id, radius: 2, expected_digest: '0'.repeat(64) })).toMatchObject({ success: false, code: 'DIGEST_CONFLICT' })
    expect(await call(studio, 'set_studio_presentation', { video_id: video.id, presenter: { muted: true } })).toMatchObject({ success: false, error: expect.stringMatching(/no camera recording/) })
    expect(await call(studio, 'set_studio_presentation', { video_id: video.id })).toMatchObject({ success: false, code: 'INVALID' })
    const versions = await call(studio, 'list_studio_versions', { video_id: video.id })
    expect((versions.versions as { label: string }[]).some((v) => /set_studio_presentation/.test(v.label))).toBe(true)
    expect(await call(studio, 'list_studio_versions', { video_id: video.id, of: 'storyboard' })).toMatchObject({ success: true, of: 'storyboard', versions: [] })
  })

  it('merges a patch into the edit without touching the rest. Pure', () => {
    const project = { presentation: { background: { kind: 'none', color: '#000000', color2: '#ffffff', angle: 0, assetId: null }, blur: 0, padding: 40, inset: 0, radius: 12, shadow: { opacity: 0.3, blur: 20, distance: 4, angle: 90 } }, cursor: { style: 'arrow', size: 24, clickFeedback: true }, presenterTrack: null } as never
    const next = withPresentation(project, { shadow: { opacity: 0 }, cursor: { size: 30 } })
    expect(next.presentation.shadow).toEqual({ opacity: 0, blur: 20, distance: 4, angle: 90 })
    expect(next.presentation.padding).toBe(40)
    expect(next.cursor).toEqual({ style: 'arrow', size: 30, clickFeedback: true })
  })
})

describe('costs and continuity', () => {
  it('move charges only to a video here, and measure nothing without a generated beat', async () => {
    const video = await blank()
    const media = createStudioMediaTools(AVA, WS)
    expect(await call(media, 'assign_studio_costs', { charge_ids: ['c1'], video_id: 'd'.repeat(8) + '-1111-4222-8333-999999999999' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(await call(media, 'assign_studio_costs', { charge_ids: ['c1'], video_id: null })).toMatchObject({ success: true, moved: 0 })
    expect(await call(media, 'check_studio_continuity', { video_id: video.id })).toMatchObject({ success: true, matched: true, issues: [] })
  })
})

describe('their registry classes', () => {
  it('reads read, writes are artifacts, the link reaches outside, and report mode keeps away from every write', () => {
    for (const name of ['get_studio_transcript', 'get_studio_images', 'list_studio_fonts']) {
      expect(getToolSideEffect(name)).toBe('read')
      expect(isReadShapedToolName(name)).toBe(true)
    }
    const mutating = getMutatingToolNames()
    for (const name of ['import_studio_file', 'transcribe_studio_asset', 'install_studio_font', 'assign_studio_costs', 'check_studio_continuity', 'set_studio_presentation']) {
      expect(getToolSideEffect(name)).toBe('internal-write')
      expect(getToolWriteTarget(name)).toBe('artifact')
      expect(mutating.has(name)).toBe(true)
    }
    expect(getToolSideEffect('import_studio_media_from_link')).toBe('external-write')
    expect(mutating.has('import_studio_media_from_link')).toBe(true)
  })
})
