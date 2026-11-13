// Takes uploaded while they are recorded (live-takes.ts), over the in-memory tables and bucket: pieces come in order,
// each signed for its own length and held against the workspace's space; a take is the person's own; a track is
// sealed only from pieces that are in storage at their length, from the first, and that open as a recording; the
// worker reads a sealed track a link per piece; a take whose window closed is offered back and made a video from what
// arrived; a finished import removes the pieces and finishes the recording with nobody waiting; the sweep clears
// what was left behind. Made-up people and bytes.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commitBlob, createBlobWrite, readBlob, workerWriteFence } from '../blobs'
import { workerBlobRead } from '../http'
import { claimJob, completeJob, failJob, queueJob } from '../jobs'
import { discardLiveTake, LINK_SAFE_MS, livePiece, MAX_RESENDS, PIECE_MAX_BYTES, PIECE_MIN_BYTES, QUIET_MS, recordingContainer, savedTakes, sealLiveTrack, startLiveTake, TAKES, TRACKS } from '../live-takes'
import { advanceRecording, listRecordings, recoverTake, startRecording } from '../recordings'
import { sweepStudio } from '../sweep'
import type { StudioContext } from '../context'
import { AVA, fakeContext, OTHER_WS, WS } from './fake'

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

/** The recorder's part for one piece: ask for its link, then PUT its bytes there (as storage takes a PUT on a signed link). */
async function send(takeId: string, role: string, index: number, bytes: Uint8Array, extra: Record<string, unknown> = {}, ctx: StudioContext = env.ctx) {
  const link = (await livePiece(ctx, takeId, { role, index, bytes: bytes.byteLength, seconds: (index + 1) * 4, ...extra })) as { index: number; url?: string; headers?: Record<string, string>; stored?: boolean }
  if (link.url) env.storage.putLink({ url: link.url, headers: link.headers! }, bytes)
  return link
}
/** Later than any take recorded in a test has gone quiet for. */
const later = () => Date.now() + QUIET_MS + 1000
/** Later than any link signed in a test can still write. */
const linksGone = () => Date.now() + LINK_SAFE_MS + 60_000
/** As if the take's last link was signed long ago (no link of it can write any more). */
function ageLinks(takeId: string) {
  for (const r of env.tables.studio_record!) if (r.collection === TRACKS && String(r.key).startsWith(`${takeId}:`)) (r.value as { updatedAt: string }).updatedAt = new Date(Date.now() - LINK_SAFE_MS - 60_000).toISOString()
}
const statusOf = (takeId: string) => (env.tables.studio_record!.find((r) => r.collection === TAKES && r.key === takeId)?.value as { status?: string } | undefined)?.status

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
    const link = await send(take.id, 'screen', 0, mp4(20000))
    expect(link.url).toBe(`fake://upload/${WS}/live/${take.id}/screen/0`)
    expect(link.headers!['content-type']).toBe('application/octet-stream')
    expect(pendingOf(`live/${take.id}/screen`)!.bytes).toBe(64 * 1024 ** 2)
    await send(take.id, 'screen', 1, filler(10000))
    const track = env.tables.studio_record!.find((r) => r.collection === TRACKS && r.key === `${take.id}:screen`)!.value as { n: number; pieces: number[]; bytes: number; seconds: number }
    expect(track).toMatchObject({ n: 2, pieces: [20000, 10000], bytes: 30000, seconds: 8 })
  })

  it('refuses pieces out of order, sent twice with another length, too large, or for a track the take does not have', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 10 })).rejects.toMatchObject({ status: 409, code: 'OUT_OF_ORDER' })
    await send(take.id, 'screen', 0, mp4(2000))
    await send(take.id, 'screen', 1, filler(2000))
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 0, bytes: 2000 })).rejects.toMatchObject({ code: 'OUT_OF_ORDER' })
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 1980 })).rejects.toMatchObject({ code: 'OUT_OF_ORDER' })
    // The last piece again, the same length (its upload failed): signed again, nothing counted twice.
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 2000 })).resolves.toMatchObject({ index: 1 })
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
      await send(take.id, 'screen', 0, mp4(20000))
      const held = pendingOf(`live/${take.id}/screen`)!.bytes
      // Fill the workspace with another file, then ask for more than the track holds.
      ;(env.tables.studio_blob ??= []).push({ workspace_id: WS, key: 'uploads/other', bytes: 40 * 1024 ** 2, parts: 2, part_bytes: 32 * 1024 ** 2, content_type: 'video/mp4', sha256: null })
      const track = env.tables.studio_record!.find((r) => r.collection === TRACKS)!.value as { bytes: number }
      track.bytes = held - 10
      await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 20000 })).rejects.toMatchObject({ status: 413, code: 'QUOTA' })
      expect(pendingOf(`live/${take.id}/screen`)!.bytes).toBe(held)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('finishing a take', () => {
  async function recorded() {
    const take = await newTake()
    await send(take.id, 'screen', 0, mp4(6000))
    await send(take.id, 'screen', 1, filler(4000))
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
    expect(read).toMatchObject({ key: take.keys.screen, bytes: 10000, sha256: null, contentType: 'video/mp4' })
    expect(read.parts.map((p) => [p.index, p.bytes, p.url])).toEqual([[0, 6000, `fake://read/${WS}/live/${take.id}/screen/0`], [1, 4000, `fake://read/${WS}/live/${take.id}/screen/1`]])
    // The space held shrinks to the track.
    expect(pendingOf(take.keys.screen!)!.bytes).toBe(10000)
    // Finished: no more pieces.
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 2, bytes: 10 })).rejects.toMatchObject({ code: 'TAKE_CLOSED' })
    await expect(discardLiveTake(env.ctx, take.id)).rejects.toMatchObject({ code: 'TAKE_CLOSED' })
  })

  it('refuses a take with a piece missing or of the wrong length, so the recorder sends it again', async () => {
    const take = await recorded()
    env.storage.objects.delete(`${WS}/live/${take.id}/screen/1`)
    await expect(startRecording(env.ctx, body(take), 0)).rejects.toThrow('The upload is not complete: piece 2 of 2 is missing.')
    env.storage.put(`${WS}/live/${take.id}/screen/1`, filler(3980))
    await expect(startRecording(env.ctx, body(take), 0)).rejects.toThrow('The upload is not complete: piece 2 of 2 has 3980 bytes, not 4000.')
    await expect(startRecording(env.ctx, body(take, { screen: 3, camera: 1, microphone: 1 }), 0)).rejects.toThrow('piece 3 of 3 was never sent')
    env.storage.put(`${WS}/live/${take.id}/screen/1`, filler(4000))
    await expect(startRecording(env.ctx, body(take), 0)).resolves.toBeTruthy()
  })

  it('reads a track the Studio cut short as far as it goes', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(6000))
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

  it('finishes the recording when its last import ends, with nobody waiting, and then drops the take, its pieces going once no link can write', async () => {
    const take = await newTake(env.ctx, ['screen', 'microphone'])
    await send(take.id, 'screen', 0, mp4(6000))
    await send(take.id, 'microphone', 0, webm(50), { offsetSeconds: -0.1 })
    const { recording } = await startRecording(env.ctx, {
      screen: { uploadKey: take.keys.screen, name: 'Screen recording.mp4', pieces: 1 },
      microphone: { uploadKey: take.keys.microphone, name: 'Microphone.m4a', offsetSeconds: -0.1, pieces: 1 },
    }, 0)
    const screenJob = (await claimJob(deps(), 'w', ['import']))!
    await finishImport(screenJob.id, 'w', asset('a'))
    // Imported, but the recording is not made yet: every piece is kept until it is.
    expect(env.storage.objects.has(`${WS}/live/${take.id}/screen/0`)).toBe(true)
    expect((await listRecordings(env.ctx)).recordings[0]).toMatchObject({ id: recording.id, status: 'processing' })
    // The microphone's import fails: the recording is finished without it, by the worker's own call.
    const micJob = (await claimJob(deps(), 'w', ['import']))!
    await failJob(deps(), micJob.id, 'w', 'The file could not be read')
    // Made: the take is dropped. Its pieces stay (a link still good cannot store over them) with their space held, until
    // no link of it can write; then the sweep takes the pieces, the space and the records.
    expect(statusOf(take.id)).toBe('dropped')
    expect(env.storage.objects.has(`${WS}/live/${take.id}/screen/0`)).toBe(true)
    expect(pendingOf(take.keys.screen!)).toBeTruthy()
    await sweepStudio(env.ctx.supabase, { storage: env.storage, now: new Date(linksGone()) })
    expect([...env.storage.objects.keys()].some((path) => path.includes(`live/${take.id}/`))).toBe(false)
    expect(pendingOf(take.keys.screen!)).toBeUndefined()
    expect(env.tables.studio_record!.filter((r) => r.collection === TAKES || r.collection === TRACKS)).toEqual([])
    const done = env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === recording.id)!.value as { status: string; projectId?: string; note?: string; ownerId: string }
    expect(done).toMatchObject({ status: 'done', ownerId: AVA, note: 'The microphone could not be added to this take.' })
    expect(env.tables.studio_video!.find((v) => v.id === done.projectId)).toMatchObject({ created_by: AVA })
    expect((await advanceRecording(env.ctx, recording.id)).recording).toMatchObject({ status: 'done', projectId: done.projectId })
  })
})

