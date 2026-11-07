/**
 * Local agents: typed DB operations over migration 410 (contract B, "The
 * library API"). Other builders code against these exported signatures, so
 * keep them exactly.
 *
 * `svc` is always a SERVICE-ROLE client: the tables have owner-only SELECT
 * RLS and no client write policies, so every write goes through here after a
 * route authenticated the person. Every function therefore scopes by
 * `userId` itself; a row of another person's reads as missing.
 *
 * Lazy reaping (applied on read, CAS on the status it read):
 *   queued past expires_at         → expired     (ledger: fail)
 *   starting/running, lease lapsed → interrupted (ledger: needs_input)
 *
 * The device side (heartbeat, pending, claim, events, state, ack) is in
 * ./device.ts; the ledger mirror in ./ledger.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureMacEnvironment, macEnvironmentId } from '@/lib/environments/mac'
import { isBaseBranch, isRepoFullName } from '@/lib/environments/types'
import { ringDoorbell } from './doorbell'
import { macTeammateName } from './teammate'
import { IDLE_REASON, LOOP_EXPIRED_REASON } from './transcript-view'
import {
  EXPIRED_REASON,
  moveTurn,
  nextTurn,
  startTurnRow,
  turnStatus,
  turnState,
  parkedOnTeammate,
  type LedgerSession,
} from './ledger'

type Svc = SupabaseClient

export { macTeammateName }

export type LocalAgentMode = 'read' | 'edit'
export type LocalAgentStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
  | 'expired'

export interface DeviceRow {
  id: string
  name: string
  platform: string
  appVersion: string
  lastSeenAt: string
  /** last_seen within 120 s */
  online: boolean
}

export interface FolderRow {
  id: string
  deviceId: string
  grantId: string
  label: string
  path: string
  mode: LocalAgentMode
  isGit: boolean
  deviceName: string
  online: boolean
}

export interface SessionRow {
  id: string
  folderId: string
  folderLabel: string
  deviceId: string
  deviceName: string
  conversationId: string | null
  mode: LocalAgentMode
  request: string
  status: LocalAgentStatus
  lastSignal: 'ask' | 'finish' | null
  lastSignalText: string | null
  branch: string | null
  commitSha: string | null
  error: string | null
  trackedJobId: string | null
  createdAt: string
  updatedAt: string
  endedAt: string | null
  lastDeviceSeq: { runId: string; seq: number } | null
  /**
   * Additive (after the contract): always set by toSessionRow, optional in
   * the type so fixtures written against the contract still compile.
   * runId: the device's current launcher run (the claim's provisional run
   * until /state rebinds it), so a reloaded relay rebinds before its gap-fill.
   * startedBy: who started it (the panel labels the request).
   */
  runId?: string | null
  startedBy?: 'agent' | 'person'
  /**
   * Migration 418 (teammate plan C5): the pull request for its own dial8/…
   * branch, opened by the server route or by gh on the Mac. Null until then.
   */
  prUrl?: string | null
  /** Migration 418: its latest launch ran on a model on the Mac (C1 narrows the tools by it). */
  localModel?: boolean
  /**
   * It acts for the person (isAttendedSession): they started it, or the cloud
   * agent did from their typed turn. False for a loop's job and anything
   * else with no positive marker.
   */
  attended?: boolean
}

// ── Constants ───────────────────────────────────────────────────────────────

/** A device is online when its heartbeat (every 60 s) landed within this. */
export const ONLINE_WINDOW_MS = 120_000
/** A claim's lease; renewed by event uploads and the device heartbeat. */
export const LEASE_MS = 2 * 60_000
/** A queued session waits this long for a Mac to claim it. */
export const QUEUED_TTL_MS = 6 * 60 * 60_000
/** A loop's job waits this long (unattended.ts UNATTENDED_QUEUED_TTL_MS): one claimed later would start with nobody expecting it. */
export const LOOP_QUEUED_TTL_MS = 15 * 60_000
/** An idle (waiting / interrupted) session expires after this long with no activity. */
export const IDLE_TTL_MS = 24 * 60 * 60_000
export { IDLE_REASON, LOOP_EXPIRED_REASON }
/** The lease is renewed only when less than this remains (fewer realtime row updates). */
export const LEASE_RENEW_BELOW_MS = 60_000
/** The DB's character cap (migration 410's CHECKs). The byte caps below are the binding ones. */
export const TEXT_MAX = 20_000
/**
 * Rust caps a request and a message at 16 KiB of UTF-8, and the relay prefixes
 * a message with "[From …] ", so the server caps by BYTES below that. The chat
 * tools' zod schemas use these too.
 */
export const LOCAL_AGENT_REQUEST_MAX_BYTES = 16_000
export const LOCAL_AGENT_MESSAGE_MAX_BYTES = 15_900

export const LIVE_STATUSES: readonly LocalAgentStatus[] = ['queued', 'starting', 'running', 'waiting']
/** The model relay and token refresh serve only these. */
export const RUNNING_STATUSES: readonly LocalAgentStatus[] = ['starting', 'running', 'waiting']
export const TERMINAL_STATUSES: readonly LocalAgentStatus[] = ['cancelled', 'failed', 'expired']
/**
 * The model relay and the token refresh serve these: RUNNING_STATUSES plus
 * `interrupted`, a lapsed lease the Mac may wake from mid-turn (its next event
 * upload revives the session; refusing its model call first would fail the turn).
 */
export const MODEL_LIVE_STATUSES: readonly LocalAgentStatus[] = ['starting', 'running', 'waiting', 'interrupted']

const MODE_RANK: Record<LocalAgentMode, number> = { read: 0, edit: 1 }

// ── Errors ──────────────────────────────────────────────────────────────────

export type LocalAgentErrorCode = 'not_found' | 'bad_request' | 'forbidden' | 'conflict'

/** A refusal a route maps to its api-errors helper (see `errorResponse` in ./http.ts). */
export class LocalAgentError extends Error {
  constructor(
    readonly code: LocalAgentErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'LocalAgentError'
  }
}

// ── Row shapes ──────────────────────────────────────────────────────────────

/** A local_agent_session row with its folder and device embedded. */
export interface DbSession {
  id: string
  user_id: string
  workspace_id: string
  device_id: string
  folder_id: string
  conversation_id: string | null
  tracked_job_id: string | null
  current_turn: number
  current_tracked_job_id: string | null
  started_by: 'agent' | 'person'
  mode: LocalAgentMode
  request: string
  status: LocalAgentStatus
  eve_session_id: string | null
  stream_index: number | null
  run_id: string | null
  last_seq: number | null
  last_seq_run_id: string | null
  claimed_at: string | null
  lease_expires_at: string | null
  expires_at: string
  stop_requested_at: string | null
  last_signal: 'ask' | 'finish' | null
  last_signal_text: string | null
  branch: string | null
  commit_sha: string | null
  error: string | null
  ended_at: string | null
  idempotency_key: string | null
  pending_turn_text?: string | null
  /** Migration 418; absent before it is applied (read as false / null). */
  local_model?: boolean | null
  pr_url?: string | null
  /** Migration 418: the person's words from the chat turn that started it (the reviewer's evidence). */
  start_words?: string[] | null
  /** Migration 420: its device's Mac environment, written when it started. */
  environment_id?: string | null
  /** Migration 420 (E3): an edit job's base branch, stamped when it started (null: HEAD). */
  base_branch?: string | null
  created_at: string
  updated_at: string
  folder?: { label?: string | null; grant_id?: string | null; revoked_at?: string | null } | null
  /** removed_at: migration 420's "Remove this Mac". */
  device?: { name?: string | null; last_seen_at?: string | null; removed_at?: string | null } | null
}

export const SESSION_SELECT =
  '*, folder:device_folder!folder_id(label, grant_id, revoked_at), device:user_device!local_agent_session_device_fk(name, last_seen_at, removed_at)'

interface DbFolder {
  id: string
  user_id: string
  device_id: string
  grant_id: string
  label: string
  path: string
  mode: LocalAgentMode
  is_git: boolean
  revoked_at: string | null
  /** capabilities: migration 420 (E2), what the Mac's app says it can do. */
  device?: { name?: string | null; last_seen_at?: string | null; removed_at?: string | null; capabilities?: unknown } | null
}

const FOLDER_SELECT =
  'id, user_id, device_id, grant_id, label, path, mode, is_git, revoked_at, device:user_device!device_folder_device_fk(name, last_seen_at, removed_at, capabilities)'

export function isOnline(lastSeenAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return false
  const t = Date.parse(lastSeenAt)
  return Number.isFinite(t) && now - t <= ONLINE_WINDOW_MS
}

export function toSessionRow(r: DbSession): SessionRow {
  return {
    id: r.id,
    folderId: r.folder_id,
    folderLabel: r.folder?.label ?? '',
    deviceId: r.device_id,
    deviceName: r.device?.name ?? '',
    conversationId: r.conversation_id,
    mode: r.mode,
    request: r.request,
    status: r.status,
    lastSignal: r.last_signal,
    lastSignalText: r.last_signal_text,
    branch: r.branch,
    commitSha: r.commit_sha,
    error: r.error,
    trackedJobId: r.current_tracked_job_id ?? r.tracked_job_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
    lastDeviceSeq:
      r.last_seq_run_id && typeof r.last_seq === 'number' ? { runId: r.last_seq_run_id, seq: r.last_seq } : null,
    runId: r.run_id,
    startedBy: r.started_by,
    prUrl: typeof r.pr_url === 'string' && r.pr_url ? r.pr_url : null,
    localModel: r.local_model === true,
    attended: isAttendedSession(r),
  }
}

/** The chat tool's start key (start_local_agent from a typed turn): local-agent:<conv>:session:<s>:turn:<t>:call:<c>. */
const CHAT_START_KEY = /^local-agent:[^:]+:session:/

/**
 * The session acts for the person, on a POSITIVE marker only: they started it,
 * or the cloud agent did from their typed turn (the chat tool's start key).
 * Anything else, a loop's job among them, is unattended (fail closed). The
 * same rule as C1's caller class (agent-access.ts macCallerClass; a test pins
 * the two together).
 */
export function isAttendedSession(r: Pick<DbSession, 'started_by' | 'idempotency_key'>): boolean {
  if (r.started_by === 'person') return true
  return r.started_by === 'agent' && typeof r.idempotency_key === 'string' && CHAT_START_KEY.test(r.idempotency_key)
}

