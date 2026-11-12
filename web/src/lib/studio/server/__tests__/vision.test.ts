/**
 * Vision over the in-memory tables: a two-camera take (a screen recording with its words, the main camera and a side
 * camera, all made up) with made-up face tracks. The director's dry run plans from the tracks and the words and saves
 * nothing; a real run cuts with a version kept; a narrower format centres the camera crops on the tracked face; a
 * cut-out job's result is checked, registered and attached to the edit as it is now; faces are queued once and
 * cached by the recording's bytes; without a worker on a Mac, cut-outs are refused and the rest runs without faces.
 */
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorAsset, EditorProject } from '../../engine/contracts'
import type { FaceSample } from '../../engine/director'
import { registerAsset, registerTranscript, toTranscript } from '../assets'
import { commitBlob, createBlobWrite } from '../blobs'
import { forgetWorkers, noteWorker } from '../capabilities'
import { deliveryFocus, setDelivery } from '../formats'
import type { CutoutInput, CutoutMade } from '../job-contract'
import { buildTakeProject } from '../recordings'
import { putRecord } from '../records'
import { listVersions } from '../versions'
import { openVideo, renameVideo, saveVideo } from '../videos'
import {
  applyCutouts,
  cameraAssets,
  checkCutout,
  checklistFaces,
  cutoutCandidates,
  directPlan,
  directVideo,
  FACES_COLLECTION,
  fileCutout,
  fileFaces,
  focusFootage,
  gatherFaces,
  NEEDS_TRANSCRIPT,
  startCutouts,
} from '../vision'
import { fakeContext } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  forgetWorkers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

const sha = (c: string) => c.repeat(64)
const video = (id: string, name: string, extra: Partial<EditorAsset> = {}): EditorAsset => ({
  id, name, kind: 'video', file: `assets/${id}.mp4`, sha256: id, bytes: 1000, width: 1280, height: 720, sourceFps: 30, sourceFrames: 600, durationSeconds: 20, hasAudio: false, sourceCursorHidden: false, ...extra,
})
const SCREEN = video(sha('a'), 'Made-up screen take.mp4', { width: 1920, height: 1080, hasAudio: true })
const MAIN = video(sha('b'), 'Made-up main camera.mp4')
const SIDE = video(sha('c'), 'Made-up side camera.mp4')

/** The words: a greeting, a line started again, dead air, then two more sentences. */
const WORDS: [string, number, number][] = [
  ['Welcome', 0.5, 0.9], ['to', 0.9, 1.0], ['the', 1.0, 1.1], ['demo.', 1.1, 1.6],
  ['Notes', 2.0, 2.3], ['and', 2.3, 2.5], ['follow', 2.5, 2.8], ['Notes', 2.9, 3.2], ['and', 3.2, 3.4], ['follow', 3.4, 3.7], ['ups', 3.7, 3.9], ['land', 3.9, 4.2], ['in', 4.2, 4.3], ['one', 4.3, 4.5], ['place.', 4.5, 5.0],
  ['Then', 9.0, 9.3], ['the', 9.3, 9.4], ['side', 9.4, 9.7], ['camera', 9.7, 10.1], ['takes', 10.1, 10.4], ['over.', 10.4, 10.9],
  ['That', 11.2, 11.5], ['is', 11.5, 11.6], ['the', 11.6, 11.7], ['whole', 11.7, 12.0], ['flow.', 12.0, 12.6],
]

/** A face every 0.2 s, turned toward the camera (yaw 0) or away (yaw 1.2) depending on the time. */
const track = (toward: (t: number) => boolean, box = { x: 0.4, y: 0.2, w: 0.2, h: 0.35 }): FaceSample[] =>
  Array.from({ length: 100 }, (_, i) => ({ t: +(i * 0.2).toFixed(1), faces: [{ ...box, confidence: 0.9, yaw: toward(i * 0.2) ? 0 : 1.2 }] }))

/** Register the take's media and words, and save it as a video with a side camera. */
async function twoCameraVideo(options: { words?: boolean } = {}): Promise<EditorProject> {
  for (const asset of [SCREEN, MAIN, SIDE]) await registerAsset(env.ctx, asset)
  const transcript = options.words === false ? null : await registerTranscript(env.ctx, toTranscript(SCREEN, { words: WORDS.map(([text, s, e]) => ({ text, startMs: s * 1000, endMs: e * 1000 })), text: WORDS.map((w) => w[0]).join(' ') }, 'imported', sha('e'), 'Made-up words'))
  const take = buildTakeProject({ id: randomUUID(), title: 'Two-camera take', media: { screen: SCREEN, camera: { asset: MAIN, offsetSeconds: 0 }, microphone: null, systemAudio: null }, transcript })
  const project: EditorProject = { ...take, assets: [...take.assets, SIDE], sources: [{ id: 'src-side', kind: 'camera', name: 'Side camera', assetId: SIDE.id, sync: { screenAssetId: SCREEN.id, offsetSeconds: 0 } }] }
  return (await saveVideo(env.ctx, project, null)).project
}

