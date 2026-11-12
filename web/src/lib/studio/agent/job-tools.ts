/**
 * The Studio tools that hand work to the Studio worker (studio-worker/, its
 * own container with a browser and FFmpeg): rendering frames to look at,
 * exporting a video, and reading or waiting for a job. Part of the Studio tool
 * family (src/lib/ai/tools/studio.ts), on the Studio server's job queue
 * (src/lib/studio/server/jobs.ts: a studio_job row the worker claims).
 *
 *   render_studio_stills  frames at the times given, waited for (about a
 *                         minute and a half), then shown to the agent as one
 *                         image (./stills-sheet.ts) through the tool image
 *                         slot (src/lib/ai/tools/tool-image.ts). Still
 *                         rendering at the deadline: the job id, to wait on.
 *   export_studio_video   an MP4 of the video; answers the job at once.
 *   get_studio_job        a job's status, progress, and a finished export's
 *                         download link.
 *   wait_for_studio_job   the same, once the job is done (or the wait ends);
 *                         a finished stills job shows its frames too.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { TOOL_IMAGE_BASE64, TOOL_IMAGE_MIME_TYPE } from '@/lib/ai/tools/tool-image'
import type { StudioContext } from '@/lib/studio/server/context'
import type { JobRow } from '@/lib/studio/server/jobs'
import type { StillsResult } from '@/lib/studio/server/job-contract'
import { refusal, studioRefusal, type StudioRefusal } from './access'
import type { StudioVideoFields } from './reads'
import { stillsSheet } from './stills-sheet'

type MissingKind = Parameters<typeof studioRefusal>[1]
type WithStudio = <T>(work: (ctx: StudioContext) => Promise<T>, missing?: MissingKind) => Promise<T | StudioRefusal>
type VideoAnswer = (ctx: StudioContext, id: string) => Promise<StudioVideoFields | null>

/** How long render_studio_stills waits for its frames, and wait_for_studio_job at most. */
export const STILLS_WAIT_MS = 90_000
export const JOB_WAIT_MAX_SECONDS = 90
/** How often a wait reads the job. */
const POLL_MS = 1500
/** The most frames one call renders. */
export const STILLS_MAX = 12

/** A job as the agent reads it: never its input (an export's is a whole edit). */
export function jobView(row: Pick<JobRow, 'id' | 'kind' | 'status' | 'progress' | 'error' | 'result' | 'video_id' | 'input' | 'workspace_id'>, downloadUrl?: string | null) {
  const result = row.result ?? {}
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: Math.round((Number(row.progress) || 0) * 100),
    video_id: row.video_id,
    ...(row.error ? { error: row.error } : {}),
    ...(row.kind === 'export' && row.status === 'completed'
      ? {
          ...(downloadUrl ? { download_url: downloadUrl } : {}),
          ...(typeof result.durationSeconds === 'number' ? { seconds: Math.round(result.durationSeconds * 100) / 100 } : {}),
          ...(typeof result.width === 'number' && typeof result.height === 'number' ? { width: result.width, height: result.height } : {}),
          ...(typeof result.bytes === 'number' ? { megabytes: Math.round((result.bytes / 1_000_000) * 10) / 10 } : {}),
        }
      : {}),
    ...(row.kind === 'stills' && row.status === 'completed' && Array.isArray((result as Partial<StillsResult>).stills)
      ? { stills: (result as StillsResult).stills.map((s) => ({ time: s.time, width: s.width, height: s.height })) }
      : {}),
    // A generated shot (studio-media.ts): made and placed, refused (nothing spent), or paid for with no file.
    ...(row.kind === 'shot' && row.status === 'completed'
      ? Object.fromEntries(Object.entries({ outcome: result.outcome, asset_id: result.assetId, credits: result.credits, model: result.model, placed: result.placed, error: result.error ?? result.placeError, provider_job_id: result.providerJobId }).filter(([, v]) => v !== undefined))
      : {}),
    // A narration (studio-media.ts): its asset and transcript, or paid for and not delivered (the worker's sentence).
    ...(row.kind === 'narration' && row.status === 'completed'
      ? result.outcome === 'undelivered'
        ? { outcome: 'undelivered', error: String(result.error ?? ''), characters: result.characters }
        : { asset_id: (result.asset as { id?: string } | undefined)?.id, transcript_id: (result.transcript as { id?: string } | undefined)?.id }
      : {}),
    // A re-voice, sound effects or a music bed (studio-audio.ts): the library assets it made, placed nowhere, or paid
    // for and not delivered (the worker's sentence).
    ...((row.kind === 'revoice' || row.kind === 'sound-effect' || row.kind === 'music') && row.status === 'completed'
      ? result.outcome === 'undelivered'
        ? { outcome: 'undelivered', error: String(result.error ?? ''), credits: result.credits }
        : { asset_ids: Array.isArray(result.assets) ? (result.assets as { id?: string }[]).map((a) => a.id) : [], placed: false, ...(result.transcript ? { transcript_id: (result.transcript as { id?: string }).id } : {}) }
      : {}),
    // A cut-out (studio-vision.ts): each recording's transparent cut-out, and how many were attached to the video.
    ...(row.kind === 'cutout' && row.status === 'completed' ? { cutouts: result.cutouts, attached: result.applied } : {}),
    // Ads (studio-ads.ts): what a finished batch, motion ad or reel made.
    ...(row.status === 'completed' && (row.kind === 'ads-static' || row.kind === 'ads-motion' || row.kind === 'ads-reel') ? adsView(row.kind, result as Record<string, unknown>) : {}),
  }
}

