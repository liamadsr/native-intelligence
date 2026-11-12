/**
 * Code scenes in a render. A `code` layer runs its scene's compiled module in a
 * locked frame (web/src/lib/studio/engine/scene-frame/protocol.ts: sandboxed,
 * no origin, a policy that refuses every request) inside the render's Chrome,
 * exactly as the editor's preview does. The frame's runtime is written into the
 * bundle's public folder when the bundle is made (render.ts); each scene's
 * module is read from the job's workspace (`scenes/<id>.js`, checked against
 * its sha256 by the app client) and written beside it as `scenes/<id>.js`, the
 * address the layer asks for.
 *
 * On the shared server the frame's only walls are the browser's origin checks
 * and its policy (Remotion runs Chrome with --no-sandbox, site isolation off,
 * and the worker's environment), so running code scenes there is a setting, STUDIO_CODE_SCENES (config.ts): on
 * outside production, off in production unless set. Off, a render that would
 * run a scene's code is refused with a sentence naming the scenes; a thumbnail
 * or a sound-only render draws each scene as a labelled box instead.
 */
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'
import { JobError, type JobContext } from './jobs/context.ts'

/** The scenes a project's layers play: id and name, each once. Pure. */
export function projectScenes(project: EditorProject): { id: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const layer of project.layers ?? []) {
    const scene = (layer as { kind?: string; style?: { scene?: { id: string; name: string } } }).style?.scene
    if (scene && /^[a-f0-9]{16}$/.test(scene.id) && !seen.has(scene.id)) seen.set(scene.id, scene.name)
  }
  return [...seen].map(([id, name]) => ({ id, name }))
}

/** The sentence a render refuses with when code scenes are off on this worker. Pure. */
export function scenesOffSentence(scenes: { name: string }[]): string {
  const names = scenes.map((s) => `"${s.name}"`).join(', ')
  return `This video has code scenes (${names}), and this Studio worker does not run scene code (STUDIO_CODE_SCENES is off here). Ask the owner to turn it on, or remove the scenes and export again.`
}

/** Refuse a render that would run scene code on a worker where it is off. */
export function checkCodeScenes(project: EditorProject, on: boolean): void {
  const scenes = projectScenes(project)
  if (scenes.length && !on) throw new JobError(scenesOffSentence(scenes))
}

/**
 * Write the project's scene modules into the bundle at `serveUrl` (public/scenes/<id>.js). Each is read from the
 * job's own workspace every time, even when the bundle has a module of that id already: the bundle is shared by
 * every job on this worker, and a project can name any id (an export takes the project it is sent), so a module
 * another workspace's render left there must never stand in for one this workspace does not have. A scene whose
 * module cannot be read fails the job with its name.
 */
export async function stageScenes(ctx: Pick<JobContext, 'job' | 'client' | 'scratch' | 'signal' | 'log'>, project: EditorProject, serveUrl: string): Promise<void> {
  const scenes = projectScenes(project)
  if (!scenes.length) return
  if (/^https?:/.test(serveUrl)) throw new JobError('Code scenes cannot be staged for a bundle served over HTTP')
  const dir = join(serveUrl, 'public', 'scenes')
  await mkdir(dir, { recursive: true })
  for (const scene of scenes) {
    const target = join(dir, `${scene.id}.js`)
    const partial = join(ctx.scratch, `scene-${scene.id}.js`)
    try {
      await ctx.client.readBlob(ctx.job.id, `scenes/${scene.id}.js`, partial, { signal: ctx.signal })
    } catch (err) {
      if (ctx.signal.aborted) throw err
      throw new JobError(`The code of scene "${scene.name}" could not be read (${(err as Error).message}). Write the scene again and place it.`)
    }
    // Moved over any module of that id already there (a rename is atomic: a render reading it sees one whole file).
    await rename(partial, target).catch(async (err) => {
      await rm(partial, { force: true })
      throw new JobError(`The code of scene "${scene.name}" could not be staged (${(err as Error).message}).`)
    })
  }
  ctx.log(`Code scenes staged: ${scenes.map((s) => s.name).join(', ')}`)
}