/**
 * Its latest launch ran on a model on the Mac (Ollama, LM Studio), not the
 * Dial8 relay (migration 418, set at the claim). C1's routes narrow the tools
 * for such a session. False before the migration is applied.
 */
export function sessionUsesLocalModel(r: Pick<DbSession, 'local_model'>): boolean {
  return r.local_model === true
}

function toFolderRow(r: DbFolder, now = Date.now()): FolderRow {
  return {
    id: r.id,
    deviceId: r.device_id,
    grantId: r.grant_id,
    label: r.label,
    path: r.path,
    mode: r.mode,
    isGit: r.is_git,
    deviceName: r.device?.name ?? '',
    online: isOnline(r.device?.last_seen_at, now),
  }
}

export function ledgerSessionOf(r: DbSession): LedgerSession {
  return {
    id: r.id,
    userId: r.user_id,
    workspaceId: r.workspace_id,
    conversationId: r.conversation_id,
    folderLabel: r.folder?.label ?? '',
    deviceName: r.device?.name ?? '',
    request: r.request,
    currentTurn: r.current_turn ?? 1,
    currentTrackedJobId: r.current_tracked_job_id,
    trackedJobId: r.tracked_job_id,
  }
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

function cleanText(text: unknown, what: string, maxBytes: number): string {
  if (typeof text !== 'string' || !text.trim()) throw new LocalAgentError('bad_request', `${what} is required`)
  const t = text.trim()
  if (t.length > TEXT_MAX || Buffer.byteLength(t, 'utf8') > maxBytes) {
    throw new LocalAgentError('bad_request', `${what} is longer than ${maxBytes} bytes`)
  }
  return t
}

/** The person's own words kept as the reviewer's evidence, at most (migration 418's check). */
export const PERSON_WORDS_MAX = 3
/** Each, at most (the reviewer reads the person's latest messages cut to this). */
export const PERSON_WORD_CHARS = 2000

/**
 * The person's own words from a chat turn (the chat route's `personMessages`,
 * oldest first) as kept for the reviewer: strings only, trimmed, non-empty,
 * the newest PERSON_WORDS_MAX, each cut to PERSON_WORD_CHARS.
 */
export function personWordsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
    .map((w) => w.trim().slice(0, PERSON_WORD_CHARS))
    .slice(-PERSON_WORDS_MAX)
}

/**
 * Keep the words on a row (migration 418): a session's `start_words`, a
 * message's `person_words`. Error-tolerant: before the migration the
 * reviewer simply has no evidence, and holds.
 */
async function keepPersonWords(svc: Svc, table: 'local_agent_session' | 'local_agent_message', id: string, userId: string, raw: readonly string[]): Promise<void> {
  const words = personWordsOf(raw)
  if (words.length === 0) return
  const column = table === 'local_agent_session' ? 'start_words' : 'person_words'
  const { error } = await svc.from(table).update({ [column]: words }).eq('id', id).eq('user_id', userId)
  if (error) console.warn(`[local-agent] keeping the person's words on ${table} failed:`, error.message)
}

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString()
}

// ── Reading sessions (with lazy reaping) ────────────────────────────────────

export type Staleness = 'expired' | 'idle' | 'interrupted'

/**
 * Why a row is stale now, or null:
 *   expired      queued past expires_at (no Mac claimed it in 6 h)
 *   idle         waiting / interrupted with no activity for 24 h (→ expired:
 *                the model relay and token refresh then refuse it)
 *   interrupted  starting / running with a lapsed lease
 */
export function staleness(
  r: Pick<DbSession, 'status' | 'expires_at' | 'lease_expires_at'> & { updated_at?: string | null },
  now = Date.now(),
): Staleness | null {
  if (r.status === 'queued' && r.expires_at && Date.parse(r.expires_at) < now) return 'expired'
  if (
    (r.status === 'starting' || r.status === 'running') &&
    r.lease_expires_at &&
    Date.parse(r.lease_expires_at) < now
  ) {
    return 'interrupted'
  }
  if (
    (r.status === 'waiting' || r.status === 'interrupted') &&
    r.updated_at &&
    Date.parse(r.updated_at) < now - IDLE_TTL_MS &&
    !(r.lease_expires_at && Date.parse(r.lease_expires_at) >= now)
  ) {
    return 'idle'
  }
  return null
}

/**
 * Reap a stale row and move its ledger. The CAS re-checks the staleness it
 * read (the status AND the lapsed deadline), so a device that renewed the
 * lease or settled the row concurrently wins. Returns the row as it is now.
 */
export async function reapIfStale(svc: Svc, r: DbSession, now = Date.now()): Promise<DbSession> {
  const to = staleness(r, now)
  if (!to) return r
  const at = nowIso(now)
  const reason = to === 'idle' ? IDLE_REASON : isUnattendedKey(r.idempotency_key) ? LOOP_EXPIRED_REASON : EXPIRED_REASON
  const patch =
    to === 'interrupted'
      ? { status: 'interrupted' as const, lease_expires_at: null }
      : { status: 'expired' as const, error: reason, ended_at: at, lease_expires_at: null }
  let q = svc
    .from('local_agent_session')
    .update(patch)
    .eq('id', r.id)
    .eq('user_id', r.user_id)
    .eq('status', r.status)
  if (to === 'expired') q = q.lt('expires_at', at)
  else if (to === 'interrupted') q = q.lt('lease_expires_at', at)
  else q = q.lt('updated_at', nowIso(now - IDLE_TTL_MS))
  const { data } = await q.select(SESSION_SELECT).maybeSingle()
  if (!data) {
    // Lost the race: re-read what won.
    const { data: fresh } = await svc
      .from('local_agent_session')
      .select(SESSION_SELECT)
      .eq('id', r.id)
      .eq('user_id', r.user_id)
      .maybeSingle()
    return (fresh as DbSession | null) ?? r
  }
  const reaped = data as DbSession
  await moveTurn(
    svc,
    ledgerSessionOf(reaped),
    to === 'interrupted' ? { type: 'interrupted' } : { type: 'fail', message: reason },
  )
  await settleActionRunStatus(svc, r, reaped)
  return reaped
}

/** The session row (reaped), or null when it isn't this person's. */
export async function loadSession(svc: Svc, userId: string, sessionId: string): Promise<DbSession | null> {
  if (!isUuid(sessionId)) return null
  const { data, error } = await svc
    .from('local_agent_session')
    .select(SESSION_SELECT)
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`local agent session read failed: ${error.message}`)
  if (!data) return null
  return reapIfStale(svc, data as DbSession)
}

export async function getSession(svc: Svc, userId: string, sessionId: string): Promise<SessionRow | null> {
  const row = await loadSession(svc, userId, sessionId)
  return row ? toSessionRow(row) : null
}

export async function listSessions(
  svc: Svc,
  userId: string,
  opts: { conversationId?: string; live?: boolean } = {},
): Promise<SessionRow[]> {
  let q = svc.from('local_agent_session').select(SESSION_SELECT).eq('user_id', userId)
  if (opts.conversationId) q = q.eq('conversation_id', opts.conversationId)
  if (opts.live) q = q.in('status', LIVE_STATUSES as LocalAgentStatus[])
  const { data, error } = await q.order('created_at', { ascending: false }).limit(100)
  if (error) throw new Error(`local agent sessions read failed: ${error.message}`)
  const now = Date.now()
  const rows: DbSession[] = []
  for (const r of (data ?? []) as DbSession[]) {
    rows.push(staleness(r, now) ? await reapIfStale(svc, r, now) : r)
  }
  const out = rows.map(toSessionRow)
  return opts.live ? out.filter((s) => (LIVE_STATUSES as string[]).includes(s.status)) : out
}

// ── Devices and folders ─────────────────────────────────────────────────────

export async function listDevices(svc: Svc, userId: string): Promise<DeviceRow[]> {
  const { data, error } = await svc
    .from('user_device')
    .select('id, name, platform, app_version, last_seen_at')
    .eq('user_id', userId)
    // A removed Mac (migration 420) isn't one of them; its folders are revoked too.
    .is('removed_at', null)
    .order('last_seen_at', { ascending: false })
  if (error) throw new Error(`devices read failed: ${error.message}`)
  const now = Date.now()
  return ((data ?? []) as Array<{ id: string; name: string; platform: string; app_version: string; last_seen_at: string }>).map(
    (d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      appVersion: d.app_version,
      lastSeenAt: d.last_seen_at,
      online: isOnline(d.last_seen_at, now),
    }),
  )
}

/**
 * The person's live folders (non-revoked grants), across their Macs: their
 * environment. A folder in it is available to the Dial8 agent in every chat
 * until the person removes it on their Mac; nothing is attached per chat.
 */
export async function listFolders(svc: Svc, userId: string): Promise<FolderRow[]> {
  const { data, error } = await svc
    .from('device_folder')
    .select(FOLDER_SELECT)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('label', { ascending: true })
  if (error) throw new Error(`folders read failed: ${error.message}`)
  const now = Date.now()
  return ((data ?? []) as DbFolder[]).map((f) => toFolderRow(f, now))
}

/** An edit job's git branch in one of the person's folders (the Environment card's worktree rows). */
export interface WorktreeRow {
  sessionId: string
  folderId: string
  branch: string
  status: LocalAgentStatus
  /** The session is live (queued, running, waiting, interrupted): its branch may still move. */
  live: boolean
  updatedAt: string
}

/** Worktrees shown: edit sessions with a branch, touched within this (a live one always is: the reaper ends it sooner). */
export const WORKTREE_RECENT_MS = 7 * 24 * 60 * 60_000
/** Worktrees shown, at most (the newest). */
export const WORKTREES_MAX = 50

const WORKTREE_LIVE: ReadonlySet<string> = new Set([...LIVE_STATUSES, 'interrupted'])

/**
 * The branches the person's edit jobs left, live or from the last 7 days,
 * newest first, one row per (folder, branch). No lazy reaping: a stale status
 * only colours a row, and the session reads reap it.
 */
