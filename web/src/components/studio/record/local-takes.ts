// Takes kept on this computer that are not settled: shown to the person where saved takes are listed (the Record
// dialog), each with its size, what is wrong in plain words, Try again and Discard. The app never removes such a take
// by its age (studio_recorder.rs sweep): it stays until it is filed (and the Studio holds every byte) or discarded.
import type { Settled } from './filing'
import type { ProvisionalRecord } from './provisional'

/** A take folder as studio_recorder_unfinished_takes lists it. */
export type ListedTake = {
  sessionId: string
  takeId: string | null
  tracks: { role: string; bytes: number }[]
  hasDraft: boolean
  draftUnreadable: boolean
  /** Recorded while another account was signed in: listed for its size, with Discard only. */
  otherAccount: boolean
  /** The recorder's stop payload kept beside it (null: the take was never stopped cleanly). */
  stop: unknown
  modifiedMs: number | null
}

/** What to do on Try again. */
export type LocalTakeAction =
  | { kind: 'refile'; projectId: string }
  /** Filed, its edit not on the video yet: carry it on from the Studio's copies (App.tsx retryAdopt). */
  | { kind: 'adopt'; projectId: string }
  /** The edit is on the video: let go of the files once the Studio holds every byte (`anyway`: even if this computer
   *  could not tell that the last edits reached the video; the person was told to check). */
  | { kind: 'release'; projectId: string; anyway?: boolean }
  | { kind: 'recover'; takeId: string }
  | { kind: 'file-whole' }
  | { kind: 'none' }

/** `edits`: Discard deletes the edits made to it too (its draft is beside the files). */
export type LocalTakeRow = { sessionId: string; bytes: number; at: string | null; problem: string; action: LocalTakeAction; projectId?: string; edits: boolean }

const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** The app's answer as listed takes (anything it does not say is left out, never guessed). */
export function listedTakes(raw: unknown): ListedTake[] {
  const takes = Array.isArray(obj(raw).takes) ? (obj(raw).takes as unknown[]) : []
  return takes.flatMap((value) => {
    const t = obj(value)
    if (typeof t.sessionId !== 'string') return []
    return [{
      sessionId: t.sessionId,
      takeId: typeof t.takeId === 'string' ? t.takeId : null,
      tracks: (Array.isArray(t.tracks) ? t.tracks : []).map(obj).map((x) => ({ role: String(x.role), bytes: typeof x.bytes === 'number' ? x.bytes : 0 })),
      hasDraft: t.hasDraft === true,
      draftUnreadable: t.draftUnreadable === true,
      otherAccount: t.otherAccount === true,
      stop: t.stop ?? null,
      modifiedMs: typeof t.modifiedMs === 'number' ? t.modifiedMs : null,
    }]
  })
}

/**
 * One row for each take kept on this computer that is not on its way by itself: what is wrong, in plain words, and
 * what Try again does. `skip`: video ids this page is filing now or has open (left out: their editor says how it goes).
 * Pure.
 */
