// Filing a Mac take behind the editor, and letting go of its files only once the Studio has every byte of it.
//
// A take is never thrown away from this computer on the Studio's "done" alone: the recording must hold every track the
// computer has, with the very bytes recorded (the Studio's `received`, per track, against the hashes of the files here).
// A track the Studio lost (its import failed, or its bytes differed) is uploaded again whole, under a fresh upload, and
// put into the video (POST /recordings/:id/tracks). Until then the folder stays; its note says why, plainly.
//
// Each take opened before it was filed has its own filing (Filer), kept by its video id: a second take never takes the
// first one's place, and Try again on either sends that take. Its record lives beside the take (provisional.ts
// DraftStore), so a reload, a restart or another window finds it; one page holds a take at a time (PageLeases).
import { STUDIO_API } from '../studio-env'
import { recordingRequest } from './finish'
import { withWords, type DraftStore, type FilingState, type ProvisionalRecord } from './provisional'
import type { FinishedTake, TakeRole, TakeWord, UploadPart } from './types'
import type { RecordingAnswer, RecordingView } from '@/lib/studio/server/recordings'

export type FilingApi = { get<T>(url: string): Promise<T>; post<T>(url: string, body?: unknown): Promise<T> }
/** What filing asks of the app (studio_recorder_*: tauri-bridge.ts). */
export type FilingNative = {
  takeMedia?: (sessionId: string) => Promise<unknown>
  upload: (sessionId: string, role: string, parts: UploadPart[]) => Promise<unknown>
  discard: (sessionId: string) => Promise<unknown>
  words?: (sessionId: string) => Promise<unknown>
}
export type LocalTrack = { role: TakeRole; sha256: string; bytes: number }

const ROLES: TakeRole[] = ['screen', 'camera', 'microphone', 'system-audio']
const studioRole = (role: TakeRole) => (role === 'system-audio' ? 'systemAudio' : role) as 'screen' | 'camera' | 'microphone' | 'systemAudio'
const fromStudio = (role: string): TakeRole | null => (role === 'systemAudio' ? 'system-audio' : ROLES.includes(role as TakeRole) ? (role as TakeRole) : null)
const word = (role: TakeRole) => (role === 'system-audio' ? 'computer sound' : role === 'screen' ? 'screen recording' : role)
const recordingUrl = (id: string) => `${STUDIO_API}/recordings/${encodeURIComponent(id)}`

/** The take's files on this computer: their hashes and sizes (null when the app cannot say). */
export async function localTracks(native: Pick<FilingNative, 'takeMedia'>, sessionId: string): Promise<LocalTrack[] | null> {
  if (typeof native.takeMedia !== 'function') return null
  try {
    const raw = (await native.takeMedia(sessionId)) as { tracks?: unknown[] }
    return (raw.tracks ?? []).flatMap((t) => {
      const v = t as Partial<LocalTrack>
      return v && ROLES.includes(v.role as TakeRole) && typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256) && typeof v.bytes === 'number' ? [{ role: v.role!, sha256: v.sha256, bytes: v.bytes }] : []
    })
  } catch {
    return null
  }
}

/**
 * Whether a made recording holds every track on this computer, byte for byte: `safe` (the files may go), the tracks
 * to send again (lost by the Studio, still here), and `waiting` (being made, or a track sent again still importing).
 * A track that differs and that the Studio did not count as lost cannot be sent again: never safe. Pure.
 */
export function compareFiled(view: Pick<RecordingView, 'status' | 'received' | 'lost' | 'attaching'>, local: LocalTrack[]): { safe: boolean; waiting: boolean; resend: TakeRole[]; short: TakeRole[] } {
  if (view.status !== 'done') return { safe: false, waiting: view.status === 'processing', resend: [], short: [] }
  const lost = new Set((view.lost ?? []).map((l) => fromStudio(l.role)).filter((r): r is TakeRole => !!r))
  const short: TakeRole[] = []
  for (const track of local) {
    const got = view.received?.[studioRole(track.role)]
    if (!got || got.sha256 !== track.sha256 || got.bytes !== track.bytes) short.push(track.role)
  }
  const waiting = !!view.attaching?.length
  const resend = short.filter((role) => lost.has(role) && role !== 'screen')
  return { safe: !waiting && !short.length && !lost.size, waiting, resend, short }
}

