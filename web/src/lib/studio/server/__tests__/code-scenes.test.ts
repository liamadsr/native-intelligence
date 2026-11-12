/**
 * The code scenes switch on the app's side (../code-scenes.ts) and everything it holds: on outside production, off in
 * production unless STUDIO_CODE_SCENES=on; off, writing a scene, placing one, and any editing command that puts a scene
 * on a video or changes a code layer's scene are refused with one sentence (403 NOT_SET_UP), through the routes too,
 * while reading scenes and opening, saving or trimming a video that already has one still work; the editor's bootstrap
 * says whether scenes run. And the props cap: every write of a scene layer (a command, a saved video) holds to 16 KB.
 * Made-up scenes and videos.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyOps } from '../../engine/ops'
import { LayerStyleSchema, MAX_SCENE_PROPS_BYTES } from '../../engine/layers'
import { createBlankVideo } from '../blank'
import { CODE_SCENES_OFF, codeScenesOn, requireCodeScenes } from '../code-scenes'
import { runOps } from '../ops'
import { dispatch } from '../router'
import { studioRoutes } from '../routes'
import { placeScene } from '../scene-place'
import { getScene, listScenes, saveScene, touchesScenes } from '../scenes'
import { bootstrap, openVideo, saveVideo } from '../videos'
import { fakeContext } from './fake'

const SOURCE = `import { useTime } from '@studio/kit';
export default function Bar() { const { t } = useTime(); return <div style={{ width: t * 100, height: 20, background: '#ff5a36' }} />; }
`
const big = { text: 'x'.repeat(MAX_SCENE_PROPS_BYTES + 10) }

afterEach(() => vi.unstubAllEnvs())

/** A workspace with a blank video carrying one code scene, made while scenes were on. */
async function videoWithScene() {
  const env = fakeContext()
  const video = await createBlankVideo(env.ctx, { title: 'Bar beat', seconds: 4, fps: 30, width: 640, height: 360 })
  const scene = await saveScene(env.ctx, { source: SOURCE, name: 'Bar' })
  const placed = await placeScene(env.ctx, video.id, { sceneId: scene.id, at: 0.5, duration: 2 })
  return { ...env, videoId: video.id, scene, layerId: placed.layerId }
}
const production = () => vi.stubEnv('NODE_ENV', 'production')

describe('the switch', () => {
  it('is on outside production, off in production, and a set value wins either way', () => {
    expect(codeScenesOn({ NODE_ENV: 'development' })).toBe(true)
    expect(codeScenesOn({ NODE_ENV: 'test' })).toBe(true)
    expect(codeScenesOn({ NODE_ENV: 'production' })).toBe(false)
    expect(codeScenesOn({ NODE_ENV: 'production', STUDIO_CODE_SCENES: 'on' })).toBe(true)
    expect(codeScenesOn({ NODE_ENV: 'production', STUDIO_CODE_SCENES: ' ON ' })).toBe(true)
    expect(codeScenesOn({ NODE_ENV: 'production', STUDIO_CODE_SCENES: 'maybe' })).toBe(false)
    expect(codeScenesOn({ NODE_ENV: 'development', STUDIO_CODE_SCENES: 'off' })).toBe(false)
    expect(codeScenesOn({ NODE_ENV: 'development', STUDIO_CODE_SCENES: '0' })).toBe(false)
    expect(() => requireCodeScenes({ NODE_ENV: 'production' })).toThrow(expect.objectContaining({ message: CODE_SCENES_OFF, status: 403, code: 'NOT_SET_UP' }))
    expect(() => requireCodeScenes({ NODE_ENV: 'development' })).not.toThrow()
  })

  it('knows which commands touch a scene, whatever their arguments', () => {
    expect(touchesScenes([{ op: 'add_scene', args: {} }])).toBe(true)
    expect(touchesScenes([{ op: 'add_scene' }])).toBe(true)
    expect(touchesScenes([{ op: 'update_layer', args: { id: 'scene-1', style: { scene: { props: {} } } } }])).toBe(true)
    expect(touchesScenes([{ op: 'update_layer', args: { id: 'scene-1', start: 1 } }])).toBe(false)
    expect(touchesScenes([{ op: 'remove_layer', args: { id: 'scene-1' } }])).toBe(false)
  })
})

