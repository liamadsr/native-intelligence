import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { isRefusal, refusal, studioContext, studioRefusal, type StudioRefusal } from '@/lib/studio/agent/access'
import type { StudioContext } from '@/lib/studio/server/context'
import { StudioError } from '@/lib/studio/server/errors'
import type { SceneRecord } from '@/lib/studio/server/scenes'

/** What every scene tool's description says a scene is and may use. */
export const SCENE_RULES =
  'A code scene is one TSX module whose default export is a React component taking JSON props. It may import only react, remotion and @studio/kit ' +
  '(useTime, spring, tween, keys, ease, progress, mix, noise, rand, float, Reveal, SplitText, Counter, DrawPath, smoothPath, signalPath, Glass, Backdrop, Grain, ' +
  'Phone, Watch, Browser, Cursor, Media, font, shadow, glow). It draws on a stage 1920 px wide (its height follows the layer box: 1080 for a full 16:9 frame), ' +
  'its frame 0 is the layer start, and everything is a function of the time (no timers, no state between frames, no Math.random or Date.now). ' +
  'It runs in a locked frame with no network: images come from the video library through <Media src="asset id or name">, data through props.'

/** A scene as the agent reads it in a list or an answer. Pure. */
export function sceneSummary(scene: SceneRecord) {
  return {
    scene_id: scene.id,
    name: scene.name,
    props: scene.props,
    ...(scene.fonts.length ? { fonts: scene.fonts } : {}),
    imports: scene.imports,
    source_kb: Math.round(scene.sourceBytes / 102.4) / 10,
    updated_at: scene.updatedAt,
  }
}

/** A compile problem as the agent's refusal: the sentence, and the line to fix. Pure. */
export function compileRefusal(problem: { error: string; line?: number; column?: number; lineText?: string }): StudioRefusal & { line?: number; column?: number; line_text?: string } {
  return {
    ...refusal('COMPILE', `The scene did not compile: ${problem.error} Fix the source and write it again.`),
    ...(problem.line ? { line: problem.line } : {}),
    ...(problem.column !== undefined ? { column: problem.column + 1 } : {}),
    ...(problem.lineText ? { line_text: problem.lineText } : {}),
  }
}

const placement = {
  at: z.number().min(0).max(36000).optional().describe('Start in seconds on the video (default 0; ignored with layer_id unless duration is given too)'),
  duration: z.number().min(0.1).max(600).optional().describe('Seconds on screen (default 4)'),
  x: z.number().min(-1).max(2).optional().describe("The box's centre as a fraction of the frame width (default 0.5)"),
  y: z.number().min(-1).max(2).optional().describe("The box's centre as a fraction of the frame height (default 0.5)"),
  width: z.number().min(0.02).max(3).optional().describe('The box width as a fraction of the frame (default 1: the whole frame)'),
  height: z.number().min(0.02).max(3).optional().describe('The box height as a fraction of the frame (default 1)'),
  props: z.record(z.string(), z.unknown()).optional().describe("The props this layer passes (JSON; default the scene's own)"),
  behind: z.boolean().optional().describe('Sit behind the cut-out person'),
}

/**
 * Code scenes (src/lib/studio/server/scenes.ts), for the agent:
 *
 *   write_studio_scene   compile a scene's source and keep it (a compile error comes back with its line); with
 *                        video_id and layer_id, swap the new code into that layer as well
 *   get_studio_scene     a scene's source, to change it
 *   list_studio_scenes   the workspace's scenes
 *   add_studio_scene     place a scene on a video as a layer (or swap it into one), through the editing commands'
 *                        save path: one undoable step, the edit before it kept, the digest guard
 *
 * The scene's code never runs on the server or in the person's page: only in the layer's locked frame, in the
 * editor's preview and in the Studio worker's render. Each refuses a workspace guest; every refusal is
 * `{ success: false, code, error }`.
 */