export function localTakeRows(listed: ListedTake[], records: ProvisionalRecord[], skip: ReadonlySet<string> = new Set()): LocalTakeRow[] {
  return listed.flatMap((take) => {
    const bytes = take.tracks.reduce((n, t) => n + t.bytes, 0)
    const at = take.modifiedMs ? new Date(take.modifiedMs).toISOString() : null
    const record = take.otherAccount ? undefined : records.find((r) => r.sessionId === take.sessionId)
    const edits = !!record || take.hasDraft || take.draftUnreadable
    const row = (problem: string, action: LocalTakeAction, projectId?: string): LocalTakeRow[] => [{ sessionId: take.sessionId, bytes, at, problem, action, edits, ...(projectId ? { projectId } : {}) }]
    if (take.otherAccount) return row('This recording was made while another account was signed in, so it cannot be filed from this one.', { kind: 'none' })
    // A draft beside the take that is not a record this page can read (torn, or of another version): its edits are lost.
    if (take.draftUnreadable || (take.hasDraft && !record)) {
      const action: LocalTakeAction = take.takeId ? { kind: 'recover', takeId: take.takeId } : take.stop ? { kind: 'file-whole' } : { kind: 'none' }
      return row(action.kind === 'none'
        ? 'The edit kept for this recording could not be read, and the recording cannot be made into a video here.'
        : 'The edit kept for this recording could not be read. Try again makes the recording a new video (the edits made to it before it was filed are lost).', action)
    }
    if (record) {
      if (skip.has(record.projectId)) return []
      if (record.state === 'failed') return row(record.failed ?? 'This recording could not be filed.', { kind: 'refile', projectId: record.projectId }, record.projectId)
      if (record.state === 'filing') return row('This recording has not been filed yet.', { kind: 'refile', projectId: record.projectId }, record.projectId)
      if (record.state === 'filed') return row('Filed. Your edits are not on the video yet. Try again puts them on it.', { kind: 'adopt', projectId: record.projectId }, record.projectId)
      if (record.saveOwed) return row('The video is made, but your last edits may not have reached it. Open the video to check them. Try again lets go of these files once the Studio holds every byte of them.', { kind: 'release', projectId: record.projectId, anyway: true }, record.projectId)
      return row('The video is made, but the Studio does not hold every byte of this recording yet, so its files are kept on this computer.', { kind: 'release', projectId: record.projectId }, record.projectId)
    }
    if (!take.takeId) {
      return take.stop
        ? row('This recording never reached the Studio (there was no connection while it recorded). Try again makes it a new video.', { kind: 'file-whole' })
        : row('This recording stopped before it was finished and never reached the Studio. It cannot be made into a video here.', { kind: 'none' })
    }
    return row('Part of this recording is on the Studio and the rest is on this computer. Try again makes it a video from all of it.', { kind: 'recover', takeId: take.takeId })
  })
}

/** What Try again and Discard on a listed take need (useManualRecording wires them to the filing and the app). */
export type LocalTakeDeps = {
  refile: (projectId: string) => Promise<void>
  adopt: (projectId: string) => Promise<void>
  release: (projectId: string, anyway: boolean) => Promise<Settled>
  recover: (takeId: string) => Promise<void>
  /** File the take whole as a new video, from the files on this computer. */
  fileWhole: (row: LocalTakeRow) => Promise<void>
  /** The records kept beside the takes now (a take with one is on its way already: never filed a second time). */
  records: () => Promise<ProvisionalRecord[]>
  discard: (sessionId: string) => Promise<unknown>
  /** Why the take cannot be discarded now (this page has it open, is sending it, another window holds it), or null. */
  inUse: (sessionId: string) => Promise<string | null>
  notify: (text: string, error?: boolean) => void
  refresh: () => void
  /** The takes being acted on now (their buttons wait). */
  onBusy?: (sessionIds: string[]) => void
}

/** What the person is told when a second Try again or Discard comes while the first is still under way. */
export const STILL_WORKING = 'This recording is being worked on already.'

/**
 * Try again and Discard on listed takes, one at a time per take: a second press while the first runs does nothing
 * (two presses never make two videos), and a take with a record is never filed whole again.
 */
export function localTakeActions(deps: LocalTakeDeps) {
  const busy = new Set<string>()
  const run = async (sessionId: string, work: () => Promise<void>) => {
    if (busy.has(sessionId)) return
    busy.add(sessionId)
    deps.onBusy?.([...busy])
    try {
      await work()
    } catch (cause) {
      deps.notify(cause instanceof Error ? cause.message : String(cause), true)
    } finally {
      busy.delete(sessionId)
      deps.onBusy?.([...busy])
      deps.refresh()
    }
  }
  return {
    busy: (sessionId: string) => busy.has(sessionId),
    retry: (row: LocalTakeRow) => run(row.sessionId, async () => {
      const action = row.action
      if (action.kind === 'refile') await deps.refile(action.projectId)
      else if (action.kind === 'adopt') await deps.adopt(action.projectId)
      else if (action.kind === 'release') {
        const settled = await deps.release(action.projectId, !!action.anyway)
        if (!settled.safe && settled.note) deps.notify(settled.note, true)
      } else if (action.kind === 'recover') await deps.recover(action.takeId)
      else if (action.kind === 'file-whole') {
        if ((await deps.records()).some((r) => r.sessionId === row.sessionId)) throw new Error('This recording is being made into a video already.')
        await deps.fileWhole(row)
      }
    }),
    discard: (sessionId: string) => run(sessionId, async () => {
      const why = await deps.inUse(sessionId)
      if (why) throw new Error(why)
      await deps.discard(sessionId)
    }),
  }
}

/** A size in plain words (MB, GB). */
export function sizeWords(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.max(1, Math.round(bytes / 1e6))} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}