/** Upload one track of the take whole, from the computer, under a fresh upload (never a key used before): its key. */
export async function uploadWhole(api: FilingApi, native: FilingNative, sessionId: string, track: LocalTrack, name?: string): Promise<string> {
  const audio = track.role === 'microphone' || track.role === 'system-audio'
  const ticket = await api.post<{ uploadKey: string; parts: UploadPart[] }>(`${STUDIO_API}/uploads`, {
    name: name ?? `${track.role}.${audio ? 'm4a' : 'mp4'}`, bytes: track.bytes, contentType: audio ? 'audio/mp4' : 'video/mp4',
  })
  await native.upload(sessionId, track.role, ticket.parts)
  return ticket.uploadKey
}

export type Settled = { safe: boolean; note?: string; view?: RecordingView }

/**
 * Bring a made recording up to every byte on this computer: each track it lost is sent again whole (once per call) and
 * put into the video; answers `safe` once the Studio holds every track as recorded. Never throws; never discards.
 */
export async function settleRecording(deps: { api: FilingApi; native: FilingNative; sleep: (ms: number) => Promise<void> }, recordingId: string, sessionId: string, options: { rounds?: number; waitMs?: number; local?: LocalTrack[] | null } = {}): Promise<Settled> {
  const local = options.local ?? (await localTracks(deps.native, sessionId))
  if (!local?.length) return { safe: false, note: 'The files on this computer could not be read, so they are kept.' }
  const sent = new Set<TakeRole>()
  let view: RecordingView | undefined
  const rounds = options.rounds ?? 40
  // Waits only between looks: one look (rounds 1) never waits.
  const pause = (round: number) => (round + 1 < rounds ? deps.sleep(options.waitMs ?? 3000) : Promise.resolve())
  for (let round = 0; round < rounds; round++) {
    try {
      view = (await deps.api.get<RecordingAnswer>(recordingUrl(recordingId))).recording
    } catch {
      await pause(round)
      continue
    }
    if (view.status === 'failed') return { safe: false, view, note: view.error ?? 'The Studio could not make the recording.' }
    const check = compareFiled(view, local)
    if (check.safe) return { safe: true, view }
    if (!check.waiting && view.status === 'done') {
      const todo = check.resend.filter((role) => !sent.has(role))
      if (!todo.length) return { safe: false, view, note: keptNote(check.short, view) }
      for (const role of todo) {
        sent.add(role)
        try {
          const key = await uploadWhole(deps.api, deps.native, sessionId, local.find((t) => t.role === role)!)
          await deps.api.post(`${recordingUrl(recordingId)}/tracks`, { role: studioRole(role), uploadKey: key, sha256: local.find((t) => t.role === role)!.sha256 })
        } catch (cause) {
          return { safe: false, view, note: `The ${word(role)} could not be sent again (${errorText(cause)}). It is kept on this computer.` }
        }
      }
    }
    await pause(round)
  }
  return { safe: false, view, note: 'The Studio has not finished taking this recording yet. It is kept on this computer.' }
}

function keptNote(short: TakeRole[], view: RecordingView): string {
  const names = short.map(word)
  const lost = view.lost?.map((l) => `${word(fromStudio(l.role) ?? 'screen')}: ${l.reason}`).join('; ')
  return `The video is missing ${names.length ? `the ${names.join(' and ')}` : 'part of this recording'}${lost ? ` (${lost})` : ''}. The files are kept on this computer.`
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/\.$/, '')

/** The recording's files go from this computer only once settleRecording says the Studio has every byte. */
export async function releaseWhenSafe(deps: { api: FilingApi; native: FilingNative; sleep: (ms: number) => Promise<void> }, recordingId: string, sessionId: string, options: { rounds?: number; waitMs?: number } = {}): Promise<Settled> {
  const settled = await settleRecording(deps, recordingId, sessionId, options)
  if (settled.safe) await Promise.resolve(deps.native.discard(sessionId)).catch(() => undefined)
  return settled
}

