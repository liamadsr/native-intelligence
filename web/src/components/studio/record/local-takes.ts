// Takes kept on this computer that are not settled: shown to the person where saved takes are listed (the Record
// dialog), each with its size, what is wrong in plain words, Try again and Discard. The app never removes such a take
// by its age (studio_recorder.rs sweep): it stays until it is filed (and the Studio holds every byte) or discarded.
import type { ProvisionalRecord } from './provisional'

/** A take folder as studio_recorder_unfinished_takes lists it. */
export type ListedTake = {
  sessionId: string
  takeId: string | null
  tracks: { role: string; bytes: number }[]
  hasDraft: boolean
  draftUnreadable: boolean
  /** The recorder's stop payload kept beside it (null: the take was never stopped cleanly). */
  stop: unknown
  modifiedMs: number | null
}

/** What to do on Try again. */
export type LocalTakeAction =
  | { kind: 'refile'; projectId: string }
  | { kind: 'release'; projectId: string }
  | { kind: 'recover'; takeId: string }
  | { kind: 'file-whole' }
  | { kind: 'none' }

export type LocalTakeRow = { sessionId: string; bytes: number; at: string | null; problem: string; action: LocalTakeAction; projectId?: string }

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
      stop: t.stop ?? null,
      modifiedMs: typeof t.modifiedMs === 'number' ? t.modifiedMs : null,
    }]
  })
}

/**
 * One row for each take kept on this computer that is not on its way by itself: what is wrong, in plain words, and
 * what Try again does. `filing`: video ids whose filing this page is following now (left out: their editor says it).
 * Pure.
 */
export function localTakeRows(listed: ListedTake[], records: ProvisionalRecord[], filing: ReadonlySet<string> = new Set()): LocalTakeRow[] {
  return listed.flatMap((take) => {
    const bytes = take.tracks.reduce((n, t) => n + t.bytes, 0)
    const at = take.modifiedMs ? new Date(take.modifiedMs).toISOString() : null
    const record = records.find((r) => r.sessionId === take.sessionId)
    const row = (problem: string, action: LocalTakeAction, projectId?: string): LocalTakeRow[] => [{ sessionId: take.sessionId, bytes, at, problem, action, ...(projectId ? { projectId } : {}) }]
    if (take.draftUnreadable) {
      return row('The edit kept for this recording could not be read. Try again makes the recording a new video (the edits made to it before it was filed are lost).', take.takeId ? { kind: 'recover', takeId: take.takeId } : take.stop ? { kind: 'file-whole' } : { kind: 'none' })
    }
    if (record) {
      if (filing.has(record.projectId)) return []
      if (record.state === 'failed') return row(record.failed ?? 'This recording could not be filed.', { kind: 'refile', projectId: record.projectId }, record.projectId)
      if (record.state === 'filing') return row('This recording has not been filed yet.', { kind: 'refile', projectId: record.projectId }, record.projectId)
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

/** A size in plain words (MB, GB). */
export function sizeWords(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.max(1, Math.round(bytes / 1e6))} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}