describe('a take whose window closed', () => {
  it('is offered back once no piece has come for a while, and only to its person', async () => {
    const take = await newTake()
    await send(take.id, 'screen', 0, mp4(6000))
    await send(take.id, 'camera', 0, webm(100), { offsetSeconds: 0.25 })
    expect((await savedTakes(env.ctx)).takes).toEqual([])
    const later = Date.now() + QUIET_MS + 1000
    const { takes } = await savedTakes(env.ctx, later)
    expect(takes).toHaveLength(1)
    expect(takes[0]).toMatchObject({ id: take.id, seconds: 4, bytes: 6100 })
    expect((await savedTakes(as(BEN), later)).takes).toEqual([])
  })

  it('becomes a video from the pieces that arrived: the run from the first, its end read as far as it goes', async () => {
    const take = await newTake()
    await send(take.id, 'screen', 0, mp4(6000))
    await send(take.id, 'screen', 1, filler(4000))
    // Piece 3 was signed but its upload never arrived; piece 4 did: only the unbroken run counts.
    await livePiece(env.ctx, take.id, { role: 'screen', index: 2, bytes: 2000, seconds: 12 })
    await send(take.id, 'microphone', 0, webm(50), { offsetSeconds: -0.1 })
    const answer = await recoverTake(env.ctx, take.id, 0, later())
    expect(answer.recording.status).toBe('processing')
    const jobs = env.tables.studio_job!
    const screen = jobs.find((j) => (j.input as { provenance: { role: string } }).provenance.role === 'screen')!.input as Record<string, unknown>
    expect(screen).toMatchObject({ uploadKey: take.keys.screen, partial: true, durationHint: 8 })
    const mic = jobs.find((j) => (j.input as { provenance: { role: string } }).provenance.role === 'microphone')!.input as Record<string, unknown>
    expect(mic).toMatchObject({ uploadKey: take.keys.microphone, partial: true })
    // The camera sent nothing: it is left out.
    expect(jobs).toHaveLength(2)
    const read = await readBlob(env.ctx, take.keys.screen!)
    expect(read.parts.map((p) => p.bytes)).toEqual([6000, 4000])
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
    await expect(recoverTake(env.ctx, take.id, 0, later())).rejects.toThrow('Nothing of the screen was saved, so there is no recording to bring back.')
    await expect(discardLiveTake(as(BEN), take.id)).rejects.toMatchObject({ status: 404 })
    await discardLiveTake(env.ctx, take.id)
    expect(statusOf(take.id)).toBe('dropped')
    await sweepStudio(env.ctx.supabase, { storage: env.storage, now: new Date(linksGone()) })
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

// ---- what review found -------------------------------------------------------------------------------------------

describe('the length of what is stored', () => {
  it('signs pieces without replacing: a piece stored once is answered as stored when it is asked for again', async () => {
    const take = await newTake(env.ctx, ['screen'])
    const first = await send(take.id, 'screen', 0, mp4(2000))
    expect(first.headers!['x-upsert']).toBe('false')
    // A second PUT on the same link is refused by storage: nothing replaces a stored piece.
    expect(env.storage.putLink({ url: first.url!, headers: first.headers! }, filler(5000))).toBe(false)
    // Asked for again (the answer to the PUT was lost): it is there at its length, so nothing is to be sent.
    expect(await livePiece(env.ctx, take.id, { role: 'screen', index: 0, bytes: 2000 })).toEqual({ index: 0, stored: true })
  })

  it('stops the take where a piece was stored at another length than it was declared with, and empties that piece for good', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(2000))
    const second = (await livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 2000, seconds: 8 })) as { url: string; headers: Record<string, string> }
    env.storage.putLink({ url: second.url!, headers: second.headers! }, filler(50 * 1024 ** 2))
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 2, bytes: 2000 })).rejects.toMatchObject({ status: 409, code: 'PIECE_MISMATCH' })
    // Its bytes are gone, and the path stays taken: its link (still good) cannot store anything there again.
    expect(env.storage.objects.get(`${WS}/live/${take.id}/screen/1`)?.bytes.byteLength).toBe(0)
    expect(env.storage.putLink({ url: second.url, headers: second.headers }, filler(50 * 1024 ** 2))).toBe(false)
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 2000 })).rejects.toMatchObject({ code: 'PIECE_MISMATCH' })
    // What came before is kept: the recorder's count (it believes it sent 2) is read as far as storage has it.
    await startRecording(env.ctx, { screen: { uploadKey: take.keys.screen, name: 'Screen.mp4', pieces: 2 } }, 0)
    expect(env.tables.studio_job![0]!.input).toMatchObject({ uploadKey: take.keys.screen, partial: true })
    expect((await readBlob(env.ctx, take.keys.screen!)).parts.map((p) => p.bytes)).toEqual([2000])
  })

  it('stops the take where a piece the recorder moved past was never stored', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await livePiece(env.ctx, take.id, { role: 'screen', index: 0, bytes: 2000 })
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 2000 })).rejects.toMatchObject({ code: 'PIECE_MISMATCH' })
  })

  it('signs the same piece again only so many times', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await livePiece(env.ctx, take.id, { role: 'screen', index: 0, bytes: 2000 })
    for (let i = 0; i < MAX_RESENDS; i++) await livePiece(env.ctx, take.id, { role: 'screen', index: 0, bytes: 2000 })
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 0, bytes: 2000 })).rejects.toMatchObject({ status: 409, code: 'TOO_MANY_RESENDS' })
  })

  it('keeps a thrown-away take’s pieces in place while its links can write, so no link stores anything there again', async () => {
    const take = await newTake(env.ctx, ['screen'])
    const first = await send(take.id, 'screen', 0, mp4(2000))
    const last = (await livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 2000, seconds: 8 })) as { url: string; headers: Record<string, string> }
    env.storage.putLink(last, filler(2000))
    await discardLiveTake(env.ctx, take.id)
    // Every link is refused: its piece is still there. Nothing is signed for a dropped take.
    expect(env.storage.putLink({ url: first.url!, headers: first.headers! }, filler(50 * 1024 ** 2))).toBe(false)
    expect(env.storage.putLink(last, filler(50 * 1024 ** 2))).toBe(false)
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 2, bytes: 2000 })).rejects.toMatchObject({ code: 'TAKE_CLOSED' })
    // The space stays held until the pieces go.
    expect(pendingOf(take.keys.screen!)).toBeTruthy()
    // Within the links' life the sweep leaves them; past it, everything goes.
    await sweepStudio(env.ctx.supabase, { storage: env.storage })
    expect(env.storage.objects.has(`${WS}/live/${take.id}/screen/0`)).toBe(true)
    await sweepStudio(env.ctx.supabase, { storage: env.storage, now: new Date(linksGone()) })
    expect([...env.storage.objects.keys()].some((path) => path.includes('/live/'))).toBe(false)
    expect(pendingOf(take.keys.screen!)).toBeUndefined()
  })

  it('sweeps pieces no take points to', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(2000))
    env.tables.studio_record = env.tables.studio_record!.filter((r) => r.collection !== TAKES && r.collection !== TRACKS)
    expect(await sweepStudio(env.ctx.supabase, { storage: env.storage })).toMatchObject({ liveTracks: 1 })
    expect([...env.storage.objects.keys()].some((path) => path.includes('/live/'))).toBe(false)
  })

  it('refuses a piece but the last below the floor, so links cannot be collected for next to nothing', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(PIECE_MIN_BYTES - 1))
    await expect(livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 2000 })).rejects.toMatchObject({ status: 400, code: 'TOO_SMALL' })
    // A last piece may be any size: it is sealed as it is.
    await expect(startRecording(env.ctx, { screen: { uploadKey: take.keys.screen, name: 'Screen.mp4', pieces: 1 } }, 0)).resolves.toBeTruthy()
  })
})

