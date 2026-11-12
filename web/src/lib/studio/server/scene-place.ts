// Placing a code scene on a video: through the editing commands and their save path (ops.ts runOps), so it is one
// undoable step, the edit before it is kept as a version, and a digest the caller read guards it. A new layer is
// `add_scene`; giving a layer swaps the scene's new code into that layer and keeps its timing and box.
import type { StudioContext } from './context'
import { notFoundError, StudioError } from './errors'
import { runOps } from './ops'
import { checkProps, getScene, requireCodeScenes, type SceneRecord } from './scenes'
import { openVideo } from './videos'

export type ScenePlacement = {
  sceneId: string
  /** Swap into this code layer instead of adding one. */
  layerId?: string
  at?: number
  duration?: number
  x?: number
  y?: number
  width?: number
  height?: number
  props?: unknown
  clip?: boolean
  behind?: boolean
  enter?: unknown
  exit?: unknown
}

/** The layer's scene: the record's name, the props (the placement's, else the record's) and the fonts it names. Pure. */
export function layerScene(scene: SceneRecord, props: Record<string, unknown> | undefined) {
  const chosen = props ?? scene.props
  return {
    id: scene.id,
    name: scene.name.slice(0, 80),
    ...(Object.keys(chosen).length ? { props: chosen } : {}),
    ...(scene.fonts.length ? { fonts: scene.fonts.slice(0, 12) } : {}),
  }
}

/** The editing command for a placement. Pure. */
export function placementCommand(scene: SceneRecord, place: ScenePlacement): { op: string; args: Record<string, unknown> } {
  const props = place.props === undefined ? undefined : checkProps(place.props)
  const layer = layerScene(scene, props)
  const defined = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
  if (place.layerId) {
    const start = place.at
    const end = place.at !== undefined && place.duration !== undefined ? place.at + place.duration : undefined
    return { op: 'update_layer', args: defined({ id: place.layerId, style: { scene: layer }, start, end, x: place.x, y: place.y, width: place.width, height: place.height, behind: place.behind, enter: place.enter, exit: place.exit }) }
  }
  return {
    op: 'add_scene',
    args: defined({ sceneId: scene.id, name: layer.name, props: layer.props, fonts: layer.fonts, at: place.at ?? 0, duration: place.duration, x: place.x, y: place.y, width: place.width, height: place.height, clip: place.clip, behind: place.behind, enter: place.enter, exit: place.exit }),
  }
}

/** Put a workspace scene on a video as one step. Answers the new digest and the layer's id. */
export async function placeScene(ctx: StudioContext, videoId: string, place: ScenePlacement, expectedDigest?: unknown): Promise<{ projectDigest: string; layerId: string; scene: SceneRecord }> {
  requireCodeScenes()
  const scene = await getScene(ctx, place.sceneId)
  if (place.layerId) {
    const layer = (await openVideo(ctx, videoId)).project.layers?.find((l) => l.id === place.layerId)
    if (!layer) throw notFoundError(`The video has no layer ${place.layerId}.`)
    if (layer.kind !== 'code') throw new StudioError(`Layer ${place.layerId} is not a code scene: leave layer_id out to add one.`, 400, 'INVALID')
  }
  const command = placementCommand(scene, place)
  const { projectDigest, results } = await runOps(ctx, videoId, [command], expectedDigest)
  const result = results[0] as { id?: string } | undefined
  return { projectDigest, layerId: place.layerId ?? result?.id ?? '', scene }
}