/** The made-up tracks cached as a finished faces job leaves them: the person faces the main camera first, the side one from 8 s. */
async function cacheTracks() {
  await putRecord(env.ctx, FACES_COLLECTION, MAIN.sha256, { assetId: MAIN.id, sha256: MAIN.sha256, every: 0.2, samples: track((t) => t < 8), at: 'now' })
  await putRecord(env.ctx, FACES_COLLECTION, SIDE.sha256, { assetId: SIDE.id, sha256: SIDE.sha256, every: 0.2, samples: track((t) => t >= 8, { x: 0.3, y: 0.25, w: 0.2, h: 0.35 }), at: 'now' })
}

async function storeBlob(key: string, bytes = 10) {
  // A library file is written with the hash its key names, as the worker writes one.
  const asset = /^assets\/([0-9a-f]{64})\./.exec(key)
  const write = await createBlobWrite(env.ctx, { key, bytes, contentType: 'video/webm', sha256: asset?.[1] ?? null })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
  await commitBlob(env.ctx, key)
}

describe('the recordings vision reads', () => {
  it('finds the cameras, the cut-out candidates and the footage a format centres on', async () => {
    const project = await twoCameraVideo()
    expect(cameraAssets(project).map((a) => a.id)).toEqual([MAIN.id, SIDE.id])
    expect(cutoutCandidates(project).map((a) => a.id)).toEqual([MAIN.id, SIDE.id])
    // The screen take has no pointer trace here, so a narrower format looks for a face in it too.
    expect(focusFootage(project).map((a) => a.id)).toEqual([MAIN.id, SIDE.id, SCREEN.id])
  })
})

describe('the director pass', () => {
  it('plans a dry run from made-up tracks and words: the false start and dead air out, the camera faced, nothing saved', async () => {
    const project = await twoCameraVideo()
    await cacheTracks()
    const before = await openVideo(env.ctx, project.id)
    const out = await directVideo(env.ctx, project.id, { options: {}, dryRun: true }, 0)
    expect(out.dryRun).toBe(true)
    expect(out.faces).toBe('measured')
    expect(out.report.removed.some((r) => /false start/.test(r.why))).toBe(true)
    expect(out.report.removed.some((r) => !/false start/.test(r.why))).toBe(true) // the silence before "Then"
    const reasons = out.report.shots.map((s) => `${s.main}: ${s.reason}`)
    expect(reasons[0]).toBe('camera: facing the main camera')
    expect(reasons).toContain('src-side: facing Side camera')
    expect(out.report.medianShot).toBeGreaterThan(0)
    expect((await openVideo(env.ctx, project.id)).projectDigest).toBe(before.projectDigest)
    expect(await listVersions(env.ctx, project.id)).toEqual([])
  })

  it('cuts for real against the digest it read, with a version kept first', async () => {
    const project = await twoCameraVideo()
    await cacheTracks()
    const out = await directVideo(env.ctx, project.id, { dryRun: false }, 0)
    expect('projectDigest' in out && out.projectDigest).toBe((await openVideo(env.ctx, project.id)).projectDigest)
    expect((await listVersions(env.ctx, project.id)).map((v) => v.by)).toEqual(['Before the director pass'])
    const cut = (await openVideo(env.ctx, project.id)).project
    expect(cut.clips.some((c) => c.view?.main === 'src-side')).toBe(true)
  })

  it('refuses without words, checks its options, and runs without faces where none can be found', async () => {
    const silent = await twoCameraVideo({ words: false })
    await expect(directVideo(env.ctx, silent.id, { dryRun: true }, 0)).rejects.toThrow(NEEDS_TRANSCRIPT)
    expect(() => directPlan(silent, {}, {})).toThrow(NEEDS_TRANSCRIPT)
    env = fakeContext()
    const project = await twoCameraVideo()
    await expect(directVideo(env.ctx, project.id, { options: { minShot: 0 }, dryRun: true }, 0)).rejects.toThrow()
    await expect(directVideo(env.ctx, project.id, { options: { cut: true }, dryRun: true }, 0)).rejects.toThrow()
    const out = await directVideo(env.ctx, project.id, { dryRun: true }, 0)
    expect(out.faces).toBe('unavailable')
    expect(out.logs).toContain('Cameras were chosen without face tracks.')
    expect(env.tables.studio_job ?? []).toHaveLength(0)
  })

  it('queues one faces job for the missing tracks and answers "still finding faces" while it runs', async () => {
    const project = await twoCameraVideo()
    noteWorker('mac-1', ['faces'])
    await expect(directVideo(env.ctx, project.id, { dryRun: true }, 0)).rejects.toMatchObject({ status: 503, code: 'FACES_PENDING' })
    await expect(directVideo(env.ctx, project.id, { dryRun: true }, 0)).rejects.toMatchObject({ code: 'FACES_PENDING' })
    const jobs = env.tables.studio_job!
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ kind: 'faces', video_id: project.id })
    expect((jobs[0]!.input as { assets: EditorAsset[] }).assets.map((a) => a.id)).toEqual([MAIN.id, SIDE.id])
  })
})

