/**
 * The measured checks on the app's side (checks.ts), over the in-memory tables (./fake.ts): which worker may take
 * them (the analysis capabilities), what a check's job carries (the edit, its digest, the review's context, the
 * references), keeping a finished check as the video's latest (and the readiness list using a visual check only
 * while the video is unchanged), serving a check's pictures to its own workspace only, and the agent's compact
 * reading of a report. The worker's side is faked by calling the job routes' functions. Made-up videos and numbers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkImageKey, compactCheck, compactLook, compactMotion, compactReview } from '../../agent/check-answer'
import { createLayer } from '../../engine/layers'
import { createBlankVideo } from '../blank'
import { commitBlob, createBlobWrite } from '../blobs'
import { CAPABILITY_TTL_MS, checkCapabilities, forgetWorkers, noteWorker } from '../capabilities'
import type { LookResult, MotionResult, ReviewResult } from '../check-contract'
import { CHECK_FILE, checkRange, checkRecordKey, latestCheck, latestVisual, reviewContext, serveCheckFile, startCheck, visualFor, type CheckRecord } from '../checks'
import { claimJob, completeJob, jobRow } from '../jobs'
import { openVideo, saveVideo } from '../videos'
import { fakeContext, OTHER_WS } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  forgetWorkers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })

/** A stored file under a key (every part put, then committed), as the worker leaves it. */
async function storeBlob(key: string, bytes = 10) {
  // A library file is written with the hash its key names, as the worker writes one.
  const asset = /^assets\/([0-9a-f]{64})\./.exec(key)
  const write = await createBlobWrite(env.ctx, { key, bytes, contentType: 'image/png', sha256: asset?.[1] ?? null })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
  await commitBlob(env.ctx, key)
}

const look = (issues: LookResult['issues'] = []): LookResult => ({ projectId: 'v', digest: '', checkedAt: '2031-03-01T09:00:00Z', times: [0.25, 0.75], issues, sheet: 'sheet.png', folder: 'checks/x', overlap: 'not-measured', note: 'Overlays on the person were not measured.', files: ['sheet.png', 'report.json'] })
const faint: LookResult['issues'][number] = { kind: 'low-contrast', layerId: 'l2', name: 'Second line', from: 2.25, to: 4.75, worst: 1.3, box: { x: 0.3, y: 0.6, width: 0.4, height: 0.03 }, detail: 'contrast 1.3:1 against what is behind it (needs 4.5:1, or 3:1 for big text)' }

describe('capabilities', () => {
  it('the motion check and the review need a worker with the analysis, heard from in the last minute', () => {
    const t = Date.parse('2031-03-01T09:00:00Z')
    expect(checkCapabilities(t)).toEqual({ motionCheck: false, review: false })
    noteWorker('mac-1', ['motionCheck', 'review', 'voiceover'], t)
    expect(checkCapabilities(t + 1000)).toEqual({ motionCheck: true, review: true })
    expect(checkCapabilities(t + CAPABILITY_TTL_MS + 1)).toEqual({ motionCheck: false, review: false })
  })
})