/** The recorder's words (ms after its start, `{words}`) on the screen file's clock (`shiftMs`: desktop.ts normalizeStop). */
export function wordsOnScreenClock(transcript: unknown, shiftMs: number): TakeWord[] {
  const list = transcript && typeof transcript === 'object' && Array.isArray((transcript as { words?: unknown }).words) ? (transcript as { words: unknown[] }).words : []
  return list.flatMap((value) => {
    const w = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const text = typeof w.text === 'string' ? w.text.trim() : ''
    const startMs = (typeof w.startMs === 'number' ? w.startMs : NaN) + shiftMs
    const endMs = (typeof w.endMs === 'number' ? w.endMs : NaN) + shiftMs
    if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < 0) return []
    return [{ text, startMs: Math.max(0, startMs), endMs: Math.max(0, startMs, endMs) }]
  })
}

// ---- holding a take: one page at a time ----------------------------------------------------------------------

export type HoldBridge = { hold?: (sessionId: string, holder: string, release?: boolean) => Promise<unknown> }

/**
 * This page's hold on the takes it sends, files or plays (studio_recorder_hold): renewed every few seconds, let go
 * when the page goes (or, after a reload or a crash, when it stops renewing). Another window's hold makes `hold`
 * answer false: that window has the take.
 */
export class PageLeases {
  readonly holder: string
  private held = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(private readonly native: HoldBridge, holder?: string, private readonly every = 5000) {
    this.holder = holder ?? (globalThis.crypto?.randomUUID?.() ?? `page-${Math.random().toString(36).slice(2)}`)
  }
  async hold(sessionId: string): Promise<boolean> {
    if (typeof this.native.hold !== 'function') return true
    try {
      const answer = (await this.native.hold(sessionId, this.holder, false)) as { held?: boolean }
      if (answer?.held === false) return false
    } catch {
      // An app without holds, or a take gone: nothing to hold.
      return true
    }
    this.held.add(sessionId)
    this.timer ??= setInterval(() => void this.renew(), this.every)
    return true
  }
  async release(sessionId: string): Promise<void> {
    if (!this.held.delete(sessionId)) return
    if (!this.held.size && this.timer) { clearInterval(this.timer); this.timer = null }
    await Promise.resolve(this.native.hold?.(sessionId, this.holder, true)).catch(() => undefined)
  }
  holds(sessionId: string): boolean { return this.held.has(sessionId) }
  async renew(): Promise<void> {
    for (const id of this.held) await Promise.resolve(this.native.hold?.(id, this.holder, false)).catch(() => undefined)
  }
  /** The page is going: let go of everything now (its next page, or another window, takes over at once). */
  releaseAll(): void {
    for (const id of [...this.held]) void this.release(id)
  }
}

// ---- one take's filing ---------------------------------------------------------------------------------------

/** A record changed one at a time per video (the page and its filing both write it): `fn` on the latest copy. */
export function recordKeeper(store: DraftStore) {
  const chains = new Map<string, Promise<unknown>>()
  return {
    update(projectId: string, fn: (record: ProvisionalRecord) => ProvisionalRecord | null): Promise<ProvisionalRecord | null> {
      const run = (chains.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        const record = await store.get(projectId)
        if (!record) return null
        const next = fn(record)
        if (!next || next === record) return record
        await store.put(next)
        return next
      })
      chains.set(projectId, run)
      return run
    },
  }
}

export type FilerDeps = {
  store: DraftStore
  api: FilingApi
  native: FilingNative
  leases: PageLeases
  /** Upload every file of a take (whole: never from what went up while it recorded); answers the keys by role. */
  uploadTake: (take: FinishedTake, whole: boolean, onFraction: (fraction: number) => void) => Promise<Partial<Record<TakeRole, string>>>
  /** Send what reached no page (sendUnfinishedTakes, with this page's holds): before a take is brought back. */
  sendUnfinished: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  alive: () => boolean
  onState: (projectId: string, state: FilingState | null) => void
  onFiled: (projectId: string, recordingId: string) => void
  /** Words that arrived after the draft opened, for the editor (its draft and history take them too). */
  onWords?: (projectId: string, words: TakeWord[]) => void
  /** A take's files were kept when they were to go (the Studio does not hold every byte): why, in plain words. */
  onKept?: (projectId: string, note: string) => void
  /** The Studio refused the Mac's words for good: said once, in plain words. */
  onWordsDropped?: (projectId: string, note: string) => void
}

