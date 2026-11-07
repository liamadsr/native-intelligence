/**
 * The desktop relay (l1-contract E; docs/plans/local-agents.md "The full
 * build"): the main window's link between this Mac's local agents (Rust,
 * through `tauriBridge.localAgent`) and the server (`/api/local-agent/*`).
 *
 * Pure and dependency-injected (fetch, the bridge, a clock), so it is unit
 * tested with fakes and a Node e2e script can drive the real launcher with
 * `runHeadlessRelay()`. The React side (src/hooks/use-local-agent-relay.ts)
 * adds only the doorbell subscription and the focus / online triggers.
 *
 * - **Heartbeat** (at start, then every 60 s): `local_agent_device` + status
 *   → POST /device with the grants (the server's read-only mirror) and the
 *   live job ids (their leases: a long tool call sends no events).
 * - **Pending** (doorbell, 5 s poll, focus): GET /device/pending, then
 *   - start: claim (CAS; a 409 is skipped) → `local_agent_start` with the
 *     session id as the job id and the claim's mode, token, resume and, for
 *     an edit job on a desktop that resolves one, its base branch (E3). A
 *     grant Rust doesn't hold, or an edit on a read grant, reports `failed`;
 *   - messages: prefixed `[From the Dial8 agent]` / `[From <first name>]`
 *     (the local agent's instructions), sent to the live job, resumed first
 *     when no launcher runs it, then acked;
 *   - stops: `local_agent_stop`, or `cancelled` for a job no launcher runs.
 *   Drains are serialized and a claimed session cools down, so duplicate
 *   doorbells coalesce and never claim twice.
 * - **Events**: each session job's `local-agent://event` is batched (500 ms
 *   or 50 events, at most 200 per call) into POST /sessions/[id]/events with
 *   its runId. The server ignores a (session, runId, seq) it has, so retries
 *   and gap-fill overlaps are harmless.
 * - **Gap-fill** (at start and on reconnect): for each Rust job that is live
 *   or holds events, the server's last stored (runId, seq) →
 *   `local_agent_events` → the missing tail ({@link gapEntries}).
 * - **State**: the eve session id and stream cursor live in Rust and reach
 *   the page only through status, so a status event (debounced) or the
 *   heartbeat posts them to /sessions/[id]/state when they change. Process
 *   exits travel as status events. After a reload, a job Rust no longer runs
 *   that the server thinks is working is corrected ({@link reconcileStatus}).
 * - **Runs**: the claim must name a run before Rust has made one (start needs
 *   the claim's token), so it sends a provisional id; once Rust answers its
 *   real run (start, or a resume), /state `{runId, previousRunId}` rebinds
 *   the server (only the session's current run may derive state). A job's
 *   uploads wait until a rebind answers `applied: true` (retried with
 *   backoff, never released on a failure).
 * - **Capacity**: Rust parks an idle launcher to make room, so only busy
 *   (starting / running) jobs count against its 3; a parked job revives
 *   through resume-then-send. A send Rust refuses for now ("try again") is
 *   retried (three tries over ~10 s) before its ack fails; a message always
 *   fits Rust's 16 KiB with its prefix.
 * - **Model token**: refreshed at 75% of its life while the job is live, and
 *   at once for a live job found after a reload (its age is unknown).
 */

import type {
  LocalAgentDevice,
  LocalAgentEvent,
  LocalAgentEventEnvelope,
  LocalAgentJob,
  LocalAgentJobStatus,
  LocalAgentMode,
  LocalAgentPolicy,
  LocalAgentResult,
  LocalAgentResumeArgs,
  LocalAgentRun,
  LocalAgentStartArgs,
  LocalAgentStatus,
} from '@/lib/tauri-bridge'
import { isBaseBranch } from '@/lib/environments/types'

// ── Tunables ────────────────────────────────────────────────────────────────

export const HEARTBEAT_MS = 60_000
export const POLL_MS = 5_000
/** Events wait at most this long, or until BATCH_MAX are pending. */
export const BATCH_MS = 500
export const BATCH_MAX = 50
/** The events route takes at most this many per call. */
export const UPLOAD_MAX = 200
export const TOKEN_REFRESH_FRACTION = 0.75
/** A token whose expiry can't be read is assumed to live this long (tokens.ts). */
export const TOKEN_TTL_FALLBACK_MS = 2 * 60 * 60_000
const TOKEN_RETRY_MS = 60_000
const TOKEN_MIN_DELAY_MS = 5_000
/** Rust runs at most this many BUSY launchers (MAX_RUNNING). It parks an
 *  idle one to make room (live: false, waiting, session kept: a message
 *  resumes it), so only starting / running jobs count; more stay queued. */
export const MAX_BUSY_JOBS = 3
/** Rust's longest request or message (MAX_TEXT_BYTES), in UTF-8 bytes. The
 *  server caps a message below it (LOCAL_AGENT_MESSAGE_MAX_BYTES), leaving room
 *  for the `[From …] ` prefix; the relay still never sends more. */
export const RUST_TEXT_MAX_BYTES = 16 * 1024
/** A send Rust refuses for now ("…; try again") is retried after these, then failed: three tries over ~10 s. */
export const SEND_RETRY_MS = [2_000, 8_000] as const
/** A run rebind that didn't land is retried after these (the last repeats). */
export const REBIND_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const
/** A session just claimed (or refused with 409) isn't claimed again for this long. */
export const CLAIM_COOLDOWN_MS = 15_000
/** A claimed start Rust refused for now ("try again": another coding agent's
 *  confirm is up on the Mac) is tried again after these, inside the claim's
 *  2-minute lease, then failed. Off the drain only. */
export const START_RETRY_MS = [5_000, 15_000, 30_000, 60_000] as const
const UPLOAD_RETRY_MS = [2_000, 5_000, 15_000, 30_000] as const
const STATE_SYNC_MS = 300
const STOP_RETRY_MS = 15_000

const API = '/api/local-agent'

export const GRANT_GONE = 'This folder is no longer granted on your Mac.'
export const GRANT_READ_ONLY = 'This folder is read-only on your Mac, so the local agent can’t make changes in it.'
export const NO_LOCAL_JOB = 'Your Mac no longer has this local agent, so the message couldn’t reach it.'
const START_FAILED = 'The local agent couldn’t start on your Mac.'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** What the events route accepts as a kind (device.ts sanitizeEvent). */
const UPLOADABLE_KIND = /^[a-z_]{1,40}$/

// ── Dependencies ────────────────────────────────────────────────────────────

/** The part of `tauriBridge.localAgent` the relay uses. */
export interface RelayBridge {
  device(): Promise<LocalAgentResult<LocalAgentDevice>>
  status(): Promise<LocalAgentStatus>
  start(args: LocalAgentStartArgs): Promise<LocalAgentResult<LocalAgentRun>>
  resume(
    jobId: string,
    modelToken?: string | null,
    localModel?: boolean | null,
    message?: { text: string; policy: LocalAgentPolicy } | null,
  ): Promise<LocalAgentResult<LocalAgentRun>>
  send(jobId: string, text: string, policy: LocalAgentPolicy): Promise<LocalAgentResult<void>>
  stop(jobId: string): Promise<LocalAgentResult<void>>
  events(jobId: string, sinceSeq: number): Promise<LocalAgentResult<LocalAgentEventEnvelope[]>>
  setModelToken(jobId: string, modelToken: string): Promise<LocalAgentResult<void>>
  onEvent(cb: (envelope: LocalAgentEventEnvelope) => void): () => void
}