describe('a long take', () => {
  /** A track of `n` pieces of 10 bytes, as if recorded for an hour and more. */
  async function longTrack(n: number) {
    const take = await newTake(env.ctx, ['screen'])
    const track = env.tables.studio_record!.find((r) => r.collection === TRACKS)!.value as { n: number; pieces: number[]; times: number[]; bytes: number }
    Object.assign(track, { n, pieces: Array(n).fill(10), times: Array.from({ length: n }, (_, i) => i * 4), bytes: n * 10 })
    for (let i = 0; i < n; i++) env.storage.put(`${WS}/live/${take.id}/screen/${i}`, i ? filler(10) : mp4(16))
    ageLinks(take.id)
    return take
  }

  it('removes more pieces than storage deletes at once, in several calls', async () => {
    const take = await longTrack(1201)
    await discardLiveTake(env.ctx, take.id)
    expect([...env.storage.objects.keys()].some((path) => path.includes('/live/'))).toBe(false)
    expect(Math.max(...env.storage.removeCalls)).toBeLessThanOrEqual(1000)
  })

  it('keeps the records when the pieces cannot be listed, and removes every piece it knows of when the listing misses some', async () => {
    const take = await longTrack(3)
    env.storage.failList = true
    await expect(discardLiveTake(env.ctx, take.id)).rejects.toThrow()
    expect(env.tables.studio_record!.some((r) => r.collection === TRACKS)).toBe(true)
    env.storage.failList = false
    const list = env.storage.list.bind(env.storage)
    env.storage.list = async () => []
    await discardLiveTake(env.ctx, take.id)
    env.storage.list = list
    expect([...env.storage.objects.keys()].some((path) => path.includes('/live/'))).toBe(false)
  })
})

