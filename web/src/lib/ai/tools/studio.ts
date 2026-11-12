import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { opNames } from '@/lib/studio/engine/ops'
import { exportPresets } from '@/lib/studio/engine/formats'
import { isRefusal, missingRefusal, refusal, studioContext, studioRefusal, type StudioRefusal } from '@/lib/studio/agent/access'
import { readStudioOverview, readStudioVideoBrief, videoFields } from '@/lib/studio/agent/reads'
import { parseScriptText, scriptSeconds, scriptText } from '@/lib/studio/agent/script-text'
import { createStudioJobTools } from '@/lib/studio/agent/job-tools'
import { studioBrandWords } from '@/lib/studio/agent/brand-words'
import type { StudioContext } from '@/lib/studio/server/context'

/** A video id: the Studio's ids are uuids. */
const videoId = z.string().describe('The video (list_studio_projects lists them, with their ids)')

/** The most media one list_studio_assets answer holds. */
const ASSETS_MAX = 100

/**
 * The Studio (migration 620): making videos and ads. A Studio project groups
 * the videos a team makes with the same cast, brand and media; a video is one
 * edit. "Studio project" and "video" everywhere the agent could confuse them
 * with the Projects page or an outreach campaign.
 *
 *   list_studio_projects   the Studio projects, each with its videos, and the videos in none.
 *   get_studio_video       one video: the engine's summary of its edit, its digest, a link.
 *   get_studio_catalog     every editing command with its arguments, and the automation catalog.
 *   get_studio_storyboard  a video's beats, cast and inputs.
 *   get_studio_script /
 *   write_studio_script    a video's script, as text.
 *   list_studio_assets     the media library.
 *   create_studio_project /
 *   update_studio_project  a Studio project.
 *   create_studio_video    a blank-canvas video.
 *   update_studio_video    its title, status or Studio project.
 *   duplicate_studio_video a copy.
 *   edit_studio_video      editing commands, in order, as ONE undoable step: the write path.
 *   make_studio_format     a separate video reframed for a platform.
 *   list_studio_versions /
 *   restore_studio_version the versions kept before each pass.
 *   check_studio_video     the readiness checklist.
 *   render_studio_stills,
 *   export_studio_video,
 *   get_studio_job,
 *   wait_for_studio_job    the Studio worker's jobs (src/lib/studio/agent/job-tools.ts).
 *   archive_studio_video   to the trash.
 *
 * Every tool works through the Studio server's own functions
 * (src/lib/studio/server/), the same checked path the editor takes: a
 * person's edit and the agent's never overwrite each other (the digest), and
 * every agent pass keeps the version before it. Each refuses a workspace guest
 * (src/lib/studio/agent/access.ts), and every refusal is
 * `{ success: false, code, error }`. Answers are compact: never the whole edit.
 */