export interface RelayClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: RelayClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface RelayDeps {
  /** `fetch` for a path under /api (the webview: its cookie session; Node: a base URL and auth). */
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  bridge: RelayBridge
  clock?: RelayClock
  /** The signed-in person's name, read at each message (`[From <first name>]`). */
  personName?: () => string | null | undefined
  /** The claim's provisional run id. */
  newRunId?: () => string
  log?: (line: string) => void
}

export interface DeviceFolder {
  id: string
  grantId: string
  label: string
  mode: LocalAgentMode
  isGit: boolean
}

export interface HeartbeatResult {
  /** The server ids of this Mac's granted folders. */
  folders: DeviceFolder[]
}

export interface LocalAgentRelay {
  /** Subscribe to the desktop's events, heartbeat, gap-fill, drain, and keep
   *  polling. False (and nothing running) when this desktop has no local agents. */
  start(): Promise<boolean>
  /** Drain pending work now (doorbell, focus). Coalesces with a running drain. */
  ring(): Promise<void>
  /** The connection came back: gap-fill every job, then drain. */
  reconnected(): Promise<void>
  /**
   * One heartbeat now; the folders' server ids, or null when it didn't land.
   * `rejoin`: a folder was just added on this Mac, which brings a removed Mac
   * back (migration 420's "Remove this Mac"); every other beat leaves it out.
   */
  heartbeat(opts?: { rejoin?: boolean }): Promise<HeartbeatResult | null>
  /** Upload every pending event now. */
  flushAll(): Promise<void>
  dispose(): void
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

export type SessionStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
  | 'expired'

const SESSION_STATUSES: readonly SessionStatus[] = [
  'queued',
  'starting',
  'running',
  'waiting',
  'cancelled',
  'failed',
  'interrupted',
  'expired',
]
/** The statuses a device may still write (device.ts DEVICE_WRITABLE). */
const DEVICE_WRITABLE: ReadonlySet<SessionStatus> = new Set(['starting', 'running', 'waiting', 'interrupted'])
const WORKING: ReadonlySet<SessionStatus> = new Set(['starting', 'running', 'waiting'])
const ACTIVE_JOB: ReadonlySet<LocalAgentJobStatus> = new Set(['starting', 'running', 'waiting'])

/** A launcher mid-turn (Rust won't park it). */
export function isBusy(job: Pick<LocalAgentJob, 'live' | 'status'>): boolean {
  return job.live && (job.status === 'starting' || job.status === 'running')
}

/** A device job status as the session's: `completed` is idle, so `waiting`. */
export function toSessionStatus(status: LocalAgentJobStatus): SessionStatus {
  return status === 'completed' ? 'waiting' : status
}

/**
 * What the server should be told about a job after a reload or relaunch, or
 * null. Only the cases events can't settle: the server thinks a job is
 * working that no launcher runs (the app quit: Rust marks it `interrupted` at
 * launch, or it died mid-turn), or thinks one interrupted that runs. A
 * `waiting` job without a launcher is parked (Rust freed its slot; the
 * session is kept and a message resumes it): idle, so `waiting`.
 */
export function reconcileStatus(
  job: Pick<LocalAgentJob, 'status' | 'live'>,
  server: SessionStatus,
): SessionStatus | null {
  if (!job.live && WORKING.has(server)) {
    const device =
      job.status === 'waiting' ? 'waiting' : ACTIVE_JOB.has(job.status) ? 'interrupted' : toSessionStatus(job.status)
    return device === server ? null : device
  }
  if (job.live && server === 'interrupted') return toSessionStatus(job.status)
  return null
}

export interface LastDeviceSeq {
  runId: string
  seq: number
}

/** The `sinceSeq` to read the desktop's ring from for a gap-fill: the
 *  server's mark when the job is still on that run, else everything. */
export function sinceSeqFor(job: Pick<LocalAgentJob, 'runId'> | undefined, last: LastDeviceSeq | null): number {
  return job?.runId && last && last.runId === job.runId ? last.seq : 0
}

/**
 * The gap: the ring's events the server doesn't have. `seq` is monotonic per
 * job within an app run, across its runs, so when the ring still holds the
 * server's last run, everything after its seq is new. Otherwise the server's
 * mark is from an earlier app run (the ring restarted at 1) or fell out of
 * the ring: upload all of it, and the server drops what it has.
 */
export function gapEntries(
  entries: readonly LocalAgentEventEnvelope[],
  last: LastDeviceSeq | null,
): LocalAgentEventEnvelope[] {
  if (!last || !entries.some((e) => e.runId === last.runId)) return entries.slice()
  return entries.filter((e) => e.seq > last.seq)
}

/** The first word of a name, safe inside the `[From …]` prefix; null when there isn't one. */
export function firstNameForPrefix(name: string | null | undefined): string | null {
  // No brackets or control characters: a name must not close the prefix early.
  const first = (name ?? '').replace(/[[\]\p{Cc}]/gu, ' ').trim().split(/\s+/)[0] ?? ''
  if (!first || first.includes('@') || first.length > 24 || !/\p{L}/u.test(first)) return null
  return first
}

/** UTF-8 length of a string, without allocating. */
export function utf8Bytes(text: string): number {
  let n = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

/** `text` in at most `max` UTF-8 bytes: cut on a character, with an ellipsis. */
export function fitUtf8(text: string, max: number): string {
  if (utf8Bytes(text) <= max) return text
  const room = Math.max(0, max - 3) // '…' is 3 bytes
  let out = ''
  let used = 0
  for (const ch of text) {
    const n = utf8Bytes(ch)
    if (used + n > room) break
    out += ch
    used += n
  }
  return `${out}…`
}

/** The text a local agent gets: who sent it, then the message
 *  (agents/local-agent/instructions.md), within Rust's byte cap. */
export function prefixMessage(author: 'agent' | 'person', text: string, personName?: string | null): string {
  const who = author === 'person' ? (firstNameForPrefix(personName) ?? 'the person') : 'the Dial8 agent'
  const prefix = `[From ${who}] `
  return prefix + fitUtf8(text, RUST_TEXT_MAX_BYTES - utf8Bytes(prefix))
}

/** Rust refused a send for now (its queue is full): worth another try. */
export function isTransientSendError(error: string): boolean {
  return /\btry again\b/i.test(error)
}

/** A model token's expiry (ms): the server's `expiresAt` when given, else
 *  the `exp` inside an `la1.<payload>.<mac>` token; null when neither reads. */
export function tokenExpiresAt(token: string, hint?: unknown): number | null {
  if (typeof hint === 'string') {
    const t = Date.parse(hint)
    if (Number.isFinite(t)) return t
  }
  if (typeof hint === 'number' && Number.isFinite(hint)) return hint < 1e11 ? hint * 1000 : hint
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { exp?: unknown }
    return typeof json.exp === 'number' && Number.isFinite(json.exp) ? json.exp * 1000 : null
  } catch {
    return null
  }
}

/** When to refresh a token received at `receivedAt`: at 75% of its life. */
export function tokenRefreshDelay(receivedAt: number, expiresAt: number): number {
  return Math.max(TOKEN_MIN_DELAY_MS, Math.floor((expiresAt - receivedAt) * TOKEN_REFRESH_FRACTION))
}

/** The event as the desktop sent it: an `other` goes back out as its raw object. */
export function wireEvent(event: LocalAgentEvent): Record<string, unknown> {
  return event.kind === 'other' ? event.raw : event
}

export interface PendingEvent {
  seq: number
  runId: string | null
  event: Record<string, unknown>
}

/** The next upload: from the lowest seq, the events of one run (a call
 *  carries one runId), at most `max`. Null when there's no run to name. */
export function nextUploadChunk(
  sorted: readonly PendingEvent[],
  fallbackRunId: string | null,
  max: number,
): { runId: string; events: PendingEvent[] } | null {
  const first = sorted[0]
  const runId = first?.runId ?? fallbackRunId
  if (!first || !runId) return null
  const events: PendingEvent[] = []
  for (const e of sorted) {
    if ((e.runId ?? fallbackRunId) !== runId || events.length >= max) break
    events.push(e)
  }
  return { runId, events }
}

/**
 * POST /device's body: the device, its grants, the jobs Rust runs now, what
 * this desktop says it can do (`capabilities`: `baseBranch` when its status
 * says so, environments E3), and `rejoin` after a folder was added here.
 */
export function heartbeatBody(
  device: LocalAgentDevice,
  status: Pick<LocalAgentStatus, 'grants' | 'jobs' | 'baseBranch'>,
  ignored: ReadonlySet<string> = new Set(),
  rejoin = false,
): Record<string, unknown> {
  return {
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    appVersion: device.appVersion,
    grants: status.grants.map((g) => ({ grantId: g.id, label: g.label, path: g.path, mode: g.mode, isGit: g.isGit })),
    liveJobIds: status.jobs.filter((j) => j.live && UUID_RE.test(j.id) && !ignored.has(j.id)).map((j) => j.id),
    capabilities: status.baseBranch === true ? ['baseBranch'] : [],
    ...(rejoin ? { rejoin: true } : {}),
  }
}

// ── Server shapes, read defensively ─────────────────────────────────────────

interface PendingStart {
  sessionId: string
  grantId: string
  mode: LocalAgentMode
  request: string
  resume: LocalAgentResumeArgs | null
}

interface PendingMessage {
  id: string
  sessionId: string
  text: string
  policy: LocalAgentPolicy
  author: 'agent' | 'person'
}

interface Claim {
  grantId: string
  mode: LocalAgentMode
  request: string
  modelToken: string | null
  modelTokenExpiresAt: unknown
  resume: LocalAgentResumeArgs | null
  /** The model the server recorded the session on (null: an older server). */
  localModel: boolean | null
  /** An edit job's base branch (E3), a local branch name; null: HEAD (and an older server). */
  baseBranch: string | null
}

interface ServerSession {
  status: SessionStatus | null
  /** undefined: the server doesn't say. */
  runId: string | null | undefined
  lastDeviceSeq: LastDeviceSeq | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

function toResume(v: unknown): LocalAgentResumeArgs | null {
  if (!isRecord(v)) return null
  const eveSessionId = str(v.eveSessionId)
  const streamIndex = typeof v.streamIndex === 'number' && Number.isInteger(v.streamIndex) && v.streamIndex >= 0 ? v.streamIndex : 0
  return eveSessionId ? { eveSessionId, streamIndex } : null
}

function parsePending(body: unknown): { start: PendingStart[]; messages: PendingMessage[]; stops: string[] } {
  const b = isRecord(body) ? body : {}
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : [])
  const start: PendingStart[] = []
  for (const s of list(b.start)) {
    const sessionId = str(s.sessionId)
    const grantId = str(s.grantId)
    const request = str(s.request)
    if (!sessionId || !grantId || !request) continue
    start.push({ sessionId, grantId, request, mode: s.mode === 'edit' ? 'edit' : 'read', resume: toResume(s.resume) })
  }
  const messages: PendingMessage[] = []
  for (const m of list(b.messages)) {
    const id = str(m.id)
    const sessionId = str(m.sessionId)
    if (!id || !sessionId || typeof m.text !== 'string') continue
    messages.push({
      id,
      sessionId,
      text: m.text,
      policy: m.policy === 'queue' ? 'queue' : 'steer',
      // The column is NOT NULL; anything else is the Dial8 agent's (never the person's name on another's words).
      author: m.author === 'person' ? 'person' : 'agent',
    })
  }
  const stops = list(b.stops)
    .map((s) => str(s.sessionId))
    .filter((id): id is string => id !== null)
  return { start, messages, stops }
}

function parseClaim(body: unknown, pending: PendingStart): Claim {
  const b = isRecord(body) ? body : {}
  return {
    grantId: str(b.grantId) ?? pending.grantId,
    mode: b.mode === 'edit' ? 'edit' : b.mode === 'read' ? 'read' : pending.mode,
    request: str(b.request) ?? pending.request,
    modelToken: str(b.modelToken),
    modelTokenExpiresAt: b.modelTokenExpiresAt,
    resume: 'resume' in b ? toResume(b.resume) : pending.resume,
    localModel: typeof b.localModel === 'boolean' ? b.localModel : null,
    // The server's pattern again (the Mac checks it a third time): a name, never a ref expression.
    baseBranch: isBaseBranch(b.baseBranch) ? b.baseBranch : null,
  }
}

function parseSession(body: unknown): ServerSession | null {
  const s = isRecord(body) && isRecord(body.session) ? body.session : null
  if (!s) return null
  const last = isRecord(s.lastDeviceSeq) ? s.lastDeviceSeq : null
  const lastRun = last ? str(last.runId) : null
  return {
    status: SESSION_STATUSES.includes(s.status as SessionStatus) ? (s.status as SessionStatus) : null,
    runId: 'runId' in s ? str(s.runId) : undefined,
    lastDeviceSeq:
      last && lastRun && typeof last.seq === 'number' && Number.isInteger(last.seq) ? { runId: lastRun, seq: last.seq } : null,
  }
}

function parseFolders(body: unknown): DeviceFolder[] {
  const list = isRecord(body) && Array.isArray(body.folders) ? body.folders.filter(isRecord) : []
  const out: DeviceFolder[] = []
  for (const f of list) {
    const id = str(f.id)
    const grantId = str(f.grantId)
    if (!id || !grantId) continue
    out.push({ id, grantId, label: str(f.label) ?? '', mode: f.mode === 'edit' ? 'edit' : 'read', isGit: f.isGit === true })
  }
  return out
}

function defaultRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  // Very old engines only; the server needs a token, not a perfect uuid.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ── The relay ───────────────────────────────────────────────────────────────

/** One server session's job on this Mac. */
interface Track {
  jobId: string
  /** Rust's run for the job as last seen: the runId of an event that has none. */
  runId: string | null
  /** The run the server holds as the session's current one. */
  serverRunId: string | null
  /** Settles when uploads may go (a gap-fill read, or a start / resume and its rebind). */
  ready: Promise<void>
  pending: Map<number, PendingEvent>
  /** Every seq at or below this is on the server. */
  uploadedThrough: number
  uploading: Promise<void> | null
  batchTimer: unknown
  retryTimer: unknown
  retries: number
  stateTimer: unknown
  tokenTimer: unknown
  sentSession: string | null
  sentStream: number | null
  /** The rebind in flight (uploads hold until it lands). */
  rebinding: { runId: string; done: Promise<void> } | null
  rebindTimer: unknown
  /** A run the session can no longer take (it settled): never rebound again. */
  unbindableRunId: string | null
  /** Not a session of this person (a dev-page job, or deleted): ignored. */
  gone: boolean
}

interface DrainCtx {
  status: LocalAgentStatus
  /** Jobs started or resumed during this drain (status is older). */
  live: Set<string>
}

interface CallResult {
  status: number
  ok: boolean
  body: unknown
}

/** The relay a mounted window runs; `refreshLocalAgentDevice` goes through it. */
let activeRelay: LocalAgentRelay | null = null

export function createLocalAgentRelay(deps: RelayDeps): LocalAgentRelay {
  const clock = deps.clock ?? systemClock
  const newRunId = deps.newRunId ?? defaultRunId
  const log = deps.log ?? (() => {})
  const bridge = deps.bridge

  const tracks = new Map<string, Track>()
  const ignored = new Set<string>()
  const claiming = new Set<string>()
  const claimCooldown = new Map<string, number>()
  const delivering = new Set<string>()
  /** Messages handed to Rust: never sent twice, whatever pending still says. */
  const delivered = new Set<string>()
  const unacked = new Map<string, { ok: boolean; error?: string }>()
  /** Messages Rust refused for now: tries so far and when the next falls due. */
  const sendRetries = new Map<string, { attempts: number; at: number }>()
  const wakeTimers = new Set<unknown>()
  const stopIssued = new Map<string, number>()
  /** Idle jobs (no launcher, no ring) already read once for reconcileStatus. */
  const reconciledOnce = new Set<string>()
  /** Sessions whose start or revival waits on the person (a coding agent's
   *  confirm on the Mac, up to 2 minutes): run off the drain, so nobody
   *  else's stops and messages wait behind it. */
  const detached = new Set<string>()
  /** Stops for sessions being claimed: carried out once the start lands. */
  const stopWanted = new Set<string>()

  let device: LocalAgentDevice | null = null
  let disposed = false
  let active = false
  let unlisten: (() => void) | null = null
  let pollTimer: unknown = null
  let heartbeatTimer: unknown = null
  let draining: Promise<void> | null = null
  let drainAgain = false

  const clear = (handle: unknown) => {
    if (handle !== null && handle !== undefined) clock.clearTimeout(handle)
  }

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<CallResult> {
    try {
      const res = await deps.fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let parsed: unknown = null
      try {
        parsed = await res.json()
      } catch {
        /* an empty or non-JSON body */
      }
      return { status: res.status, ok: res.ok, body: parsed }
    } catch {
      return { status: 0, ok: false, body: null }
    }
  }

  const postState = (jobId: string, body: Record<string, unknown>) =>
    call('POST', `${API}/sessions/${jobId}/state`, body)

  async function getDevice(): Promise<LocalAgentDevice | null> {
    if (device) return device
    const r = await bridge.device()
    if (r.ok) device = r.value
    return device
  }

  // ── Tracks ──

  function newTrack(jobId: string): Track {
    const track: Track = {
      jobId,
      runId: null,
      serverRunId: null,
      ready: Promise.resolve(),
      pending: new Map(),
      uploadedThrough: 0,
      uploading: null,
      batchTimer: null,
      retryTimer: null,
      retries: 0,
      stateTimer: null,
      tokenTimer: null,
      sentSession: null,
      sentStream: null,
      rebinding: null,
      rebindTimer: null,
      unbindableRunId: null,
      gone: false,
    }
    tracks.set(jobId, track)
    return track
  }

  /** Hold the track's uploads until the returned release is called. */
  function hold(track: Track): () => void {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const prev = track.ready
    track.ready = prev.then(() => gate)
    return release
  }

  function markGone(track: Track) {
    track.gone = true
    track.pending.clear()
    clear(track.batchTimer)
    clear(track.retryTimer)
    clear(track.stateTimer)
    clear(track.tokenTimer)
    clear(track.rebindTimer)
    track.batchTimer = track.retryTimer = track.stateTimer = track.tokenTimer = track.rebindTimer = null
    ignored.add(track.jobId)
  }

  function raiseUploadedThrough(track: Track, seq: number) {
    if (seq <= track.uploadedThrough) return
    track.uploadedThrough = seq
    for (const s of track.pending.keys()) if (s <= seq) track.pending.delete(s)
  }

  // ── Events → uploads ──

  function onEnvelope(envelope: LocalAgentEventEnvelope) {
    if (disposed || ignored.has(envelope.jobId)) return
    if (!UUID_RE.test(envelope.jobId)) {
      ignored.add(envelope.jobId)
      return
    }
    const track = tracks.get(envelope.jobId) ?? adoptTrack(envelope.jobId)
    enqueue(track, envelope)
  }

  function enqueue(track: Track, envelope: LocalAgentEventEnvelope) {
    if (track.gone || envelope.seq <= track.uploadedThrough || track.pending.has(envelope.seq)) return
    const event = wireEvent(envelope.event)
    if (typeof event.kind !== 'string' || !UPLOADABLE_KIND.test(event.kind)) return
    track.pending.set(envelope.seq, { seq: envelope.seq, runId: envelope.runId ?? null, event })
    if (envelope.event.kind === 'status') scheduleStateSync(track)
    if (track.pending.size >= BATCH_MAX) void flush(track)
    else scheduleBatch(track)
  }

  function scheduleBatch(track: Track) {
    if (track.batchTimer !== null || track.retryTimer !== null) return
    track.batchTimer = clock.setTimeout(() => {
      track.batchTimer = null
      void flush(track)
    }, BATCH_MS)
  }

  function scheduleRetry(track: Track) {
    if (track.retryTimer !== null) return
    const ms = UPLOAD_RETRY_MS[Math.min(track.retries, UPLOAD_RETRY_MS.length - 1)]
    track.retries++
    track.retryTimer = clock.setTimeout(() => {
      track.retryTimer = null
      void flush(track)
    }, ms)
  }

  function flush(track: Track): Promise<void> {
    clear(track.batchTimer)
    track.batchTimer = null
    if (track.uploading) return track.uploading
    if (track.gone || track.pending.size === 0) return Promise.resolve()
    const run = (async () => {
      await track.ready
      while (track.pending.size > 0 && !track.gone && !disposed) {
        const sorted = [...track.pending.values()].sort((a, b) => a.seq - b.seq)
        const chunk = nextUploadChunk(sorted, track.runId ?? track.serverRunId, UPLOAD_MAX)
        if (!chunk) break
        const res = await call('POST', `${API}/sessions/${track.jobId}/events`, {
          runId: chunk.runId,
          events: chunk.events.map((e) => ({ seq: e.seq, event: e.event })),
        })
        if (res.status === 404 || res.status === 403) {
          markGone(track)
          break
        }
        if (res.status === 400) {
          // Off-shape for the server: retrying can't help. Drop it and go on.
          log(`[local-agent-relay] events refused for ${track.jobId}`)
        } else if (!res.ok) {
          scheduleRetry(track)
          break
        }
        track.retries = 0
        raiseUploadedThrough(track, chunk.events[chunk.events.length - 1].seq)
        if (isRecord(res.body) && res.body.stopRequested === true) void stopFromServer(track.jobId)
      }
    })()
    const uploading = run.finally(() => {
      track.uploading = null
      // Events that landed as the loop ended: their own batch.
      if (track.pending.size > 0 && !track.gone && !disposed) scheduleBatch(track)
    })
    track.uploading = uploading
    return uploading
  }

  // ── Gap-fill ──

  /** A session job the relay meets without having started it: read the
   *  server's mark, upload the gap, then set its status right. */
  function adoptTrack(jobId: string): Track {
    const track = newTrack(jobId)
    readopt(track)
    return track
  }

  function readopt(track: Track) {
    const release = hold(track)
    let fix: (() => Promise<void>) | null = null
    void gapFill(track)
      .then((after) => {
        fix = after
      })
      .catch(() => {})
      .finally(release)
    void track.ready.then(async () => {
      await flush(track)
      await fix?.()
    })
  }

  /** Read the server's state of a track, rebind its run, and enqueue the
   *  ring's missing tail. Answers the status correction to post once that
   *  tail is up, if any. */
  async function gapFill(track: Track): Promise<(() => Promise<void>) | null> {
    const res = await call('GET', `${API}/sessions/${track.jobId}?limit=1`)
    if (res.status === 404 || res.status === 403) {
      markGone(track)
      return null
    }
    const session = res.ok ? parseSession(res.body) : null
    if (!session || disposed) return null
    const status = await bridge.status()
    const job = status.jobs.find((j) => j.id === track.jobId)
    if (job?.runId) track.runId = job.runId
    if (session.runId !== undefined) track.serverRunId = session.runId
    else if (job?.runId) track.serverRunId = job.runId
    if (
      job?.runId &&
      session.runId &&
      session.runId !== job.runId &&
      session.status !== null &&
      DEVICE_WRITABLE.has(session.status)
    ) {
      // Rust runs (or last ran) a run the server never heard of.
      await rebind(track, job.runId, session.runId)
    }

    const last = session.lastDeviceSeq
    const ring = await bridge.events(track.jobId, sinceSeqFor(job, last))
    if (ring.ok) {
      if (last && ring.value.some((e) => e.runId === last.runId)) raiseUploadedThrough(track, last.seq)
      for (const e of gapEntries(ring.value, last)) enqueue(track, e)
    }

    const correction = job && session.status ? reconcileStatus(job, session.status) : null
    const runId = track.serverRunId ?? job?.runId ?? null
    if (!correction || !runId || !job) {
      if (job?.live) void refreshToken(track)
      return null
    }
    return async () => {
      await postState(track.jobId, { runId, status: correction, ...sessionFields(job) })
      if (job.live) void refreshToken(track)
    }
  }

  async function gapFillAll() {
    const status = await bridge.status()
    if (!status.available || disposed) return
    for (const job of status.jobs) {
      if (!UUID_RE.test(job.id) || ignored.has(job.id)) continue
      if (!job.live && !((job.lastSeq ?? 0) > 0)) {
        // No launcher and no ring (every job after an app relaunch): nothing to
        // upload, but a job Rust holds as interrupted or parked may be one the
        // server still thinks is working. Read it once, so reconcileStatus
        // tells the server now rather than when the lease lapses.
        const holdsSession = job.status === 'interrupted' || ACTIVE_JOB.has(job.status)
        if (!holdsSession || reconciledOnce.has(job.id)) continue
        reconciledOnce.add(job.id)
      }
      const track = tracks.get(job.id)
      if (!track) adoptTrack(job.id)
      else if (!track.gone) readopt(track)
    }
  }

  // ── Runs and state ──

  function sessionFields(job: Pick<LocalAgentJob, 'sessionId' | 'streamIndex'>): Record<string, unknown> {
    return {
      ...(job.sessionId ? { eveSessionId: job.sessionId } : {}),
      ...(job.streamIndex !== null ? { streamIndex: job.streamIndex } : {}),
    }
  }

  /**
   * Tell the server the session's current run is now `runId` (a CAS on the
   * run it holds, and on this device when known). Settles only once the
   * server answers `applied: true`, retrying with backoff: an upload under a
   * run the server doesn't hold is stored but never derived. It settles
   * without binding only when the session can no longer take the run (gone,
   * or settled / requeued: its uploads then only fill the transcript). A
   * definite no re-reads the session and rebinds from the run it holds.
   */
  function rebind(track: Track, runId: string, previousRunId: string): Promise<void> {
    if (track.rebinding?.runId === runId) return track.rebinding.done
    clear(track.rebindTimer)
    track.rebindTimer = null
    let previous = previousRunId
    let attempt = 0
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => (resolveDone = resolve))
    track.rebinding = { runId, done }
    const settle = (bound: boolean, unbindable = false) => {
      if (bound) track.serverRunId = runId
      if (unbindable) track.unbindableRunId = runId
      if (track.rebinding?.done === done) track.rebinding = null
      resolveDone()
    }
    const tryOnce = async () => {
      track.rebindTimer = null
      if (disposed || track.gone) return settle(false)
      const res = await postState(track.jobId, {
        runId,
        previousRunId: previous,
        ...(device ? { deviceId: device.deviceId } : {}),
      })
      if (res.status === 404 || res.status === 403) {
        markGone(track)
        return settle(false)
      }
      if (res.ok && isRecord(res.body) && res.body.applied === true) return settle(true)
      if (res.ok) {
        const now = await call('GET', `${API}/sessions/${track.jobId}?limit=1`)
        if (now.status === 404 || now.status === 403) {
          markGone(track)
          return settle(false)
        }
        const session = now.ok ? parseSession(now.body) : null
        if (session?.runId === runId) return settle(true)
        if (session?.status && !DEVICE_WRITABLE.has(session.status)) return settle(false, true)
        if (session?.runId) previous = session.runId
      }
      if (disposed || track.gone) return settle(false)
      log(`[local-agent-relay] run ${runId} not bound yet for ${track.jobId} (${res.status}); retrying`)
      const ms = REBIND_RETRY_MS[Math.min(attempt++, REBIND_RETRY_MS.length - 1)]
      track.rebindTimer = clock.setTimeout(() => void tryOnce(), ms)
    }
    void tryOnce()
    return done
  }

