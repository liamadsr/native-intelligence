// Code scenes: graphics the agent writes as React code, kept per workspace. A scene is its source (one TSX module)
// and its compiled module (scene-compile.ts: a transform, never a run), both stored as files under content-addressed
// keys (`scenes/<id>.tsx`, `scenes/<id>.js`, the id taken from the source and the compiler's version), and a record
// (studio_record, collection `scenes`) with its name, the props it was written with, sizes, hashes and who made it.
// Its code runs only inside the locked frame a `code` layer holds (engine/scene-frame/protocol.ts), in the editor's
// preview and in the Studio worker's render alike. Placing one on a video is scene-place.ts.
import { createHash } from 'node:crypto'
import { blobPartUrls, getBlob, putBlobBytes } from './blobs'
import type { StudioContext } from './context'
import { notFoundError, StudioError } from './errors'
import { getRecord, getRecords, listRecords, putRecord } from './records'
import { compileSceneSource, COMPILER_VERSION, isSceneProblem, MAX_SOURCE_BYTES, type SceneProblem } from './scene-compile'
import { MAX_SCENE_PROPS_BYTES } from '../engine/layers'
import { requireCodeScenes } from './code-scenes'

/** The studio_record collection scenes are kept in. */
export const SCENES = 'scenes'
/** A scene's id: 16 hex characters (the engine's layer schema names it so). */
export const SCENE_ID = /^[a-f0-9]{16}$/
/** The most props a scene keeps, as JSON (the engine's layer schema holds every layer to the same). */
export const MAX_PROPS_BYTES = MAX_SCENE_PROPS_BYTES

export { CODE_SCENES_OFF, codeScenesOn, requireCodeScenes } from './code-scenes'

