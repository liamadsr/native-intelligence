// Takes uploaded while they are recorded (live-takes.ts), over the in-memory tables and bucket: pieces come in order,
// each signed for its own length and held against the workspace's space; a take is the person's own; a track is
// sealed only from pieces that are in storage at their length, from the first, and that open as a recording; the
// worker reads a sealed track a link per piece; a take whose window closed is offered back and made a video from what
// arrived; a finished import removes the pieces and finishes the recording with nobody waiting; the sweep clears
// what was left behind. Made-up people and bytes.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commitBlob, createBlobWrite, readBlob, workerWriteFence } from '../blobs'
import { claimJob, completeJob, failJob } from '../jobs'
import { discardLiveTake, livePiece, PIECE_MAX_BYTES, QUIET_MS, recordingContainer, savedTakes, startLiveTake, TAKES, TRACKS } from '../live-takes'
import { advanceRecording, listRecordings, recoverTake, startRecording } from '../recordings'
import { sweepStudio } from '../sweep'
import type { StudioContext } from '../context'
import { AVA, fakeContext, WS } from './fake'

const BEN = 'b2b2b2b2-1111-4222-8333-777777777777'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })
const as = (userId: string | null): StudioContext => ({ ...env.ctx, userId })

/** The first bytes of a WebM (EBML) and of a fragmented MP4 (`ftyp`), then filler. */
const webm = (bytes: number) => { const b = new Uint8Array(bytes).fill(9); b.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]); return b }
const mp4 = (bytes: number) => { const b = new Uint8Array(bytes).fill(9); b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); return b }
const filler = (bytes: number) => new Uint8Array(bytes).fill(9)

async function newTake(ctx: StudioContext = env.ctx, roles: ('screen' | 'camera' | 'microphone')[] = ['screen', 'camera', 'microphone']) {
  const names = { screen: 'Screen recording 12 Nov, 09.41.mp4', camera: 'Camera 12 Nov, 09.41.mp4', microphone: 'Microphone 12 Nov, 09.41.m4a' }
  return (await startLiveTake(ctx, { recorder: 'browser', tracks: roles.map((role) => ({ role, name: names[role] })) })).take
}

/** The recorder's part for one piece: ask for its link, then PUT its bytes there. */
async function send(takeId: string, role: string, index: number, bytes: Uint8Array, extra: Record<string, unknown> = {}, ctx: StudioContext = env.ctx) {
  const link = await livePiece(ctx, takeId, { role, index, bytes: bytes.byteLength, seconds: (index + 1) * 4, ...extra })
  env.storage.put(link.url.replace('fake://upload/', ''), bytes)
  return link
}

const pendingOf = (key: string) => env.tables.studio_record!.find((r) => r.collection === 'blob-writes' && r.key === key)?.value as { bytes: number } | undefined
const asset = (n: string, extra: Record<string, unknown> = {}) => ({
  id: n.repeat(64), name: 'Screen recording.mp4', kind: 'video', file: `assets/${n.repeat(64)}.mp4`, sha256: n.repeat(64), bytes: 100,
  width: 1920, height: 1080, sourceFps: 30, sourceFrames: 300, durationSeconds: 10, hasAudio: false, sourceCursorHidden: false, ...extra,
})
/** The worker's part: store the asset's file, then complete the job with it. */
async function finishImport(jobId: string, worker: string, made: ReturnType<typeof asset>) {
  const write = await createBlobWrite(env.ctx, { key: made.file, bytes: made.bytes, contentType: 'video/mp4', sha256: made.sha256 })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), filler(part.bytes))
  await commitBlob(env.ctx, made.file)
  await completeJob(deps(), jobId, worker, { asset: made })
}

