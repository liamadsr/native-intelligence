// Takes kept on this computer that are not settled: shown to the person where saved takes are listed (the Record
// dialog), each with its size, what is wrong in plain words, Try again and Discard. The app never removes such a take
// by its age (studio_recorder.rs sweep): it stays until it is filed (and the Studio holds every byte) or discarded.
import { wordsOwed, type Settled } from './filing'
import { CHANGED_ELSEWHERE, OWED_CHANGED, OWED_UNKNOWN, type ProvisionalRecord } from './provisional'

/** A take folder as studio_recorder_unfinished_takes lists it. */
export type ListedTake = {
  sessionId: string
  takeId: string | null
  tracks: { role: string; bytes: number }[]
  hasDraft: boolean
  draftUnreadable: boolean
  /** Recorded while another account was signed in: listed for its size, with Discard only. */
  otherAccount: boolean
  /** No screen recording the Studio could use (its writer failed, or a crash before its first segment): the other
   *  files are kept and listed, with Discard only. */
  screenMissing: boolean
  /** The recorder's stop payload kept beside it (null: the take was never stopped cleanly). */
  stop: unknown
  modifiedMs: number | null
}

/** What to do on Try again. */
export type LocalTakeAction =
  | { kind: 'refile'; projectId: string }
  /** Filed (or adopted with its last edits owed), its edit not on the video yet: put it on (App.tsx retryAdopt). */
  | { kind: 'adopt'; projectId: string }
  /** The edit is on the video: let go of the files once the Studio holds every byte (`anyway`: even if this computer
   *  could not tell that the last edits reached the video; the person was told so). */
  | { kind: 'release'; projectId: string; anyway?: boolean }
  | { kind: 'recover'; takeId: string }
  | { kind: 'file-whole' }
  | { kind: 'none' }

/**
 * `edits`: Discard deletes edits that are on this computer only (its draft is beside the files). `label`: the button's
 * words (Try again when not said). `alt`: a second thing the person can do instead.
 */
export type LocalTakeRow = { sessionId: string; bytes: number; at: string | null; problem: string; action: LocalTakeAction; label?: string; alt?: { action: LocalTakeAction; label: string }; projectId?: string; edits: boolean }

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
      screenMissing: t.screenMissing === true,
      stop: t.stop ?? null,
      modifiedMs: typeof t.modifiedMs === 'number' ? t.modifiedMs : null,
    }]
  })
}

const roleWord = (role: string) => (role === 'system-audio' ? 'computer sound' : role)
const andList = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0] ?? '')

/**
 * One row for each take kept on this computer that is not on its way by itself: what is wrong, in plain words, and
 * what Try again does. `skip`: video ids this page is filing now or has open (left out: their editor says how it goes).
 * `heldHere`: takes this page holds (one it is filing has a draft before this page has read its record: never shown as
 * a lost edit meanwhile). `owned`: takes this page's recorder still has (stopped and being uploaded or made into a video
 * the classic way, "Preparing your recording"): left out unless they have a record (then their filing is listed). Pure.
 */