  /** Rebind with the track's uploads held until it lands (not awaited by the caller). */
  function rebindHeld(track: Track, runId: string, previousRunId: string, release = hold(track)): void {
    void rebind(track, runId, previousRunId).then(release)
  }

  function scheduleStateSync(track: Track) {
    if (track.stateTimer !== null) return
    track.stateTimer = clock.setTimeout(() => {
      track.stateTimer = null
      void syncState(track)
    }, STATE_SYNC_MS)
  }

  /** The job's eve session id and cursor → /state when they moved. */
  async function syncState(track: Track, snapshot?: LocalAgentStatus) {
    if (track.gone || disposed) return
    await track.ready
    const status = snapshot ?? (await bridge.status())
    const job = status.jobs.find((j) => j.id === track.jobId)
    if (!job || track.gone) return
    if (job.runId && track.serverRunId && job.runId !== track.serverRunId && job.runId !== track.unbindableRunId) {
      // A run the relay didn't start (the dev page's resume, say).
      track.runId = job.runId
      rebindHeld(track, job.runId, track.serverRunId)
      await track.ready
    }
    if (job.sessionId === track.sentSession && job.streamIndex === track.sentStream) return
    if (!job.sessionId && job.streamIndex === null) return
    const runId = job.runId ?? track.runId
    if (!runId) return
    // The events first: the server applies both in arrival order.
    await flush(track)
    const res = await postState(track.jobId, { runId, ...sessionFields(job) })
    if (res.ok) {
      track.sentSession = job.sessionId
      track.sentStream = job.streamIndex
    }
  }