describe('starting a take', () => {
  it('makes the take and its tracks, the person’s own', async () => {
    const take = await newTake()
    expect(take.keys).toEqual({ screen: `live/${take.id}/screen`, camera: `live/${take.id}/camera`, microphone: `live/${take.id}/microphone` })
    expect(take.pieceMaxBytes).toBe(PIECE_MAX_BYTES)
    const record = env.tables.studio_record!.find((r) => r.collection === TAKES)!.value as { ownerId: string; status: string }
    expect(record).toMatchObject({ ownerId: AVA, status: 'recording' })
    expect(env.tables.studio_record!.filter((r) => r.collection === TRACKS)).toHaveLength(3)
  })

  it('refuses a job (nobody signed in), a take without a screen, a track twice, a name with a folder or not a recording', async () => {
    await expect(startLiveTake(as(null), { tracks: [{ role: 'screen', name: 'a.webm' }] })).rejects.toMatchObject({ status: 403 })
    await expect(startLiveTake(env.ctx, { tracks: [{ role: 'camera', name: 'a.webm' }] })).rejects.toThrow('A recording has a screen track.')
    await expect(startLiveTake(env.ctx, { tracks: [{ role: 'screen', name: 'a.webm' }, { role: 'screen', name: 'b.webm' }] })).rejects.toThrow('Each track of a recording is sent once.')
    await expect(startLiveTake(env.ctx, { tracks: [{ role: 'screen', name: '../a.webm' }] })).rejects.toThrow(/folders/)
    await expect(startLiveTake(env.ctx, { tracks: [{ role: 'screen', name: 'page.html' }] })).rejects.toThrow(/WebM, MP4/)
  })

  it('refuses a fourth take recording at once', async () => {
    for (let i = 0; i < 3; i++) await newTake()
    await expect(newTake()).rejects.toMatchObject({ status: 429, code: 'TOO_MANY_TAKES' })
    // Another person is not counted against.
    await expect(newTake(as(BEN))).resolves.toBeTruthy()
  })
})

