// The editor's side of a Mac take opened before it was filed (record/provisional.ts, record/filing.ts): pure steps
// App.tsx takes, kept here so they are tested as they run.
import type { EditorProject, EditorTranscript } from '@/lib/studio/engine/contracts'
import { adoptFiled, CHANGED_ELSEWHERE, OWED_UNKNOWN, withoutTranscripts, type DraftStore, type ProvisionalRecord } from '../record/provisional'
export { CHANGED_ELSEWHERE, OWED_UNKNOWN }
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
  /** Wait (with a limit) for the Mac's words to reach the Studio: true when nothing is left to wait for. */
  waitWords?: () => Promise<boolean>
}
export type Adopted =
  | { outcome: 'gone' | 'already' }
  | { outcome: 'taken' | 'saved'; settled?: Settled; wordsLater: boolean }
  | { outcome: 'conflict'; message: string; recovery: { project: EditorProject; digest: string; base: string } }
  | { outcome: 'network' | 'failed' | 'unreadable'; message: string }

/** What the person is told when the words had not reached the Studio when the edit was carried on. */
export const WORDS_LATER = 'The words the Mac heard are still on their way to the Studio. They are added to this video when they arrive (corrections made to them before then are not kept).'
/** What the person is told when those words reached the open video. */
export const WORDS_ARRIVED = 'The words the Mac heard have arrived. They are in the Words tab.'

/**
 * The editor carried a filed take on from the Studio's copies: the record says so (`adopted`) with the digest of the
 * Studio's edit it was first carried on from, before the editor goes on. A later launch then never saves the old draft
 * over the video (adoptKept refuses). `saveOwed`: the editor's edits are still to be saved over the Studio's (the files
 * and the record stay until they are). Throws when the record could not be written: the editor does not carry on then.
 */
export async function markEditorAdopted(records: AdoptDeps['records'], projectId: string, digest: string, saveOwed = false, studio?: EditorProject, owedEdit?: EditorProject): Promise<ProvisionalRecord> {
  const note = studio ? await studioNote(studio) : {}
  // Owed: the edit itself is kept too (on the Studio's assets), with the digest its save goes over, so the Record
  // dialog's "Put my edits on it" saves what is owed, never an older draft (App.tsx keeps it up to date).
  const owed = (r: ProvisionalRecord) => (saveOwed ? { saveOwed: true, ...(owedEdit ? { owedEdit, owedDigest: r.studioDigest ?? digest } : {}) } : { saveOwed: undefined, owedEdit: undefined, owedDigest: undefined })
  const kept = await records.update(projectId, (r) => ({ ...r, state: 'adopted', ...(r.studioDigest ? {} : { studioDigest: digest, ...note }), failed: undefined, ...owed(r) }))
  if (!kept || kept.state !== 'adopted') throw new Error('this computer could not keep a note of it')
  return kept
}

/**
 * The digest an edited draft carried on in the open editor is saved over: the Studio's edit as first filed. When the
 * video changed on the Studio since (the agent, another window), its save is refused and the person chooses which
 * version to keep, never the Studio's changes silently overwritten. Not edited: nothing is saved, the Studio's as read.
 */
export function carriedDigest(record: Pick<ProvisionalRecord, 'studioDigest'>, serverDigest: string, edited: boolean): string {
  return edited && record.studioDigest ? record.studioDigest : serverDigest
}

/** What is noted of the Studio's edit as first read: its transcripts' ids and a hash of it (keys sorted). */
export async function studioNote(project: EditorProject): Promise<{ studioTranscripts: string[]; studioBaseHash: string }> {
  return { studioTranscripts: project.transcripts.map((t) => t.id), studioBaseHash: await sha256(canonical(project)) }
}
async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The Studio's video since its first filing changed only by transcripts it added (the Mac's late words): those, else null
 * (a real change made there, or nothing noted to tell by). Pure but for hashing.
 */
export async function onlyLateWordsSince(record: Pick<ProvisionalRecord, 'studioTranscripts' | 'studioBaseHash'>, server: EditorProject): Promise<EditorTranscript[] | null> {
  if (!record.studioTranscripts || !record.studioBaseHash) return null
  const added = server.transcripts.filter((t) => !record.studioTranscripts!.includes(t.id))
  if (!added.length) return null
  const before = { ...server, transcripts: server.transcripts.filter((t) => !added.includes(t)) }
  return (await sha256(canonical(before))) === record.studioBaseHash ? added : null
}