/** The waits between tries at sending the words, then a minute at a time until they are sent. */
const WORD_RETRIES_MS = [2_000, 5_000, 10_000, 30_000, 60_000]
/** How long a take is brought back for (its last pieces still arriving, no connection) before it says it could not be. */
const BRING_BACK_ROUNDS = 40

/** A failure that is only the connection (tried again), as against the Studio's answer. */
const onlyTheConnection = (cause: unknown) => cause instanceof TypeError || (cause as { code?: unknown } | null)?.code === 'NETWORK'

/**
 * What the Studio's answer to the words means (the client's `status`, ui/client.ts): `final`, a no that asking again will
 * not change (400 words it cannot read, 403 another person's, 413 too many); `missing`, a 404, which can also be this
 * page looking in another workspace than the recording's (so it is final only after WORDS_MISSES_FOR_GOOD launches say
 * so); null, anything else (BUSY, no connection, a 401 while the session renews, the Studio down): tried again.
 */
export function wordsRefusal(cause: unknown): 'final' | 'missing' | null {
  const { status, code } = (cause ?? {}) as { status?: unknown; code?: unknown }
  if (code === 'BUSY') return null
  if (status === 400 || status === 403 || status === 413) return 'final'
  return status === 404 ? 'missing' : null
}
/** The Mac's words still owed to the Studio: heard (or still being read) and neither sent nor given up. */
export const wordsOwed = (r: Pick<ProvisionalRecord, 'heard' | 'take' | 'wordsSent' | 'wordsRefused'>) => !r.wordsSent && !r.wordsRefused && (!!r.heard?.length || !!r.take?.wordsPending)

/** How many pages (launches, reloads) must find the recording missing before its words are given up. */
export const WORDS_MISSES_FOR_GOOD = 3

/** The recording the Studio made from the take failed: the take is made again from a fresh copy (never followed again). */
class RecordingFailed extends Error {}

/** The words sent with a recording (as its build reads them). */
const wordsBody = (words: TakeWord[]) => ({ words: words.slice(0, 40_000).map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs })) })

export class Filer {
  /** This run's takes, by video id: Try again sends the take itself. */
  private takes = new Map<string, { take: FinishedTake; title: string }>()
  private running = new Set<string>()
  private words = new Map<string, TakeWord[]>()
  private sendingWords = new Set<string>()
  /** Takes whose words this page stopped sending (their recording missing here): not waited for again by this page. */
  private wordsStopped = new Set<string>()
  /** Sessions whose recorder said it heard nothing (before their record was kept). */
  private heardNothing = new Set<string>()
  readonly records: ReturnType<typeof recordKeeper>
  constructor(private readonly deps: FilerDeps) {
    this.records = recordKeeper(deps.store)
  }

  private async failed(projectId: string, why: string): Promise<void> {
    const text = `This recording is kept on this computer, but it could not be filed: ${why.replace(/\.$/, '')}.`
    this.deps.onState(projectId, { projectId, fraction: 0, step: 'Not filed', failed: text })
    await this.records.update(projectId, (r) => ({ ...r, state: 'failed', failed: text })).catch(() => undefined)
  }

  /** A take opened at Stop: kept for Try again, held by this page, and filed. */
  async start(take: FinishedTake, projectId: string, title: string): Promise<void> {
    this.takes.set(projectId, { take, title })
    await this.deps.leases.hold(take.sessionId)
    // Words that came between Stop and the record being kept: into it now (they reached only memory until then).
    const early = this.words.get(take.sessionId)
    if (early?.length) await this.heard(take.sessionId, early)
    else if (this.heardNothing.has(take.sessionId)) await this.nothingHeard(take.sessionId)
    await this.file(projectId, false)
  }