describe('one take, one recording', () => {
  async function recordedScreen() {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(2000))
    await send(take.id, 'screen', 1, filler(2000))
    return take
  }

  it('answers a second POST /recordings for a take with the recording it already made', async () => {
    const take = await recordedScreen()
    const body = { screen: { uploadKey: take.keys.screen, name: 'Screen.mp4', pieces: 2 } }
    const first = await startRecording(env.ctx, body, 0)
    const again = await startRecording(env.ctx, body, 0)
    expect(again.recording.id).toBe(first.recording.id)
    expect(env.tables.studio_job).toHaveLength(1)
    expect(env.tables.studio_record!.filter((r) => r.collection === 'recordings')).toHaveLength(1)
  })

  it('refuses a count above what was sealed', async () => {
    const take = await recordedScreen()
    await recoverTake(env.ctx, take.id, 0, later())
    await expect(sealLiveTrack(env.ctx, take.keys.screen!, 3)).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' })
  })

  it('does not bring back a take that may still be recording', async () => {
    const take = await recordedScreen()
    await expect(recoverTake(env.ctx, take.id, 0, Date.now())).rejects.toMatchObject({ status: 409, code: 'STILL_RECORDING' })
    // Pieces still go up.
    await expect(send(take.id, 'screen', 2, filler(2000))).resolves.toBeTruthy()
  })

  it('makes a retried start of the same take the same take, and counts only takes still recording against the limit', async () => {
    const id = '7c7c7c7c-1111-4222-8333-888888888888'
    const body = { id, recorder: 'browser', tracks: [{ role: 'screen', name: 'Screen.webm' }] }
    const first = (await startLiveTake(env.ctx, body)).take
    expect((await startLiveTake(env.ctx, body)).take).toEqual(first)
    expect(env.tables.studio_record!.filter((r) => r.collection === TAKES)).toHaveLength(1)
    await expect(startLiveTake(as(BEN), body)).rejects.toMatchObject({ status: 409 })
    // Fifty-one takes left behind do not block a new one; three still recording do.
    const old = new Date(Date.now() - 2 * QUIET_MS).toISOString()
    const age = () => { for (const r of env.tables.studio_record!) if (r.collection === TRACKS) r.updated_at = old }
    age()
    for (let i = 0; i < 51; i++) {
      await newTake(env.ctx, ['screen'])
      age()
    }
    await newTake(env.ctx, ['screen'])
    await newTake(env.ctx, ['screen'])
    await newTake(env.ctx, ['screen'])
    await expect(newTake(env.ctx, ['screen'])).rejects.toMatchObject({ status: 429 })
  })
})