describe('starting a check', () => {
  it('freezes the saved edit with its digest; motion and review only while a worker can run them, look while any worker runs', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Launch', seconds: 4, fps: 30 })
    const { projectDigest } = await openVideo(env.ctx, video.id)
    await expect(startCheck(env.ctx, 'motion', video.id, {})).rejects.toMatchObject({ status: 503, code: 'NOT_AVAILABLE' })
    await expect(startCheck(env.ctx, 'review', video.id, {})).rejects.toThrow(/STUDIO_ANALYSIS_PYTHON/)
    // With no worker at all, the visual check is refused at once rather than left waiting in the queue.
    await expect(startCheck(env.ctx, 'look', video.id, { step: 0.25 })).rejects.toMatchObject({ status: 503, code: 'NOT_AVAILABLE', message: expect.stringMatching(/none is running/) })
    expect(env.tables.studio_job ?? []).toHaveLength(0)
    noteWorker('mac-0', [])
    const { job: lookJob } = await startCheck(env.ctx, 'look', video.id, { step: 0.25 })
    expect(lookJob.status).toBe('running')
    noteWorker('mac-1', ['motionCheck', 'review'])
    const { job } = await startCheck(env.ctx, 'motion', video.id, { from: 1, to: 3 })
    const row = env.tables.studio_job!.find((r) => r.id === job.id)!
    expect(row).toMatchObject({ kind: 'motion', video_id: video.id, input: { digest: projectDigest, from: 1, to: 3 } })
    expect((row.input as { project: { id: string } }).project.id).toBe(video.id)
    await expect(startCheck(env.ctx, 'motion', video.id, { from: 3, to: 1 })).rejects.toThrow(/after/)
    await expect(startCheck(env.ctx, 'look', video.id, { step: 0 })).rejects.toThrow(/step/)
    // A reference must be a library video.
    await expect(startCheck(env.ctx, 'review', video.id, { references: ['nope'] })).rejects.toThrow(/not a video/)
    const canvas = video.assets[0]!
    const { job: reviewJob } = await startCheck(env.ctx, 'review', video.id, { references: [canvas.id] })
    const reviewRow = env.tables.studio_job!.find((r) => r.id === reviewJob.id)!
    expect(reviewRow.input).toMatchObject({ references: [{ asset: { id: canvas.id, kind: 'video' } }], context: { title: 'Launch', words: [], layers: [], clicks: [] } })
  })

  it('the review context: layers and their text, in seconds on the video', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Launch', seconds: 4, fps: 30 })
    const headline = createLayer('text', 'h1', 15, 90, { name: 'Headline', style: { text: 'Grow faster' } } as never, 30)
    const chips = createLayer('chips', 'c1', 30, 120, { name: 'Steps' }, 30)
    expect(reviewContext({ ...video, layers: [headline, chips] })).toEqual({
      title: 'Launch',
      words: [],
      layers: [
        { name: 'Headline', kind: 'text', text: 'Grow faster', start: 0.5, end: 3 },
        { name: 'Steps', kind: 'chips', text: 'First step · Second step · Third step', start: 1, end: 4 },
      ],
      clicks: [],
    })
    expect(checkRange({})).toEqual({})
    expect(() => checkRange({ from: -1 })).toThrow(/seconds/)
  })
})

describe('a finished check', () => {
  it('is kept as the video’s latest of its kind; the readiness list takes a visual check only while the video is unchanged', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Launch', seconds: 4, fps: 30 })
    const opened = await openVideo(env.ctx, video.id)
    noteWorker('mac-1', [])
    const { job } = await startCheck(env.ctx, 'look', video.id, {})
    const claimed = await claimJob(deps(), 'mac-1', ['look'])
    expect(claimed?.id).toBe(job.id)
    await completeJob(deps(), job.id, 'mac-1', look([faint]))
    const record = (await latestCheck(env.ctx, video.id, 'look')) as CheckRecord
    expect(record).toMatchObject({ kind: 'look', jobId: job.id, videoId: video.id, digest: opened.projectDigest })
    expect(env.tables.studio_record!.some((r) => r.collection === 'checks' && r.key === checkRecordKey(video.id, 'look'))).toBe(true)
    const visual = await latestVisual(env.ctx, video.id, opened.projectDigest)
    expect(visual?.issues).toEqual([faint])
    // Edited since: the check no longer counts.
    const saved = await saveVideo(env.ctx, { ...opened.project, title: 'Launch v2' }, opened.projectDigest)
    expect(await latestVisual(env.ctx, video.id, saved.projectDigest)).toBeNull()
    expect(visualFor(null, 'x')).toBeNull()
    expect(visualFor({ ...record, kind: 'motion' }, record.digest)).toBeNull()
    expect(await latestCheck(env.ctx, video.id, 'motion')).toBeNull()
  })

  it('a check that answers no report fails, and nothing is kept', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Launch', seconds: 2 })
    noteWorker('mac-1', ['motionCheck'])
    const { job } = await startCheck(env.ctx, 'motion', video.id, {})
    await claimJob(deps(), 'mac-1', ['motion'])
    await expect(completeJob(deps(), job.id, 'mac-1', { nothing: true })).rejects.toMatchObject({ status: 422 })
    expect((await jobRow(env.ctx, job.id)).status).toBe('failed')
    expect(await latestCheck(env.ctx, video.id, 'motion')).toBeNull()
  })

  it('its pictures are served to its own workspace, by its own kind, by safe names only', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Launch', seconds: 2 })
    noteWorker('mac-1', ['motionCheck'])
    const { job } = await startCheck(env.ctx, 'motion', video.id, {})
    await storeBlob(`checks/${job.id}/timeline.png`, 12)
    const get = (kinds: ('motion' | 'review' | 'look')[], file: string, ctx = env.ctx) => serveCheckFile(ctx, kinds, job.id, file, new Request('http://x/', { method: 'HEAD' }))
    const ok = await get(['motion'], 'timeline.png')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    await expect(get(['review'], 'timeline.png')).rejects.toMatchObject({ status: 404 })
    await expect(get(['motion'], 'other.png')).rejects.toMatchObject({ status: 404 })
    await expect(get(['motion'], '..%2Fx.png')).rejects.toMatchObject({ status: 404 })
    await expect(serveCheckFile(env.ctx, ['motion'], 'not-a-uuid', 'timeline.png', new Request('http://x/'))).rejects.toMatchObject({ status: 404 })
    await expect(get(['motion'], 'timeline.png', { ...env.ctx, workspaceId: OTHER_WS })).rejects.toMatchObject({ status: 404 })
    expect(CHECK_FILE.test('move_01.20_onion.png')).toBe(true)
    expect(CHECK_FILE.test('scenes/scene00_0.jpg')).toBe(false)
  })
})