/** The same edit, whatever order its fields came in. */
export const sameProject = (a: EditorProject, b: EditorProject) => canonical(a) === canonical(b)

/** Keys sorted, so two copies of a project compare equal whatever order their fields came in. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v))

/**
 * The transcripts the Studio added to a video since the editor's saved copy, when that is all that changed (the Mac's
 * words arriving after the edit carried on without them, recordings.ts addRecordingWords): null when anything else
 * changed too (a real edit elsewhere: the person chooses). Pure.
 */
export function lateTranscripts(saved: EditorProject, remote: EditorProject): EditorTranscript[] | null {
  const added = remote.transcripts.filter((t) => !saved.transcripts.some((x) => x.id === t.id))
  if (!added.length) return null
  const rest = { ...remote, transcripts: remote.transcripts.filter((t) => !added.includes(t)) }
  return canonical(rest) === canonical(saved) ? added : null
}

/**
 * Whether the open editor still owes a save over the Studio's edit once it carried a filed take on: only when it will make
 * one, its edit differing from the Studio's as the editor tells a change (an edit whose only change was dropped, such as a
 * word correction on a transcript left out, has nothing to save). Pure.
 */
export const saveOwedAfter = (edited: boolean, project: EditorProject, server: EditorProject) => edited && JSON.stringify(project) !== JSON.stringify(server)

/** The transcripts another version of a video added since the editor's saved copy (none known without one). Pure. */
export function remoteAddedTranscripts(saved: EditorProject | null, remote: EditorProject): EditorTranscript[] {
  return saved ? remote.transcripts.filter((t) => !saved.transcripts.some((x) => x.id === t.id)) : []
}

/** `project` with the transcripts `add` of voices it has and has no transcript of yet. Pure. */
export function withTranscripts(project: EditorProject, add: EditorTranscript[]): EditorProject {
  const fresh = add.filter((t) => project.assets.some((a) => a.id === t.assetId) && !project.transcripts.some((x) => x.id === t.id || x.assetId === t.assetId))
  return fresh.length ? { ...project, transcripts: [...project.transcripts, ...fresh] } : project
}

/**
 * A filed take whose draft is not open: not edited, the Studio's edit is taken as it is; edited, the draft moved onto
 * the Studio's copies is saved over it with its digest, only over the edit the Studio first filed (never over a video
 * changed since, nor when the editor already carried it on: `already`). The words still on their way are waited for
 * first; past the wait the edit goes on without the transcript made here (the words follow). Only once that is done is
 * the record marked `adopted` and the files let go (when the Studio holds every byte of them). A save refused because
 * the video changed elsewhere, or one that never reached the Studio, keeps the record and the take: the edit is
 * offered back, or tried again.
 */