export async function listWorktrees(svc: Svc, userId: string, now = Date.now()): Promise<WorktreeRow[]> {
  const { data, error } = await svc
    .from('local_agent_session')
    .select('id, folder_id, branch, status, updated_at')
    .eq('user_id', userId)
    .eq('mode', 'edit')
    .gte('updated_at', new Date(now - WORKTREE_RECENT_MS).toISOString())
    .order('updated_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(`worktrees read failed: ${error.message}`)
  const seen = new Set<string>()
  const out: WorktreeRow[] = []
  for (const r of (data ?? []) as Array<{ id: string; folder_id: string; branch: string | null; status: LocalAgentStatus; updated_at: string }>) {
    const branch = typeof r.branch === 'string' ? r.branch.trim() : ''
    if (!branch) continue
    const key = `${r.folder_id}:${branch}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ sessionId: r.id, folderId: r.folder_id, branch, status: r.status, live: WORKTREE_LIVE.has(r.status), updatedAt: r.updated_at })
    if (out.length >= WORKTREES_MAX) break
  }
  return out
}

/** What GET /api/local-agent/environment answers: the person's Macs, their folders, and their edit jobs' branches. */
export interface EnvironmentView {
  devices: DeviceRow[]
  folders: FolderRow[]
  /** Only for folders in `folders` (a removed folder's branches go with it). */
  worktrees: WorktreeRow[]
}

export async function readEnvironment(svc: Svc, userId: string): Promise<EnvironmentView> {
  const [devices, folders, worktrees] = await Promise.all([listDevices(svc, userId), listFolders(svc, userId), listWorktrees(svc, userId)])
  const live = new Set(folders.map((f) => f.id))
  return { devices, folders, worktrees: worktrees.filter((w) => live.has(w.folderId)) }
}

async function loadFolder(svc: Svc, userId: string, folderId: string): Promise<DbFolder | null> {
  if (!isUuid(folderId)) return null
  const { data, error } = await svc
    .from('device_folder')
    .select(FOLDER_SELECT)
    .eq('id', folderId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`folder read failed: ${error.message}`)
  return (data as DbFolder | null) ?? null
}

async function assertConversation(svc: Svc, userId: string, conversationId: string): Promise<{ workspaceId: string }> {
  if (!isUuid(conversationId)) throw new LocalAgentError('not_found', 'Conversation not found')
  const { data, error } = await svc
    .from('chat_conversations')
    .select('id, workspace_id')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`conversation read failed: ${error.message}`)
  if (!data) throw new LocalAgentError('not_found', 'Conversation not found')
  return { workspaceId: (data as { workspace_id: string }).workspace_id }
}

// ── Sessions ────────────────────────────────────────────────────────────────

const UNIQUE_VIOLATION = '23505'

async function sessionByKey(svc: Svc, userId: string, key: string): Promise<DbSession | null> {
  const { data } = await svc
    .from('local_agent_session')
    .select(SESSION_SELECT)
    .eq('idempotency_key', key)
    .eq('user_id', userId)
    .maybeSingle()
  return (data as DbSession | null) ?? null
}

// ── One agent per folder (teammate plan, WS-C) ──────────────────────────────

/** The statuses that hold a folder: migration 419's one-per-folder index (the code runs with or without it). */
export const FOLDER_HOLDING_STATUSES: readonly LocalAgentStatus[] = ['queued', 'starting', 'running', 'waiting', 'interrupted']
/** Migration 419's index; a unique violation naming it is a start that lost the race. */
export const FOLDER_LIVE_INDEX = 'local_agent_session_one_live_per_folder'
/** Why an idle agent ended when a start took its folder (the panel shows it), by who started: another chat, this chat, a loop. */
export const REPLACED_REASON = 'Another chat started Dial8 in this folder.'
export const REPLACED_BY_THIS_CHAT_REASON = 'A new request in this chat started Dial8 in this folder.'
export const REPLACED_BY_LOOP_REASON = 'One of your loops started Dial8 in this folder.'
export const REPLACED_BY_ACTION_REASON = 'One of your actions started Dial8 in this folder.'
/** The refusal's code (details.code), which the chat tools and the routes pass on. */
export const FOLDER_BUSY_CODE = 'FOLDER_BUSY'
/** addMessage's refusal when the session changed under it (ended, a stop asked, moved on): claimFolder decides again. */
export const SESSION_CHANGED_CODE = 'SESSION_CHANGED'

/**
 * Why a start can't take the folder: its agent works for another chat (or
 * loop), it's read-only and this edits, a loop step's job runs in the other
 * mode, it waits on the person's answer (a loop's request never answers it),
 * a stop was asked, or it kept changing as the start tried to join it.
 */
export type FolderBusyReason = 'other_chat' | 'read_only' | 'other_mode' | 'asking' | 'stopping' | 'changing'

/**
 * A session a loop started (WS-D, src/lib/local-agent/unattended.ts
 * parseUnattendedKey): its idempotency key carries this prefix, and C1 runs
 * its tools as unattended. A start never joins across that line: a loop's
 * request in a session the person started would run with the person's trust.
 */
export const UNATTENDED_KEY_PREFIX = 'local-agent-loop:'

/**
 * A session a person's Start on an action put on their Mac (environments E2,
 * unattended.ts startActionMacJob): `local-agent-action:<action>:start:<id>`.
 * Unattended like a loop's (the click is the only evidence of what they
 * want), with the same short queue, the same join rule, and its own words in
 * what it says.
 */
export const ACTION_JOB_KEY_PREFIX = 'local-agent-action:'

function isLoopKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(UNATTENDED_KEY_PREFIX)
}

function isActionJobKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(ACTION_JOB_KEY_PREFIX)
}

/** Started with nobody watching: a loop's job, or an action's Start on the Mac. */
export function isUnattendedKey(key: string | null | undefined): boolean {
  return isLoopKey(key) || isActionJobKey(key)
}

const ACTION_JOB_ID_RE = /^local-agent-action:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):start:/i

/** The action an action-started job works (its key), or null. unattended.ts parseActionJobKey reads the whole key. */
export function actionIdOfJobKey(key: string | null | undefined): string | null {
  const m = typeof key === 'string' ? ACTION_JOB_ID_RE.exec(key) : null
  return m ? m[1].toLowerCase() : null
}

/**
 * What an action's agent_run_status reads once its Mac job settles, in the
 * cloud path's values: `pr_open` once it opened a pull request, `failed` when
 * it failed (or expired before it ran), else `idle` (its turn ended with
 * nothing asked, it was stopped, or it ended idle). Null while it works or
 * asks: the action stays `working`.
 */
export function actionRunStatusFor(r: Pick<DbSession, 'status' | 'last_signal' | 'pr_url' | 'error'>): 'pr_open' | 'failed' | 'idle' | null {
  const settled = r.status === 'failed' || r.status === 'cancelled' || r.status === 'expired' || (r.status === 'waiting' && r.last_signal !== 'ask')
  if (!settled) return null
  if (typeof r.pr_url === 'string' && r.pr_url) return 'pr_open'
  if (r.status === 'failed') return 'failed'
  if (r.status === 'expired') return r.error === IDLE_REASON ? 'idle' : 'failed'
  return 'idle'
}

/** A coding run still in flight (agent-run/types.ts AGENT_RUN_LIVE_STATUSES; kept here to keep this module light). */
const AGENT_RUN_LIVE: readonly string[] = ['queued', 'running', 'needs_input', 'canceling']

/**
 * The job's own turn still holds its action: it works (queued, starting,
 * running, interrupted mid-turn), or it waits with something open (a
 * question, a queued turn, a message on its way, a native prompt or a push:
 * isIdle says no). The start-agent route's "busy" (unattended.ts), and what
 * settling checks the job held before it settles.
 */
export async function turnStillOpen(svc: Svc, r: DbSession): Promise<boolean> {
  if (r.status === 'queued' || r.status === 'starting' || r.status === 'running' || r.status === 'interrupted') return true
  return r.status === 'waiting' && !(await isIdle(svc, r))
}

/** It works on after this: a question, a queued turn, or a message on its way (its turn isn't over for its action). */
async function turnWorksOn(svc: Svc, r: DbSession): Promise<boolean> {
  if (r.status !== 'waiting') return false
  if (r.last_signal === 'ask' || r.pending_turn_text) return true
  const { data } = await svc.from('local_agent_message').select('id').eq('session_id', r.id).eq('user_id', r.user_id).eq('status', 'pending').limit(1)
  return ((data ?? []) as unknown[]).length > 0
}

/**
 * Settle the action's agent_run_status for an action-started Mac job
 * (environments E2), only on the transition that ends the job's OWN working
 * turn, the one its Start marked `working`:
 *   - `before` held its turn (turnStillOpen), or is null when the caller
 *     knows it did (a turn that ran in this upload, a joined request just
 *     dropped);
 *   - `after` has settled (actionRunStatusFor) and works on no further;
 *   - and the action still reads `working`.
 * A job that had already settled (waiting, nothing open) never settles again
 * when it is later ended (another start took its folder, a stop, its folder
 * removed, the 24-hour reap), so a later run's `working` (a teammate's cloud
 * run, the person's next Start) is never overwritten. A pull request that
 * lands later is settleLatePullRequest's. Best-effort: a failed write is logged.
 */
export async function settleActionRunStatus(svc: Svc, before: DbSession | null, after: DbSession): Promise<void> {
  const actionId = actionIdOfJobKey(after.idempotency_key)
  if (!actionId) return
  const status = actionRunStatusFor(after)
  if (!status) return
  try {
    if (before && !(await turnStillOpen(svc, before))) return
    if (await turnWorksOn(svc, after)) return
    const { error } = await svc
      .from('actions')
      .update({ agent_run_status: status })
      .eq('id', actionId)
      .eq('workspace_id', after.workspace_id)
      .eq('agent_run_status', 'working')
    if (error) console.warn('[local-agent] settling the action’s run status failed:', error.message)
  } catch (err) {
    console.warn('[local-agent] settling the action’s run status failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * A pull request that landed after the job's turn settled (a push the person
 * allowed after `finish`): the action goes `idle` → `pr_open`, and only while
 * nothing newer owns it: no live cloud run on the action, and no newer
 * action job for it. A job still mid-turn settles to pr_open itself when the
 * turn ends (its pr_url is set). Best-effort.
 */
async function settleLatePullRequest(svc: Svc, row: DbSession): Promise<void> {
  const actionId = actionIdOfJobKey(row.idempotency_key)
  if (!actionId) return
  try {
    const [runs, newer] = await Promise.all([
      svc.from('agent_run').select('id').eq('workspace_id', row.workspace_id).eq('action_id', actionId).in('status', [...AGENT_RUN_LIVE]).limit(1),
      svc
        .from('local_agent_session')
        .select('id')
        .eq('workspace_id', row.workspace_id)
        .like('idempotency_key', `${ACTION_JOB_KEY_PREFIX}${actionId}:start:%`)
        .gt('created_at', row.created_at)
        .limit(1),
    ])
    if (runs.error) throw new Error(runs.error.message)
    if (newer.error) throw new Error(newer.error.message)
    if (((runs.data ?? []) as unknown[]).length > 0 || ((newer.data ?? []) as unknown[]).length > 0) return
    const { error } = await svc
      .from('actions')
      .update({ agent_run_status: 'pr_open' })
      .eq('id', actionId)
      .eq('workspace_id', row.workspace_id)
      .eq('agent_run_status', 'idle')
    if (error) throw new Error(error.message)
  } catch (err) {
    console.warn('[local-agent] settling the action’s pull request failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Who a session works for, as far as joining goes: the person (attended), one
 * loop's step (`local-agent-loop:<flow>:step:<action>`, without its fire), or
 * one action (`local-agent-action:<action>`, without its start). A start
 * joins only a session of the same: a loop's request in another loop's job
 * would be reviewed against that loop's saved words.
 */
function joinKind(key: string | null | undefined): string {
  if (!isUnattendedKey(key)) return 'attended'
  const cut = key!.indexOf(isActionJobKey(key) ? ':start:' : ':fire:')
  return cut < 0 ? key! : key!.slice(0, cut)
}

/** How long a native question on the Mac (C3) may still be open: the longest wait, 30 min, and a minute's slack. */
export const PROMPT_OPEN_MS = 31 * 60_000
/** How long an allowed push may still be running (push.rs: the push 5 min, gh or the server route 1.5 min), with slack. */
export const PUSH_RUNNING_MS = 15 * 60_000

/**
 * Its turn ended with nothing open, so ending it loses nothing: waiting, no
 * question (its own or to its teammate), nothing queued, no message on its way
 * to the Mac, its ledger turn settled (no row counts; one it can't read
 * doesn't), and no native question open on the Mac (an edit job's push waits
 * there after `finish`).
 */
export async function isIdle(svc: Svc, r: DbSession): Promise<boolean> {
  if (r.status !== 'waiting' || r.last_signal === 'ask' || r.pending_turn_text) return false
  const { data: pending } = await svc
    .from('local_agent_message')
    .select('id')
    .eq('session_id', r.id)
    .eq('user_id', r.user_id)
    .eq('status', 'pending')
    .limit(1)
  if (((pending ?? []) as unknown[]).length > 0) return false
  // Its turn settled. No row (never recorded, or pruned): the session's own
  // state stands. One it can't read is not known to be.
  const turn = await turnState(svc, ledgerSessionOf(r))
  if (turn === 'unknown' || (turn !== 'none' && !SETTLED_TURN.has(turn))) return false
  const { data: prompt } = await svc
    .from('local_agent_event')
    .select('id, payload, created_at')
    .eq('session_id', r.id)
    .eq('user_id', r.user_id)
    .eq('kind', 'prompt')
    .order('id', { ascending: false })
    .limit(1)
  const last = ((prompt ?? []) as Array<{ id: number; payload?: { state?: unknown; prompt?: unknown } | null; created_at?: string }>)[0]
  const age = last?.created_at ? Date.now() - Date.parse(last.created_at) : Infinity
  if (last?.payload?.state === 'asking' && age < PROMPT_OPEN_MS) return false
  // A push the person allowed is running on the Mac until its pull_request event lands.
  if (last?.payload?.prompt === 'push' && last.payload.state === 'allowed' && age < PUSH_RUNNING_MS) {
    const { data: pr } = await svc
      .from('local_agent_event')
      .select('id')
      .eq('session_id', r.id)
      .eq('user_id', r.user_id)
      .eq('kind', 'pull_request')
      .gt('id', last.id)
      .limit(1)
    if (((pr ?? []) as unknown[]).length === 0) return false
  }
  return true
}

/**
 * The person said yes to this job's push on their Mac (Rust's `prompt` event,
 * push, allowed). Its pull request may still land after the job ended (a stop,
 * another chat taking the folder): the PR route and the pull_request ingest
 * take it then (teammate plan C5).
 */
export async function pushWasAllowed(svc: Svc, r: Pick<DbSession, 'id' | 'user_id'>): Promise<boolean> {
  const { data } = await svc
    .from('local_agent_event')
    .select('payload')
    .eq('session_id', r.id)
    .eq('user_id', r.user_id)
    .eq('kind', 'prompt')
    .order('id', { ascending: false })
    .limit(20)
  return ((data ?? []) as Array<{ payload?: { prompt?: unknown; state?: unknown } | null }>).some(
    (e) => e.payload?.prompt === 'push' && e.payload.state === 'allowed',
  )
}

/** The folder's live sessions (reaped), newest first. */
async function liveInFolder(svc: Svc, userId: string, folderId: string): Promise<DbSession[]> {
  const { data, error } = await svc
    .from('local_agent_session')
    .select(SESSION_SELECT)
    .eq('user_id', userId)
    .eq('folder_id', folderId)
    .in('status', FOLDER_HOLDING_STATUSES as LocalAgentStatus[])
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw new Error(`local agent sessions read failed: ${error.message}`)
  const now = Date.now()
  const out: DbSession[] = []
  for (const r of (data ?? []) as DbSession[]) {
    const row = staleness(r, now) ? await reapIfStale(svc, r, now) : r
    if ((FOLDER_HOLDING_STATUSES as string[]).includes(row.status)) out.push(row)
  }
  return out
}

/**
 * End an idle session quietly (CAS on the idle state isIdle read, its
 * updated_at included: a join or a message since makes it lose): its turn
 * already settled, so the ledger keeps its result. The Mac drops it on the
 * doorbell. `reason` says who took the folder.
 */
async function endIdle(svc: Svc, r: DbSession, reason: string): Promise<boolean> {
  const at = nowIso()
  let q = svc
    .from('local_agent_session')
    .update({ status: 'cancelled', error: reason, stop_requested_at: at, ended_at: at, lease_expires_at: null })
    .eq('id', r.id)
    .eq('user_id', r.user_id)
    .eq('status', 'waiting')
    .eq('updated_at', r.updated_at)
    .is('pending_turn_text', null)
  q = r.last_signal ? q.eq('last_signal', r.last_signal) : q.is('last_signal', null)
  const { data } = await q.select('id').maybeSingle()
  if (!data) return false
  // No settling: an idle job had settled already, and the action may be a later run's now.
  await ringDoorbell(svc, r.user_id, { reason: 'stop', sessionId: r.id })
  return true
}

type ClaimInput = {
  userId: string
  folderId: string
  conversationId: string | null
  request: string
  mode: LocalAgentMode
  startedBy: 'agent' | 'person'
  idempotencyKey?: string
  personWords?: readonly string[]
}

/** Who took the folder from an idle session, in the words its ended line shows. */
function replacedReason(cur: DbSession, input: ClaimInput): string {
  if (isActionJobKey(input.idempotencyKey)) return REPLACED_BY_ACTION_REASON
  if (isLoopKey(input.idempotencyKey)) return REPLACED_BY_LOOP_REASON
  return (cur.conversation_id ?? null) === (input.conversationId ?? null) ? REPLACED_BY_THIS_CHAT_REASON : REPLACED_REASON
}

/** The FOLDER_BUSY refusal, naming the folder's agent (only what names it: its request and words may be another chat's). */
function folderBusy(cur: DbSession | null, input: ClaimInput, reason: FolderBusyReason): LocalAgentError {
  const name = macTeammateName(cur?.device?.name)
  const label = cur?.folder?.label || 'this folder'
  const whose = !cur
    ? ''
    : isActionJobKey(cur.idempotency_key)
      ? ' for one of your actions'
      : isLoopKey(cur.idempotency_key)
        ? ' for one of your loops'
        : (cur.conversation_id ?? null) === (input.conversationId ?? null)
          ? ' for you in this chat'
          : ' for another chat'
  const message =
    reason === 'read_only'
      ? `${name} is already working in ${label}, read-only. One agent works in a folder at a time: wait for it to finish, or stop it, before starting one that edits.`
      : reason === 'other_mode'
        ? `${name} is already working in ${label}${whose}, ${cur?.mode === 'edit' ? 'with edits' : 'read-only'}, and this asks for ${input.mode === 'edit' ? 'edits' : 'read-only'}. One agent works in a folder at a time: wait for it to finish, or stop it first.`
        : reason === 'asking'
          ? `${name} in ${label} is waiting on your answer. One agent works in a folder at a time: answer it, or stop it, first.`
          : reason === 'stopping'
            ? `${name} in ${label} is stopping. One agent works in a folder at a time: try again once it has stopped.`
            : reason === 'changing'
              ? `${name} in ${label} changed as this started. One agent works in a folder at a time: try again in a moment.`
              : `${name} is already working in ${label}${whose}. One agent works in a folder at a time: wait for it to finish, or stop it first.`
  return new LocalAgentError('conflict', message, {
    code: FOLDER_BUSY_CODE,
    reason,
    ...(cur ? { session: { id: cur.id, teammate: name, folder: label, status: cur.status, mode: cur.mode } } : {}),
  })
}

/**
 * One agent per folder, enforced here (the rule's other half is migration
 * 419's index, which closes the race). For the folder's live session:
 *   same chat and kind (the person's, or the same loop step's), nobody asked
 *     it to stop, its mode fits (covers it; a loop's: the same), and, for a
 *     loop's request, no open question (the person answers it, never a fire)
 *                                              → the request becomes its next
 *                                                turn (a queued message): `joined`;
 *   idle (its turn ended, nothing open)        → it ends quietly, and a new
 *     one starts (isIdle: settled, nothing pending, no prompt or push open);
 *   otherwise                                  → refused: FOLDER_BUSY, naming it.
 * A join that loses a race (another start ended it, a stop was asked, it moved
 * on) decides again, once; still changing, it's FOLDER_BUSY.
 */
async function claimFolder(svc: Svc, input: ClaimInput): Promise<{ joined: DbSession; messageId: string | null; same?: true } | null> {
  const loop = isUnattendedKey(input.idempotencyKey)
  let changed: DbSession | null = null
  for (let round = 0; round < 2; round++) {
    changed = null
    for (const cur of await liveInFolder(svc, input.userId, input.folderId)) {
      // The same start again (two Start presses at once share one key, and
      // the other one's insert landed between our key check and here): it is
      // this start's own job, never a second turn of it.
      if (input.idempotencyKey && cur.idempotency_key === input.idempotencyKey) return { joined: cur, messageId: null, same: true }
      const sameKind =
        (cur.conversation_id ?? null) === (input.conversationId ?? null) && joinKind(cur.idempotency_key) === joinKind(input.idempotencyKey)
      // A retried fire whose request this job already holds joined it: said so,
      // whatever the job is doing now (asking, being stopped).
      if (loop && sameKind && input.idempotencyKey) {
        const held = await messageByKey(svc, input.userId, cur.id, startKeyOf(input.idempotencyKey))
        if (held) return { joined: (await loadSession(svc, input.userId, cur.id)) ?? cur, messageId: held }
      }
      const modeFits = loop ? cur.mode === input.mode : MODE_RANK[cur.mode] >= MODE_RANK[input.mode]
      const asking = loop && cur.last_signal === 'ask'
      // A job being stopped never takes another turn: the stop would refuse
      // its calls and the request would be lost. Idle, it ends; else it's busy.
      if (sameKind && !cur.stop_requested_at && modeFits && !asking) {
        try {
          const sent = await addMessage(svc, {
            userId: input.userId,
            sessionId: cur.id,
            author: input.startedBy,
            text: input.request,
            policy: 'queue',
            ...(input.idempotencyKey ? { idempotencyKey: startKeyOf(input.idempotencyKey) } : {}),
            ...(input.personWords ? { personWords: input.personWords } : {}),
            // A loop's request never answers a question the server sees asked
            // before its write lands (one the Mac asks after taking it is the Mac's).
            ...(loop ? { refuseAsk: true } : {}),
          })
          return { joined: (await loadSession(svc, input.userId, cur.id)) ?? cur, messageId: sent.messageId }
        } catch (err) {
          // It ended or changed under the join (another start ended it, a stop,
          // a question asked meanwhile): decide again.
          if (!(err instanceof LocalAgentError) || err.code !== 'conflict') throw err
          changed = cur
          break
        }
      }
      // Idle is strict (settled, nothing open, nothing on its way, no push
      // running), so ending one loses nothing, whoever starts next: a loop
      // included, or the person's finished jobs would hold a folder for a day.
      // An ending that lost to a write since the read (a message, the Mac)
      // decides again, as a join does.
      if (await isIdle(svc, cur)) {
        if (await endIdle(svc, cur, replacedReason(cur, input))) continue
        changed = cur
        break
      }
      const reason: FolderBusyReason = !sameKind
        ? 'other_chat'
        : cur.stop_requested_at
          ? 'stopping'
          : asking
            ? 'asking'
            : loop
              ? 'other_mode'
              : 'read_only'
      throw folderBusy(cur, input, reason)
    }
    if (!changed) return null
  }
  throw folderBusy(changed, input, 'changing')
}

/**
 * The session's environment (migration 420): its device's Mac environment,
 * written when it starts and only then. Best-effort: a failed read starts the
 * job without one, as before the environments existed.
 */
async function sessionEnvironmentId(svc: Svc, userId: string, folder: DbFolder): Promise<string | null> {
  try {
    return (await macEnvironmentId(svc, userId, folder.device_id)) ?? (await ensureMacEnvironment(svc, userId, folder.device_id, folder.device?.name ?? ''))
  } catch (err) {
    console.warn('[local-agent] session environment lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * An edit job's base branch (E3): the folder's setting, only on a Mac whose
 * app says it resolves one (`baseBranch` in its capabilities), and only when
 * it still matches the strict pattern. Anything else is null: the Mac
 * branches from HEAD, as before. A read that fails is null too.
 */
async function sessionBaseBranch(svc: Svc, folder: DbFolder, mode: LocalAgentMode): Promise<string | null> {
  if (mode !== 'edit') return null
  const caps = folder.device?.capabilities
  if (!Array.isArray(caps) || !caps.includes('baseBranch')) return null
  const { data, error } = await svc.from('device_folder_setting').select('base_branch').eq('device_folder_id', folder.id).maybeSingle()
  if (error) {
    console.warn('[local-agent] base branch read failed:', error.message)
    return null
  }
  const branch = (data as { base_branch?: unknown } | null)?.base_branch
  return isBaseBranch(branch) ? branch : null
}

/** Why a start on a removed Mac is refused (environments, "Remove this Mac"). */
export const MAC_REMOVED_REASON = 'This Mac was removed from Dial8. Add a folder on it again to use it.'

function macRemoved(): LocalAgentError {
  return new LocalAgentError('conflict', MAC_REMOVED_REASON, { code: 'DEVICE_REMOVED' })
}

/** The message key a start that joins a job carries (a retried start finds it). */
function startKeyOf(key: string): string {
  return `start:${key}`.slice(0, 1000)
}

/** A new session's queue life: the caller's, when sane and shorter, else QUEUED_TTL_MS. */
function queuedTtlOf(ms: number | undefined): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(ms, QUEUED_TTL_MS) : QUEUED_TTL_MS
}

/**
 * Start a local agent. Validates the folder (owned, not revoked, `mode` at most
 * the folder's), records turn 1's ledger row and rings the doorbell. The new
 * session records its Mac environment and, for an edit job on a Mac whose app
 * resolves one, its folder's base branch (migration 420), both written now
 * and only now: a later change to either never moves it. With an
 * `idempotencyKey`, a retried call returns the existing session
 * (`created: false`). One agent per folder (claimFolder): a start in a folder
 * whose agent works for this chat becomes its next turn (`joined: true`), and
 * one that can't be taken there is refused (LocalAgentError 'conflict',
 * details.code FOLDER_BUSY). Every session has a conversation: its thread,
 * where C1 puts its approval cards (teammate plan C4).
 */
export async function createSession(
  svc: Svc,
  input: {
    userId: string
    workspaceId: string
    folderId: string
    conversationId: string | null
    request: string
    mode: LocalAgentMode
    startedBy: 'agent' | 'person'
    idempotencyKey?: string
    /** The person's own words from the chat turn that started it (personWordsOf): the reviewer's evidence. */
    personWords?: readonly string[]
    /**
     * How long a new session waits for a Mac to claim it, at most
     * QUEUED_TTL_MS (6 hours). A loop's job waits 15 minutes
     * (src/lib/local-agent/unattended.ts): one claimed hours later would
     * start with nobody expecting it.
     */
    queuedTtlMs?: number
  },
  attempt = 0,
): Promise<{ session: SessionRow; created: boolean; deviceOnline: boolean; joined?: true }> {
  const request = cleanText(input.request, 'request', LOCAL_AGENT_REQUEST_MAX_BYTES)
  if (input.mode !== 'read' && input.mode !== 'edit') throw new LocalAgentError('bad_request', 'mode must be read or edit')
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 1000)) {
    throw new LocalAgentError('bad_request', 'invalid idempotency key')
  }

  if (input.idempotencyKey) {
    const existing = await sessionByKey(svc, input.userId, input.idempotencyKey)
    if (existing) {
      const row = await reapIfStale(svc, existing)
      return { session: toSessionRow(row), created: false, deviceOnline: isOnline(row.device?.last_seen_at) }
    }
  }

  const folder = await loadFolder(svc, input.userId, input.folderId)
  if (!folder || folder.revoked_at) throw new LocalAgentError('not_found', 'Folder not found')
  if (folder.device?.removed_at) throw macRemoved()
  if (MODE_RANK[input.mode] > MODE_RANK[folder.mode]) {
    throw new LocalAgentError('forbidden', `This folder is read-only on ${folder.device?.name || 'your Mac'}; edits must be allowed on the Mac`)
  }
  // C1 refuses a session without one (409 NO_CONVERSATION): never make one.
  if (!input.conversationId) throw new LocalAgentError('bad_request', 'A local agent needs a conversation to report in')
  await assertConversation(svc, input.userId, input.conversationId)

  const joined = await claimFolder(svc, { ...input, request })
  if (joined) {
    return {
      session: toSessionRow(joined.joined),
      created: false,
      deviceOnline: isOnline(joined.joined.device?.last_seen_at),
      ...(joined.same ? {} : { joined: true as const }),
    }
  }

  const now = Date.now()
  const [environmentId, baseBranch] = await Promise.all([
    sessionEnvironmentId(svc, input.userId, folder),
    sessionBaseBranch(svc, folder, input.mode),
  ])
  const { data, error } = await svc
    .from('local_agent_session')
    .insert({
      user_id: input.userId,
      workspace_id: input.workspaceId,
      device_id: folder.device_id,
      folder_id: folder.id,
      ...(environmentId ? { environment_id: environmentId } : {}),
      ...(baseBranch ? { base_branch: baseBranch } : {}),
      conversation_id: input.conversationId,
      started_by: input.startedBy,
      mode: input.mode,
      request,
      status: 'queued',
      expires_at: nowIso(now + queuedTtlOf(input.queuedTtlMs)),
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select(SESSION_SELECT)
    .maybeSingle()
  if (error || !data) {
    if (error?.code === UNIQUE_VIOLATION && input.idempotencyKey) {
      const existing = await sessionByKey(svc, input.userId, input.idempotencyKey)
      if (existing) return { session: toSessionRow(existing), created: false, deviceOnline: isOnline(existing.device?.last_seen_at) }
    }
    // Another start in this folder won the race (migration 419's index): decide again against it.
    // Lost twice, the folder is busy with whoever keeps winning.
    if (error?.code === UNIQUE_VIOLATION && `${error.message ?? ''} ${(error as { details?: string }).details ?? ''}`.includes(FOLDER_LIVE_INDEX)) {
      if (attempt === 0) return createSession(svc, input, 1)
      const [winner] = await liveInFolder(svc, input.userId, input.folderId)
      throw folderBusy(winner ?? null, { ...input, request }, 'changing')
    }
    throw new Error(`local agent session insert failed: ${error?.message ?? 'no row'}`)
  }
  let row = data as DbSession
  // "Remove this Mac" marks the device before it looks for live jobs: one it
  // marked while this start was between its check and its insert is seen
  // here (the insert's own read of the device), so the start ends and is
  // refused, never left running on a removed Mac.
  if (row.device?.removed_at) {
    await svc
      .from('local_agent_session')
      .update({ status: 'cancelled', error: MAC_REMOVED_REASON, ended_at: nowIso(), lease_expires_at: null })
      .eq('id', row.id)
      .eq('user_id', input.userId)
    throw macRemoved()
  }
  await keepPersonWords(svc, 'local_agent_session', row.id, input.userId, input.personWords ?? [])

  // Turn 1's ledger row (queued: the Mac hasn't claimed it yet).
  const ledger = ledgerSessionOf(row)
  const trackedJobId = await startTurnRow(svc, ledger, { turn: 1, text: request, status: 'queued' })
  if (trackedJobId) {
    const { data: linked } = await svc
      .from('local_agent_session')
      .update({ tracked_job_id: trackedJobId, current_tracked_job_id: trackedJobId })
      .eq('id', row.id)
      .eq('user_id', input.userId)
      .select(SESSION_SELECT)
      .maybeSingle()
    row = (linked as DbSession | null) ?? { ...row, tracked_job_id: trackedJobId, current_tracked_job_id: trackedJobId }
  }

  await ringDoorbell(svc, input.userId, { reason: 'start', sessionId: row.id })
  return { session: toSessionRow(row), created: true, deviceOnline: isOnline(row.device?.last_seen_at, now) }
}

/**
 * A message to a local agent (`author`: the Dial8 agent or the person). It
 * writes the message and its `inbound` transcript event and rings the
 * doorbell. With an `idempotencyKey` (`person:<requestId>`, `steer:<id>`,
 * `local-agent-msg:<conv>:session:…:call:<c>`), a retried send returns the
 * first message (`requeued: false, duplicate: true`) and writes nothing: no
 * event, no ledger move, no doorbell.
 *
 * The ledger opens turns ONLY here (never from a device event):
 *   idle (waiting), turn settled      → the next turn's row, now (queued)
 *   working + 'queue'                 → the turn after this one, opened at its
 *                                       end (pending_turn_text), unless it ends
 *                                       on a question, which this then answers
 *   waiting on a question             → resume() the asking turn
 *   interrupted, lease lapsed         → back to queued (the Mac resumes its eve
 *                                       session: `requeued: true`); its parked
 *                                       turn resumes when the Mac claims it
 */
export async function addMessage(
  svc: Svc,
  input: {
    userId: string
    sessionId: string
    author: 'agent' | 'person'
    text: string
    policy: 'steer' | 'queue'
    idempotencyKey?: string
    /** With an `agent` message from a typed chat turn: the person's own words in it (the reviewer's evidence). */
    personWords?: readonly string[]
    /**
     * A loop's request (claimFolder): it never answers the job's open question.
     * Refused (SESSION_CHANGED) when the job asks, read before the write or at
     * any decision after it.
     */
    refuseAsk?: boolean
  },
): Promise<{ messageId: string; requeued: boolean; duplicate?: true }> {
  const text = cleanText(input.text, 'text', LOCAL_AGENT_MESSAGE_MAX_BYTES)
  if (input.author !== 'agent' && input.author !== 'person') throw new LocalAgentError('bad_request', 'invalid author')
  if (input.policy !== 'steer' && input.policy !== 'queue') throw new LocalAgentError('bad_request', 'policy must be steer or queue')
  const key = input.idempotencyKey
  if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 1000)) {
    throw new LocalAgentError('bad_request', 'invalid idempotency key')
  }
  const row = await loadSession(svc, input.userId, input.sessionId)
  if (!row) throw new LocalAgentError('not_found', 'Local agent not found')
  if (key) {
    const existing = await messageByKey(svc, input.userId, row.id, key)
    if (existing) return { messageId: existing, requeued: false, duplicate: true }
  }
  if ((TERMINAL_STATUSES as string[]).includes(row.status)) {
    throw new LocalAgentError('conflict', `This local agent has ${row.status === 'expired' ? 'expired' : row.status === 'cancelled' ? 'been stopped' : 'failed'}; start a new one`, { status: row.status })
  }
  if (input.refuseAsk && row.last_signal === 'ask') throw waitingOnAnswer(row)

  const now = Date.now()
  const leaseLiveOf = (r: DbSession) => !!r.lease_expires_at && Date.parse(r.lease_expires_at) >= now
  const workingOf = (r: DbSession) => r.status === 'starting' || r.status === 'running' || (r.status === 'interrupted' && leaseLiveOf(r))
  // An answer that lands while its turn still reads as working (the Mac body's
  // question to its teammate is asked mid-turn, and that turn's end may not
  // have reached the server yet) goes as `queue`: the Mac then always runs it
  // as a turn of its own, the one pending_turn_text opens below.
  const policy: 'steer' | 'queue' = workingOf(row) && row.last_signal === 'ask' ? 'queue' : input.policy

  const { data: msg, error } = await svc
    .from('local_agent_message')
    .insert({
      session_id: row.id,
      user_id: input.userId,
      author: input.author,
      text,
      policy,
      status: 'pending',
      ...(key ? { idempotency_key: key } : {}),
    })
    .select('id')
    .single()
  if (error || !msg) {
    if (error?.code === UNIQUE_VIOLATION && key) {
      const existing = await messageByKey(svc, input.userId, row.id, key)
      if (existing) return { messageId: existing, requeued: false, duplicate: true }
    }
    throw new Error(`local agent message insert failed: ${error?.message ?? 'no row'}`)
  }
  const messageId = (msg as { id: string }).id
  if (input.author === 'agent') await keepPersonWords(svc, 'local_agent_message', messageId, input.userId, input.personWords ?? [])

  // The transcript keeps the message in order with the device's events.
  const { data: inbound, error: evError } = await svc
    .from('local_agent_event')
    .insert({
      session_id: row.id,
      user_id: input.userId,
      source: 'server',
      kind: 'inbound',
      payload: { author: input.author, text, policy, messageId },
    })
    .select('id')
    .maybeSingle()
  if (evError) console.warn('[local-agent] inbound event insert failed:', evError.message)

  // The session takes the message in one CAS on the state it was decided
  // from: its status, and no stop asked. Lost (the Mac moved it on), it reads
  // again and decides once more; ended or being stopped, the message is taken
  // back and the call refused (SESSION_CHANGED: a start decides again).
  let decided = row
  let requeued = false
  // The Mac took the message before the session write landed: it ran it as decided.
  let taken: 'delivered' | 'failed' | null = null
  // Sent while the session kept changing: no decision to record.
  let kept = false
  for (let attempt = 0; ; attempt++) {
    const leaseLive = leaseLiveOf(decided)
    const patch: Record<string, unknown> = { updated_at: nowIso(now) }
    // The question (or the finished turn) is answered: the home-turn gate on
    // message_local_agent (last_signal = 'ask') closes with it.
    if (decided.last_signal) {
      patch.last_signal = null
      patch.last_signal_text = null
    }
    // A queued message while a turn runs is the next turn (an early answer included, above).
    // So is one to a job no Mac has claimed yet (a start that joined it): the
    // Mac runs it after the request, and its turn needs a row to report on.
    if ((workingOf(decided) || decided.status === 'queued') && policy === 'queue' && !decided.pending_turn_text) patch.pending_turn_text = text
    // Back to the queue only when no Mac holds it: a live lease means the Mac
    // woke up and is still working on it. It waits as long as the job's own
    // queue (a loop's 15 minutes).
    const requeue = decided.status === 'interrupted' && !leaseLive
    if (requeue) {
      Object.assign(patch, {
        status: 'queued',
        expires_at: nowIso(now + queuedTtlFor(decided)),
        lease_expires_at: null,
        claimed_at: null,
      })
    }
    // The state it was decided from, its question included (as endIdle compares it).
    let cas = svc
      .from('local_agent_session')
      .update(patch)
      .eq('id', decided.id)
      .eq('user_id', input.userId)
      .eq('status', decided.status)
      .is('stop_requested_at', null)
    cas = decided.last_signal ? cas.eq('last_signal', decided.last_signal) : cas.is('last_signal', null)
    const { data: updated } = await cas.select('id').maybeSingle()
    if (updated) {
      requeued = requeue
      break
    }
    // The Mac may have taken the message and moved the session on as it ran
    // it: then it was decided right (the ledger moves from that decision), and
    // nothing more is written to the session (no queued turn behind its own).
    taken = await messageTaken(svc, input.userId, messageId)
    if (taken) break
    const fresh = await loadSession(svc, input.userId, decided.id)
    const live = !!fresh && !(TERMINAL_STATUSES as string[]).includes(fresh.status) && !fresh.stop_requested_at
    // A loop's request to a job that asked meanwhile: taken back, never the answer.
    const asking = !!input.refuseAsk && fresh?.last_signal === 'ask'
    if (live && !asking) {
      if (attempt < MESSAGE_DECIDE_TRIES - 1) {
        decided = fresh
        continue
      }
      // Still live and still moving: the message stays (the Mac may hold it
      // already, and taking it back would have it sent twice). It's sent; the
      // session and the ledger record only that it answers an open question.
      console.warn('[local-agent] a message went out while its session kept changing:', decided.id)
      kept = true
      await answerOpenQuestion(svc, fresh)
      break
    }
    if (await takeBackMessage(svc, input.userId, messageId, (inbound as { id?: number } | null)?.id ?? null)) {
      if (asking) throw waitingOnAnswer(fresh!)
      throw new LocalAgentError('conflict', 'This local agent has ended or is stopping; nothing was sent. Start a new one.', {
        code: SESSION_CHANGED_CODE,
        status: fresh?.status ?? null,
      })
    }
    // The Mac took it between the check and the take-back: sent, as decided.
    taken = (await messageTaken(svc, input.userId, messageId)) ?? 'delivered'
    break
  }

  // One the Mac couldn't take opens no turn (its ack reported it: device.ts undelivered).
  if (taken === 'failed' || kept) {
    await ringDoorbell(svc, input.userId, { reason: 'message', sessionId: row.id })
    return { messageId, requeued }
  }

  // Ledger.
  const ledger = ledgerSessionOf(decided)
  const turn = await turnStatus(svc, ledger)
  // Its open question is answered. A device's question parks the turn only
  // once it ended (waiting); the Mac body's message_teammate parks it as it
  // asks, so the answer may land while that turn is still winding down.
  if (turn === 'needs_input' && decided.last_signal === 'ask') {
    await moveTurn(svc, ledger, { type: 'resume' })
  } else if (
    (decided.status === 'waiting' || (decided.status === 'interrupted' && !leaseLiveOf(decided))) &&
    (turn === null || SETTLED_TURN.has(turn))
  ) {
    // An idle session whose turn settled: this message is the next turn.
    await nextTurn(svc, ledger, { text, status: 'queued' })
  }

  await ringDoorbell(svc, input.userId, { reason: 'message', sessionId: row.id })
  return { messageId, requeued }
}

/** A session's queue life: an unattended job (a loop's, an action's) waits 15 minutes, a person's 6 hours. */
function queuedTtlFor(r: Pick<DbSession, 'idempotency_key'>): number {
  return isUnattendedKey(r.idempotency_key) ? LOOP_QUEUED_TTL_MS : QUEUED_TTL_MS
}

/**
 * A message kept on a session that kept changing answers the question it
 * holds now, as any sent message does: the question closes (CAS on its
 * words) and its parked turn resumes. Without it the answered job would read
 * as asking until it expired.
 */
async function answerOpenQuestion(svc: Svc, r: DbSession): Promise<void> {
  if (r.last_signal !== 'ask') return
  let q = svc.from('local_agent_session').update({ last_signal: null, last_signal_text: null }).eq('id', r.id).eq('user_id', r.user_id).eq('last_signal', 'ask')
  q = r.last_signal_text === null ? q.is('last_signal_text', null) : q.eq('last_signal_text', r.last_signal_text)
  const { data } = await q.select('id').maybeSingle()
  if (!data) return
  const ledger = ledgerSessionOf(r)
  if ((await turnStatus(svc, ledger)) === 'needs_input') await moveTurn(svc, ledger, { type: 'resume' })
}

/** How many times addMessage decides against a session that keeps changing under its write. */
const MESSAGE_DECIDE_TRIES = 3

/** A loop's request refused because the job waits on the person's answer (claimFolder: FOLDER_BUSY 'asking'). */
function waitingOnAnswer(r: Pick<DbSession, 'status'>): LocalAgentError {
  return new LocalAgentError('conflict', "This local agent is waiting on the person's answer, which a loop's request never gives; nothing was sent.", {
    code: SESSION_CHANGED_CODE,
    reason: 'asking',
    status: r.status,
  })
}

/** The message left `pending` (the Mac acked it): how, or null while it waits. */
async function messageTaken(svc: Svc, userId: string, messageId: string): Promise<'delivered' | 'failed' | null> {
  const { data } = await svc.from('local_agent_message').select('status').eq('id', messageId).eq('user_id', userId).maybeSingle()
  const status = (data as { status?: unknown } | null)?.status
  return status === 'delivered' || status === 'failed' ? status : null
}

/** Take back a message its session refused, while it's still pending (and its inbound line). False: the Mac took it already. */
async function takeBackMessage(svc: Svc, userId: string, messageId: string, inboundId: number | null): Promise<boolean> {
  const { count } = await svc.from('local_agent_message').delete({ count: 'exact' }).eq('id', messageId).eq('user_id', userId).eq('status', 'pending')
  if (!count) return false
  if (inboundId !== null) await svc.from('local_agent_event').delete().eq('id', inboundId).eq('user_id', userId)
  return true
}

const SETTLED_TURN: ReadonlySet<string> = new Set(['needs_review', 'done', 'failed', 'canceled', 'skipped'])

async function messageByKey(svc: Svc, userId: string, sessionId: string, key: string): Promise<string | null> {
  const { data } = await svc
    .from('local_agent_message')
    .select('id')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .eq('idempotency_key', key)
    .maybeSingle()
  return (data as { id?: string } | null)?.id ?? null
}

/**
 * Stop a local agent. A queued (never claimed) or interrupted session is
 * cancelled at once; a live one gets `stop_requested_at` and the doorbell, and
 * the Mac's `cancelled` status settles it.
 */
export async function requestStop(svc: Svc, userId: string, sessionId: string): Promise<SessionRow> {
  const row = await loadSession(svc, userId, sessionId)
  if (!row) throw new LocalAgentError('not_found', 'Local agent not found')
  if ((TERMINAL_STATUSES as string[]).includes(row.status)) return toSessionRow(row)
  const now = nowIso()
  if (row.status === 'queued' || row.status === 'interrupted') {
    const { data } = await svc
      .from('local_agent_session')
      .update({ status: 'cancelled', stop_requested_at: now, ended_at: now, lease_expires_at: null })
      .eq('id', row.id)
      .eq('user_id', userId)
      .eq('status', row.status)
      .select(SESSION_SELECT)
      .maybeSingle()
    if (data) {
      const cancelled = data as DbSession
      await moveTurn(svc, ledgerSessionOf(cancelled), { type: 'cancel' })
      await settleActionRunStatus(svc, row, cancelled)
      // An interrupted job may still be on the Mac's list: tell it too.
      if (row.status === 'interrupted') await ringDoorbell(svc, userId, { reason: 'stop', sessionId: row.id })
      return toSessionRow(cancelled)
    }
    // The Mac claimed it meanwhile: fall through to a requested stop.
  }
  const { data } = await svc
    .from('local_agent_session')
    .update({ stop_requested_at: now })
    .eq('id', row.id)
    .eq('user_id', userId)
    .in('status', ['queued', 'starting', 'running', 'waiting'])
    .select(SESSION_SELECT)
    .maybeSingle()
  await ringDoorbell(svc, userId, { reason: 'stop', sessionId: row.id })
  return toSessionRow((data as DbSession | null) ?? (await loadSession(svc, userId, sessionId)) ?? row)
}

// ── The Mac body's teammate tools (teammate plan C4) ────────────────────────

/** report_to_person's and message_teammate's text, at most (a report's and a question's old caps were 4000 and 2000). */
export const TEAMMATE_TEXT_MAX = 4000
/** How many of a kind's newest server events a retry's key is looked for in. */
const KEY_SCAN = 50
/**
 * message_teammate's caps (teammate plan, decided after the review of #892
 * and #897): each one starts a paid home turn of the cloud body. Per job per
 * rolling hour, per job in all, and per person per day. Past any of them the
 * call is refused and the Mac body carries on or finishes.
 */
export const TEAMMATE_MESSAGES_PER_HOUR = 6
export const TEAMMATE_MESSAGES_PER_JOB = 30
export const TEAMMATE_MESSAGES_PER_DAY = 60
export const TEAMMATE_CAP_CODE = 'TEAMMATE_CAP'
/** report_to_person, at most, per job per rolling hour (a note in its own thread: no paid turn, but no flood either). */
export const REPORTS_PER_HOUR = 30
export const REPORT_CAP_CODE = 'REPORT_CAP'

/** Server events of `kind` written by `via` (a teammate tool), in a scope: the job (optionally since), or the person since. */
async function countVia(
  svc: Svc,
  scope: { sessionId?: string; userId: string; since?: number },
  kind: 'ask' | 'report',
  via: string,
  max: number,
): Promise<number> {
  let q = svc.from('local_agent_event').select('id, payload').eq('user_id', scope.userId).eq('source', 'server').eq('kind', kind)
  if (scope.sessionId) q = q.eq('session_id', scope.sessionId)
  if (scope.since !== undefined) q = q.gte('created_at', nowIso(scope.since))
  const { data, error } = await q.order('id', { ascending: false }).limit(max * 3)
  // Can't count: say it's full rather than start paid turns unbounded.
  if (error) return max
  return ((data ?? []) as Array<{ payload?: { via?: unknown } | null }>).filter((e) => e.payload?.via === via).length
}

type TeammateCap = 'hour' | 'job' | 'day'

const TEAMMATE_CAP_WORDS: Record<TeammateCap, string> = {
  hour: `${TEAMMATE_MESSAGES_PER_HOUR} times on this job in the last hour`,
  job: `${TEAMMATE_MESSAGES_PER_JOB} times on this job`,
  day: `${TEAMMATE_MESSAGES_PER_DAY} times today, across this person's jobs`,
}

/** Which of message_teammate's caps the job is at (before this call is recorded), or null. */
async function teammateCapHit(svc: Svc, row: DbSession, now = Date.now()): Promise<TeammateCap | null> {
  const [hour, job, day] = await Promise.all([
    countVia(svc, { sessionId: row.id, userId: row.user_id, since: now - 60 * 60_000 }, 'ask', 'message_teammate', TEAMMATE_MESSAGES_PER_HOUR),
    countVia(svc, { sessionId: row.id, userId: row.user_id }, 'ask', 'message_teammate', TEAMMATE_MESSAGES_PER_JOB),
    countVia(svc, { userId: row.user_id, since: now - 24 * 60 * 60_000 }, 'ask', 'message_teammate', TEAMMATE_MESSAGES_PER_DAY),
  ])
  if (hour >= TEAMMATE_MESSAGES_PER_HOUR) return 'hour'
  if (job >= TEAMMATE_MESSAGES_PER_JOB) return 'job'
  if (day >= TEAMMATE_MESSAGES_PER_DAY) return 'day'
  return null
}

const MISSING_FUNCTION_CODES: ReadonlySet<string> = new Set(['PGRST202', '42883'])

type AskRecord = { status: 'recorded' | 'duplicate'; id: number } | { status: 'capped'; cap: TeammateCap } | { status: 'ended' }

/**
 * Record message_teammate's question in the thread, only when it is under
 * every cap: migration 419's local_agent_teammate_ask counts and inserts as
 * one step under a per-person lock, so a refused question is never written
 * (the Agents panel shows inserts live) and two calls at once can't both slip
 * under a cap. Before 419 the same steps run without its lock.
 */
async function recordTeammateAsk(svc: Svc, row: DbSession, text: string, key: string): Promise<AskRecord> {
  const { data, error } = await svc.rpc('local_agent_teammate_ask', {
    p_session_id: row.id,
    p_user_id: row.user_id,
    p_key: key,
    p_question: text,
    p_per_hour: TEAMMATE_MESSAGES_PER_HOUR,
    p_per_job: TEAMMATE_MESSAGES_PER_JOB,
    p_per_day: TEAMMATE_MESSAGES_PER_DAY,
  })
  if (!error) {
    const out = data as { status?: unknown; id?: unknown; cap?: unknown } | null
    if ((out?.status === 'recorded' || out?.status === 'duplicate') && typeof out.id === 'number') return { status: out.status, id: out.id }
    if (out?.status === 'capped' && (out.cap === 'hour' || out.cap === 'job' || out.cap === 'day')) return { status: 'capped', cap: out.cap }
    // The session ended between the read and the lock.
    if (out?.status === 'ended') return { status: 'ended' }
    throw new Error('local agent question: unexpected answer from local_agent_teammate_ask')
  }
  if (!MISSING_FUNCTION_CODES.has((error as { code?: string }).code ?? '')) throw new Error(`local agent question failed: ${error.message}`)
  const existing = await serverEventByKey(svc, row, 'ask', key)
  if (existing !== null) return { status: 'duplicate', id: existing }
  const cap = await teammateCapHit(svc, row)
  if (cap) return { status: 'capped', cap }
  const id = await addServerEvent(svc, row, 'ask', { question: text, via: 'message_teammate', key })
  if (id === null) throw new Error('local agent question: the insert returned no row')
  return { status: 'recorded', id }
}

/**
 * The job moved past this question: a newer question (either body's) or a
 * message (an answer, or anything sent since) reached it. A retry of a call
 * the job moved past changes nothing.
 */
async function movedPast(svc: Svc, row: DbSession, eventId: number): Promise<boolean> {
  const { data: newer } = await svc
    .from('local_agent_event')
    .select('id')
    .eq('session_id', row.id)
    .eq('user_id', row.user_id)
    .eq('kind', 'ask')
    .gt('id', eventId)
    .limit(1)
  if (((newer ?? []) as unknown[]).length > 0) return true
  const { data: event } = await svc.from('local_agent_event').select('created_at').eq('id', eventId).eq('user_id', row.user_id).maybeSingle()
  const at = (event as { created_at?: unknown } | null)?.created_at
  if (typeof at !== 'string') return true
  const { data } = await svc.from('local_agent_message').select('id').eq('session_id', row.id).eq('user_id', row.user_id).gte('created_at', at).limit(1)
  return ((data ?? []) as unknown[]).length > 0
}

/** A session the Mac body may still write to: its own, in its workspace, not ended. */
async function teammateSession(svc: Svc, input: { userId: string; workspaceId: string; sessionId: string }): Promise<DbSession> {
  const row = await loadSession(svc, input.userId, input.sessionId)
  if (!row || row.workspace_id !== input.workspaceId) throw new LocalAgentError('not_found', 'Local agent not found')
  if ((TERMINAL_STATUSES as string[]).includes(row.status)) {
    throw new LocalAgentError('conflict', 'This session has ended; nothing was sent.', { status: row.status })
  }
  return row
}

/** The server event a call with this key already wrote (eve retries a call it lost the answer to). */
async function serverEventByKey(svc: Svc, row: DbSession, kind: string, key: string): Promise<number | null> {
  const { data } = await svc
    .from('local_agent_event')
    .select('id, payload')
    .eq('session_id', row.id)
    .eq('user_id', row.user_id)
    .eq('source', 'server')
    .eq('kind', kind)
    .order('id', { ascending: false })
    .limit(KEY_SCAN)
  const hit = ((data ?? []) as Array<{ id: number; payload?: { key?: unknown } | null }>).find((e) => e.payload?.key === key)
  return hit ? hit.id : null
}

async function addServerEvent(svc: Svc, row: DbSession, kind: string, payload: Record<string, unknown>): Promise<number | null> {
  const { data, error } = await svc
    .from('local_agent_event')
    .insert({ session_id: row.id, user_id: row.user_id, source: 'server', kind, payload })
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`local agent event insert failed: ${error.message}`)
  return (data as { id?: number } | null)?.id ?? null
}

/**
 * report_to_person: a note in the session's own thread (the Agents panel),
 * as a `report` the server writes. `key` (eve's ids) makes a retry write once.
 */
export async function addThreadReport(
  svc: Svc,
  input: { userId: string; workspaceId: string; sessionId: string; text: string; key: string },
): Promise<{ session: SessionRow; duplicate?: true }> {
  const text = cleanText(input.text, 'text', TEAMMATE_TEXT_MAX * 4)
  const row = await teammateSession(svc, input)
  if (await serverEventByKey(svc, row, 'report', input.key)) return { session: toSessionRow(row), duplicate: true }
  if ((await countVia(svc, { sessionId: row.id, userId: row.user_id, since: Date.now() - 60 * 60_000 }, 'report', 'report_to_person', REPORTS_PER_HOUR)) >= REPORTS_PER_HOUR) {
    throw new LocalAgentError(
      'conflict',
      `You have reported ${REPORTS_PER_HOUR} times on this job in the last hour, the most it takes. Nothing was shown. Carry on, and put what matters in your finish summary.`,
      { code: REPORT_CAP_CODE },
    )
  }
  await addServerEvent(svc, row, 'report', { text: text.slice(0, TEAMMATE_TEXT_MAX), via: 'report_to_person', key: input.key })
  return { session: toSessionRow(row) }
}

/**
 * message_teammate: the Mac body asks the cloud body (its teammate). The
 * question goes in the thread (a server `ask`), becomes the session's open
 * question (last_signal, so the cloud body's home turn may answer it with
 * message_local_agent), and parks the current turn on it (needs_input), which
 * reports it in the cloud body's chat and runs a home turn there. The answer
 * (the cloud body's, or the person's) arrives as the Mac body's next message.
 *
 * A call is proof the Mac is mid-turn: an idle or interrupted row goes back to
 * running with a fresh lease, so the turn's late `running` upload can't read
 * as a new turn and drop the question.
 *
 * A retried call (eve's ids are the key) acts once. It also finishes what an
 * earlier try left undone (a crash after the question was recorded), unless
 * the job has moved past the question (answered, or a newer one asked).
 */
export async function askTeammate(
  svc: Svc,
  input: { userId: string; workspaceId: string; sessionId: string; text: string; key: string },
): Promise<{ session: SessionRow; duplicate?: true }> {
  const text = cleanText(input.text, 'text', TEAMMATE_TEXT_MAX * 4).slice(0, TEAMMATE_TEXT_MAX)
  let row = await teammateSession(svc, input)
  const record = await recordTeammateAsk(svc, row, text, input.key)
  if (record.status === 'ended') throw new LocalAgentError('conflict', 'This session has ended; nothing was sent.', { status: 'ended' })
  if (record.status === 'capped') {
    throw new LocalAgentError(
      'conflict',
      `You have messaged Dial8 ${TEAMMATE_CAP_WORDS[record.cap]}, the most it takes. Nothing was sent. Carry on with what you have, or finish and say in your summary what you still need.`,
      { code: TEAMMATE_CAP_CODE },
    )
  }
  const retried = record.status === 'duplicate'
  if (retried && (await movedPast(svc, row, record.id))) return { session: toSessionRow(row), duplicate: true }
  let wrote = false
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      // A retry whose question the session already holds has nothing to write,
      // unless the session lapsed meanwhile: the call is proof the Mac is back.
      const held = retried && row.last_signal === 'ask' && row.last_signal_text === text && row.status !== 'interrupted'
      if (!held) {
        const patch: Record<string, unknown> = { last_signal: 'ask', last_signal_text: text }
        if (row.status === 'waiting' || row.status === 'interrupted') {
          patch.status = 'running'
          patch.lease_expires_at = nowIso(Date.now() + LEASE_MS)
        }
        const { data } = await svc
          .from('local_agent_session')
          .update(patch)
          .eq('id', row.id)
          .eq('user_id', row.user_id)
          .eq('status', row.status)
          .select(SESSION_SELECT)
          .maybeSingle()
        if (!data) {
          row = await teammateSession(svc, input)
          continue
        }
        row = data as DbSession
        wrote = true
      }
      let ledger = ledgerSessionOf(row)
      // A question needs an open turn to park on, or it never reaches the chat:
      // a turn the Mac runs past its settled row gets the next one now. A turn
      // parked on this question already (a retry, or one overlapping its
      // original) is left as it is: parking it again would report it twice.
      if (!(await parkedOnTeammate(svc, ledger, text))) {
        const turn = await turnStatus(svc, ledger)
        if (turn === null || SETTLED_TURN.has(turn)) ledger = await nextTurn(svc, ledger, { text, status: 'running' })
        await moveTurn(svc, ledger, { type: 'ask', question: text, from: 'teammate' })
      }
      return retried ? { session: toSessionRow(row), duplicate: true } : { session: toSessionRow(row) }
    }
    throw new Error('local agent session changed while its question was recorded')
  } catch (err) {
    // This call's question never reached the session: take it back, so a
    // retry starts clean. Once the session holds it, it stays (a retry finishes).
    if (!retried && !wrote) await svc.from('local_agent_event').delete().eq('id', record.id).eq('user_id', row.user_id)
    throw err
  }
}