export function createStudioSceneTools(userId: string, workspaceId?: string) {
  /** Run `work` as the person in the workspace's Studio, its errors as refusals. */
  const withStudio = async <T>(work: (ctx: StudioContext) => Promise<T>, missing?: Parameters<typeof studioRefusal>[1]): Promise<T | StudioRefusal> => {
    const ctx = await studioContext(getServiceClient(), userId, workspaceId)
    if (isRefusal(ctx)) return ctx
    try {
      return await work(ctx)
    } catch (error) {
      const { SceneCompileError } = await import('@/lib/studio/server/scenes')
      if (error instanceof SceneCompileError) return compileRefusal(error.problem)
      // A missing scene or layer says which (the generic not-found would say "video").
      if (error instanceof StudioError && error.status === 404 && /scene|layer/i.test(error.message)) return refusal('NOT_FOUND', error.message)
      return studioRefusal(error, missing)
    }
  }
  const scenes = () => import('@/lib/studio/server/scenes')

  return {
    write_studio_scene: tool({
      description:
        'Write a code scene: an animated graphic no editing command makes (a stat counting up beside a device, a chart drawing on, signals, a logo reveal, cards wired to a phone). ' +
        'Compiles the source and keeps it in the workspace; a compile error comes back with its line and column (fix and write again). The same source is the same scene. ' +
        'Then place it with add_studio_scene, and look at it with render_studio_stills (mid-entrance, landed, just before the exit). ' +
        'To change a placed scene, write the new source with video_id and layer_id: the new code goes into the same layer and keeps its timing (one undoable step). ' +
        SCENE_RULES,
      inputSchema: z.object({
        name: z.string().min(1).max(80).describe('A short name for the scene ("Stat counter")'),
        source: z.string().min(1).max(100_000).describe('The whole TSX module, with export default'),
        props: z.record(z.string(), z.unknown()).optional().describe('The props it is placed with by default (JSON)'),
        video_id: z.string().optional().describe('With layer_id: the video whose code layer gets the new code'),
        layer_id: z.string().optional().describe('With video_id: the code layer to swap the new code into'),
        expected_digest: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('With video_id: the digest get_studio_video returned'),
      }),
      execute: async ({ name, source, props, video_id, layer_id, expected_digest }) =>
        withStudio(async (ctx) => {
          if (!!video_id !== !!layer_id) return refusal('INVALID', 'Give video_id and layer_id together to swap the code into a layer, or neither to only write the scene.')
          const { saveScene } = await scenes()
          const scene = await saveScene(ctx, { source, name, props })
          if (!video_id || !layer_id) {
            return { success: true, ...sceneSummary(scene), next: 'add_studio_scene places it on a video; then render_studio_stills to look at it.' }
          }
          const { placeScene } = await import('@/lib/studio/server/scene-place')
          const placed = await placeScene(ctx, video_id, { sceneId: scene.id, layerId: layer_id, ...(props ? { props } : {}) }, expected_digest)
          return { success: true, ...sceneSummary(scene), layer_id: placed.layerId, digest: placed.projectDigest, message: 'The new code is in the layer (one undoable step). Look at it with render_studio_stills.' }
        }),
    }),

    get_studio_scene: tool({
      description: "A code scene's source and the props it was written with, to read or change it (then write_studio_scene with the new source). list_studio_scenes lists them.",
      inputSchema: z.object({ scene_id: z.string().regex(/^[a-f0-9]{16}$/).describe('The scene (list_studio_scenes)') }),
      execute: async ({ scene_id }) =>
        withStudio(async (ctx) => {
          const { sceneSource } = await scenes()
          const { scene, source } = await sceneSource(ctx, scene_id)
          return { success: true, ...sceneSummary(scene), source }
        }),
    }),

    list_studio_scenes: tool({
      description: "The workspace's code scenes, newest first: id, name, default props, fonts and size. A video's code layers name theirs (get_studio_video).",
      inputSchema: z.object({}),
      execute: async () =>
        withStudio(async (ctx) => {
          const { listScenes } = await scenes()
          const all = await listScenes(ctx)
          return { success: true, scenes: all.slice(0, 100).map(sceneSummary), ...(all.length > 100 ? { more: all.length - 100 } : {}) }
        }),
    }),

    add_studio_scene: tool({
      description:
        'Place a code scene (write_studio_scene) on a video as a layer: the whole frame by default, or a box (x, y = its centre, width, height as fractions of the frame). ' +
        'With layer_id the scene goes into that code layer instead, keeping its timing and box. One undoable step through the editing commands (the edit before it is kept); ' +
        'pass the digest you read as expected_digest. Then render_studio_stills at a few times to see it.',
      inputSchema: z.object({
        video_id: z.string().describe('The video (list_studio_projects lists them)'),
        scene_id: z.string().regex(/^[a-f0-9]{16}$/).describe('The scene (write_studio_scene, list_studio_scenes)'),
        layer_id: z.string().optional().describe('A code layer of the video to swap this scene into'),
        ...placement,
        expected_digest: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('The digest get_studio_video returned'),
      }),
      execute: async ({ video_id, scene_id, layer_id, expected_digest, ...place }) =>
        withStudio(async (ctx) => {
          const { placeScene } = await import('@/lib/studio/server/scene-place')
          const placed = await placeScene(ctx, video_id, { sceneId: scene_id, layerId: layer_id, ...place }, expected_digest)
          return {
            success: true,
            layer_id: placed.layerId,
            scene_id: placed.scene.id,
            name: placed.scene.name,
            digest: placed.projectDigest,
            message: `${layer_id ? 'The scene is in the layer' : 'The scene is on the video'} (one undoable step). Look at it with render_studio_stills at a few times: mid-entrance, landed, just before the exit.`,
          }
        }),
    }),
  }
}