describe('a recording that could not be made', () => {
  it('offers its take back with every piece kept, to bring back again or throw away', async () => {
    const take = await newTake(env.ctx, ['screen', 'microphone'])
    await send(take.id, 'screen', 0, mp4(6000))
    await send(take.id, 'microphone', 0, webm(50))
    await startRecording(env.ctx, { screen: { uploadKey: take.keys.screen, name: 'Screen.mp4', pieces: 1 }, microphone: { uploadKey: take.keys.microphone, name: 'Mic.m4a', offsetSeconds: 0, pieces: 1 } }, 0)
    const mic = (await claimJob(deps(), 'w', ['import']))!
    const screen = (await claimJob(deps(), 'w', ['import']))!
    const [micJob, screenJob] = (mic.input as unknown as { provenance: { role: string } }).provenance.role === 'microphone' ? [mic, screen] : [screen, mic]
    await finishImport(micJob.id, 'w', asset('b', { kind: 'audio', name: 'Mic.m4a', file: `assets/${'b'.repeat(64)}.m4a`, width: undefined, height: undefined, sourceFps: undefined, sourceFrames: undefined, hasAudio: true }))
    await failJob(deps(), screenJob.id, 'w', 'The file could not be read')
    expect([...env.storage.objects.keys()].filter((path) => path.includes(`/live/${take.id}/`))).toHaveLength(2)
    const { takes } = await savedTakes(env.ctx, later())
    expect(takes.map((t) => t.id)).toEqual([take.id])
    // Brought back: imported again from the same pieces, read as far as they go.
    await recoverTake(env.ctx, take.id, 0, later())
    const again = env.tables.studio_job!.filter((j) => j.status === 'queued')
    expect(again.map((j) => j.input)).toEqual(expect.arrayContaining([expect.objectContaining({ uploadKey: take.keys.screen, partial: true })]))
  })
})

