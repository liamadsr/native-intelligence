import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { exportPresets } from '@/lib/studio/engine/formats'
import type { DirectorReport } from '@/lib/studio/engine/director'
import { isRefusal, studioContext, studioRefusal, type StudioRefusal } from '@/lib/studio/agent/access'
import type { StudioContext } from '@/lib/studio/server/context'

/** A video id: the Studio's ids are uuids. */
const videoId = z.string().describe('The video (list_studio_projects lists them, with their ids)')

/** The director's rules, in its tool's description. */
const DIRECTOR_RULES =
  'Its rules: cut on sentence boundaries (never mid-sentence), shots between about 2.2 and 8 seconds, never two cuts within a second, the camera the person faces, the screen when they click or type. ' +
  'Locked beats are left alone.'

/** The plan as the agent reads it: removed stretches and each shot with its reason, in seconds. Pure. */
export function directorPlan(report: DirectorReport) {
  return {
    removed: report.removed.map((r) => ({ from: r.from, to: r.to, why: r.why })),
    shots: report.shots.map((s) => ({ from: s.from, to: s.to, shows: s.main, reason: s.reason })),
    median_shot_seconds: report.medianShot,
    cuts_per_minute: report.cutsPerMinute,
    length_seconds: report.seconds,
  }
}

/**
 * The Studio's vision (src/lib/studio/server/vision.ts): what the Studio worker sees with macOS Vision when it runs
 * on a Mac. The production container is Linux and cannot: there, a cut-out is refused with a sentence, a format's
 * crops stay centred, and the director picks cameras without face tracks.
 *
 *   cut_out_studio_subject       the person (or any subject) cut out of a video's recordings, so layers marked
 *                                behind sit behind them; a job to wait for, attached as one undoable step
 *   direct_studio_video          the director pass on a multi-camera take: a dry run answers the plan, a real run
 *                                cuts (a version kept first)
 *   set_studio_delivery_format   show and export a video in a platform's shape, the camera crops centred on the
 *                                face (measured from face tracks), non-destructively
 *
 * Each works through the Studio server's own functions, the editor's checked path; each refuses a workspace guest,
 * and every refusal is `{ success: false, code, error }`.
 */