  /**
   * File this run's take under its video id: upload (`whole`: every file again from the computer, under fresh uploads,
   * after the Studio refused what it had), hand it over, follow it until made.
   */
  private async file(projectId: string, whole: boolean): Promise<void> {
    const kept = this.takes.get(projectId)
    if (!kept || this.running.has(projectId)) return
    this.running.add(projectId)
    const { take, title } = kept
    try {
      this.deps.onState(projectId, { projectId, fraction: 0, step: 'Uploading the recording' })
      const keys = await this.deps.uploadTake(take, whole, (fraction) => this.deps.onState(projectId, { projectId, fraction: 0.85 * fraction, step: 'Uploading the recording' }))
      const late = take.transcript?.words.length ? null : this.words.get(take.sessionId)
      const body = { ...recordingRequest(take, keys, { kind: 'new' }, title), projectId, ...(late?.length ? { transcript: wordsBody(late) } : {}) }
      const first = await this.deps.api.post<RecordingAnswer>(`${STUDIO_API}/recordings?wait=1`, body)
      await this.follow(projectId, first.recording.id, first, late?.length ? true : undefined)
    } catch (cause) {
      await this.failed(projectId, errorText(cause))
    } finally {
      this.running.delete(projectId)
    }
  }

  /** Follow a handed-over recording until made (or failed). */
  private async follow(projectId: string, recordingId: string, first?: RecordingAnswer, wordsSent?: boolean): Promise<void> {
    // A new recording (the one before failed and the take was made again): its words are owed to it afresh.
    const fresh = (r: ProvisionalRecord) => (r.recordingId && r.recordingId !== recordingId) || (!r.recordingId && (r.wordsMisses || r.wordsRefused))
    await this.records.update(projectId, (r) => ({ ...r, ...(fresh(r) ? { wordsSent: undefined, wordsRefused: undefined, wordsMisses: undefined } : {}), recordingId, ...(wordsSent ? { wordsSent } : {}) })).catch(() => undefined)
    this.wordsStopped.delete(projectId)
    void this.ensureWords(projectId)
    let answer = first
    let failures = 0
    while (this.deps.alive()) {
      if (answer) {
        const view = answer.recording
        if (view.status === 'done') {
          // Made into its draft's video, or (brought back elsewhere first) into another: adopted under the Studio's id.
          const filedAs = view.projectId && view.projectId !== projectId ? view.projectId : undefined
          await this.records.update(projectId, (r) => ({ ...r, state: 'filed', failed: undefined, ...(filedAs ? { filedAs } : {}) })).catch(() => undefined)
          this.deps.onState(projectId, null)
          this.deps.onFiled(projectId, recordingId)
          return
        }
        if (view.status === 'failed') {
          // Never followed again: Try again makes it from a fresh copy (brought back, or uploaded whole).
          await this.records.update(projectId, (r) => ({ ...r, recordingId: null })).catch(() => undefined)
          throw new RecordingFailed(view.error ?? 'the Studio could not make it')
        }
        this.deps.onState(projectId, { projectId, fraction: 0.85 + 0.15 * view.progress, step: 'Filing the recording' })
      }
      await this.deps.sleep(1500)
      try {
        answer = await this.deps.api.get<RecordingAnswer>(recordingUrl(recordingId))
        failures = 0
      } catch (cause) {
        answer = undefined
        if (++failures > 20) throw cause
      }
    }
  }