describe('bringing a take back', () => {
  it('leaves out a track that is not a recording, and seals nothing when nothing of the screen arrived', async () => {
    const take = await newTake(env.ctx, ['screen', 'camera'])
    await send(take.id, 'screen', 0, mp4(2000))
    await send(take.id, 'camera', 0, new TextEncoder().encode('not a recording at all'))
    await expect(recoverTake(env.ctx, take.id, 0, later())).resolves.toMatchObject({ recording: { status: 'processing' } })
    expect(env.tables.studio_job!.map((j) => (j.input as { provenance: { role: string } }).provenance.role)).toEqual(['screen'])

    const empty = await newTake(env.ctx, ['screen', 'camera'])
    await send(empty.id, 'camera', 0, webm(100))
    await expect(recoverTake(env.ctx, empty.id, 0, later())).rejects.toThrow(/Nothing of the screen/)
    const camera = env.tables.studio_record!.find((r) => r.collection === TRACKS && r.key === `${empty.id}:camera`)!.value as { sealed?: unknown }
    expect(camera.sealed).toBeUndefined()
  })
})

describe('the sweep and the worker, as reviewed', () => {
  it('clears a take’s held space whose track is gone, and is not starved by takes’ space', async () => {
    const old = new Date(Date.now() - 3 * 24 * 3600_000).toISOString()
    const rows = env.tables.studio_record ??= []
    for (let i = 0; i < 520; i++) rows.push({ workspace_id: WS, collection: 'blob-writes', key: `live/0a0a0a0a-1111-4222-8333-${String(i).padStart(12, '0')}/screen`, value: { bytes: 1 }, updated_at: old })
    rows.push({ workspace_id: WS, collection: 'blob-writes', key: 'uploads/0d0d0d0d-1111-4222-8333-999999999999', value: { bytes: 1 }, updated_at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString() })
    await sweepStudio(env.ctx.supabase, { storage: env.storage })
    expect(env.tables.studio_record!.find((r) => r.key === 'uploads/0d0d0d0d-1111-4222-8333-999999999999')).toBeUndefined()
    await sweepStudio(env.ctx.supabase, { storage: env.storage })
    expect(env.tables.studio_record!.filter((r) => String(r.key).startsWith('live/'))).toEqual([])
  })

  it('lets a worker read a take’s track only for the job that names it', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(2000))
    await startRecording(env.ctx, { screen: { uploadKey: take.keys.screen, name: 'Screen.mp4', pieces: 1 } }, 0)
    const other = await queueJob(env.ctx, 'import', { uploadKey: 'uploads/0e0e0e0e-1111-4222-8333-999999999999', name: 'x.mp4' })
    await claimJob(deps(), 'w', ['import'])
    const own = await claimJob(deps(), 'w', ['import'])
    const read = (jobId: string) => workerBlobRead(new Request('http://localhost/x', { method: 'POST', headers: { authorization: 'Bearer dev-studio-worker', 'content-type': 'application/json' }, body: JSON.stringify({ jobId, workerId: 'w', key: take.keys.screen }) }), deps())
    const jobs = [own!.id, other.id].sort()
    const screenJob = env.tables.studio_job!.find((j) => (j.input as { uploadKey: string }).uploadKey === take.keys.screen)!.id as string
    expect((await read(screenJob)).status).toBe(200)
    expect((await read(jobs.find((id) => id !== screenJob)!)).status).toBe(409)
  })

  it('answers the worker first and finishes the recording after', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(2000))
    const { recording } = await startRecording(env.ctx, { screen: { uploadKey: take.keys.screen, name: 'Screen.mp4', pieces: 1 } }, 0)
    const job = (await claimJob(deps(), 'w', ['import']))!
    const later: (() => Promise<void>)[] = []
    const write = await createBlobWrite(env.ctx, { key: asset('a').file, bytes: 100, contentType: 'video/mp4', sha256: 'a'.repeat(64) })
    for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), filler(part.bytes))
    await commitBlob(env.ctx, asset('a').file)
    await completeJob({ ...deps(), defer: (task) => later.push(task) }, job.id, 'w', { asset: asset('a', { provenance: { rawBytes: 100, rawSha256: 'f'.repeat(64) } }) })
    const record = () => env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === recording.id)!.value as { status: string }
    expect(record().status).toBe('importing')
    expect(env.storage.objects.has(`${WS}/live/${take.id}/screen/0`)).toBe(true)
    for (const task of later) await task()
    expect(record().status).toBe('done')
    // Made: the take is dropped (its pieces go once no link of it can write).
    expect(statusOf(take.id)).toBe('dropped')
    // The original's size and hash come from what the worker read.
    expect(env.tables.studio_job!.find((j) => j.id === job.id)!.result).toMatchObject({ rawBytes: 100, rawSha256: 'f'.repeat(64) })
  })
})

