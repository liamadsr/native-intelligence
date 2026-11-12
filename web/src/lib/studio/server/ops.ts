// The agent's write path: editing commands (engine/ops.ts, the same verbs the editor uses) applied to the saved
// video and saved in one write, all or nothing. The edit as it was is kept as a version first ("Before the
// assistant: …"), and the storyboard as well when the commands change it, so the person can go back; the editor
// picks the saved edit up as one undoable step.
import { applyOps, automationCatalog, opSchemas, type OpCall } from '../engine/ops'
import type { StudioContext } from './context'
import { conflictError, StudioError } from './errors'
import { sameJson } from './stable'
import { saveStoryboardVersion, saveVersion } from './versions'
import { namedLibraryAssets, openVideo, saveVideo } from './videos'

/** The commands and what can be automated (for the agent and its tools). */
export function catalog() {
  return { commands: opSchemas(), automation: automationCatalog() }
}

/** Check a list of 1–200 commands. */
export function checkCalls(calls: unknown): OpCall[] {
  if (!Array.isArray(calls) || !calls.length || calls.length > 200) throw new StudioError('ops must be a list of 1–200 commands')
  for (const call of calls) if (!call || typeof call !== 'object' || typeof (call as OpCall).op !== 'string') throw new StudioError('Each command is {op, args}.')
  return calls as OpCall[]
}

/**
 * Apply commands to a video and save it as one step. `expectedDigest` (optional): refuse when the video changed
 * since it was read. Library media the commands name by id comes along into the video.
 */
export async function runOps(ctx: StudioContext, videoId: string, calls: unknown, expectedDigest?: unknown) {
  const list = checkCalls(calls)
  const opened = await openVideo(ctx, videoId)
  if (typeof expectedDigest === 'string' && expectedDigest !== opened.projectDigest)
    throw conflictError('The project changed since you last read it — read it again and retry', 'DIGEST_CONFLICT')
  let start = opened.project
  const brought = await namedLibraryAssets(ctx, start, JSON.stringify(list))
  if (brought.length) start = { ...start, assets: [...start.assets, ...brought] }
  const { project: next, results } = applyOps(start, list)
  const names = [...new Set(list.map((call) => call.op))].join(', ')
  if (!sameJson(next, opened.project)) await saveVersion(ctx, videoId, 'project', `Before the assistant: ${names}`, opened.project).catch(() => null)
  const saved = await saveVideo(ctx, next, opened.projectDigest)
  // The storyboard as it was before this pass, so the person can go back to it.
  if (!sameJson(opened.project.storyboard ?? null, next.storyboard ?? null))
    await saveStoryboardVersion(ctx, videoId, opened.project.storyboard, `Before: ${names}`).catch(() => null)
  return { projectDigest: saved.projectDigest, results }
}