describe('the agent’s reading of a report', () => {
  it('is compact, on the video’s clock, with the key picture named', () => {
    const motion: MotionResult = {
      name: 'job-m',
      offsetSeconds: 2,
      summary: { alive: 0.0943, longest_hold: 5.13, empty_seconds: 3, cuts_through_empty: 3, unknown: 'x' },
      text: 'long text',
      moves: 2,
      handoffs: [
        { start: 0.5, end: 1.5, kind: 'crossfade', picture: 'handoff_00.50.png' },
        { start: 1, end: 1.2, kind: 'transform' },
      ],
      pictures: { timeline: 'timeline.png' },
      compare: { score: 0.077, text: 'c', issues: [{ metric: 'empty_seconds', label: 'Seconds of empty frame', ours: 3, refs: [0.55], severity: 6, fix: 'keep something on screen' }] },
      references: ['reference-a'],
      files: ['timeline.png'],
    }
    const m = compactMotion(motion)
    expect(m).toMatchObject({ check: 'motion', in_range_percent: 8, summary: { alive: 0.09, longest_hold: 5.13 }, fix_first: ['Seconds of empty frame: ours 3, references 0.55. keep something on screen'], handoffs_to_rework: [{ from: 2.5, to: 3.5, kind: 'crossfade' }] })
    expect(m.summary).not.toHaveProperty('unknown')
    expect(JSON.stringify(m)).not.toContain('long text')
    expect(checkImageKey({ id: 'job-m', kind: 'motion', result: motion as never })).toBe('checks/job-m/timeline.png')

    const review: ReviewResult = {
      name: 'job-r',
      offsetSeconds: 0,
      profile: { scenes: 5, median_scene_s: 1, luma: 0.93 },
      issues: Array.from({ length: 12 }, (_, i) => ({ at: i, end: i + 1, scene: i, kind: 'static', severity: 3, text: `still ${i}` })),
      text: 'scene by scene',
      pictures: { scenes: 'scenes.png', timeline: 'timeline.png' },
      against: { references: ['ref.mp4'], rows: [{ label: 'Brightness', ours: 0.93, refs: [0.4], state: 'high', note: 'lighter than the references' }, { label: 'Scenes', ours: 1, refs: [1], state: 'ok', note: '' }], in_range: 1, of: 2 },
      scenes: 5,
      onScreenText: 'not-read',
      note: 'On-screen text was not read.',
      files: [],
    }
    const r = compactReview(review)
    expect(r.flags).toHaveLength(10)
    expect(r).toMatchObject({ more_flags: 2, on_screen_text: 'not-read', style: { in_range: 1, of: 2, off: ['Brightness: ours 0.93, references 0.4. lighter than the references'] } })
    expect(checkImageKey({ id: 'job-r', kind: 'review', result: review as never })).toBe('checks/job-r/scenes.png')

    const l = compactLook(look([faint]))
    expect(l).toEqual({
      check: 'look',
      frames: 2,
      issues: [{ kind: 'low-contrast', layer: 'Second line', layer_id: 'l2', from: 2.3, to: 4.8, what: faint.detail }],
      overlap: 'not-measured',
      note: 'Overlays on the person were not measured.',
      pictures: 'The contact sheet (each problem in its worst frame, boxed in red) is attached.',
    })
    expect(checkImageKey({ id: 'job-l', kind: 'look', result: { ...look(), sheet: '../x.png' } as never })).toBeNull()
    expect(compactCheck({ kind: 'stills', result: {} })).toBeNull()
  })
})