  /**
   * A record found again (a reload, a restart, another window let go): followed when it was handed over; else what
   * reached no page is sent first (its last pieces), and the take is brought back from the Studio under its video id;
   * a take that never reached the Studio is filed whole from the computer. Held by this page, or left to the window
   * that holds it (false).
   */
  async resume(record: ProvisionalRecord): Promise<boolean> {
    if (!(await this.deps.leases.hold(record.sessionId))) return false
    // Words that came while no page listened are kept beside the take (words.json), whatever the take's state: a filed
    // or adopted take's words still go to its recording. Nothing heard and nothing still being read: nothing to wait for.
    if (!record.heard?.length && !record.wordsSent && typeof this.deps.native.words === 'function') {
      void Promise.resolve(this.deps.native.words(record.sessionId)).then(async (answer) => {
        const said = (answer ?? null) as { transcript?: unknown; pending?: unknown } | null
        if (said?.transcript) await this.heardRaw(record.sessionId, said.transcript)
        if (said?.pending === false) await this.records.update(record.projectId, (r) => (r.heard?.length || !r.take?.wordsPending ? r : { ...r, take: { ...r.take, wordsPending: false } }))
      }).catch(() => undefined)
    }
    // Words not yet on the Studio go now, whatever the take's state.
    void this.ensureWords(record.projectId)
    if (record.state === 'adopted') {
      // The edit is on the Studio: only the files are left, and they go once the Studio holds every byte of them.
      void this.release(record.projectId).then((settled) => { if (!settled.safe && settled.note) this.deps.onKept?.(record.projectId, settled.note) })
      return true
    }
    if (record.state === 'filed') {
      if (record.recordingId) this.deps.onFiled(record.projectId, record.recordingId)
      return true
    }
    if (record.state === 'failed') {
      this.deps.onState(record.projectId, { projectId: record.projectId, fraction: 0, step: 'Not filed', failed: record.failed ?? 'Not filed.' })
      return true
    }
    void this.bringBack(record.projectId)
    return true
  }

  private async bringBack(projectId: string): Promise<void> {
    if (this.running.has(projectId)) return
    this.running.add(projectId)
    try {
      for (let round = 0; this.deps.alive(); round++) {
        const record = await this.deps.store.get(projectId)
        if (!record) return
        if (record.recordingId) {
          this.deps.onState(projectId, { projectId, fraction: 0.85, step: 'Filing the recording' })
          await this.follow(projectId, record.recordingId)
          return
        }
        if (!record.takeId) {
          // Never reached the Studio (no connection while it recorded): the whole take goes up from the computer.
          if (!record.take) throw new Error('it never reached the Studio')
          const trace = record.assets.find((asset) => (asset.provenance as { role?: unknown } | undefined)?.role === 'screen')?.trace ?? null
          this.takes.set(projectId, { take: { ...record.take, trace, transcript: record.heard?.length ? { words: record.heard } : record.take.transcript }, title: record.title })
          this.running.delete(projectId)
          await this.file(projectId, true)
          return
        }
        if (round >= BRING_BACK_ROUNDS) throw new Error('the Studio has not taken the rest of it yet. Check the connection, then try again')
        this.deps.onState(projectId, { projectId, fraction: 0.85, step: 'Sending the rest of the recording' })
        // Its last pieces first: a take brought back before they arrive would be made from less than was recorded.
        await this.deps.sendUnfinished().catch(() => 0)
        const local = await localTracks(this.deps.native, record.sessionId)
        const sha256 = Object.fromEntries((local ?? []).map((t) => [studioRole(t.role), t.sha256]))
        try {
          const answer = await this.deps.api.post<RecordingAnswer>(`${STUDIO_API}/live-takes/${encodeURIComponent(record.takeId)}/recover`, { projectId, ...(Object.keys(sha256).length ? { sha256 } : {}) })
          await this.follow(projectId, answer.recording.id, answer)
          return
        } catch (cause) {
          // Still arriving from this computer, or no connection: tried again for a while. Anything else is said.
          if (cause instanceof RecordingFailed) throw cause
          if ((cause as { code?: string }).code !== 'STILL_RECORDING' && !onlyTheConnection(cause)) throw cause
        }
        await this.deps.sleep(15_000)
      }
    } catch (cause) {
      await this.failed(projectId, errorText(cause))
    } finally {
      this.running.delete(projectId)
    }
  }

  /**
   * Try again: this run's take is sent again whole (every file under a fresh upload: what the Studio had may be what
   * it refused); a take this run does not have is brought back as after a restart.
   */
  async refile(projectId: string): Promise<void> {
    let record = await this.records.update(projectId, (r) => ({ ...r, state: 'filing', failed: undefined })).catch(() => null)
    if (!record) return
    if (record.recordingId) {
      // Handed over: followed again while the Studio is still making it (or no answer now); made again from a fresh
      // copy only when its recording failed.
      const view = await this.deps.api.get<RecordingAnswer>(recordingUrl(record.recordingId)).then((a) => a.recording, () => null)
      if (view?.status !== 'failed') return this.bringBack(projectId)
      record = await this.records.update(projectId, (r) => ({ ...r, recordingId: null })).catch(() => null)
      if (!record) return
    }
    if (this.takes.has(projectId)) return this.file(projectId, true)
    await this.bringBack(projectId)
  }