export function createStudioTools(userId: string, workspaceId?: string) {
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
  /** One video as the card and the agent read it, or a refusal when it is gone. */
  const videoAnswer = async (ctx: StudioContext, id: string) => {
    const brief = await readStudioVideoBrief(ctx.supabase, ctx.workspaceId, id)
    return brief ? videoFields(brief) : null
  }

  return {
    list_studio_projects: tool({
      description:
        'The Studio: every Studio project (a group of videos made with the same cast and brand: a launch, one client\'s ads) with its videos, and the videos in no Studio project. ' +
        'Each video: id, title, status (draft, review, approved), length in seconds, width and height. Start here to find a video\'s id. ' +
        "brand_words points at the canon documents the videos' words come from (the product's positioning and voice, the person's voice): read them with read_canon before writing a script.",
      inputSchema: z.object({}),
      execute: async () =>
        withStudio(async (ctx) => {
          const overview = await readStudioOverview(ctx.supabase, ctx.workspaceId)
          const count = overview.projects.reduce((n, p) => n + p.videos.length, overview.unfiled.length)
          // Where the videos' words live: canon pointers (keys, never their text), read with read_canon.
          const brandWords = await studioBrandWords(ctx.supabase, ctx.workspaceId, userId)
          return {
            success: true,
            studio_projects: overview.projects,
            videos_in_no_studio_project: overview.unfiled,
            brand_words: brandWords,
            ...(count ? {} : { note: 'No videos yet: create_studio_video makes a blank one (create_studio_project first to group several).' }),
          }
        }),
    }),

    get_studio_video: tool({
      description:
        "One video's edit, summarized: its size and frame rate, length, media, clips (with the clicks recorded in them), layers, automation, shots, sources, slides and the transcript (capped), " +
        'plus its digest (pass it to edit_studio_video as expected_digest), status, Studio project, and a link the person opens it at. Times are seconds on the video; positions fractions of the frame.',
      inputSchema: z.object({ video_id: videoId }),
      execute: async ({ video_id }) =>
        withStudio(async (ctx) => {
          const brief = await readStudioVideoBrief(ctx.supabase, ctx.workspaceId, video_id)
          if (!brief) return missingRefusal('video')
          const { summary, ...video } = brief
          return { success: true, video, edit: summary }
        }),
    }),

    get_studio_catalog: tool({
      description:
        'What edit_studio_video accepts: every editing command with its arguments as JSON Schema, and the automation catalog (the picture and layer parameters with their ranges, the animations, transitions, text looks and layer kinds). Read it once before editing.',
      inputSchema: z.object({}),
      execute: async () =>
        withStudio(async () => {
          const { catalog } = await import('@/lib/studio/agent/server')
          const { commands, automation } = catalog()
          return { success: true, commands, automation, formats: exportPresets.map((p) => ({ id: p.id, label: p.label, width: p.width, height: p.height })) }
        }),
    }),

    get_studio_storyboard: tool({
      description:
        "A video's storyboard: every beat in order (its time, words and the words its length holds, picture source, status, whether the person locked it, notes), the cast and the inputs. Change it with edit_studio_video's storyboard commands.",
      inputSchema: z.object({ video_id: videoId }),
      execute: async ({ video_id }) =>
        withStudio(async (ctx) => {
          const { openVideo, applyOps } = await import('@/lib/studio/agent/server')
          const { project } = await openVideo(ctx, video_id)
          const { results } = applyOps(project, [{ op: 'storyboard', args: {} }])
          return { success: true, video_id, storyboard: results[0] }
        }),
    }),

    get_studio_script: tool({
      description: "A video's script, what gets said, as text: blocks separated by a blank line, each optionally starting [5s] Label:. Empty when it has none.",
      inputSchema: z.object({ video_id: videoId }),
      execute: async ({ video_id }) =>
        withStudio(async (ctx) => {
          const { getScript, openVideo } = await import('@/lib/studio/agent/server')
          await openVideo(ctx, video_id)
          const script = await getScript(ctx, video_id)
          if (!script) return { success: true, video_id, script: null, note: 'This video has no script yet: write_studio_script writes one.' }
          return { success: true, video_id, script: { title: script.title, beats: script.beats.length, seconds: scriptSeconds(script.beats), text: scriptText(script.beats), updated_at: script.updatedAt } }
        }),
    }),

    write_studio_script: tool({
      description:
        "Write a video's script (replacing the one it has): what gets said, the teleprompter's text and what a storyboard starts from (edit_studio_video storyboard_from_script). " +
        'text is blocks separated by a blank line, one per beat; a block may start with its length and its name: "[5s] Hook: Your inbox, finally quiet." Up to 100 beats. ' +
        'Or give document_id instead of text: the script is that document, word for word, one beat per paragraph (a heading names the beat after it). ' +
        'as_document: true also puts the script in a new document "<video title>: script", linked to the video (with neither text nor document_id, it does only that, for the script the video has).',
      inputSchema: z.object({
        video_id: videoId,
        title: z.string().max(200).optional().describe("The script's title. Omit to keep it"),
        text: z.string().min(1).max(100_000).optional().describe('The script: blocks separated by a blank line, each optionally starting [5s] Label:'),
        document_id: z.string().optional().describe('A document to take the script from, word for word (list_documents finds it). Instead of text'),
        as_document: z.boolean().optional().describe('Also save the script as a new document linked to the video'),
      }),
      execute: async ({ video_id, title, text, document_id, as_document }) => {
        if (text && document_id) return refusal('INVALID', 'Give text or document_id, not both.')
        if (!text && !document_id && !as_document) return refusal('INVALID', 'Give the script as text, or a document_id to take it from.')
        const parsed = text ? parseScriptText(text) : null
        if (parsed && !parsed.ok) return refusal('INVALID', parsed.error)
        return withStudio(async (ctx) => {
          const { getScript, saveScript, scriptFromDocument, scriptToDocument } = await import('@/lib/studio/agent/server')
          let script = parsed?.ok
            ? await saveScript(ctx, video_id, { beats: parsed.beats, ...(title ? { title } : {}) })
            : document_id
              ? (await scriptFromDocument(ctx, video_id, document_id)).script
              : await getScript(ctx, video_id)
          if (!script) return refusal('INVALID', 'This video has no script yet: write one with text or document_id first.')
          if (document_id && title) script = await saveScript(ctx, video_id, { beats: script.beats, title })
          const doc = as_document ? await scriptToDocument(ctx, video_id) : null
          return {
            success: true,
            video_id,
            script: { title: script.title, beats: script.beats.length, seconds: scriptSeconds(script.beats) },
            ...(doc ? { document: { id: doc.document.id, title: doc.document.title, linked_to_video: doc.linked } } : {}),
            message: `${parsed || document_id ? `Saved the script (${script.beats.length} beats)` : 'Kept the script'}${doc ? `, and put it in the document ${doc.document.title}` : ''}.`,
          }
        })
      },
    }),

    list_studio_assets: tool({
      description: "The workspace's Studio media library: recordings, uploads, generated media. Each: id (what commands name it by), name, kind, seconds, width and height. Filter by kind or a word in its name.",
      inputSchema: z.object({
        kind: z.enum(['video', 'image', 'audio']).optional().describe('Only this kind'),
        query: z.string().max(200).optional().describe('Only media whose name has this'),
      }),
      execute: async ({ kind, query }) =>
        withStudio(async (ctx) => {
          const { listAssets } = await import('@/lib/studio/agent/server')
          const want = query?.trim().toLowerCase()
          const all = (await listAssets(ctx)).filter((a) => (!kind || a.kind === kind) && (!want || a.name.toLowerCase().includes(want)))
          return {
            success: true,
            total: all.length,
            assets: all.slice(0, ASSETS_MAX).map((a) => ({
              id: a.id,
              name: a.name,
              kind: a.kind,
              ...(a.durationSeconds !== undefined ? { seconds: Math.round(a.durationSeconds * 100) / 100 } : {}),
              ...(a.width && a.height ? { width: a.width, height: a.height } : {}),
            })),
            ...(all.length > ASSETS_MAX ? { note: `The first ${ASSETS_MAX}; narrow with kind or query.` } : {}),
          }
        }),
    }),

    create_studio_project: tool({
      description:
        'Make a Studio project: the group for videos made with the same cast, brand and media (a launch, a season, one client\'s ads). Not the Projects page\'s projects, and not an outreach campaign.',
      inputSchema: z.object({
        title: z.string().min(1).max(160),
        client: z.string().max(160).optional().describe('Who the videos are for'),
        notes: z.string().max(20_000).optional().describe('The brief, the audience, what to keep to'),
      }),
      execute: async ({ title, client, notes }) =>
        withStudio(async (ctx) => {
          const { createProject, updateProject } = await import('@/lib/studio/agent/server')
          // A new project's brand starts from the workspace (its name; its logo's link in the notes: brand-seed.ts).
          let made = await createProject(ctx, title)
          if (client || notes) made = await updateProject(ctx, made.id, { client, notes: notes ? [notes, made.notes].filter(Boolean).join('\n\n') : undefined })
          return { success: true, studio_project: { id: made.id, title: made.title, client: made.client ?? null }, message: `Made the Studio project ${made.title}.` }
        }, 'studio_project'),
    }),

    update_studio_project: tool({
      description: "Change a Studio project's title, client, notes or brand (its name and colours). Give only what changes.",
      inputSchema: z.object({
        project_id: z.string().describe('The Studio project (list_studio_projects)'),
        title: z.string().min(1).max(160).optional(),
        client: z.string().max(160).optional(),
        notes: z.string().max(20_000).optional(),
        brand: z
          .object({
            name: z.string().max(120).optional(),
            colors: z.array(z.object({ name: z.string().max(60), hex: z.string().regex(/^#[\da-fA-F]{6}$/) })).max(24).optional(),
          })
          .optional()
          .describe('The brand its videos keep to: a name and named #RRGGBB colours'),
      }),
      execute: async ({ project_id, ...patch }) =>
        withStudio(async (ctx) => {
          const { isUuid, updateProject } = await import('@/lib/studio/agent/server')
          if (!isUuid(project_id)) return missingRefusal('studio_project')
          const saved = await updateProject(ctx, project_id, patch)
          return { success: true, studio_project: { id: saved.id, title: saved.title, client: saved.client ?? null, notes: saved.notes ? saved.notes.slice(0, 500) : null } }
        }, 'studio_project'),
    }),

    create_studio_video: tool({
      description:
        'Make a blank-canvas video: a plain colour picture to build from layers (titles, cards, motion), with nothing recorded; footage can be recorded or dropped on top later. ' +
        'Defaults: 1920x1080, 60 fps, 15 seconds. 1080x1920 for Shorts, Reels and TikTok, 1080x1350 for a feed. In a Studio project, or none.',
      inputSchema: z.object({
        title: z.string().min(1).max(250),
        studio_project_id: z.string().optional().describe('The Studio project to file it in (list_studio_projects). Omit for none'),
        width: z.number().int().min(64).max(4096).optional(),
        height: z.number().int().min(64).max(4096).optional(),
        fps: z.number().int().min(1).max(60).optional(),
        seconds: z.number().min(1).max(600).optional(),
        color: z.string().regex(/^#[\da-fA-F]{6}$/).optional().describe('The canvas colour, #RRGGBB'),
      }),
      execute: async ({ title, studio_project_id, width, height, fps, seconds, color }) =>
        withStudio(async (ctx) => {
          const { createBlankVideo, fileVideo, isUuid } = await import('@/lib/studio/agent/server')
          if (studio_project_id && !isUuid(studio_project_id)) return missingRefusal('studio_project')
          const made = await createBlankVideo(ctx, { title, width: width ?? 1920, height: height ?? 1080, fps: fps ?? 60, seconds: seconds ?? 15, ...(color ? { color } : {}) })
          if (studio_project_id) {
            try {
              await fileVideo(ctx, studio_project_id, made.id)
            } catch (error) {
              return { ...studioRefusal(error, 'studio_project'), video_id: made.id, note: 'The video was made, in no Studio project.' }
            }
          }
          const video = await videoAnswer(ctx, made.id)
          return { success: true, video, message: `Made ${made.title}. Open it in the Studio: ${video?.link ?? ''}` }
        }),
    }),

    update_studio_video: tool({
      description:
        "Change a video's title, its status (draft, review, approved: a video in a Studio project only), or its Studio project (an id to file it there, null to take it out). Give only what changes.",
      inputSchema: z.object({
        video_id: videoId,
        title: z.string().min(1).max(250).optional(),
        status: z.enum(['draft', 'review', 'approved']).optional(),
        studio_project_id: z.string().nullable().optional().describe('The Studio project to file it in; null for none'),
      }),
      execute: async ({ video_id, title, status, studio_project_id }) =>
        withStudio(async (ctx) => {
          const { fileVideo, unfileVideo, setVideoStatus, openVideo, renameVideo, isUuid } = await import('@/lib/studio/agent/server')
          await openVideo(ctx, video_id)
          if (studio_project_id === null) await unfileVideo(ctx, video_id)
          else if (studio_project_id !== undefined) {
            if (!isUuid(studio_project_id)) return missingRefusal('studio_project')
            try {
              await fileVideo(ctx, studio_project_id, video_id)
            } catch (error) {
              return studioRefusal(error, 'studio_project')
            }
          }
          if (status) await setVideoStatus(ctx, video_id, status)
          if (title) await renameVideo(ctx, video_id, title)
          return { success: true, video: await videoAnswer(ctx, video_id) }
        }),
    }),

    duplicate_studio_video: tool({
      description: 'Copy a video as a new one, filed next to it (same edit, same Studio project). To try another take on a video without touching it.',
      inputSchema: z.object({ video_id: videoId, title: z.string().min(1).max(250).optional().describe('The copy\'s title. Omit for "<title> copy"') }),
      execute: async ({ video_id, title }) =>
        withStudio(async (ctx) => {
          const { duplicateVideo, renameVideo } = await import('@/lib/studio/agent/server')
          const copy = await duplicateVideo(ctx, video_id)
          if (title) await renameVideo(ctx, copy.id, title)
          return { success: true, video: await videoAnswer(ctx, copy.id) }
        }),
    }),

    edit_studio_video: tool({
      description:
        'Edit a video: apply editing commands in order as ONE undoable step, all or nothing. Each is {op, args}; get_studio_catalog has every command\'s arguments. ' +
        'A refusal names the failing step and nothing is saved. Pass the digest you read (get_studio_video) as expected_digest: a video the person changed since is refused, read it again. ' +
        'Beats the person locked are theirs: propose those changes in chat. The version before the edit is kept (list_studio_versions). ' +
        `Times are seconds on the video; positions fractions of the frame (0,0 top left). Commands: ${opNames.join(', ')}.`,
      inputSchema: z.object({
        video_id: videoId,
        edits: z
          .array(
            z.object({
              op: z.enum(opNames as [string, ...string[]]).describe('The command'),
              args: z.record(z.string(), z.unknown()).optional().describe("The command's arguments (get_studio_catalog)"),
            }),
          )
          .min(1)
          .max(200),
        expected_digest: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('The digest get_studio_video returned'),
      }),
      execute: async ({ video_id, edits, expected_digest }) =>
        withStudio(async (ctx) => {
          const { runOps } = await import('@/lib/studio/agent/server')
          const { projectDigest, results } = await runOps(ctx, video_id, edits.map((e) => ({ op: e.op, args: e.args ?? {} })), expected_digest)
          return { success: true, digest: projectDigest, results, video: await videoAnswer(ctx, video_id) }
        }),
    }),

    make_studio_format: tool({
      description:
        `Make a separate video reframed for a platform: its shape and loudness, text moved clear of its buttons, filed as an output of this one (asking again remakes it). Formats: ${exportPresets.map((p) => `${p.id} (${p.label})`).join(', ')}. ` +
        'Returns the new video and what breaks the platform\'s rules (too long, text under its buttons).',
      inputSchema: z.object({ video_id: videoId, format: z.enum(exportPresets.map((p) => p.id) as [string, ...string[]]) }),
      execute: async ({ video_id, format }) =>
        withStudio(async (ctx) => {
          const { makeFormatVersion } = await import('@/lib/studio/agent/server')
          const made = await makeFormatVersion(ctx, video_id, format)
          return { success: true, video: await videoAnswer(ctx, made.projectId), warnings: made.warnings }
        }),
    }),

    list_studio_versions: tool({
      description: "A video's kept versions, newest first: the edit as it was before each assistant pass or restore. restore_studio_version puts one back.",
      inputSchema: z.object({ video_id: videoId }),
      execute: async ({ video_id }) =>
        withStudio(async (ctx) => {
          const { openVideo, listVersions } = await import('@/lib/studio/agent/server')
          await openVideo(ctx, video_id)
          const versions = await listVersions(ctx, video_id)
          return { success: true, video_id, versions: versions.map((v) => ({ id: v.id, at: v.at, label: v.by })) }
        }),
    }),

    restore_studio_version: tool({
      description: "Put a kept version of a video back. The edit as it is now is kept as a version first, so this is undone the same way. The person's latest device choices stay.",
      inputSchema: z.object({ video_id: videoId, version_id: z.string().describe('The version (list_studio_versions)') }),
      execute: async ({ video_id, version_id }) =>
        withStudio(async (ctx) => {
          const { openVideo, restoreVersion } = await import('@/lib/studio/agent/server')
          await openVideo(ctx, video_id)
          try {
            const saved = await restoreVersion(ctx, video_id, version_id)
            return { success: true, digest: saved.projectDigest, video: await videoAnswer(ctx, video_id) }
          } catch (error) {
            return studioRefusal(error, 'version')
          }
        }),
    }),

    check_studio_video: tool({
      description:
        "A video's readiness checklist before a hand-off: what is missing, what would read badly, beats over their word budget, placeholders still waiting for a recording, and the latest visual check (look_at_studio_video) when it ran on the current version. Each check says what to fix. Run it before telling the person a video is ready.",
      inputSchema: z.object({ video_id: videoId }),
      execute: async ({ video_id }) =>
        withStudio(async (ctx) => {
          const { openVideo, checklist } = await import('@/lib/studio/agent/server')
          const { project, projectDigest } = await openVideo(ctx, video_id)
          // The latest visual check (look_at_studio_video) counts when it measured this exact version.
          const visual = await (await import('@/lib/studio/server/checks')).latestVisual(ctx, video_id, projectDigest)
          // Face tracks when cached (the Studio worker on a Mac found them): the checks that need them run too.
          const faces = await (await import('@/lib/studio/server/vision')).checklistFaces(ctx, project)
          const checks = checklist(project, { ...(visual ? { visual } : {}), ...(faces ? { faces } : {}) })
          const failing = checks.filter((c) => !c.ok)
          return { success: true, video_id, ready: failing.length === 0, passed: checks.length - failing.length, failing, passing: checks.filter((c) => c.ok).map((c) => c.check) }
        }),
    }),

    ...createStudioJobTools(withStudio, videoAnswer),

    archive_studio_video: tool({
      description: 'Move a video to the trash. Its media and the other videos stay. Only when the person asks.',
      inputSchema: z.object({ video_id: videoId }),
      execute: async ({ video_id }) =>
        withStudio(async (ctx) => {
          const { archiveVideo, getVideoRow } = await import('@/lib/studio/agent/server')
          const row = await getVideoRow(ctx, video_id)
          await archiveVideo(ctx, video_id)
          return { success: true, video_id, message: `${row?.title ?? 'The video'} is in the trash.` }
        }),
    }),
  }
}
