import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { isRefusal, studioContext, studioRefusal, type StudioRefusal } from '@/lib/studio/agent/access'
import type { StudioContext } from '@/lib/studio/server/context'
import type { EditorJob } from '@/lib/studio/engine/api'

/** A video id: the Studio's ids are uuids. */
const videoId = z.string().describe('The video (list_studio_projects lists them, with their ids)')

/** The rule every sound tool carries: the agent cannot hear. */
const EARS =
  "You cannot hear: never describe how the video sounds without listen_to_studio_video's report, and quote its numbers. Whooshes peak on the moment, risers end on it. Fix one thing at a time and listen again."

const presetField = z.enum(['launch', 'crisp', 'calm', 'minimal']).optional().describe('The kit: launch (default, music-led, soft and short), crisp (energetic product film), calm (text-led), minimal')

/** How a queued sound job answers: its id to wait on. */
function queued(job: EditorJob, message: string) {
  return { success: true as const, job: { id: job.id, kind: job.kind, status: job.status }, message: `${message} wait_for_studio_job with job_id ${job.id} returns the result.` }
}

/**
 * Sound design for the Studio's videos (src/lib/studio/server/sound.ts): the automatic sound pass, chosen sounds,
 * importing a sound or music bed from the library, the sound bank, and listening to the mix. The audio work runs in
 * the Studio worker with earshot (an outside, MIT-licensed tool installed where the worker runs); these tools queue
 * it and the app applies what comes back to the video (one undoable step, a version kept). Each answers its job at
 * once; get_studio_job / wait_for_studio_job read the result (a listen's scorecard, and its annotated sheet as an
 * image when waited for).
 *
 *   sound_pass_studio_video   a sound on every entrance, transition and click, levelled against the music
 *   add_studio_sounds         chosen sounds at times (kit roles or bank ids)
 *   import_studio_sound       a library audio file on the Sound effects track, or as the music bed
 *   list_studio_sounds        the bank and the presets' roles (read)
 *   listen_to_studio_video    the mix heard: transcript, scorecard, sheet
 *
 * Nothing leaves the workspace: the sounds are made on the workspace's own worker into its own storage and library.
 * Every refusal is `{ success: false, code, error }`; a workspace guest is refused.
 */