/** What a finished ads job made, compactly: ids to open, counts and the notes, never the whole report. Pure. */
export function adsView(kind: 'ads-static' | 'ads-motion' | 'ads-reel', result: Record<string, unknown>) {
  const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null))
  if (kind === 'ads-static') {
    const ads = Array.isArray(result.ads) ? (result.ads as { id?: string; flags?: unknown[]; images?: unknown[] }[]) : []
    return defined({
      batch_id: result.batchId,
      ads: ads.length,
      images: ads.reduce((n, ad) => n + (ad.images?.length ?? 0), 0),
      flagged: ads.filter((ad) => (ad.flags?.length ?? 0) > 0).map((ad) => ad.id),
      notes: result.notes,
    })
  }
  if (kind === 'ads-motion') return defined({ brief_id: result.briefId, title: result.title, made_video_id: result.videoId, check_errors: result.errors, notes: result.notes })
  return defined({ reel_id: result.reelId, title: result.title, seconds: result.seconds, asset_id: (result.render as { id?: string } | undefined)?.id, notes: result.notes })
}

/** The bytes of one stored file (its parts, joined), read through the links the Studio signs. */
async function blobBytes(ctx: StudioContext, key: string): Promise<Buffer> {
  const { readBlob } = await import('@/lib/studio/agent/server')
  const blob = await readBlob(ctx, key, 300)
  const parts = await Promise.all(
    blob.parts.map(async (part) => {
      const res = await fetch(part.url)
      if (!res.ok) throw new Error(`Couldn't read a rendered frame (${res.status}).`)
      return new Uint8Array(await res.arrayBuffer())
    }),
  )
  return Buffer.concat(parts)
}

/**
 * A finished stills job's frames, as the answer's image (the tool image keys:
 * the chat's agent sees it as an image, every other caller a note), or a note
 * when they can't be read.
 */
