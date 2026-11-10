/**
 * The agent runtime across a page's frames, the cloud twin of the desktop's
 * browser_agent_frames.h (docs/plans/cloud-browser.md, C1). Kept free of CDP so
 * the contract is tested on its own; `page.ts` supplies the frames.
 *
 * Snapshot: the main frame and every child frame answer the same snapshot
 * script, in the ni-agent world. The main frame's read is required; child
 * frames share one budget and a slow one is left out, never waited for. Each
 * observation names its own frame path (its index among its parent's frames,
 * from the top), so the newest observation per path is kept, at most 16.
 *
 * Action: inside a frame, each enclosing document gates it first (same
 * observation, same unmoved and visible <iframe>, the point lands on it), the
 * target frame then validates and performs it, and only real input the
 * runtime asked for is delivered, at the main viewport's point. The caller
 * never chooses real input or points.
 */

export const MAX_FRAMES = 16
export const MAX_DEPTH = 4

export const SNAPSHOT_JS =
  "JSON.stringify(window.__dial8Agent ? window.__dial8Agent.snapshot({decision:true}) : {error:'agent runtime not present'})"
const STALE = '{"ok":false,"code":"stale_observation"}'
const UNKNOWN = '{"ok":false,"code":"write_outcome_unknown"}'

export type Point = { x: number; y: number }
export type RuntimeInput = { kind: string; x?: number; y?: number; key?: string }

/** A page's frames, as the runtime sees them. `F` identifies one frame. */
export interface AgentFrames<F> {
  main: F
  /** The page's child frames, shallowest first. */
  children: F[]
  /** The script's string result in `frame`'s agent world; null for a non-string result. Throws when the frame can't be read.
   *  `gesture`: run it as a user gesture, as WebKit runs every script (an action's, never a read's). */
  evaluate(frame: F, expression: string, options?: { gesture?: boolean }): Promise<string | null>
}

type Json = Record<string, unknown>
const parse = (json: string | null): unknown => {
  if (json === null) return null
  try { return JSON.parse(json) } catch { return null }
}
const record = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** "0.2" for a valid frame path ([0, 2]), else null. */
export function framePathKey(path: unknown): string | null {
  if (!Array.isArray(path) || path.length === 0 || path.length > MAX_DEPTH) return null
  for (const index of path) if (!Number.isInteger(index) || index < 0 || index > 999) return null
  return path.join('.')
}

export const runtimeCall = (method: string, argument: unknown) =>
  `JSON.stringify(window.__dial8Agent ? window.__dial8Agent.${method}(${JSON.stringify(argument ?? null)}) : {ok:false,code:'stale_observation'})`

/**
 * One decision snapshot: `{"main":…,"frames":[…],"inputCapable":bool}`, and
 * which frame answered for each frame path (the next action's map). Null when
 * the main frame did not answer.
 */
export async function decisionSnapshot<F>(frames: AgentFrames<F>, budgetMs: number, inputCapable: boolean):
  Promise<{ json: string; paths: Map<string, F> } | null> {
  const children = frames.children
  const results: (string | null)[] = children.map(() => null)
  const reads = children.map((frame, i) => frames.evaluate(frame, SNAPSHOT_JS)
    .then(json => { results[i] = json }, () => { /* gone: left out, as the desktop unregisters it */ }))
  let main: string | null = null
  const mainRead = frames.evaluate(frames.main, SNAPSHOT_JS).then(json => { main = json }, () => {})
  // The main frame's read is required; past the budget, frames that have not answered are left out.
  let budget: ReturnType<typeof setTimeout> | undefined
  await Promise.all([mainRead, Promise.race([Promise.all(reads), new Promise<void>(resolve => { budget = setTimeout(resolve, budgetMs) })])])
  clearTimeout(budget)
  if (main === null) return null
  const answered = results.slice()

  // A frame read twice (it navigated) keeps its newest observation.
  const best = new Map<string, { i: number; observationId: number }>()
  const observations = answered.map(json => parse(json))
  observations.forEach((observation, i) => {
    if (!record(observation)) return
    const key = framePathKey(observation.framePath)
    if (key === null || !finite(observation.observationId)) return
    const current = best.get(key)
    if (!current || observation.observationId > current.observationId) best.set(key, { i, observationId: observation.observationId })
  })
  const paths = new Map<string, F>()
  const kept: string[] = []
  for (let i = 0; i < children.length && kept.length < MAX_FRAMES; i++) {
    const observation = observations[i]
    const key = record(observation) ? framePathKey(observation.framePath) : null
    if (key === null || best.get(key)?.i !== i) continue
    paths.set(key, children[i])
    kept.push(answered[i] as string)
  }
  return { json: `{"main":${main},"frames":[${kept.join(',')}],"inputCapable":${inputCapable}}`, paths }
}