export function createStudioSoundTools(userId: string, workspaceId?: string) {
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
  const server = () => import('@/lib/studio/server/sound')

  return {
    sound_pass_studio_video: tool({
      description:
        "Give a video its sound effects in one go: a sound on every layer entrance, transition and recorded click (chips pop, titles whoosh or land, notifications ding, zoom punches hit, tilt-ins get a big whoosh), each on the frame the eye reads it, levelled against any music, and the music steps down before big moments. Replaces the previous automatic pass; sounds placed by hand stay. from / to limit it to a stretch (seconds). " +
        EARS,
      inputSchema: z.object({
        video_id: videoId,
        preset: presetField,
        from: z.number().min(0).optional().describe('Only moments from this second'),
        to: z.number().min(0).optional().describe('Only moments up to this second'),
        clicks: z.boolean().optional().describe('Sound the recorded clicks (default true)'),
        captions: z.boolean().optional().describe('Sound heavy caption words (default true)'),
      }),
      execute: async ({ video_id, preset, from, to, clicks, captions }) =>
        withStudio(async (ctx) => {
          const { startSoundPass } = await server()
          const { job } = await startSoundPass(ctx, video_id, { preset, from, to, clicks, captions })
          return queued(job, 'Sounding the video.')
        }),
    }),

    add_studio_sounds: tool({
      description:
        "Place sound effects at times (seconds on the video). Each: {at, kind} with a kit role (pop, whoosh.short, whoosh.long, hit, land, land.light, tick, tock, click, click.confirm (ding), text, riser, swell, drop, bell, key, snap) or {at, sound} with a bank id from list_studio_sounds, plus optional pitch (\"E5\"), dur / apex (seconds, whooshes and risers), weight (0–2), level_db, over_bed_db (how far it rides over the music: ~3 felt, 8–10 clearly heard), label. replace: cue ids to remove first. " +
        EARS,
      inputSchema: z.object({
        video_id: videoId,
        sounds: z
          .array(
            z.object({
              at: z.number().min(0).describe('Seconds on the video'),
              kind: z.string().optional().describe('A kit role'),
              sound: z.string().optional().describe('A bank id (list_studio_sounds)'),
              pitch: z.string().optional(),
              dur: z.number().optional(),
              apex: z.number().optional(),
              weight: z.number().min(0).max(2).optional(),
              level_db: z.number().optional(),
              over_bed_db: z.number().optional(),
              label: z.string().optional(),
            }),
          )
          .min(1)
          .max(200),
        preset: presetField,
        replace: z.array(z.string()).optional().describe('Cue ids to remove first (get_studio_video shows the Sound effects track)'),
      }),
      execute: async ({ video_id, sounds, preset, replace }) =>
        withStudio(async (ctx) => {
          const { startAddSounds } = await server()
          const { job } = await startAddSounds(ctx, video_id, { sounds, preset, replace })
          return queued(job, `Making ${sounds.length} sound${sounds.length === 1 ? '' : 's'}.`)
        }),
    }),

    import_studio_sound: tool({
      description:
        "Put an audio file that is already in the Studio library (list_studio_assets; uploaded by the person) on the video: on the Sound effects track with its onset (hits, clicks) or peak (whooshes) on `at`, or as the music bed (track: music) from `at` to the end, faded out over fade_out seconds (default 1.5); from starts the file that many seconds in. There is no tool to download sounds from the web in this version: ask the person to upload one. After a music bed, run sound_pass_studio_video again so the effects are levelled against it. " +
        EARS,
      inputSchema: z.object({
        video_id: videoId,
        asset_id: z.string().describe('A library audio asset (list_studio_assets)'),
        at: z.number().min(0).describe('Seconds on the video'),
        align: z.enum(['onset', 'peak']).optional().describe('Which point lands on `at` (default onset)'),
        offset_ms: z.number().min(-5000).max(5000).optional(),
        level_db: z.number().min(-60).max(12).optional().describe('Gain in dB (default 0)'),
        label: z.string().optional(),
        track: z.enum(['sfx', 'music']).optional().describe('sfx (default) or music (the bed)'),
        fade_out: z.number().min(0).max(30).optional().describe('Music: the fade at the end, seconds'),
        from: z.number().min(0).optional().describe("Start the file this many seconds in (a bed from its strongest section)"),
      }),
      execute: async ({ video_id, asset_id, at, align, offset_ms, level_db, label, track, fade_out, from }) =>
        withStudio(async (ctx) => {
          const { startImportSound } = await server()
          const { job } = await startImportSound(ctx, video_id, { assetId: asset_id, at, align, offsetMs: offset_ms, levelDb: level_db, label, track, fadeOut: fade_out, from })
          return queued(job, track === 'music' ? 'Placing the music bed.' : 'Placing the sound.')
        }),
    }),

    list_studio_sounds: tool({
      description:
        "The sound bank (sounds made in code: whooshes, pops, hits, risers, clicks, keys, mallets, dings, shutters…) with their categories and notes, and each kit preset's role → sound. query filters by any text. Needs the Studio worker with earshot the first time; then kept.",
      inputSchema: z.object({ query: z.string().optional().describe('Text to filter by (a category, a word in the notes)') }),
      execute: async ({ query }) =>
        withStudio(async (ctx) => {
          const { filterBank, presetRoles, soundBank } = await server()
          const bank = await soundBank(ctx)
          const found = filterBank(bank.sounds, query)
          const shown = found.slice(0, query ? 80 : 60)
          return {
            success: true,
            available: bank.available,
            ...(bank.version ? { version: bank.version } : {}),
            sounds: shown.map((s) => ({ id: s.id, ...(s.category ? { category: s.category } : {}), ...(Array.isArray(s.kinds) ? { kinds: s.kinds } : {}), ...(typeof s.notes === 'string' ? { notes: s.notes.slice(0, 140) } : {}) })),
            ...(found.length > shown.length ? { more: found.length - shown.length, note: 'Narrow it with query (a category: whoosh, pop, hit, riser, click, key, mallet, notify…).' } : {}),
            presets: presetRoles(bank.presets),
            ...(!bank.available && !bank.sounds.length ? { note: 'No Studio worker with earshot is running now, and the bank has not been read yet.' } : {}),
          }
        }),
    }),

    listen_to_studio_video: tool({
      description:
        "Hear a video: its mix rendered (sound only) and listened to by earshot against the video's own cue sheet: a listening transcript (what happens when, sync of each sound to its moment), a scorecard against professional launch films with timestamped fixes, and an annotated sheet image. Answers the job at once; wait_for_studio_job returns the verdict, score and scorecard, with the sheet attached. Use it after every sound change; never say how the video sounds without it. checks: any of timeline, critique, sheet (all by default).",
      inputSchema: z.object({
        video_id: videoId,
        checks: z.array(z.enum(['timeline', 'critique', 'sheet'])).min(1).optional(),
      }),
      execute: async ({ video_id, checks }) =>
        withStudio(async (ctx) => {
          const { startListen } = await server()
          const { job } = await startListen(ctx, video_id, { checks })
          return queued(job, 'Listening (a first listen loads the models: about half a minute more).')
        }),
    }),
  }
}