  // ── Model token ──

  function scheduleTokenRefresh(track: Track, token: string, hint: unknown) {
    clear(track.tokenTimer)
    const receivedAt = clock.now()
    const expiresAt = tokenExpiresAt(token, hint) ?? receivedAt + TOKEN_TTL_FALLBACK_MS
    track.tokenTimer = clock.setTimeout(() => {
      track.tokenTimer = null
      void refreshToken(track)
    }, tokenRefreshDelay(receivedAt, expiresAt))
  }

  /** A fresh token, null when the server won't give one (not live, not
   *  configured), 'retry' when it couldn't be asked. */
  async function fetchModelToken(jobId: string): Promise<{ token: string; expiresAt: unknown; localModel: boolean | null } | null | 'retry'> {
    const res = await call('POST', `${API}/sessions/${jobId}/model-token`)
    if (res.ok) {
      const body = isRecord(res.body) ? res.body : {}
      const token = str(body.modelToken)
      return token ? { token, expiresAt: body.expiresAt, localModel: typeof body.localModel === 'boolean' ? body.localModel : null } : null
    }
    return res.status === 0 || (res.status >= 500 && res.status !== 503) ? 'retry' : null
  }

  async function refreshToken(track: Track) {
    if (disposed || track.gone) return
    clear(track.tokenTimer)
    track.tokenTimer = null
    const status = await bridge.status()
    // No launcher, no token to keep fresh: the next start or resume brings one.
    if (!status.jobs.find((j) => j.id === track.jobId)?.live) return
    const fresh = await fetchModelToken(track.jobId)
    if (disposed || track.gone) return
    if (fresh === 'retry') {
      track.tokenTimer = clock.setTimeout(() => {
        track.tokenTimer = null
        void refreshToken(track)
      }, TOKEN_RETRY_MS)
      return
    }
    if (!fresh) return
    const set = await bridge.setModelToken(track.jobId, fresh.token)
    if (!set.ok) log(`[local-agent-relay] token refresh for ${track.jobId}: ${set.error}`)
    scheduleTokenRefresh(track, fresh.token, fresh.expiresAt)
  }