// ---- the security review --------------------------------------------------------------------------------------

describe('recordings no one followed up', () => {
  /** A take made into a recording whose screen import finished, but whose follow-up after the answer was lost. */
  async function lostFollowUp() {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(2000))
    const { recording } = await startRecording(env.ctx, { screen: { uploadKey: take.keys.screen, name: 'Screen.mp4', pieces: 1 } }, 0)
    const job = (await claimJob(deps(), 'w', ['import']))!
    const write = await createBlobWrite(env.ctx, { key: asset('a').file, bytes: 100, contentType: 'video/mp4', sha256: 'a'.repeat(64) })
    for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), filler(part.bytes))
    await commitBlob(env.ctx, asset('a').file)
    await completeJob({ ...deps(), defer: () => undefined }, job.id, 'w', { asset: asset('a') })
    return { take, recording }
  }
  const row = (id: string) => env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === id)!

  it('are finished by the sweep ten minutes on', async () => {
    const { take, recording } = await lostFollowUp()
    expect((row(recording.id).value as { status: string }).status).toBe('importing')
    row(recording.id).updated_at = new Date(Date.now() - 11 * 60_000).toISOString()
    expect(await sweepStudio(env.ctx.supabase, { storage: env.storage })).toMatchObject({ recordings: 1 })
    expect((row(recording.id).value as { status: string; ownerId: string }).status).toBe('done')
    expect(statusOf(take.id)).toBe('dropped')
  })

  it('never lose their footage to the week-old pass while they could still use it', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(2000))
    await startRecording(env.ctx, { screen: { uploadKey: take.keys.screen, name: 'Screen.mp4', pieces: 1 } }, 0)
    // The import is still running; the track was last written over a week ago.
    await claimJob(deps(), 'w', ['import'])
    const track = env.tables.studio_record!.find((r) => r.collection === TRACKS)!
    track.updated_at = new Date(Date.now() - 8 * 24 * 3600_000).toISOString()
    expect(await sweepStudio(env.ctx.supabase, { storage: env.storage })).toMatchObject({ liveTracks: 0 })
    expect(env.storage.objects.has(`${WS}/live/${take.id}/screen/0`)).toBe(true)
    expect(statusOf(take.id)).toBe('finished')
  })
})