describe('face tracks', () => {
  it('caches a finished job by the bytes, refuses a recording it did not ask for, and feeds the checklist', async () => {
    const project = await twoCameraVideo()
    expect(await checklistFaces(env.ctx, project)).toBeUndefined()
    const row = { input: { assets: [MAIN] } }
    await expect(fileFaces(env.ctx, row, { tracks: [{ assetId: SIDE.id, sha256: SIDE.sha256, every: 0.2, samples: [] }] })).rejects.toThrow(/did not ask for/)
    const kept = await fileFaces(env.ctx, row, { tracks: [{ assetId: MAIN.id, sha256: MAIN.sha256, every: 0.2, samples: track(() => true).slice(0, 5) }] })
    expect(kept).toEqual({ tracks: [{ assetId: MAIN.id, samples: 5, withFaces: 5 }] })
    const gathered = await gatherFaces(env.ctx, project.id, [MAIN], { waitMs: 0 })
    expect(gathered.state).toBe('measured')
    expect(gathered.tracks[MAIN.id]).toHaveLength(5)
    expect(Object.keys((await checklistFaces(env.ctx, project))!)).toEqual([MAIN.id])
  })
})

describe('face-aware formats', () => {
  it('centres each camera crop on the median tracked face, and stores it with a narrower format', async () => {
    const project = await twoCameraVideo()
    await cacheTracks()
    await directVideo(env.ctx, project.id, { dryRun: false }, 0)
    // The screen take is looked at too (it has no pointer trace here): no face in it.
    await putRecord(env.ctx, FACES_COLLECTION, SCREEN.sha256, { assetId: SCREEN.id, sha256: SCREEN.sha256, every: 0.2, samples: [{ t: 0, faces: [] }], at: 'now' })
    const { focus, faces } = await deliveryFocus(env.ctx, project.id, 0)
    expect(faces).toBe('measured')
    const cut = (await openVideo(env.ctx, project.id)).project
    const main = cut.clips.find((c) => c.view?.main === 'camera')!
    const side = cut.clips.find((c) => c.view?.main === 'src-side')!
    // The face's centre, with a little headroom: x + w/2, y + h × 0.55.
    expect(focus[main.id]).toEqual({ x: 0.5, y: 0.393 })
    expect(focus[side.id]).toEqual({ x: 0.4, y: 0.443 })
    const saved = await setDelivery(env.ctx, project.id, 'youtube-shorts')
    expect(saved.project.delivery).toEqual({ format: 'youtube-shorts', focus })
  })

  it('stays centred without a worker on a Mac, and stores no focus while faces are still being found', async () => {
    const project = await twoCameraVideo()
    expect(await deliveryFocus(env.ctx, project.id, 0)).toEqual({ focus: {}, faces: 'unavailable' })
    noteWorker('mac-1', ['faces'])
    const pending = await gatherFaces(env.ctx, project.id, cameraAssets(project), { waitMs: 0 })
    expect(pending.state).toBe('pending')
    // A format chosen meanwhile is shown at once; its crops are measured the next time.
    const saved = await setDelivery(env.ctx, project.id, 'youtube-shorts', 0)
    expect(saved.project.delivery).toEqual({ format: 'youtube-shorts' })
    await expect(deliveryFocus(env.ctx, project.id, 0)).rejects.toMatchObject({ code: 'FACES_PENDING' })
    // The cameras' job was already running: only the screen take got a job of its own.
    expect(env.tables.studio_job!.map((r) => (r.input as { assets: EditorAsset[] }).assets.map((a) => a.id))).toEqual([[MAIN.id, SIDE.id], [SCREEN.id]])
  })
})