export async function adoptKept(deps: AdoptDeps, projectId: string): Promise<Adopted> {
  let record = await deps.store.get(projectId).catch(() => null)
  if (!record) return { outcome: 'gone' }
  // Adopted with its last edits still owed (the editor's save never landed): "Put my edits on it" goes on below.
  if (record.state === 'adopted' && !record.saveOwed) return { outcome: 'already' }
  if (deps.waitWords) {
    await deps.waitWords()
    record = (await deps.store.get(projectId).catch(() => null)) ?? record
  }
  let server: { project: EditorProject; projectDigest: string }
  try {
    server = await deps.read(record.filedAs ?? projectId)
  } catch (error) {
    return { outcome: 'unreadable', message: `The recording is filed, but its video could not be read yet (${text(error)}). Your edits are kept on this computer.` }
  }
  // Owed by the editor that carried it on: the owed edit itself (already on the Studio's assets), saved over the digest
  // the editor last saved at. Not kept (an older record): nothing here may claim it saved them.
  const owed = record.state === 'adopted' && !!record.saveOwed
  if (owed && !record.owedEdit) return { outcome: 'failed', message: OWED_UNKNOWN }
  let adopted: { edited: boolean; unregistered: string[]; project: EditorProject }
  try {
    adopted = owed ? { edited: true, unregistered: [], project: record.owedEdit! } : adoptFiled(record, record.draft, server.project)
  } catch (error) {
    const message = `The recording is filed, but your edits could not be moved onto it (${text(error)}). They are kept on this computer.`
    await deps.records.update(projectId, (r) => ({ ...r, failed: message })).catch(() => undefined)
    return { outcome: 'failed', message }
  }
  const wordsLater = adopted.unregistered.length > 0
  const project = withoutTranscripts(adopted.project, adopted.unregistered)
  // The Studio's edit the save goes over: the one the editor last saved at when owed, else the one first filed.
  const over = owed ? (record.owedDigest ?? record.studioDigest) : record.studioDigest
  if (adopted.edited) {
    const conflict = async (): Promise<Adopted> => {
      // Noted beside the take, so the Record dialog says what is wrong (not that Try again puts the edits on).
      await deps.records.update(projectId, (r) => ({ ...r, failed: CHANGED_ELSEWHERE })).catch(() => undefined)
      return { outcome: 'conflict', message: CHANGED_ELSEWHERE, recovery: { project, digest: server.projectDigest, base: JSON.stringify(server.project) } }
    }
    // The video is already this edit (with, at most, the Mac's late words on it): an earlier save landed, only its answer
    // or the note after it was lost. Nothing to save.
    const landed = sameProject(server.project, project) || !!lateTranscripts(project, server.project)
    if (!landed) {
      let save = project
      if (over && over !== server.projectDigest) {
        // Changed since its first filing only by the Mac's late words: they go into the edit, which is saved over it.
        const late = over === record.studioDigest ? await onlyLateWordsSince(record, server.project) : null
        if (!late) return conflict()
        save = withTranscripts(project, late)
      }
      if (!record.studioDigest) {
        const note = await studioNote(server.project)
        const noted = await deps.records.update(projectId, (r) => ({ ...r, studioDigest: server.projectDigest, ...note })).catch(() => null)
        if (!noted?.studioDigest) return { outcome: 'failed', message: 'The recording is filed, but this computer could not keep a note of it, so your edits were not saved onto it yet. They are kept on this computer.' }
      }
      try {
        await deps.save(server.project.id, save, server.projectDigest)
      } catch (error) {
        const kind = saveRefusal(error)
        if (kind === 'conflict') return conflict()
        return { outcome: kind === 'network' ? 'network' : 'failed', message: kind === 'network' ? 'The recording is filed, but the Studio could not be reached to save your edits onto it. They are kept on this computer.' : `The recording is filed, but your edits could not be saved onto it (${text(error)}). They are kept on this computer.` }
      }
    }
  }
  const marked = await deps.records.update(projectId, (r) => ({ ...r, state: 'adopted', saveOwed: undefined, owedEdit: undefined, owedDigest: undefined, failed: undefined })).catch(() => null)
  // Not noted: the files stay (a later launch finds the video changed since its first read, and never saves again).
  if (marked?.state !== 'adopted') return { outcome: adopted.edited ? 'saved' : 'taken', wordsLater }
  return { outcome: adopted.edited ? 'saved' : 'taken', settled: await deps.release(projectId), wordsLater }
}

/**
 * The saves this page owes over the Studio's edit: only for takes this page's editor carried on (never read back from
 * the records at a launch: a later save of the same video, from the Studio's copy, is not the owed edit landing).
 */
export class OwedSaves {
  private owed = new Map<string, string>()
  /** The editor carried `draftId` on as `videoId`, its edit still to be saved. */
  carriedOn(videoId: string, draftId: string): void { this.owed.set(videoId, draftId) }
  has(videoId: string): boolean { return this.owed.has(videoId) }
  draftOf(videoId: string): string | undefined { return this.owed.get(videoId) }
  /** A save of `videoId` from this editor landed: what was owed is saved (true when something was owed). */
  async saved(videoId: string, records: AdoptDeps['records'] | null): Promise<boolean> {
    const draftId = this.owed.get(videoId)
    if (draftId === undefined) return false
    this.owed.delete(videoId)
    await records?.update(draftId, (r) => ({ ...r, state: 'adopted', saveOwed: undefined, owedEdit: undefined, owedDigest: undefined })).catch(() => undefined)
    return true
  }
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')