describe('the orphan pass, many takes', () => {
  it('checks take records a hundred at a time and skips a workspace it cannot read, never the run', async () => {
    const rows = env.tables.studio_record ??= []
    const id = (i: number) => `5e5e5e5e-1111-4222-8333-${String(i).padStart(12, '0')}`
    for (let i = 0; i < 250; i++) {
      rows.push({ workspace_id: WS, collection: TAKES, key: id(i), value: { id: id(i), ownerId: AVA, createdAt: new Date().toISOString(), recorder: 'browser', status: 'recording', tracks: { screen: { name: 'S.webm' } } }, updated_at: new Date().toISOString() })
      env.storage.put(`${WS}/live/${id(i)}/screen/0`, webm(16))
    }
    env.storage.put(`${WS}/live/${id(999)}/screen/0`, webm(16))
    // Another workspace whose live folder cannot be listed.
    env.storage.put(`${OTHER_WS}/live/${id(998)}/screen/0`, webm(16))
    const folders = env.storage.folders.bind(env.storage)
    env.storage.folders = async (folder: string) => {
      if (folder === `${OTHER_WS}/live`) throw new Error('Storage could not list that folder.')
      return folders(folder)
    }
    const counts = await sweepStudio(env.ctx.supabase, { storage: env.storage })
    expect(counts).toMatchObject({ liveTracks: 1 })
    expect(env.storage.objects.has(`${WS}/live/${id(999)}/screen/0`)).toBe(false)
    expect([...env.storage.objects.keys()].filter((path) => path.startsWith(`${WS}/live/`))).toHaveLength(250)
  })
})

describe('a seal and a piece at once', () => {
  it('never undoes the seal: the piece is refused or the seal is asked again', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(2000))
    const [sealed, piece] = await Promise.allSettled([sealLiveTrack(env.ctx, take.keys.screen!, 1), livePiece(env.ctx, take.id, { role: 'screen', index: 1, bytes: 2000 })])
    const track = env.tables.studio_record!.find((r) => r.collection === TRACKS)!.value as { n: number; sealed?: { count: number } }
    if (sealed.status === 'fulfilled') {
      expect(track.sealed).toMatchObject({ count: 1 })
      expect(track.n).toBe(1)
      expect(piece.status).toBe('rejected')
    } else {
      expect(track.sealed).toBeUndefined()
    }
  })
})

describe('a recording is its person’s', () => {
  it('answers another member that it is not found', async () => {
    const take = await newTake(env.ctx, ['screen'])
    await send(take.id, 'screen', 0, mp4(2000))
    const { recording } = await startRecording(env.ctx, { screen: { uploadKey: take.keys.screen, name: 'Screen.mp4', pieces: 1 } }, 0)
    await expect(advanceRecording(as(BEN), recording.id, 0)).rejects.toMatchObject({ status: 404 })
    await expect(advanceRecording(env.ctx, recording.id, 0)).resolves.toMatchObject({ recording: { id: recording.id } })
  })
})