export interface ActionOptions {
  inputCapable: boolean
  /** Delivers runtime-approved input at `offset` from the main viewport's origin; false when it couldn't be. */
  deliver(input: RuntimeInput, offset: Point): Promise<boolean>
  now?: () => number
}

/** The runtime's answer minus its delivery instructions, after delivering any input (finish_action). */
async function finish(json: string | null, offset: Point, deadline: number, options: ActionOptions): Promise<string> {
  const result = parse(json)
  if (!record(result)) return json ?? UNKNOWN
  if (!record(result.input)) return json as string
  const { input, ...answer } = result
  // A click must never arrive after the caller has stopped waiting for it.
  if (answer.ok === true && deadline > 0 && (options.now ?? Date.now)() >= deadline)
    return JSON.stringify({ ...answer, ok: false, code: 'deadline_exceeded' })
  // The observation is already consumed: an undelivered input is an unknown outcome, never a retry.
  if (answer.ok === true && !(await options.deliver(input as RuntimeInput, offset).catch(() => false)))
    return JSON.stringify({ ...answer, ok: false, code: 'write_outcome_unknown' })
  return JSON.stringify(answer)
}

const read = <F>(frames: AgentFrames<F>, frame: F, expression: string, gesture = false) =>
  frames.evaluate(frame, expression, gesture ? { gesture } : undefined).catch(() => null)

/** One task action (action): `request.frame` = {path, ancestors, point} for a control inside a frame. */
export async function taskAction<F>(frames: AgentFrames<F>, paths: Map<string, F>, request: Json, options: ActionOptions): Promise<string> {
  const { frame, expectedPoint: _expectedPoint, ...rest } = request
  const action: Json = { ...rest, trustedInput: options.inputCapable }
  const deadline = finite(action.deadline) ? action.deadline : 0
  if (frame === undefined)
    return finish(await read(frames, frames.main, runtimeCall('taskAction', action), true), { x: 0, y: 0 }, deadline, options)

  const path = record(frame) ? frame.path : undefined
  const ancestors = record(frame) ? frame.ancestors : undefined
  const point = record(frame) ? frame.point : undefined
  if (framePathKey(path) === null || !Array.isArray(ancestors) || ancestors.length !== (path as number[]).length ||
      !record(point) || !finite(point.x) || !finite(point.y)) return STALE
  const levels = path as number[]
  const at = { x: point.x, y: point.y }

  let offset = { x: 0, y: 0 }
  for (let level = 0; level < levels.length; level++) {
    const parent = level === 0 ? frames.main : paths.get(levels.slice(0, level).join('.'))
    if (parent === undefined) return STALE
    const identity = ancestors[level]
    if (!record(identity)) return STALE
    const gate = { ...identity, index: levels[level], x: at.x - offset.x, y: at.y - offset.y,
      // A real click is coming: each enclosing document lets it land only on the frame.
      guardClick: action.operation === 'click' && action.trustedInput === true }
    const json = await read(frames, parent, runtimeCall('frameGate', gate))
    const result = parse(json)
    if (!record(result) || result.ok !== true || !finite(result.x) || !finite(result.y)) return json ?? STALE
    offset = { x: offset.x + result.x, y: offset.y + result.y }
  }
  const target = paths.get(levels.join('.'))
  if (target === undefined) return STALE
  action.expectedPoint = { x: at.x - offset.x, y: at.y - offset.y }
  return finish(await read(frames, target, runtimeCall('taskAction', action), true), offset, deadline, options)
}