describe('pieces', () => {
  it('signs each piece in order, for its length, and holds space for the track', async () => {
    const take = await newTake()
    const link = await send(take.id, 'screen', 0, mp4(1000))
    expect(link.url).toBe(`fake://upload/${WS}/live/${take.id}/screen/0`)
    expect(link.headers['content-type']).toBe('application/octet-stream')
    expect(pendingOf(`live/${take.id}/screen`)!.bytes).toBe(64 * 1024 ** 2)
    await send(take.id, 'screen', 1, filler(500))
    const track = env.tables.studio_record!.find((r) => r.collection === TRACKS && r.key === `${take.id}:screen`)!.value as { n: number; pieces: number[]; bytes: number; seconds: number }
    expect(track).toMatchObject({ n: 2, pieces: [1000, 500], bytes: 1500, seconds: 8 })
  })

  it('refuses pieces out of order, sent twice with another length, too large, or for a track the take does not have', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 10 })).rejects.toMatchObject({ status: 409, code: 'OUT_OF_ORDER' })
    await send(take.id, 'screen', 0, mp4(100))
    await send(take.id, 'screen', 1, filler(100))
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 0, bytes: 100 })).rejects.toMatchObject({ code: 'OUT_OF_ORDER' })
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 99 })).rejects.toMatchObject({ code: 'OUT_OF_ORDER' })
    // The last piece again, the same length (its upload failed): signed again, nothing counted twice.
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 100 })).resolves.toMatchObject({ index: 1 })
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 2, bytes: PIECE_MAX_BYTES + 1 })).rejects.toMatchObject({ status: 413 })
    await expect(livePiece(env.ctx, take.id, { role: 'camera', index: 0, bytes: 10 })).rejects.toThrow('That track is not part of this recording.')
  })

  it('lets only the person who started the take send to it, never a job', async () => {
    const take = await newTake()
    await expect(livePiece(as(BEN), take.id, { role: 'screen', index: 0, bytes: 10 })).rejects.toMatchObject({ status: 404 })
    await expect(livePiece(as(null), take.id, { role: 'screen', index: 0, bytes: 10 })).rejects.toMatchObject({ status: 403 })
    await expect(livePiece(env.ctx, 'not-a-take', { role: 'screen', index: 0, bytes: 10 })).rejects.toMatchObject({ status: 404 })
  })

  it('gives one of two requests for the same piece the piece, and the other a conflict to try again', async () => {
    const take = await newTake(env.ctx, ['screen'])
    const both = await Promise.allSettled([livePiece(env.ctx, take.id, { role: 'screen', index: 0, bytes: 10 }), livePiece(env.ctx, take.id, { role: 'screen', index: 0, bytes: 10 })])
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((both.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'BUSY' })
  })

  it('refuses a piece past the workspace’s space and gives back what it held', async () => {
    vi.stubEnv('STUDIO_WORKSPACE_BYTES', String(100 * 1024 ** 2))
    try {
      const take = await newTake(env.ctx, ['screen'])
      await send(take.id, 'screen', 0, mp4(1000))
      const held = pendingOf(`live/${take.id}/screen`)!.bytes
      // Fill the workspace with another file, then ask for more than the track holds.
      ;(env.tables.studio_blob ??= []).push({ workspace_id: WS, key: 'uploads/other', bytes: 40 * 1024 ** 2, parts: 2, part_bytes: 32 * 1024 ** 2, content_type: 'video/mp4', sha256: null })
      const track = env.tables.studio_record!.find((r) => r.collection === TRACKS)!.value as { bytes: number }
      track.bytes = held - 10
      await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 1000 })).rejects.toMatchObject({ status: 413, code: 'QUOTA' })
      expect(pendingOf(`live/${take.id}/screen`)!.bytes).toBe(held)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('finishing a take', () => {
  async function recorded() {
    const take = await newTake()
    await send(take.id, 'screen', 0, mp4(300))
    await send(take.id, 'screen', 1, filler(200))
    await send(take.id, 'camera', 0, webm(100), { offsetSeconds: 0.25 })
    await send(take.id, 'microphone', 0, webm(50), { offsetSeconds: -0.1 })
    return take
  }
  const body = (take: { keys: Record<string, string> }, pieces = { screen: 2, camera: 1, microphone: 1 }) => ({
    recorder: 'browser',
    screen: { uploadKey: take.keys.screen, name: 'Screen recording.mp4', pieces: pieces.screen },
    camera: { uploadKey: take.keys.camera, name: 'Camera.mp4', offsetSeconds: 0.25, pieces: pieces.camera },
    microphone: { uploadKey: take.keys.microphone, name: 'Microphone.m4a', offsetSeconds: -0.1, pieces: pieces.microphone },
    durationSeconds: 8,
  })

  it('seals every track, queues its imports and closes the take; the worker reads it a link per piece', async () => {
    const take = await recorded()
    const answer = await startRecording(env.ctx, body(take), 0)
    expect(answer.recording.status).toBe('processing')
    const screenJob = await claimJob(deps(), 'w', ['import'])
    expect(screenJob!.input).toMatchObject({ uploadKey: take.keys.screen, conform: { fps: 60, fit: true }, durationHint: 8, provenance: { role: 'screen', live: true } })
    expect(screenJob!.input).not.toHaveProperty('partial')
    const read = await readBlob({ ...env.ctx, userId: null }, take.keys.screen!)
    expect(read).toMatchObject({ key: take.keys.screen, bytes: 500, sha256: null, contentType: 'video/mp4' })
    expect(read.parts.map((p) => [p.index, p.bytes, p.url])).toEqual([[0, 300, `fake://read/${WS}/live/${take.id}/screen/0`], [1, 200, `fake://read/${WS}/live/${take.id}/screen/1`]])
    // The space held shrinks to the track.
    expect(pendingOf(take.keys.screen!)!.bytes).toBe(500)
    // Finished: no more pieces.
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 2, bytes: 10 })).rejects.toMatchObject({ code: 'TAKE_CLOSED' })
    await expect(discardLiveTake(env.ctx, take.id)).rejects.toMatchObject({ code: 'TAKE_CLOSED' })
  })

  it('refuses a take with a piece missing or of the wrong length, so the recorder sends it again', async () => {
    const take = await recorded()
    env.storage.objects.delete(`${WS}/live/${take.id}/screen/1`)
    await expect(startRecording(env.ctx, body(take), 0)).rejects.toThrow('The upload is not complete: piece 2 of 2 is missing.')
    env.storage.put(`${WS}/live/${take.id}/screen/1`, filler(199))
    await expect(startRecording(env.ctx, body(take), 0)).rejects.toThrow('The upload is not complete: piece 2 of 2 has 199 bytes, not 200.')
    await expect(startRecording(env.ctx, body(take, { screen: 3, camera: 1, microphone: 1 }), 0)).rejects.toThrow('piece 3 of 3 was never sent')
    env.storage.put(`${WS}/live/${take.id}/screen/1`, filler(200))
    await expect(startRecording(env.ctx, body(take), 0)).resolves.toBeTruthy()
  })

  it('reads a track the Studio cut short as far as it goes', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(300))
    await startRecording(env.ctx, { screen: { uploadKey: take.keys.screen, name: 'Screen.mp4', pieces: 1, partial: true } }, 0)
    expect(env.tables.studio_job![0]!.input).toMatchObject({ uploadKey: take.keys.screen, partial: true })
  })

  it('refuses a track whose bytes are not a recording', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, new TextEncoder().encode('<html><script>alert(1)</script></html>'))
    await expect(startRecording(env.ctx, { screen: { uploadKey: take.keys.screen, name: 'Screen.webm', pieces: 1 } }, 0)).rejects.toMatchObject({ status: 415, code: 'NOT_MEDIA' })
    expect(recordingContainer(webm(16))).toBe('webm')
    expect(recordingContainer(mp4(16))).toBe('mp4')
    expect(recordingContainer(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]))).toBe('ogg')
    expect(recordingContainer(new Uint8Array(4))).toBeNull()
  })

  it('refuses another person’s take, a track under another role, and tracks from two takes', async () => {
    const take = await recorded()
    await expect(startRecording(as(BEN), body(take), 0)).rejects.toMatchObject({ status: 404 })
    const swapped = { ...body(take), camera: { ...body(take).camera, uploadKey: take.keys.microphone }, microphone: { ...body(take).microphone, uploadKey: take.keys.camera } }
    await expect(startRecording(env.ctx, swapped, 0)).rejects.toThrow('Each track of a take goes under its own role.')
    const other = await newTake(env.ctx, ['screen', 'camera'])
    await expect(startRecording(env.ctx, { ...body(take), camera: { ...body(take).camera, uploadKey: other.keys.camera } }, 0)).rejects.toThrow('The tracks of a take come from one recording.')
  })

  it('removes the pieces once imported, and finishes the recording when its last import ends, with nobody waiting', async () => {
    const take = await newTake(env.ctx, ['screen', 'microphone'])
    await send(take.id, 'screen', 0, mp4(300))
    await send(take.id, 'microphone', 0, webm(50), { offsetSeconds: -0.1 })
    const { recording } = await startRecording(env.ctx, {
      screen: { uploadKey: take.keys.screen, name: 'Screen recording.mp4', pieces: 1 },
      microphone: { uploadKey: take.keys.microphone, name: 'Microphone.m4a', offsetSeconds: -0.1, pieces: 1 },
    }, 0)
    const screenJob = (await claimJob(deps(), 'w', ['import']))!
    await finishImport(screenJob.id, 'w', asset('a'))
    expect([...env.storage.objects.keys()].some((path) => path.includes(`live/${take.id}/screen/`))).toBe(false)
    expect(pendingOf(take.keys.screen!)).toBeUndefined()
    expect((await listRecordings(env.ctx)).recordings[0]).toMatchObject({ id: recording.id, status: 'processing' })
    // The microphone's import fails: the recording is finished without it, by the worker's own call.
    const micJob = (await claimJob(deps(), 'w', ['import']))!
    await failJob(deps(), micJob.id, 'w', 'The file could not be read')
    // A failed import keeps its pieces (a take brought back after a crash may be tried again) until the sweep.
    expect(env.storage.objects.has(`${WS}/live/${take.id}/microphone/0`)).toBe(true)
    const done = env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === recording.id)!.value as { status: string; projectId?: string; note?: string; ownerId: string }
    expect(done).toMatchObject({ status: 'done', ownerId: AVA, note: 'The microphone could not be added to this take.' })
    expect(env.tables.studio_video!.find((v) => v.id === done.projectId)).toMatchObject({ created_by: AVA })
    expect((await advanceRecording(env.ctx, recording.id)).recording).toMatchObject({ status: 'done', projectId: done.projectId })
  })
})