  /**
   * The app's words event (or its kept words.json): moved onto the screen's clock with the take's own shift. The app sends
   * one event per take, with no words (null) when it heard nothing, its model failed or ran out of time: nothing is left
   * to wait for then.
   */
  async heardRaw(sessionId: string, transcript: unknown, shiftMs?: number): Promise<void> {
    const record = (await this.deps.store.list().catch(() => [] as ProvisionalRecord[])).find((r) => r.sessionId === sessionId)
    const shift = shiftMs ?? this.takeOf(sessionId)?.wordsShiftMs ?? record?.take?.wordsShiftMs ?? 0
    const words = wordsOnScreenClock(transcript, shift)
    if (words.length) await this.heard(sessionId, words, record)
    else await this.nothingHeard(sessionId, record)
  }

  /** The app's `studio-recorder://words` event, as it comes (`transcript` null when the recorder heard nothing). */
  wordsEvent(event: { sessionId?: unknown; transcript?: unknown } | null | undefined): Promise<void> {
    return typeof event?.sessionId === 'string' ? this.heardRaw(event.sessionId, event.transcript ?? null) : Promise.resolve()
  }

  /** The recorder heard nothing: the record waits for no words (only the page that holds the take writes it). */
  private async nothingHeard(sessionId: string, known?: ProvisionalRecord): Promise<void> {
    if (!this.deps.leases.holds(sessionId)) return
    this.heardNothing.add(sessionId)
    const record = known ?? (await this.deps.store.list().catch(() => [] as ProvisionalRecord[])).find((r) => r.sessionId === sessionId)
    if (!record) return
    await this.records.update(record.projectId, (r) => (r.heard?.length || !r.take?.wordsPending ? r : { ...r, take: { ...r.take, wordsPending: false } })).catch(() => undefined)
  }

  private takeOf(sessionId: string): FinishedTake | undefined {
    for (const kept of this.takes.values()) if (kept.take.sessionId === sessionId) return kept.take
    return undefined
  }

  /** The Mac's words arrived (after Stop): into the record, to the editor, and to the Studio once it has the recording. */
  async heard(sessionId: string, words: TakeWord[], known?: ProvisionalRecord): Promise<void> {
    // Only the page that holds the take takes its words in (the event reaches every window): one writer of its draft.
    if (!words.length || !this.deps.leases.holds(sessionId)) return
    this.words.set(sessionId, words)
    const record = known ?? (await this.deps.store.list().catch(() => [] as ProvisionalRecord[])).find((r) => r.sessionId === sessionId)
    if (!record) return
    await this.records.update(record.projectId, (r) => {
      return { ...r, base: withWords(r.base, r.assets, r, words), draft: withWords(r.draft, r.assets, r, words), heard: words }
    }).catch(() => undefined)
    this.deps.onWords?.(record.projectId, words)
    void this.ensureWords(record.projectId)
  }