export type SceneRecord = {
  id: string
  name: string
  /** The props the scene was written with (a layer may pass others). */
  props: Record<string, unknown>
  /** The font families it names, handed to its frame as bytes when the video has them. */
  fonts: string[]
  imports: string[]
  sourceKey: string
  codeKey: string
  sourceSha256: string
  codeSha256: string
  sourceBytes: number
  codeBytes: number
  compiler: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** The keys of a scene's two files. */
export const sceneKeys = (id: string) => ({ source: `scenes/${id}.tsx`, code: `scenes/${id}.js` })

/** A scene's id: the first 16 hex characters of the sha256 of the compiler's version and the source. Pure. */
export function sceneIdOf(source: string): string {
  return createHash('sha256').update(`${COMPILER_VERSION}\0`).update(source).digest('hex').slice(0, 16)
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A compile problem as one sentence the editor and the agent read: where, what, and the line. Pure. */
export function problemSentence(problem: SceneProblem): string {
  const where = problem.line ? `Line ${problem.line}${problem.column !== undefined ? `, column ${problem.column + 1}` : ''}: ` : ''
  const text = problem.lineText?.trim() ? ` (${problem.lineText.trim().slice(0, 160)})` : ''
  return `${where}${problem.error}${text}`
}

/** The error a route answers for a scene that does not compile (400, SCENE_COMPILE). */
export class SceneCompileError extends StudioError {
  constructor(readonly problem: SceneProblem) {
    super(problemSentence(problem), 400, 'SCENE_COMPILE')
  }
}

/** A name, checked: 1 to 80 characters. */
function checkName(name: unknown): string {
  const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
  if (!clean || clean.length > 80) throw new StudioError('A scene needs a name of 1 to 80 characters.', 400, 'INVALID')
  return clean
}

/** Props, checked: a JSON object of at most 16 KB. */
export function checkProps(props: unknown): Record<string, unknown> {
  if (props === undefined || props === null) return {}
  if (typeof props !== 'object' || Array.isArray(props)) throw new StudioError('A scene\'s props are a JSON object.', 400, 'INVALID')
  const text = JSON.stringify(props)
  if (Buffer.byteLength(text) > MAX_PROPS_BYTES) throw new StudioError(`A scene's props are at most ${MAX_PROPS_BYTES / 1024} KB of JSON: pass less, or put long data in the scene.`, 400, 'INVALID')
  return JSON.parse(text) as Record<string, unknown>
}

/**
 * Compile and keep a scene. The same source is the same scene (its files are written once; a second save renames it
 * and updates its props). A source that does not compile throws SceneCompileError with the line.
 */
export async function saveScene(ctx: StudioContext, input: { source: unknown; name: unknown; props?: unknown }): Promise<SceneRecord> {
  requireCodeScenes()
  const name = checkName(input.name)
  const props = checkProps(input.props)
  if (typeof input.source !== 'string') throw new StudioError('A scene needs its source: one TSX module with a default export.', 400, 'INVALID')
  if (Buffer.byteLength(input.source) > MAX_SOURCE_BYTES) throw new SceneCompileError({ error: `The scene is over ${MAX_SOURCE_BYTES / 1024} KB. Split it, or pass long data in its props.` })
  const compiled = compileSceneSource(input.source, name)
  if (isSceneProblem(compiled)) throw new SceneCompileError(compiled)
  const id = sceneIdOf(input.source)
  const keys = sceneKeys(id)
  const now = new Date().toISOString()
  const existing = await getRecord<SceneRecord>(ctx, SCENES, id)
  const sourceBytes = new TextEncoder().encode(input.source)
  const codeBytes = new TextEncoder().encode(compiled.code)
  // Content-addressed: the files under a key never change, so they are written only when missing.
  if (!existing || !(await getBlob(ctx, keys.source))) await putBlobBytes(ctx, keys.source, sourceBytes, 'text/plain', sha256(sourceBytes))
  if (!existing || !(await getBlob(ctx, keys.code))) await putBlobBytes(ctx, keys.code, codeBytes, 'text/javascript', sha256(codeBytes))
  const record: SceneRecord = {
    id, name, props, fonts: compiled.fonts, imports: compiled.imports,
    sourceKey: keys.source, codeKey: keys.code, sourceSha256: sha256(sourceBytes), codeSha256: sha256(codeBytes),
    sourceBytes: sourceBytes.byteLength, codeBytes: codeBytes.byteLength, compiler: COMPILER_VERSION,
    createdBy: existing?.createdBy ?? ctx.userId, createdAt: existing?.createdAt ?? now, updatedAt: now,
  }
  await putRecord(ctx, SCENES, id, record)
  return record
}

/** A scene's record, or 404. */
export async function getScene(ctx: StudioContext, id: unknown): Promise<SceneRecord> {
  if (typeof id !== 'string' || !SCENE_ID.test(id)) throw notFoundError('There is no scene with that id: list_studio_scenes lists them.')
  const record = await getRecord<SceneRecord>(ctx, SCENES, id)
  if (!record) throw notFoundError('There is no scene with that id: list_studio_scenes lists them.')
  return record
}

/** The workspace's scenes, newest first. */
export async function listScenes(ctx: StudioContext): Promise<SceneRecord[]> {
  return (await listRecords<SceneRecord>(ctx, SCENES, 500)).map((row) => row.value).reverse()
}

/** Reading a stored file's bytes from a signed link (tests pass their own). */
export type ReadLink = (url: string) => Promise<Uint8Array>
const readLink: ReadLink = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Storage answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** A scene's source text, as it was written. */
export async function sceneSource(ctx: StudioContext, id: unknown, read: ReadLink = readLink): Promise<{ scene: SceneRecord; source: string }> {
  const scene = await getScene(ctx, id)
  const blob = await getBlob(ctx, scene.sourceKey)
  if (!blob) throw notFoundError(`The source of scene "${scene.name}" is missing. Write it again.`)
  const parts = await Promise.all((await blobPartUrls(ctx, blob)).map((url) => read(url)))
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.byteLength
  }
  return { scene, source: new TextDecoder().decode(bytes) }
}

/** The scene ids a list of editing commands names (add_scene, and update_layer with a scene). Pure. */
export function sceneIdsIn(calls: { op: string; args?: unknown }[]): string[] {
  const ids = new Set<string>()
  for (const call of calls) {
    const args = (call.args ?? {}) as { sceneId?: unknown; style?: { scene?: { id?: unknown } } }
    if (call.op === 'add_scene' && typeof args.sceneId === 'string') ids.add(args.sceneId)
    if (call.op === 'update_layer' && typeof args.style?.scene?.id === 'string') ids.add(args.style.scene.id)
  }
  return [...ids]
}

/** Whether a command puts a scene on a video or changes a code layer's scene, whatever its arguments' shape. Pure. */
export function touchesScenes(calls: { op: string; args?: unknown }[]): boolean {
  return calls.some((call) => call.op === 'add_scene' || (call.op === 'update_layer' && !!(call.args as { style?: unknown } | undefined)?.style && typeof (call.args as { style: unknown }).style === 'object' && 'scene' in ((call.args as { style: object }).style)))
}

/**
 * Refuse commands that put a scene on a video or change a code layer's scene where code scenes are off (403
 * NOT_SET_UP), and ones that name a scene this workspace does not have (404 with the first such id).
 */
export async function checkSceneIds(ctx: StudioContext, calls: { op: string; args?: unknown }[]): Promise<void> {
  if (touchesScenes(calls)) requireCodeScenes()
  const ids = sceneIdsIn(calls)
  if (!ids.length) return
  const found = await getRecords<SceneRecord>(ctx, SCENES, ids)
  const missing = ids.find((id) => !found.has(id))
  if (missing) throw notFoundError(`There is no scene ${missing} in this workspace: write it with write_studio_scene first.`)
}