describe('a take whose window closed', () => {
  it('is offered back once no piece has come for a while, and only to its person', async () => {
    const take = await newTake()
    await send(take.id, 'screen', 0, mp4(300))
    await send(take.id, 'camera', 0, webm(100), { offsetSeconds: 0.25 })
    expect((await savedTakes(env.ctx)).takes).toEqual([])
    const later = Date.now() + QUIET_MS + 1000
    const { takes } = await savedTakes(env.ctx, later)
    expect(takes).toHaveLength(1)
    expect(takes[0]).toMatchObject({ id: take.id, seconds: 4, bytes: 400 })
    expect((await savedTakes(as(BEN), later)).takes).toEqual([])
  })

  it('becomes a video from the pieces that arrived: the run from the first, its end read as far as it goes', async () => {
    const take = await newTake()
    await send(take.id, 'screen', 0, mp4(300))
    await send(take.id, 'screen', 1, filler(200))
    // Piece 3 was signed but its upload never arrived; piece 4 did: only the unbroken run counts.
    await livePiece(env.ctx, take.id, { role: 'screen', index: 2, bytes: 100, seconds: 12 })
    await send(take.id, 'microphone', 0, webm(50), { offsetSeconds: -0.1 })
    const answer = await recoverTake(env.ctx, take.id)
    expect(answer.recording.status).toBe('processing')
    const jobs = env.tables.studio_job!
    const screen = jobs.find((j) => (j.input as { provenance: { role: string } }).provenance.role === 'screen')!.input as Record<string, unknown>
    expect(screen).toMatchObject({ uploadKey: take.keys.screen, partial: true, durationHint: 12 })
    const mic = jobs.find((j) => (j.input as { provenance: { role: string } }).provenance.role === 'microphone')!.input as Record<string, unknown>
    expect(mic).toMatchObject({ uploadKey: take.keys.microphone, partial: true })
    // The camera sent nothing: it is left out.
    expect(jobs).toHaveLength(2)
    const read = await readBlob(env.ctx, take.keys.screen!)
    expect(read.parts.map((p) => p.bytes)).toEqual([300, 200])
    const record = env.tables.studio_record!.find((r) => r.collection === 'recordings')!.value as { recovered: boolean; input: { title: string; microphone: { offsetSeconds: number } } }
    expect(record.recovered).toBe(true)
    expect(record.input.title).toMatch(/\(recovered\)$/)
    expect(record.input.microphone.offsetSeconds).toBe(-0.1)
    // Brought back once.
    await expect(recoverTake(env.ctx, take.id)).rejects.toMatchObject({ code: 'TAKE_CLOSED' })
  })

  it('is refused when nothing of the screen arrived, and can be thrown away', async () => {
    const take = await newTake()
    await send(take.id, 'camera', 0, webm(100))
    await expect(recoverTake(env.ctx, take.id)).rejects.toThrow('Nothing of the screen was saved, so there is no recording to bring back.')
    await expect(discardLiveTake(as(BEN), take.id)).rejects.toMatchObject({ status: 404 })
    await discardLiveTake(env.ctx, take.id)
    expect([...env.storage.objects.keys()].some((path) => path.includes(`live/${take.id}/`))).toBe(false)
    expect(env.tables.studio_record!.filter((r) => r.collection === TAKES || r.collection === TRACKS || r.collection === 'blob-writes')).toEqual([])
  })
})