describe('off in production', () => {
  it('refuses writing a scene, placing one, and every command that puts or changes one', async () => {
    const env = await videoWithScene()
    production()
    const off = expect.objectContaining({ message: CODE_SCENES_OFF, status: 403, code: 'NOT_SET_UP' })
    await expect(saveScene(env.ctx, { source: SOURCE.replace('100', '120'), name: 'Bar 2' })).rejects.toThrow(off)
    await expect(placeScene(env.ctx, env.videoId, { sceneId: env.scene.id, at: 1 })).rejects.toThrow(off)
    await expect(runOps(env.ctx, env.videoId, [{ op: 'add_scene', args: { sceneId: env.scene.id, at: 0 } }])).rejects.toThrow(off)
    await expect(runOps(env.ctx, env.videoId, [{ op: 'update_layer', args: { id: env.layerId, style: { scene: { id: env.scene.id, name: 'Bar', props: { a: 1 } } } } }])).rejects.toThrow(off)
    // The same through the routes.
    for (const [path, body] of [[['scenes'], { source: SOURCE, name: 'Bar' }], [['projects', env.videoId, 'scenes'], { sceneId: env.scene.id, at: 1 }]] as const) {
      const response = await dispatch(studioRoutes, new Request(`http://studio.test/${path.join('/')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), [...path], env.ctx)
      expect(response.status, path.join('/')).toBe(403)
      expect(await response.json()).toMatchObject({ error: CODE_SCENES_OFF, code: 'NOT_SET_UP' })
    }
  })

  it('still reads scenes, and still opens, edits, saves and trims a video that has one', async () => {
    const env = await videoWithScene()
    production()
    expect((await getScene(env.ctx, env.scene.id)).name).toBe('Bar')
    expect((await listScenes(env.ctx)).map((s) => s.id)).toEqual([env.scene.id])
    const opened = await openVideo(env.ctx, env.videoId)
    expect(opened.project.layers?.some((l) => l.style.scene?.id === env.scene.id)).toBe(true)
    // Its timing changes (no scene named), and the whole edit saves as it is.
    await runOps(env.ctx, env.videoId, [{ op: 'update_layer', args: { id: env.layerId, start: 1, end: 3 } }])
    const again = await openVideo(env.ctx, env.videoId)
    await saveVideo(env.ctx, again.project, again.projectDigest)
    // And the layer can go.
    await runOps(env.ctx, env.videoId, [{ op: 'remove_layer', args: { id: env.layerId } }])
    expect((await openVideo(env.ctx, env.videoId)).project.layers?.some((l) => l.kind === 'code')).toBe(false)
  })

  it('the bootstrap tells the editor whether scenes run', async () => {
    const env = fakeContext()
    expect((await bootstrap(env.ctx, null)).capabilities.codeScenes).toBe(true)
    production()
    expect((await bootstrap(env.ctx, null)).capabilities.codeScenes).toBe(false)
    vi.stubEnv('STUDIO_CODE_SCENES', 'on')
    expect((await bootstrap(env.ctx, null)).capabilities.codeScenes).toBe(true)
  })

  it('production with STUDIO_CODE_SCENES=on writes and places as outside it', async () => {
    const env = fakeContext()
    production()
    vi.stubEnv('STUDIO_CODE_SCENES', 'on')
    const video = await createBlankVideo(env.ctx, { title: 'On', seconds: 3, fps: 30, width: 640, height: 360 })
    const scene = await saveScene(env.ctx, { source: SOURCE, name: 'Bar' })
    expect((await placeScene(env.ctx, video.id, { sceneId: scene.id })).layerId).toBeTruthy()
  })
})

describe("a scene's props are capped wherever a scene layer is written", () => {
  it('in the layer schema (a saved video), add_scene and update_layer', async () => {
    expect(LayerStyleSchema.safeParse({ scene: { id: '0123456789abcdef', name: 'Bar', props: { a: 1 } } }).success).toBe(true)
    expect(LayerStyleSchema.safeParse({ scene: { id: '0123456789abcdef', name: 'Bar', props: big } }).success).toBe(false)
    const env = await videoWithScene()
    const { project } = await openVideo(env.ctx, env.videoId)
    expect(() => applyOps(project, [{ op: 'add_scene', args: { sceneId: env.scene.id, at: 0, props: big } }])).toThrow(/16 KB/)
    expect(() => applyOps(project, [{ op: 'update_layer', args: { id: env.layerId, style: { scene: { id: env.scene.id, name: 'Bar', props: big } } } }])).toThrow(/16 KB/)
    // A whole edit saved with an oversized scene prop is refused too.
    const swollen = { ...project, layers: project.layers!.map((l) => (l.id === env.layerId ? { ...l, style: { ...l.style, scene: { ...l.style.scene!, props: big } } } : l)) }
    const before = await openVideo(env.ctx, env.videoId)
    await expect(saveVideo(env.ctx, swollen, before.projectDigest)).rejects.toThrow()
  })
})