  // ── Pending work ──

  /** A pending start `startOne` would claim now (not already, not cooling down). */
  function claimable(s: PendingStart): boolean {
    const until = claimCooldown.get(s.sessionId)
    return UUID_RE.test(s.sessionId) && !claiming.has(s.sessionId) && !(until !== undefined && clock.now() < until)
  }

  /** Room on the Mac for `s`: Rust parks an idle launcher to make room, so
   *  only busy ones count (and claims still in flight off the drain). No
   *  room: it stays queued for a later drain (its TTL is 6 h). */
  function hasRoom(s: PendingStart, ctx: DrainCtx): boolean {
    const job = ctx.status.jobs.find((j) => j.id === s.sessionId)
    const busy = ctx.status.jobs.filter(isBusy).length + ctx.live.size + claiming.size
    return !!job?.live || busy < MAX_BUSY_JOBS
  }

  /** Clock time passing (a retry's wait); dropped with the relay. */
  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = clock.setTimeout(() => {
        wakeTimers.delete(handle)
        resolve()
      }, ms)
      wakeTimers.add(handle)
    })
  }

  /** `offDrain`: run by `detach`, so it may wait (on the person, or for a
   *  "try again" from Rust to clear). */
  async function startOne(s: PendingStart, ctx: DrainCtx, dev: LocalAgentDevice, offDrain = false): Promise<boolean> {
    const id = s.sessionId
    if (!claimable(s) || !hasRoom(s, ctx)) return false

    claiming.add(id)
    try {
      const provisional = newRunId()
      const res = await call('POST', `${API}/sessions/${id}/claim`, {
        deviceId: dev.deviceId,
        runId: provisional,
        // The Mac's model for this launch, when the desktop says (teammate plan: C1 narrows the tools by it).
        ...(typeof ctx.status.localModel === 'boolean' ? { localModel: ctx.status.localModel } : {}),
      })
      claimCooldown.set(id, clock.now() + CLAIM_COOLDOWN_MS)
      if (!res.ok) return false
      const claim = parseClaim(res.body, s)
      ignored.delete(id)
      const track = tracks.get(id) ?? newTrack(id)
      track.gone = false
      let release: (() => void) | null = hold(track)
      try {
        track.serverRunId = provisional
        track.runId = provisional
        const grant = ctx.status.grants.find((g) => g.id === claim.grantId)
        const refusal = !grant ? GRANT_GONE : claim.mode === 'edit' && grant.mode !== 'edit' ? GRANT_READ_ONLY : null
        if (refusal) {
          await postState(id, { runId: provisional, status: 'failed', error: refusal })
          return false
        }
        const args: LocalAgentStartArgs = {
          grantId: claim.grantId,
          request: claim.request,
          jobId: id,
          mode: claim.mode,
          modelToken: claim.modelToken,
          resume: claim.resume,
          // The Mac launches on the model the server recorded (C1 narrows the tools by it).
          ...(claim.localModel === null ? {} : { localModel: claim.localModel }),
          // An edit job's base (E3): only to a desktop that resolves one; it checks the name itself.
          ...(claim.baseBranch && claim.mode === 'edit' && ctx.status.baseBranch === true ? { baseBranch: claim.baseBranch } : {}),
        }
        let started = stopWanted.has(id) ? null : await bridge.start(args)
        // Refused for now (a confirm is up on the Mac): the claim is ours, so try again in a while.
        for (const ms of offDrain ? START_RETRY_MS : []) {
          if (!started || started.ok || !isTransientSendError(started.error) || disposed) break
          await pause(ms)
          started = stopWanted.has(id) ? null : await bridge.start(args)
        }
        // A stop came while it was claimed: it wins, whatever the start did.
        if (stopWanted.delete(id) || !started) {
          if (started?.ok) await bridge.stop(id)
          else await postState(id, { runId: provisional, status: 'cancelled' })
          return false
        }
        if (!started.ok) {
          await postState(id, { runId: provisional, status: 'failed', error: started.error || START_FAILED })
          return false
        }
        const runId = started.value.runId ?? provisional
        track.runId = runId
        if (runId !== provisional) {
          // The hold passes to the rebind: uploads wait until it lands, the drain doesn't.
          rebindHeld(track, runId, provisional, release)
          release = null
        }
        if (claim.modelToken) scheduleTokenRefresh(track, claim.modelToken, claim.modelTokenExpiresAt)
        ctx.live.add(id)
        return true
      } finally {
        release?.()
      }
    } finally {
      claiming.delete(id)
      // A stop for a claim that never landed (a 409, say) has nothing to stop.
      stopWanted.delete(id)
    }
  }

  /** Respawn a job no launcher runs (with a fresh token), and rebind its run.
   *  `message`: the one it is revived for, which Rust then sends itself. */
  async function resumeJob(
    job: LocalAgentJob,
    message: { text: string; policy: LocalAgentPolicy } | null = null,
  ): Promise<LocalAgentResult<void>> {
    const track = tracks.get(job.id) ?? newTrack(job.id)
    // The server sent a message for it: a session after all, whatever a read said.
    track.gone = false
    ignored.delete(job.id)
    let release: (() => void) | null = hold(track)
    try {
      const previous = track.serverRunId ?? job.runId
      const fresh = await fetchModelToken(job.id)
      const token = fresh && fresh !== 'retry' ? fresh : null
      // A parked job resumes on the model the server recorded for it, or the desktop refuses.
      const resumed = message
        ? await bridge.resume(job.id, token?.token ?? null, token?.localModel ?? null, message)
        : await bridge.resume(job.id, token?.token ?? null, token?.localModel ?? null)
      if (!resumed.ok) return resumed
      const runId = resumed.value.runId
      if (runId) {
        track.runId = runId
        if (previous && previous !== runId) {
          rebindHeld(track, runId, previous, release)
          release = null
        } else if (!previous) track.serverRunId = runId
      }
      if (token) scheduleTokenRefresh(track, token.token, token.expiresAt)
      return { ok: true, value: undefined }
    } finally {
      release?.()
    }
  }

  async function ack(messageId: string, ok: boolean, error?: string) {
    const res = await call('POST', `${API}/messages/${messageId}/ack`, ok ? { ok: true } : { ok: false, error })
    // Gone or refused for good: nothing more to say about it.
    if (res.ok || res.status === 400 || res.status === 404) unacked.delete(messageId)
    else unacked.set(messageId, ok ? { ok } : { ok, error })
  }

  /** Drain again in `ms` (a send retry falling due). */
  function wake(ms: number) {
    const handle = clock.setTimeout(() => {
      wakeTimers.delete(handle)
      void ring()
    }, ms)
    wakeTimers.add(handle)
  }

  /** `offDrain`: run by `detach`, so a coding agent's revival may wait on
   *  the person here. */
  /** A pending message `deliverOne` would take now (not handed over, not
   *  in hand, its session not being claimed, any retry due). */
  function deliverable(m: PendingMessage): boolean {
    const retry = sendRetries.get(m.id)
    return (
      !delivered.has(m.id) &&
      !delivering.has(m.id) &&
      !claiming.has(m.sessionId) &&
      !(retry && clock.now() < retry.at)
    )
  }

  /** True once it settled the message (delivered or acked); false when it
   *  left it pending for a later drain (nothing to do now, or Rust said
   *  "try again"). */
  async function deliverOne(m: PendingMessage, ctx: DrainCtx, offDrain = false): Promise<boolean> {
    if (!deliverable(m)) return false
    const retry = sendRetries.get(m.id)
    delivering.add(m.id)
    try {
      const job = ctx.status.jobs.find((j) => j.id === m.sessionId)
      const text = prefixMessage(m.author, m.text, deps.personName?.())
      // A coding agent's revival carries its message: the person's confirm
      // on the Mac shows it, and Rust sends exactly that one.
      const carried = job?.worker ? { text, policy: m.policy } : null
      let revived = false
      if (!job?.live && !ctx.live.has(m.sessionId)) {
        if (!job?.sessionId) {
          // Rust lost the job (state reset): nothing can take the message.
          delivered.add(m.id)
          await ack(m.id, false, NO_LOCAL_JOB)
          const runId = tracks.get(m.sessionId)?.serverRunId ?? job?.runId
          if (runId) await postState(m.sessionId, { runId, status: 'interrupted', error: NO_LOCAL_JOB })
          return true
        }
        const resumed = await resumeJob(job, carried)
        // Refused for now (another coding agent's confirm is up): it stays pending.
        if (!resumed.ok && isTransientSendError(resumed.error)) return false
        if (!resumed.ok) {
          delivered.add(m.id)
          await ack(m.id, false, resumed.error)
          return true
        }
        ctx.live.add(job.id)
        revived = true
      }
      let sent: LocalAgentResult<void> =
        revived && carried ? { ok: true, value: undefined } : await bridge.send(m.sessionId, text, m.policy)
      // Parked (or its launcher exited) since the status read: revive it once,
      // a coding agent's only off the drain (a later one, the status fresh).
      const stale = !sent.ok && !revived && !!job?.sessionId && /isn['’]t running/i.test(sent.error)
      if (stale && job && (!job.worker || offDrain)) {
        const resumed = await resumeJob(job, carried)
        if (!resumed.ok && isTransientSendError(resumed.error)) return false
        if (resumed.ok) {
          ctx.live.add(job.id)
          sent = carried ? { ok: true, value: undefined } : await bridge.send(m.sessionId, text, m.policy)
        }
      }
      if (!sent.ok && (isTransientSendError(sent.error) || (stale && !offDrain && !!job?.worker))) {
        const attempts = (retry?.attempts ?? 0) + 1
        if (attempts <= SEND_RETRY_MS.length) {
          // Not delivered and not acked: a later drain sends it again.
          const ms = SEND_RETRY_MS[attempts - 1]
          sendRetries.set(m.id, { attempts, at: clock.now() + ms })
          wake(ms)
          return false
        }
      }
      sendRetries.delete(m.id)
      delivered.add(m.id)
      await ack(m.id, sent.ok, sent.ok ? undefined : sent.error)
      return true
    } finally {
      delivering.delete(m.id)
    }
  }

  async function stopOne(sessionId: string, ctx: DrainCtx) {
    const last = stopIssued.get(sessionId)
    if (last !== undefined && clock.now() - last < STOP_RETRY_MS) return
    stopIssued.set(sessionId, clock.now())
    if (claiming.has(sessionId)) {
      // Being started (its confirm up on the Mac, say): the start carries the
      // stop out once it lands; Rust, already holding the job, stops it now.
      stopWanted.add(sessionId)
      if (ctx.status.jobs.some((j) => j.id === sessionId)) await bridge.stop(sessionId)
      return
    }
    const job = ctx.status.jobs.find((j) => j.id === sessionId)
    if (job?.live || ctx.live.has(sessionId)) {
      // Rust's `cancelled` status event settles the session.
      const stopped = await bridge.stop(sessionId)
      if (stopped.ok) return
    }
    const runId = tracks.get(sessionId)?.serverRunId ?? job?.runId
    if (runId) await postState(sessionId, { runId, status: 'cancelled' })
  }

  async function stopFromServer(jobId: string) {
    if (disposed) return
    await stopOne(jobId, { status: await bridge.status(), live: new Set() })
  }

  /** A coding agent's job Rust has no launcher for: its start or revival
   *  waits for the person's yes on the Mac. */
  function waitsOnPerson(status: LocalAgentStatus, sessionId: string): boolean {
    const job = status.jobs.find((j) => j.id === sessionId)
    return !!job?.worker && !job.live
  }

  /** The person is being asked already: by our own launch off the drain, or
   *  a confirm Rust reports up. One at a time; Rust refuses a second. */
  function personAsked(status: LocalAgentStatus): boolean {
    return detached.size > 0 || status.jobs.some((j) => j.asking === true)
  }

  /** Run `work` off the drain (it settles and reports on its own); the
   *  session's other work waits for it. The drain runs again only when it
   *  got somewhere (true), never on a no-op. */
  function detach(sessionId: string, work: () => Promise<boolean>) {
    detached.add(sessionId)
    void work()
      .catch((err) => {
        log(`[local-agent-relay] ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      })
      .then((progressed) => {
        detached.delete(sessionId)
        if (progressed) void ring()
      })
  }

  async function drainOnce() {
    const status = await bridge.status()
    if (!status.available || disposed) return
    const dev = await getDevice()
    if (!dev) return
    for (const [id, a] of [...unacked]) await ack(id, a.ok, a.error)
    const res = await call('GET', `${API}/device/pending?deviceId=${encodeURIComponent(dev.deviceId)}`)
    if (!res.ok || disposed) return
    const pending = parsePending(res.body)
    const ctx: DrainCtx = { status, live: new Set() }

    // Stops first: never behind a start or a message, either of which can
    // wait on the person.
    for (const sessionId of pending.stops) {
      if (disposed) return
      await stopOne(sessionId, ctx)
    }
    let started = 0
    for (const s of pending.start) {
      if (disposed) return
      if (detached.has(s.sessionId)) continue
      if (waitsOnPerson(ctx.status, s.sessionId)) {
        // Never inline; left queued while the person is asked or there's no room.
        if (!personAsked(ctx.status) && claimable(s) && hasRoom(s, ctx)) {
          detach(s.sessionId, () => startOne(s, ctx, dev, true))
        }
        continue
      }
      if (await startOne(s, ctx, dev)) started++
    }
    if (started > 0) {
      ctx.status = await bridge.status()
      // A started session's messages come with the next pending (it was queued).
      drainAgain = true
    }
    for (const m of pending.messages) {
      if (disposed) return
      if (detached.has(m.sessionId)) continue
      if (waitsOnPerson(ctx.status, m.sessionId)) {
        // Never inline; left pending while the person is asked.
        if (!personAsked(ctx.status) && deliverable(m)) detach(m.sessionId, () => deliverOne(m, ctx, true))
        continue
      }
      await deliverOne(m, ctx)
    }
    // A delivered message the server no longer lists is settled.
    const listed = new Set(pending.messages.map((m) => m.id))
    for (const id of delivered) if (!listed.has(id) && !unacked.has(id)) delivered.delete(id)
    for (const id of sendRetries.keys()) if (!listed.has(id)) sendRetries.delete(id)
  }

  function ring(): Promise<void> {
    if (disposed || !active) return Promise.resolve()
    if (draining) {
      drainAgain = true
      return draining
    }
    draining = (async () => {
      try {
        do {
          drainAgain = false
          await drainOnce()
        } while (drainAgain && !disposed)
      } catch (err) {
        log(`[local-agent-relay] drain failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        draining = null
      }
    })()
    return draining
  }

  // ── Heartbeat ──

  async function heartbeat(opts: { rejoin?: boolean } = {}): Promise<HeartbeatResult | null> {
    if (disposed) return null
    const status = await bridge.status()
    if (!status.available) return null
    const dev = await getDevice()
    if (!dev || disposed) return null
    const res = await call('POST', `${API}/device`, heartbeatBody(dev, status, ignored, opts.rejoin === true))
    // Session ids and cursors move only on Rust's side; status is how they show.
    for (const track of tracks.values()) if (!track.gone) void syncState(track, status)
    return res.ok ? { folders: parseFolders(res.body) } : null
  }

  function schedulePoll() {
    pollTimer = clock.setTimeout(() => {
      pollTimer = null
      if (disposed) return
      void ring().finally(() => {
        if (!disposed) schedulePoll()
      })
    }, POLL_MS)
  }

  function scheduleHeartbeat() {
    heartbeatTimer = clock.setTimeout(() => {
      heartbeatTimer = null
      if (disposed) return
      void heartbeat().finally(() => {
        if (!disposed) scheduleHeartbeat()
      })
    }, HEARTBEAT_MS)
  }

  const relay: LocalAgentRelay = {
    async start() {
      if (disposed) return false
      if (active) return true
      const probe = await bridge.device()
      // A desktop without local agents (a release build, an older app): stay dormant.
      if (!probe.ok && probe.unavailable) return false
      if (probe.ok) device = probe.value
      if (disposed) return false
      active = true
      activeRelay = relay
      unlisten = bridge.onEvent(onEnvelope)
      await heartbeat()
      await gapFillAll()
      void ring()
      schedulePoll()
      scheduleHeartbeat()
      return true
    },
    ring,
    async reconnected() {
      if (disposed || !active) return
      await gapFillAll()
      await ring()
    },
    heartbeat,
    async flushAll() {
      await Promise.all([...tracks.values()].map((t) => flush(t)))
    },
    dispose() {
      if (disposed) return
      disposed = true
      active = false
      clear(pollTimer)
      clear(heartbeatTimer)
      for (const h of wakeTimers) clear(h)
      wakeTimers.clear()
      for (const t of tracks.values()) {
        clear(t.batchTimer)
        clear(t.retryTimer)
        clear(t.stateTimer)
        clear(t.tokenTimer)
        clear(t.rebindTimer)
      }
      unlisten?.()
      unlisten = null
      if (activeRelay === relay) activeRelay = null
    },
  }
  return relay
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Heartbeat now so a folder just picked gets its server id (the composer's
 * Select folder…). Through the window's running relay when there is one, else
 * a one-off with the desktop bridge and this page's fetch. Null outside the
 * desktop, without local agents, or when the server didn't answer. `rejoin`
 * (the add-folder path): a Mac removed from Dial8 comes back.
 */
export async function refreshLocalAgentDevice(
  deps?: Pick<RelayDeps, 'fetch' | 'bridge'>,
  opts: { rejoin?: boolean } = {},
): Promise<HeartbeatResult | null> {
  if (!deps && activeRelay) return activeRelay.heartbeat(opts)
  const resolved = deps ?? (await browserDeps())
  const once = createLocalAgentRelay(resolved)
  try {
    return await once.heartbeat(opts)
  } finally {
    once.dispose()
  }
}

async function browserDeps(): Promise<Pick<RelayDeps, 'fetch' | 'bridge'>> {
  // Lazy: Node callers (runHeadlessRelay) never load the Tauri bridge.
  const { tauriBridge } = await import('@/lib/tauri-bridge')
  return { fetch: (path, init) => fetch(path, init), bridge: tauriBridge.localAgent }
}

/**
 * The relay without a webview, for an e2e script driving the real launcher:
 * `deps.bridge` stands in for Rust, `deps.fetch` reaches the server with its
 * own auth, and `subscribeDoorbell` (optional) wires a Realtime channel; the
 * 5 s poll covers it otherwise. `stop()` uploads what is pending, then stops.
 */
export async function runHeadlessRelay(
  deps: RelayDeps & {
    subscribeDoorbell?: (on: { ring: () => void; reconnected: () => void }) => () => void
    signal?: AbortSignal
  },
): Promise<{ relay: LocalAgentRelay; active: boolean; stop: () => Promise<void> }> {
  const relay = createLocalAgentRelay(deps)
  const active = await relay.start()
  const unsubscribe =
    active && deps.subscribeDoorbell
      ? deps.subscribeDoorbell({ ring: () => void relay.ring(), reconnected: () => void relay.reconnected() })
      : null
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    unsubscribe?.()
    await relay.flushAll()
    relay.dispose()
  }
  deps.signal?.addEventListener('abort', () => void stop(), { once: true })
  return { relay, active, stop }
}