async function stillsImage(ctx: StudioContext, row: JobRow): Promise<Record<string, unknown>> {
  const stills = ((row.result ?? {}) as Partial<StillsResult>).stills ?? []
  if (!stills.length) return { frames: 'The job finished with no frames.' }
  // A place where an image in a tool's answer cannot reach the model (STUDIO_AGENT_FRAMES=off; web/.env.example says
  // when): the agent is told the frames exist and to work from the checklist, instead of the turn failing on the image.
  if (process.env.STUDIO_AGENT_FRAMES === 'off') {
    return { frames: `${stills.length} frame${stills.length === 1 ? '' : 's'} rendered, but frames can't be shown to you in this environment. Check the video with check_studio_video, and ask the person to open it in the Studio for anything only eyes can judge.` }
  }
  try {
    const bytes = await Promise.all(stills.map((s) => blobBytes(ctx, s.key)))
    const sheet = await stillsSheet(bytes)
    if (!sheet) return { frames: "The frames rendered but couldn't be read as images." }
    return {
      frames: stills.length === 1 ? 'One frame, attached.' : `${stills.length} frames on one sheet, left to right, top to bottom, in the order of times.`,
      [TOOL_IMAGE_BASE64]: sheet.base64,
      [TOOL_IMAGE_MIME_TYPE]: sheet.mediaType,
    }
  } catch (error) {
    return { frames: error instanceof Error ? error.message : "The frames couldn't be read." }
  }
}

/** A finished export's download link (the app serves the file to the person), else null. */
async function downloadUrl(row: JobRow): Promise<string | null> {
  if (row.kind !== 'export' || row.status !== 'completed') return null
  const { toEditorJob } = await import('@/lib/studio/agent/server')
  return toEditorJob(row).downloadUrl ?? null
}

/** A job's answer: the job, its video when it is an export (the chat's card), its frames when it is finished stills. */
async function jobAnswer(ctx: StudioContext, row: JobRow, videoAnswer: VideoAnswer, opts: { frames: boolean }) {
  const ended = row.status === 'failed' || row.status === 'cancelled'
  const done = row.status === 'completed' || ended
  const video = row.kind === 'export' && row.video_id ? await videoAnswer(ctx, row.video_id) : null
  return {
    success: true as const,
    done,
    job: jobView(row, await downloadUrl(row)),
    ...(video ? { video } : {}),
    ...(row.status === 'completed' && opts.frames && row.kind === 'stills' ? await stillsImage(ctx, row) : {}),
    // A finished measured check: its report, compact, and its key picture (./check-answer.ts).
    ...(row.status === 'completed' && (row.kind === 'motion' || row.kind === 'review' || row.kind === 'look') ? await (await import('./check-answer')).checkAnswer(ctx, row, { picture: opts.frames }) : {}),
    // A finished sound job: what it placed, or what listening measured, compact; waited for, a listen shows its sheet (./sound-view.ts).
    ...(row.status === 'completed' && ['sounds', 'sound-import', 'listen', 'sound-bank', 'sound-judge', 'sound-make'].includes(row.kind) ? await (await import('./sound-view')).soundAnswer(ctx, row, opts) : {}),
    ...(ended ? { note: `The ${row.kind} job ${row.status === 'failed' ? 'failed' : 'was cancelled'}${row.error ? `: ${row.error}` : '.'}` } : {}),
    ...(done ? {} : { note: `Still ${row.status} (${Math.round((Number(row.progress) || 0) * 100)}%). Call wait_for_studio_job with job_id ${row.id} to wait again; don't start another.` }),
  }
}