export function localTakeRows(listed: ListedTake[], records: ProvisionalRecord[], skip: ReadonlySet<string> = new Set(), heldHere: (sessionId: string) => boolean = () => false, owned: ReadonlySet<string> = new Set()): LocalTakeRow[] {
  return listed.flatMap((take) => {
    const bytes = take.tracks.reduce((n, t) => n + t.bytes, 0)
    const at = take.modifiedMs ? new Date(take.modifiedMs).toISOString() : null
    const record = take.otherAccount ? undefined : records.find((r) => r.sessionId === take.sessionId)
    if (!record && owned.has(take.sessionId)) return []
    // Edits only on this computer: a draft changed from the take as built and not yet on the video (an adopted take's
    // are on it, unless its last save is owed).
    const edits = record ? (record.state === 'adopted' ? !!record.saveOwed : JSON.stringify(record.draft) !== JSON.stringify(record.base)) : take.hasDraft || take.draftUnreadable
    const row = (problem: string, action: LocalTakeAction, projectId?: string, more: Pick<LocalTakeRow, 'label' | 'alt'> = {}): LocalTakeRow[] => [{ sessionId: take.sessionId, bytes, at, problem, action, edits, ...more, ...(projectId ? { projectId } : {}) }]
    if (take.otherAccount) return row('This recording was made while another account was signed in, so it cannot be filed from this one.', { kind: 'none' })
    if (take.screenMissing) {
      const kept = andList(take.tracks.filter((t) => t.role !== 'screen' && t.bytes > 0).map((t) => roleWord(t.role)))
      return row(`The screen recording failed, so this cannot be made into a video.${kept ? ` Its ${kept} ${kept.includes(' and ') ? 'are' : 'is'} kept on this computer.` : ''}`, { kind: 'none' })
    }
    if (record && skip.has(record.projectId)) return []
    // A draft beside the take that is not a record this page can read (torn, or of another version): its edits are lost.
    // Unless this page holds the take: its record is being written now.
    if (take.draftUnreadable || (take.hasDraft && !record)) {
      if (!take.draftUnreadable && heldHere(take.sessionId)) return []
      const action: LocalTakeAction = take.takeId ? { kind: 'recover', takeId: take.takeId } : take.stop ? { kind: 'file-whole' } : { kind: 'none' }
      return row(action.kind === 'none'
        ? 'The edit kept for this recording could not be read, and the recording cannot be made into a video here.'
        : 'The edit kept for this recording could not be read. Try again makes the recording a new video (the edits made to it before it was filed are lost).', action)
    }
    if (record) {
      const failed = record.failed?.trim()
      if (record.state === 'failed') return row(failed ?? 'This recording could not be filed.', { kind: 'refile', projectId: record.projectId }, record.projectId)
      if (record.state === 'filing') return row('This recording has not been filed yet.', { kind: 'refile', projectId: record.projectId }, record.projectId)
      const letGo = { action: { kind: 'release', projectId: record.projectId, anyway: true } as LocalTakeAction, label: LET_GO }
      if (record.state === 'filed') {
        // Changed elsewhere: Try again offers the edits back; letting go is the other way to settle it (asked first).
        if (failed === CHANGED_ELSEWHERE) return row(`${failed} Try again offers to open the video with them, so you can choose. ${LET_GO} removes this recording and those edits from this computer once the Studio holds every byte of it.`, { kind: 'adopt', projectId: record.projectId }, record.projectId, { alt: letGo })
        return row(failed ? `${failed} Try again tries once more.` : 'Filed. Your edits are not on the video yet. Try again puts them on it.', { kind: 'adopt', projectId: record.projectId }, record.projectId)
      }
      // Owed, but the owed edit itself was not kept: nothing here can put it on, only letting go (asked first).
      if (record.saveOwed && !record.owedEdit) return row(`${OWED_UNKNOWN} ${LET_GO} removes this recording from this computer once the Studio holds every byte of it.`, { kind: 'none' }, record.projectId, { alt: letGo })
      if (record.saveOwed) {
        return row(`${failed === OWED_CHANGED || failed === CHANGED_ELSEWHERE ? 'The video has changed since these edits were made, so they were not put on it.' : 'The video is made, but your last edits may not have reached it.'} Put my edits on it saves them onto the video, never over changes made there since. ${LET_GO} removes this recording and those edits from this computer once the Studio holds every byte of it.`,
          { kind: 'adopt', projectId: record.projectId }, record.projectId, { label: 'Put my edits on it', alt: letGo })
      }
      // Held back only by the Mac's words still on their way: the words are named, not the bytes.
      if (wordsOwed(record)) return row('The video is made, but the words the Mac heard have not reached the Studio yet, so this recording is kept on this computer until they do.', { kind: 'release', projectId: record.projectId }, record.projectId)
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

/**
 * The takes being uploaded or made into a video now ("Preparing your recording"): in the set only while `during` runs,
 * so a take whose upload failed is listed again (with Try again and Discard) once it stopped.
 */
export function takesInFlight() {
  const ids = new Set<string>()
  return {
    ids: (): ReadonlySet<string> => ids,
    async during<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
      ids.add(sessionId)
      try {
        return await work()
      } finally {
        ids.delete(sessionId)
      }
    },
  }
}

/**
 * A row action takes over a take its session kept after a failed upload (`pending`): that session lets go of it. Answers
 * the session's id (its Try again and Discard are turned off), or null when no session kept it.
 */
export function takeOverFromSession<T extends { id: string; take: { sessionId: string } }>(pending: { current: T | null }, sessionId: string): string | null {
  const kept = pending.current
  if (!kept || kept.take.sessionId !== sessionId) return null
  pending.current = null
  return kept.id
}

/** The take kept for Try again, only when it is the one of the session asked about (`id`): else null. Pure. */
export const keptFor = <T extends { id: string }>(kept: T | null, id: string): T | null => (kept && kept.id === id ? kept : null)

/** What this page knows of a listed take, to tell whether it may be discarded now (inUseReason). */
export type InUse = {
  /** Takes being sent on now (desktop.ts takesBeingSent) or recording. */
  sending: ReadonlySet<string>
  records: ProvisionalRecord[]
  /** Video ids this page is filing now or has open in the editor. */
  open: ReadonlySet<string>
}

/** Why a listed take cannot be discarded now, or null. Pure. */
export function inUseReason(sessionId: string, now: InUse): string | null {
  if (now.sending.has(sessionId)) return 'This recording is being sent to the Studio now. Try again in a moment.'
  const record = now.records.find((r) => r.sessionId === sessionId)
  if (record && now.open.has(record.projectId)) return 'This recording is open in the editor. Leave its video first, then discard it.'
  return null
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
  /** Why the take cannot be discarded now (this page has it open, is sending it), or null (inUseReason). */
  inUse: (sessionId: string) => Promise<string | null>
  /** This page's hold on the take (PageLeases): false when another window holds it. */
  holdTake: (sessionId: string) => Promise<boolean>
  letGoTake: (sessionId: string) => Promise<void>
  /** Whether this page holds the take already (its recorder or its filing): an action never lets go of such a hold. */
  holdsTake?: (sessionId: string) => boolean
  notify: (text: string, error?: boolean) => void
  refresh: () => void
  /** The takes being acted on now (their buttons wait). */
  onBusy?: (sessionIds: string[]) => void
  /** A row action takes the take over (it makes a new video of it, brings it back, or discards it): the session that kept
   *  it after a failed upload lets go of it (takeOverFromSession), so its banner never acts on it again. */
  takeOver?: (sessionId: string) => void
  /** Whether a "Preparing your recording" upload is sending the take now (a session's Try again): no row action then. */
  inFlight?: (sessionId: string) => boolean
}

/** What a row action on a take being sent now says (it is refused: the upload deletes the folder when it is done). */
export const SENDING_NOW = 'This recording is being sent now. Try again once it has finished.'

/** The second action that lets go of a take's files and edits (asked once more first, RecordDialog.tsx). */
export const LET_GO = 'Let go of the files'

/** What the person is told when another window has the take. */
export const OPEN_ELSEWHERE = 'This recording is open in another window.'

/**
 * Try again and Discard on listed takes, one at a time per take: a second press while the first runs does nothing
 * (two presses never make two videos), a take with a record is never filed whole again, and what makes a video of a take
 * or removes it holds the take first (another window never does the same at the same time).
 */
export function localTakeActions(deps: LocalTakeDeps) {
  const busy = new Set<string>()
  const run = async (sessionId: string, work: () => Promise<void>) => {
    if (busy.has(sessionId)) return
    busy.add(sessionId)
    deps.onBusy?.([...busy])
    try {
      // Being sent by a session's Try again: every row action waits (a second video, or files deleted under it).
      if (deps.inFlight?.(sessionId)) throw new Error(SENDING_NOW)
      await work()
    } catch (cause) {
      deps.notify(cause instanceof Error ? cause.message : String(cause), true)
    } finally {
      busy.delete(sessionId)
      deps.onBusy?.([...busy])
      deps.refresh()
    }
  }
  /** Hold the take for the action: a function that lets go after it, or does nothing when the hold was this page's before. */
  const hold = async (sessionId: string): Promise<() => Promise<void>> => {
    const had = deps.holdsTake?.(sessionId) ?? false
    if (!(await deps.holdTake(sessionId))) throw new Error(OPEN_ELSEWHERE)
    return had ? async () => undefined : () => deps.letGoTake(sessionId)
  }
  return {
    busy: (sessionId: string) => busy.has(sessionId),
    /** `alt`: the row's second action instead of its first. */
    retry: (row: LocalTakeRow, alt = false) => run(row.sessionId, async () => {
      const action = alt && row.alt ? row.alt.action : row.action
      if (action.kind === 'refile') await deps.refile(action.projectId)
      else if (action.kind === 'adopt') await deps.adopt(action.projectId)
      else if (action.kind === 'release') {
        const settled = await deps.release(action.projectId, !!action.anyway)
        if (!settled.safe && settled.note) deps.notify(settled.note, true)
      } else if (action.kind === 'recover') {
        const letGo = await hold(row.sessionId)
        deps.takeOver?.(row.sessionId)
        try {
          await deps.recover(action.takeId)
        } finally {
          await letGo()
        }
      } else if (action.kind === 'file-whole') {
        const letGo = await hold(row.sessionId)
        deps.takeOver?.(row.sessionId)
        let filing = false
        try {
          if ((await deps.records()).some((r) => r.sessionId === row.sessionId)) throw new Error('This recording is being made into a video already.')
          await deps.fileWhole(row)
          // Filed behind the editor now (its record kept): its filing holds it from here.
          filing = (await deps.records().catch(() => [])).some((r) => r.sessionId === row.sessionId)
        } finally {
          if (!filing) await letGo()
        }
      }
    }),
    discard: (sessionId: string) => run(sessionId, async () => {
      const why = await deps.inUse(sessionId)
      if (why) throw new Error(why)
      const letGo = await hold(sessionId)
      deps.takeOver?.(sessionId)
      try {
        await deps.discard(sessionId)
      } finally {
        await letGo()
      }
    }),
  }
}

/** A size in plain words (MB, GB). */
export function sizeWords(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.max(1, Math.round(bytes / 1e6))} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}
