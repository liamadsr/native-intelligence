// Routes for code scenes (../scenes.ts, ../scene-place.ts).
//
//   GET  scenes                    -> { scenes }              the workspace's scenes, newest first
//   GET  scenes/:id                -> { scene, source }       one scene's record and its source
//   POST scenes {source, name, props?}                         compile and keep a scene -> { scene }
//   POST projects/:id/scenes {source? | sceneId, name, at, duration, layerId, x, y, width, height, props, clip,
//        behind, enter, exit, expectedDigest}                  compile (when given source) and place it on the video
//        as one undoable step -> { scene, layerId, projectDigest }
//
// A source that does not compile answers 400 SCENE_COMPILE with the line, column and what is wrong in its sentence.
// The compiled code is read by the layer as a file of the workspace (`scenes/<id>.js`, the file route) and run only
// in the layer's locked frame (engine/scene-frame/protocol.ts).
import { route, type StudioRoute } from '../router'
import { placeScene, type ScenePlacement } from '../scene-place'
import { getScene, listScenes, saveScene, sceneSource } from '../scenes'
import { StudioError } from '../errors'

/** A number field, or undefined. */
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

export const sceneRoutes: StudioRoute[] = [
  route('GET', 'scenes', async ({ ctx }) => ({ scenes: await listScenes(ctx) })),
  route('GET', 'scenes/:id', async ({ ctx, params }) => sceneSource(ctx, params.id)),
  route('POST', 'scenes', async ({ ctx, body }) => {
    const b = await body()
    return { scene: await saveScene(ctx, { source: b.source, name: b.name, props: b.props }) }
  }),
  route('POST', 'projects/:id/scenes', async ({ ctx, params, body }) => {
    const b = await body()
    const scene = typeof b.source === 'string' ? await saveScene(ctx, { source: b.source, name: b.name, props: b.props }) : await getScene(ctx, b.sceneId)
    if (b.layerId !== undefined && typeof b.layerId !== 'string') throw new StudioError('layerId names a code layer of the video.', 400, 'INVALID')
    const place: ScenePlacement = {
      sceneId: scene.id, layerId: b.layerId as string | undefined, at: num(b.at), duration: num(b.duration), x: num(b.x), y: num(b.y), width: num(b.width), height: num(b.height),
      props: b.props, clip: b.clip === true ? true : undefined, behind: b.behind === true ? true : undefined, enter: b.enter, exit: b.exit,
    }
    const placed = await placeScene(ctx, params.id!, place, b.expectedDigest)
    return { scene: placed.scene, layerId: placed.layerId, projectDigest: placed.projectDigest }
  }),
]