describe('cut-outs', () => {
  const cutout = (id = sha('d'), extra: Partial<EditorAsset> = {}): CutoutMade => ({
    assetId: MAIN.id, cutoutAssetId: id, mode: 'person', asset: { ...video(id, 'Made-up main camera — cut-out.webm'), file: `assets/${id}.webm`, provenance: { cutoutOf: MAIN.id, mode: 'person' }, ...extra },
  })
  const input: CutoutInput = { assets: [MAIN], mode: 'person' }

  it('is refused without a worker on a Mac, then queued for the cameras not cut out yet', async () => {
    const project = await twoCameraVideo()
    await expect(startCutouts(env.ctx, project.id, { mode: 'person' })).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/find people in footage/) })
    noteWorker('mac-1', ['cutouts'])
    await expect(startCutouts(env.ctx, project.id, { assetIds: [SCREEN.id.replace('a', 'f')] })).rejects.toThrow(/is not a video in this project/)
    const { job } = await startCutouts(env.ctx, project.id, {})
    expect(job).toMatchObject({ kind: 'cutout', status: 'running' })
    const row = env.tables.studio_job!.find((r) => r.id === job.id)!
    expect(row.input).toMatchObject({ mode: 'person', assets: [{ id: MAIN.id }, { id: SIDE.id }] })
  })

  it('checks what the worker made against the job', () => {
    expect(checkCutout(input, cutout()).cutoutAssetId).toBe(sha('d'))
    expect(() => checkCutout(input, { ...cutout(), assetId: SIDE.id })).toThrow(/did not ask for/)
    expect(() => checkCutout(input, { ...cutout(), mode: 'subject' })).toThrow(/another mode/)
    expect(() => checkCutout(input, cutout(sha('d'), { sourceFrames: 590 }))).toThrow(/frame for frame/)
    expect(() => checkCutout(input, cutout(sha('d'), { file: `assets/${sha('d')}.mp4` }))).toThrow(/transparent WebM/)
  })

  it('attaches the cut-out to the edit: one per recording, only cutouts and assets change, a recording gone is skipped', () => {
    const base = { assets: [MAIN, SIDE], cutouts: [{ assetId: MAIN.id, cutoutAssetId: sha('9'), mode: 'subject' as const }], title: 'Kept' } as unknown as EditorProject
    const { project, applied } = applyCutouts(base, [cutout(), { ...cutout(sha('8')), assetId: sha('7') }])
    expect(applied).toHaveLength(1)
    expect(project.cutouts).toEqual([{ assetId: MAIN.id, cutoutAssetId: sha('d'), mode: 'person' }])
    expect(project.assets.map((a) => a.id)).toEqual([MAIN.id, SIDE.id, sha('d')])
    expect(project.title).toBe('Kept')
    expect(applyCutouts(project, [cutout()]).project.assets).toHaveLength(3)
  })

  it('files a finished job: registered, attached to the edit as it is now, with a version kept', async () => {
    const project = await twoCameraVideo()
    // The person renames the video while the worker cuts.
    await renameVideo(env.ctx, project.id, 'Renamed meanwhile')
    await expect(fileCutout(env.ctx, { input, video_id: project.id }, { cutouts: [cutout()] })).rejects.toThrow(/did not store/)
    await storeBlob(`assets/${sha('d')}.webm`, 1000)
    const filed = await fileCutout(env.ctx, { input, video_id: project.id }, { cutouts: [cutout()] })
    expect(filed).toMatchObject({ cutouts: [{ assetId: MAIN.id, cutoutAssetId: sha('d'), mode: 'person' }], applied: 1 })
    const now = (await openVideo(env.ctx, project.id)).project
    expect(now.title).toBe('Renamed meanwhile')
    expect(now.cutouts).toEqual([{ assetId: MAIN.id, cutoutAssetId: sha('d'), mode: 'person' }])
    expect(env.tables.studio_asset!.some((r) => r.id === sha('d'))).toBe(true)
    expect((await listVersions(env.ctx, project.id)).map((v) => v.by)).toEqual(['Before the cut-out'])
    // Asking again for the same recording in the same mode has nothing to do.
    noteWorker('mac-1', ['cutouts'])
    await expect(startCutouts(env.ctx, project.id, { assetIds: [MAIN.id], mode: 'person' })).rejects.toThrow(/Already cut out/)
  })
})