export function createStudioVisionTools(userId: string, workspaceId?: string) {
  /** Run `work` as the person in the workspace's Studio, its errors as refusals. */
  const withStudio = async <T>(work: (ctx: StudioContext) => Promise<T>, missing?: Parameters<typeof studioRefusal>[1]): Promise<T | StudioRefusal> => {
    const ctx = await studioContext(getServiceClient(), userId, workspaceId)
    if (isRefusal(ctx)) return ctx
    try {
      return await work(ctx)
    } catch (error) {
      return studioRefusal(error, missing)
    }
  }
  const vision = () => import('@/lib/studio/server/vision')

  return {
    cut_out_studio_subject: tool({
      description:
        'Cut the person out of a video\'s recordings (macOS Vision, like "lift subject from background"), so layers marked behind: true sit behind the speaker: words behind the head, a new background behind the person. ' +
        'Defaults to the video\'s camera recordings; asset_ids names others. mode "subject" isolates any main object instead of people. ' +
        'Takes about as long as the footage: answers a job id for wait_for_studio_job; when it finishes the cut-out is attached to the video as one undoable step (a version kept before). ' +
        'Needs the Studio worker running on a Mac; refused with a sentence otherwise.',
      inputSchema: z.object({
        video_id: videoId,
        asset_ids: z.array(z.string()).max(16).optional().describe("Recordings to cut out (their asset ids in the video); the video's cameras when left out"),
        mode: z.enum(['person', 'subject']).default('person').describe('person: people only; subject: any main object'),
      }),
      execute: async ({ video_id, asset_ids, mode }) =>
        withStudio(async (ctx) => {
          const { startCutouts } = await vision()
          const { job } = await startCutouts(ctx, video_id, { ...(asset_ids?.length ? { assetIds: asset_ids } : {}), mode })
          return { success: true, video_id, job_id: job.id, status: job.status, note: 'Cutting out runs in the Studio worker: wait_for_studio_job with this job id. When it completes, the cut-out is in the video.' }
        }, 'video'),
    }),

    direct_studio_video: tool({
      description:
        'The director pass on a video recorded with several cameras (or a camera and the screen): cuts false starts and dead air, then picks the picture for each stretch, each shot with its reason. ' +
        DIRECTOR_RULES +
        ' Run it with dry_run true first (the default): it answers the plan (the stretches it would remove, each shot with its reason, the median shot and cuts per minute) and saves nothing. Show the person the plan, then run it with dry_run false to cut; the edit as it was is kept as a version. ' +
        'It needs a transcript of the recording. Face tracks come from the Studio worker on a Mac; without one, cameras are chosen without them.',
      inputSchema: z.object({
        video_id: videoId,
        options: z
          .object({
            minShot: z.number().min(0.5).max(30).optional().describe('Shortest shot in seconds (2.2)'),
            maxShot: z.number().min(1).max(120).optional().describe('Longest shot before the angle changes, in seconds (8)'),
            minGap: z.number().min(0).max(10).optional().describe('Least time between two cuts, in seconds (1)'),
            cutDeadAir: z.boolean().optional().describe('Remove silences (true)'),
            deadAir: z.number().min(0.2).max(10).optional().describe('A silence longer than this many seconds is dead air'),
            falseStarts: z.boolean().optional().describe('Remove a line started again, keeping the last try (true)'),
            screen: z.boolean().optional().describe('Go to the screen for clicks and typing (true)'),
          })
          .strict()
          .optional(),
        dry_run: z.boolean().default(true).describe('true: answer the plan and save nothing; false: cut'),
      }),
      execute: async ({ video_id, options, dry_run }) =>
        withStudio(async (ctx) => {
          const { directVideo } = await vision()
          const out = await directVideo(ctx, video_id, { options: options ?? {}, dryRun: dry_run })
          const plan = directorPlan(out.report)
          if (dry_run) return { success: true, video_id, dry_run: true, plan, faces: out.faces, logs: out.logs, note: 'Nothing was saved. Show the person this plan; run again with dry_run false to cut.' }
          return { success: true, video_id, dry_run: false, plan, faces: out.faces, logs: out.logs, digest: 'projectDigest' in out ? out.projectDigest : undefined, note: 'Cut. The edit as it was is kept as a version (list_studio_versions).' }
        }, 'video'),
    }),

    set_studio_delivery_format: tool({
      description:
        `Show and export a video in a platform's shape, in place and non-destructively: the edit stays as it is and the format is a reframed view (switch back with original). Formats: original, ${exportPresets.map((p) => `${p.id} (${p.label})`).join(', ')}. ` +
        "For a narrower shape (a 16:9 recording as 9:16) the camera crops centre on the person's face, measured from face tracks (the Studio worker on a Mac; centred without one). Prefer this to edit_studio_video's set_format, which does not measure the faces. " +
        'make_studio_format makes a separate video instead.',
      inputSchema: z.object({ video_id: videoId, format: z.enum(['original', ...exportPresets.map((p) => p.id)] as [string, ...string[]]) }),
      execute: async ({ video_id, format }) =>
        withStudio(async (ctx) => {
          const { setDelivery } = await import('@/lib/studio/server/formats')
          const saved = await setDelivery(ctx, video_id, format)
          const focus = saved.project.delivery?.focus
          return {
            success: true,
            video_id,
            format,
            digest: saved.projectDigest,
            face_centred_clips: focus ? Object.keys(focus).length : 0,
            ...(format !== 'original' && !focus ? { note: 'Faces were not measured yet (still being found, or no Studio worker on a Mac): crops are centred. Set the format again shortly to measure them.' } : {}),
          }
        }, 'video'),
    }),
  }
}