// ── C5: the pull request ────────────────────────────────────────────────────

/**
 * Store the pull request for the session's branch (migration 418). Error
 * tolerant: before the migration the column is missing, and the PR is still
 * open and reported; only the session doesn't keep it.
 */
export async function recordPullRequest(svc: Svc, userId: string, sessionId: string, url: string): Promise<boolean> {
  const { data, error } = await svc
    .from('local_agent_session')
    .update({ pr_url: url })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .select(SESSION_SELECT)
    .maybeSingle()
  if (error) {
    console.warn('[local-agent] storing the pull request failed:', error.message)
    return false
  }
  if (!data) return false
  const row = data as DbSession
  await linkFolderRepo(svc, row, url)
  await settleLatePullRequest(svc, row)
  return true
}

/** `owner/repo` of a github.com pull request URL, when it is one. */
export function repoOfPullRequestUrl(url: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+$/i.exec(url)
  const repo = m ? `${m[1]}/${m[2]}` : null
  return repo && isRepoFullName(repo) ? repo : null
}

/**
 * A pull request opened from a folder links the folder to its repo
 * (environments §4: the offline fallback's linked repo), only when none is
 * set: a link the person set or cleared by hand is theirs. Best-effort.
 */
async function linkFolderRepo(svc: Svc, row: Pick<DbSession, 'folder_id' | 'user_id'>, url: string): Promise<void> {
  const repo = repoOfPullRequestUrl(url)
  if (!repo || !isUuid(row.folder_id)) return
  try {
    const { data: folder } = await svc.from('device_folder').select('id').eq('id', row.folder_id).eq('user_id', row.user_id).maybeSingle()
    if (!folder) return
    const made = await svc
      .from('device_folder_setting')
      .upsert({ device_folder_id: row.folder_id, repo_full_name: repo }, { onConflict: 'device_folder_id', ignoreDuplicates: true })
    if (made.error) throw new Error(made.error.message)
    const filled = await svc.from('device_folder_setting').update({ repo_full_name: repo }).eq('device_folder_id', row.folder_id).is('repo_full_name', null)
    if (filled.error) throw new Error(filled.error.message)
  } catch (err) {
    console.warn('[local-agent] linking the folder to its repo failed:', err instanceof Error ? err.message : err)
  }
}

/** Record the Mac's model at a claim (migration 418). Error tolerant like recordPullRequest. */
export async function recordLocalModel(svc: Svc, userId: string, sessionId: string, localModel: boolean): Promise<void> {
  const { error } = await svc.from('local_agent_session').update({ local_model: localModel }).eq('id', sessionId).eq('user_id', userId)
  if (error) console.warn('[local-agent] storing the model choice failed:', error.message)
}
