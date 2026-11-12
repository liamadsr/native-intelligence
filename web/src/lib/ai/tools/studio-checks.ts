import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { isRefusal, studioContext, studioRefusal, type StudioRefusal } from '@/lib/studio/agent/access'
import type { StudioContext } from '@/lib/studio/server/context'

/** A video id: the Studio's ids are uuids. */
const videoId = z.string().describe('The video (list_studio_projects lists them, with their ids)')
const from = z.number().min(0).optional().describe('Check from this second on the video (default the start)')
const to = z.number().min(0).optional().describe('Check up to this second (default the end)')
const references = z.array(z.string()).max(3).optional().describe('Library video asset ids (list_studio_assets) to compare against, e.g. films whose style to match; each is measured once')

/** What every check answers: the job to wait on. */
const queued = (job: { id: string }, what: string) => ({
  success: true as const,
  job_id: job.id,
  status: 'queued',
  message: `${what} queued. wait_for_studio_job with job_id ${job.id} returns the report and its picture (a short video takes a minute or two).`,
})

/**
 * The Studio's measured checks (src/lib/studio/server/checks.ts): the agent can't watch a video, so the Studio
 * worker renders it and measures it. Each tool queues a job and answers its id; get_studio_job / wait_for_studio_job
 * answer the finished report, compact, with its key picture as the image (src/lib/studio/agent/check-answer.ts).
 * None edits the video. The latest of each kind is kept for the video, and check_studio_video counts a visual check
 * that measured the current version.
 *
 *   check_studio_motion    how the picture moves (needs the worker's analysis: the motionCheck capability)
 *   review_studio_video    the whole video scene by scene (the review capability)
 *   look_at_studio_video   the visual check: text contrast, size and overflow on the rendered frames (any worker)
 *
 * Each refuses a workspace guest, and every refusal is `{ success: false, code, error }`.
 */
export function createStudioCheckTools(userId: string, workspaceId?: string) {
  /** Run `work` as the person in the workspace's Studio, its errors as refusals. */
  const withStudio = async <T>(work: (ctx: StudioContext) => Promise<T>): Promise<T | StudioRefusal> => {
    const ctx = await studioContext(getServiceClient(), userId, workspaceId)
    if (isRefusal(ctx)) return ctx
    try {
      return await work(ctx)
    } catch (error) {
      return studioRefusal(error)
    }
  }
  const checks = () => import('@/lib/studio/server/checks')

  return {
    check_studio_motion: tool({
      description:
        "Measure how a video moves: it is rendered without sound at half size and watched frame by frame: how much of the time something moves, every move's length, peak speed and ease (snap, even, hard stop, slow start, spring overshoot), still holds, empty frames, and each handoff between beats (transform, crossfade, cut through an empty frame), compared with reference films with a fix-first list. " +
        'Trust cuts through an empty frame, empty seconds, the longest hold and the handoff list; a crossfade between two statements is fine, typing reads as a hold. Numbers are not the goal: confirm on the timeline picture. Answers a job id for wait_for_studio_job.',
      inputSchema: z.object({ video_id: videoId, from, to, reference_asset_ids: references }),
      execute: async ({ video_id, from: a, to: b, reference_asset_ids }) =>
        withStudio(async (ctx) => {
          const { startCheck } = await checks()
          const { job } = await startCheck(ctx, 'motion', video_id, { from: a, to: b, references: reference_asset_ids })
          return queued(job, 'Motion check')
        }),
    }),

    review_studio_video: tool({
      description:
        'Review a whole video as a viewer would: it is rendered with its sound and cut into scenes, each with what is on screen (when the worker can read text), what is said, its layers, clicks, motion and sound, with flags where a viewer gets lost or bored (static, dead air, empty, small text, reading, mismatch, slow open) and, with references, style rows (scene length, pacing, text size and density, brightness, motion). ' +
        "Trust static, dead air, empty and small text; the reading flag samples a few frames per scene, so check the layer's real on-screen time before acting on it. Confirm on the scenes picture. Answers a job id for wait_for_studio_job.",
      inputSchema: z.object({ video_id: videoId, from, to, reference_asset_ids: references }),
      execute: async ({ video_id, from: a, to: b, reference_asset_ids }) =>
        withStudio(async (ctx) => {
          const { startCheck } = await checks()
          const { job } = await startCheck(ctx, 'review', video_id, { from: a, to: b, references: reference_asset_ids })
          return queued(job, 'Review')
        }),
    }),

    look_at_studio_video: tool({
      description:
        "The visual check: frames every `step` seconds are rendered with and without the overlays, and each text layer is measured where it really lands: contrast against what is behind it (4.5:1, 3:1 for big text), size (under ~30 px at 1080p is too small on a phone), running off the frame. Answers a job id for wait_for_studio_job, which returns the issues and a contact sheet with each problem boxed. " +
        'check_studio_video counts it while the video is unchanged. Confirm a finding on the sheet before changing the design.',
      inputSchema: z.object({
        video_id: videoId,
        step: z.number().min(0.1).max(5).optional().describe('Seconds between frames (default 0.5)'),
        scale: z.number().min(0.2).max(1).optional().describe('Size of the frames against the video, 0.2 to 1 (default 0.5)'),
      }),
      execute: async ({ video_id, step, scale }) =>
        withStudio(async (ctx) => {
          const { startCheck } = await checks()
          const { job } = await startCheck(ctx, 'look', video_id, { step, scale })
          return queued(job, 'Visual check')
        }),
    }),
  }
}