  /**
   * The words reach the Studio once, on the recording (made or not): tried again (the Studio busy making it, no
   * connection) until they are sent, while the page is open; again at the next resume otherwise.
   */
  async ensureWords(projectId: string): Promise<void> {
    if (this.sendingWords.has(projectId)) return
    this.sendingWords.add(projectId)
    try {
      for (let attempt = 0; this.deps.alive(); attempt++) {
        const record = await this.deps.store.get(projectId).catch(() => null)
        const words = record ? (this.words.get(record.sessionId) ?? record.heard) : undefined
        // Nothing to send, sent already or refused for good, or not handed over yet (they go with the recording then).
        if (!record?.recordingId || record.wordsSent || record.wordsRefused || this.wordsStopped.has(projectId) || !words?.length) return
        try {
          await this.deps.api.post(`${recordingUrl(record.recordingId)}/words`, wordsBody(words))
          const sent = await this.records.update(projectId, (r) => ({ ...r, wordsSent: true }))
          // An adopted take whose files waited for its words: they may go now.
          if (sent?.state === 'adopted' && !sent.saveOwed && this.deps.leases.holds(sent.sessionId)) void this.release(projectId).then((settled) => { if (!settled.safe && settled.note) this.deps.onKept?.(projectId, settled.note) })
          return
        } catch (cause) {
          const refusal = wordsRefusal(cause)
          // Missing here: this page stops (and does not wait on them again); a few launches in a row make it final.
          if (refusal === 'missing') {
            this.wordsStopped.add(projectId)
            const counted = await this.records.update(projectId, (r) => ({ ...r, wordsMisses: (r.wordsMisses ?? 0) + 1 })).catch(() => null)
            if ((counted?.wordsMisses ?? 0) < WORDS_MISSES_FOR_GOOD) return
          }
          // The Studio's own no (another person's, words it cannot read, or missing every time): never asked again, said once.
          if (refusal) {
            const before = record.wordsRefused
            await this.records.update(projectId, (r) => ({ ...r, wordsRefused: true })).catch(() => undefined)
            if (!before) this.deps.onWordsDropped?.(projectId, `The words the Mac heard could not be added to this recording's video (${errorText(cause)}). You can transcribe it from the Words tab.`)
            return
          }
          await this.deps.sleep(WORD_RETRIES_MS[Math.min(attempt, WORD_RETRIES_MS.length - 1)]!)
        }
      }
    } finally {
      this.sendingWords.delete(projectId)
    }
  }

  /**
   * Wait (at most `limitMs`) until the words the Mac is still reading have come and reached the Studio, so the edit
   * carried on from the Studio's copies has them: true when nothing is left to wait for.
   */
  async wordsSettled(projectId: string, limitMs: number, every = 1000): Promise<boolean> {
    for (let waited = 0; ; waited += every) {
      const record = await this.deps.store.get(projectId).catch(() => null)
      if (!record) return true
      const waiting = record.wordsRefused || this.wordsStopped.has(projectId) ? false : record.heard?.length ? !record.wordsSent : !!record.take?.wordsPending && !record.wordsSent
      if (!waiting) return true
      if (waited >= limitMs || !this.deps.alive()) return false
      await this.deps.sleep(every)
    }
  }

  /**
   * The editor has carried on from the Studio's copies (and saved over the Studio's edit when it was changed): the take's
   * files go once the Studio holds every byte of them, else they stay and `note` says why.
   */
  async release(projectId: string, options: { anyway?: boolean } = {}): Promise<Settled> {
    // Read after every change already asked of the record (a save that just landed clears `saveOwed`).
    const record = await this.records.update(projectId, (r) => r).catch(() => null)
    if (!record?.recordingId) return { safe: false, note: 'The recording is not filed yet: its files are kept on this computer.' }
    // Only once the edit is on the Studio: a filed take's record is its edit, and it goes with the folder. Asked anyway
    // (the person chose to let go of a take whose video changed elsewhere): noted as settled, and let go as any other.
    if (record.state !== 'adopted' && !(options.anyway && record.state === 'filed')) return { safe: false, note: 'Your edits are not on the video yet, so this recording and its edits are kept on this computer.' }
    // The Mac's words still on their way (kept beside the take, in words.json): the files wait for them.
    if (wordsOwed(record)) return { safe: false, note: 'The words the Mac heard have not reached the Studio yet, so this recording is kept on this computer until they do.' }
    if (record.state === 'filed') await this.records.update(projectId, (r) => ({ ...r, state: 'adopted', saveOwed: undefined })).catch(() => undefined)
    // Adopted in the open editor, its edits not saved over the Studio's yet: kept until they are (or the person, told to
    // check the video, lets go anyway).
    if (record.saveOwed && !options.anyway) return { safe: false, note: 'Your last edits to this recording are not saved onto its video yet, so its files are kept on this computer.' }
    const settled = await releaseWhenSafe(this.deps, record.recordingId, record.sessionId)
    if (settled.safe) {
      this.takes.delete(projectId)
      await this.deps.leases.release(record.sessionId)
    }
    return settled
  }
}