export function createStudioJobTools(withStudio: WithStudio, videoAnswer: VideoAnswer) {
  return {
    render_studio_stills: tool({
      description:
        'Look at a video: render its frames at the times given (seconds on the video) and see them, laid out left to right on one image. Fewer times give bigger frames: 1 to 4 to read text, up to 12 to see the flow. version_id renders a kept version instead, to compare two versions side by side. ' +
        "Waits about a minute and a half for the Studio's renderer; if it is still busy then, you get the job id: wait_for_studio_job shows the frames when they're done.",
      inputSchema: z.object({
        video_id: z.string().describe('The video (list_studio_projects)'),
        times: z.array(z.number().min(0)).min(1).max(STILLS_MAX).describe('Seconds on the video, one frame each'),
        scale: z.number().min(0.15).max(1).optional().describe('Size of each frame against the video, 0.15 to 1 (default 0.5)'),
        version_id: z.string().optional().describe("A kept version's frames instead of the edit now (list_studio_versions): render the same times without it to compare"),
      }),
      execute: async ({ video_id, times, scale, version_id }) =>
        withStudio(async (ctx) => {
          const { openVideo, queueJob, waitForJob, projectDuration, loadVersion } = await import('@/lib/studio/agent/server')
          const opened = await openVideo(ctx, video_id)
          let project = opened.project
          if (version_id) {
            try {
              project = { ...(await loadVersion(ctx, video_id, version_id)), id: opened.project.id }
            } catch (error) {
              return studioRefusal(error, 'version')
            }
          }
          const seconds = projectDuration(project) / project.output.fps
          const past = times.filter((t) => t > seconds)
          if (past.length) return refusal('INVALID', `The video is ${Math.round(seconds * 100) / 100} seconds long; ${past.join(', ')} ${past.length === 1 ? 'is' : 'are'} past its end.`)
          const queued = await queueJob(ctx, 'stills', { project, times, scale: scale ?? 0.5 }, video_id)
          const row = await waitForJob(ctx, queued.id, { timeoutMs: STILLS_WAIT_MS, everyMs: POLL_MS })
          // Frames that couldn't be rendered are this call's failure, said as one.
          if (row.status === 'failed' || row.status === 'cancelled') return refusal('JOB_FAILED', `The frames couldn't be rendered${row.error ? `: ${row.error}` : '.'}`)
          return jobAnswer(ctx, row, videoAnswer, { frames: true })
        }),
    }),

    export_studio_video: tool({
      description:
        "Export a video to an MP4 file, as it shows in its chosen format. Answers at once with the job: wait_for_studio_job waits for it (a short video takes a minute or two) and returns the download link. Run check_studio_video first.",
      inputSchema: z.object({ video_id: z.string().describe('The video (list_studio_projects)') }),
      execute: async ({ video_id }) =>
        withStudio(async (ctx) => {
          const { openVideo, queueExport } = await import('@/lib/studio/agent/server')
          const { project } = await openVideo(ctx, video_id)
          // Queued as the editor queues one (fonts included); `agent`: its end is delivered to the person (delivery.ts).
          const row = await queueExport(ctx, project, 'agent')
          return {
            success: true,
            job: jobView(row),
            video: await videoAnswer(ctx, video_id),
            message: `Exporting ${project.title}. wait_for_studio_job with job_id ${row.id} returns the download link.`,
          }
        }),
    }),

    get_studio_job: tool({
      description: "How a Studio job is doing (an export, frames, ads, a narration, a re-voice, a sound effect or music bed, a shot, sounds, a check or a cut-out): its status, progress and result, and a finished export's download link. Answers at once; wait_for_studio_job waits.",
      inputSchema: z.object({ job_id: z.string().describe('The job a Studio tool answered') }),
      execute: async ({ job_id }) =>
        withStudio(async (ctx) => {
          const { jobRow } = await import('@/lib/studio/agent/server')
          return jobAnswer(ctx, await jobRow(ctx, job_id), videoAnswer, { frames: false })
        }, 'job'),
    }),

    wait_for_studio_job: tool({
      description:
        `Wait for a Studio job to finish (up to ${JOB_WAIT_MAX_SECONDS} seconds), then its result: a finished export's download link, a frames job's frames to look at, or what an ads, narration, re-voice, sound effect, music, shot, sound, check or cut-out job made. ` +
        'Still going at the end: where it is up to; call this again rather than starting another.',
      inputSchema: z.object({
        job_id: z.string().describe('The job a Studio tool answered'),
        seconds: z.number().int().min(5).max(JOB_WAIT_MAX_SECONDS).optional().describe(`How long to wait at most (default ${JOB_WAIT_MAX_SECONDS})`),
      }),
      execute: async ({ job_id, seconds }) =>
        withStudio(async (ctx) => {
          const { waitForJob, jobRow } = await import('@/lib/studio/agent/server')
          await jobRow(ctx, job_id)
          const row = await waitForJob(ctx, job_id, { timeoutMs: (seconds ?? JOB_WAIT_MAX_SECONDS) * 1000, everyMs: POLL_MS })
          return jobAnswer(ctx, row, videoAnswer, { frames: true })
        }, 'job'),
    }),
  }
}
