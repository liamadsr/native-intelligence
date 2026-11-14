// The editor's side of a Mac take opened before it was filed (record/provisional.ts, record/filing.ts): pure steps
// App.tsx takes, kept here so they are tested as they run.
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { adoptFiled, type DraftStore, type ProvisionalRecord } from '../record/provisional'
import type { Settled } from '../record/filing'

export type History = { past: EditorProject[]; current: EditorProject; future: EditorProject[]; group?: number | null }

/**
 * Every step of the editor's history moved onto the Studio's assets (`swap`; null: that step cannot be). Never a hole:
 * a step that cannot be moved ends undo there (it and every older step go), and redo stops before one. The step shown
 * is `fallback` when it cannot be moved itself, with nothing to undo or redo. Pure.
 */
export function rewriteHistory(history: History, swap: (project: EditorProject) => EditorProject | null, fallback: EditorProject): History {
  const current = swap(history.current)
  if (!current) return { past: [], current: fallback, future: [], group: null }
  const past: EditorProject[] = []
  for (let i = history.past.length - 1; i >= 0; i--) {
    const moved = swap(history.past[i]!)
    if (!moved) break
    past.unshift(moved)
  }
  const future: EditorProject[] = []
  for (const step of history.future) {
    const moved = swap(step)
    if (!moved) break
    future.push(moved)
  }
  return { past, current, future, group: null }
}

/**
 * Every step of the history with the words the Mac heard (they arrived after the take opened): undo never takes them
 * away again. Pure.
 */
export function historyWithWords<H extends History>(history: H, add: (project: EditorProject) => EditorProject): H {
  return { ...history, past: history.past.map(add), current: add(history.current), future: history.future.map(add) }
}

/**
 * Wait until the editor is idle (no gesture, edit group, operation or save under way) at two checks in a row, for as
 * long as `stillOpen` says the video is the one open: true when idle, false when the person left it meanwhile (the
 * kept draft is used then). Never goes ahead in the middle of a gesture.
 */
export async function whenIdle(busy: () => boolean, stillOpen: () => boolean, sleep: (ms: number) => Promise<void>, every = 350): Promise<boolean> {
  let quiet = 0
  for (;;) {
    if (!stillOpen()) return false
    quiet = busy() ? 0 : quiet + 1
    if (quiet >= 2) return true
    await sleep(every)
  }
}

/** The waits between tries at reading a filed video: a few seconds at first, then a minute. */
export const ADOPT_RETRIES_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000]

/**
 * `run` until it succeeds, waiting ADOPT_RETRIES_MS between tries (`isAlive` false stops it): its answer, or the last
 * error once every wait is spent.
 */
export async function withRetries<T>(run: () => Promise<T>, sleep: (ms: number) => Promise<void>, isAlive: () => boolean = () => true, waits: number[] = ADOPT_RETRIES_MS): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    try {
      return await run()
    } catch (error) {
      last = error
      if (attempt === waits.length || !isAlive()) break
      await sleep(waits[attempt]!)
    }
  }
  throw last
}

/** A save over the Studio's video refused because it changed elsewhere, as against one that never reached it. */
export function saveRefusal(error: unknown): 'conflict' | 'network' | 'other' {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'DIGEST_CONFLICT' || code === 'CONFLICT') return 'conflict'
  const text = error instanceof Error ? error.message : String(error)
  if (/changed (somewhere|elsewhere)|digest|conflict/i.test(text)) return 'conflict'
  if (error instanceof TypeError || /network|failed to fetch|load failed|offline|timed? ?out/i.test(text)) return 'network'
  return 'other'
}

/** What the header says when keeping the draft on this computer failed. */
export const notSavedHere = (error: unknown) => `Not saved: the edit could not be kept on this computer (${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}).`

/** What carrying a filed take on from the Studio's copies needs, when its draft is not open in the editor. */
export type AdoptDeps = {
  store: DraftStore
  records: { update(projectId: string, fn: (record: ProvisionalRecord) => ProvisionalRecord | null): Promise<ProvisionalRecord | null> }
  read: (projectId: string) => Promise<{ project: EditorProject; projectDigest: string }>
  save: (projectId: string, project: EditorProject, digest: string) => Promise<unknown>
  release: (projectId: string) => Promise<Settled>
}
export type Adopted =
  | { outcome: 'gone' | 'taken' | 'saved'; settled?: Settled }
  | { outcome: 'conflict'; message: string; recovery: { project: EditorProject; digest: string; base: string } }
  | { outcome: 'network' | 'failed' | 'unreadable'; message: string }

/**
 * A filed take whose draft is not open: not edited, the Studio's edit is taken as it is; edited, the draft moved onto
 * the Studio's copies is saved over it with its digest. Only once that is done is the record marked `adopted` and the
 * files let go (when the Studio holds every byte of them). A save refused because the video changed elsewhere, or one
 * that never reached the Studio, keeps the record and the take: the edit is offered back, or tried again.
 */
export async function adoptKept(deps: AdoptDeps, projectId: string): Promise<Adopted> {
  const record = await deps.store.get(projectId).catch(() => null)
  if (!record) return { outcome: 'gone' }
  let server: { project: EditorProject; projectDigest: string }
  try {
    server = await deps.read(projectId)
  } catch (error) {
    return { outcome: 'unreadable', message: `The recording is filed, but its video could not be read yet (${text(error)}). Your edits are kept on this computer.` }
  }
  let adopted: ReturnType<typeof adoptFiled>
  try {
    adopted = adoptFiled(record, record.draft, server.project)
  } catch (error) {
    const message = `The recording is filed, but your edits could not be moved onto it (${text(error)}). They are kept on this computer.`
    await deps.records.update(projectId, (r) => ({ ...r, failed: message })).catch(() => undefined)
    return { outcome: 'failed', message }
  }
  if (adopted.edited) {
    // Saved over the Studio's edit only as the Studio first filed it: a video changed since (another device, between two
    // tries) is never written over; the edit is offered back instead.
    const conflict = { outcome: 'conflict' as const, message: 'This video changed somewhere else while the recording was being filed. Your edits are kept on this computer.', recovery: { project: adopted.project, digest: server.projectDigest, base: JSON.stringify(server.project) } }
    if (record.studioDigest && record.studioDigest !== server.projectDigest) return conflict
    if (!record.studioDigest) await deps.records.update(projectId, (r) => ({ ...r, studioDigest: server.projectDigest })).catch(() => undefined)
    try {
      await deps.save(projectId, adopted.project, server.projectDigest)
    } catch (error) {
      const kind = saveRefusal(error)
      if (kind === 'conflict') return conflict
      return { outcome: kind === 'network' ? 'network' : 'failed', message: kind === 'network' ? 'The recording is filed, but the Studio could not be reached to save your edits onto it. They are kept on this computer.' : `The recording is filed, but your edits could not be saved onto it (${text(error)}). They are kept on this computer.` }
    }
  }
  await deps.records.update(projectId, (r) => ({ ...r, state: 'adopted' })).catch(() => undefined)
  return { outcome: adopted.edited ? 'saved' : 'taken', settled: await deps.release(projectId) }
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')