describe('the worker and the sweep', () => {
  it('lets no worker write a take’s pieces, nor read a track before it is sealed', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(16))
    await expect(workerWriteFence({ ...env.ctx, userId: null }, { id: 'j', kind: 'import' }, take.keys.screen!)).rejects.toMatchObject({ code: 'NOT_YOURS' })
    await expect(readBlob({ ...env.ctx, userId: null }, take.keys.screen!)).rejects.toMatchObject({ code: 'NOT_SEALED' })
  })

  it('keeps a take’s space through the pending-write sweep, and clears tracks left a week', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(16))
    const day = 24 * 3600_000
    const sweep = (ms: number) => sweepStudio(env.ctx.supabase, { storage: env.storage, now: new Date(Date.now() + ms) })
    expect(await sweep(2 * day)).toMatchObject({ pendingWrites: 0, liveTracks: 0 })
    expect(env.storage.objects.has(`${WS}/live/${take.id}/screen/0`)).toBe(true)
    expect(await sweep(8 * day)).toMatchObject({ liveTracks: 1 })
    expect(env.storage.objects.has(`${WS}/live/${take.id}/screen/0`)).toBe(false)
    expect(env.tables.studio_record!.filter((r) => [TAKES, TRACKS, 'blob-writes'].includes(String(r.collection)))).toEqual([])
  })
})
