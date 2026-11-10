/**
 * Local agents, the device side: what the desktop relay (the main window's
 * webview, src/hooks/use-local-agent-relay.ts) calls through
 * /api/local-agent/device*, /sessions/[id]/{claim,events,state} and
 * /messages/[id]/ack.
 *
 * Invariant 2 (docs/plans/local-agents.md §1): the server sends the Mac only a
 * start (request text, a grant id, a mode and, for an edit job on a Mac that
 * resolves one, a local branch name: E3), a message, or a stop. Nothing here
 * carries a path or a command to the Mac; the folder mirror is written only
 * from what the Mac itself reports.
 *
 * Session state follows the device's events:
 *   status        → status (completed → waiting: the session stays open)
 *   ask / finish  → last_signal (+ its text)
 *   branch        → branch / commit_sha
 *   error         → error
 * and every upload renews the lease (2 min) and moves the ledger (ledger.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureMacEnvironment } from '@/lib/environments/mac'
import { isBaseBranch, isMacCapability, type MacCapability } from '@/lib/environments/types'
import { LEDGER_SILENT_TOOLS, moveTurn, nextTurn, stepFromTool, turnStatus, type LedgerMove } from './ledger'
import { isGithubPullRequestUrl, isSessionBranch } from './pull-request'
import {
  LEASE_MS,
  LEASE_RENEW_BELOW_MS,
  LOOP_QUEUED_TTL_MS,
  LocalAgentError,
  ACTION_JOB_KEY_PREFIX,
  SESSION_SELECT,
  isUnattendedKey,
  isUuid,
  ledgerSessionOf,
  pushWasAllowed,
  reapIfStale,
  recordLocalModel,
  recordPullRequest,
  settleActionRunStatus,
  staleness,
  type DbSession,
  type LocalAgentMode,
  type LocalAgentStatus,
} from './store'

type Svc = SupabaseClient

export const MAX_GRANTS = 200
export const MAX_DEVICES = 10
export const MAX_EVENTS_PER_UPLOAD = 200
/** A device event's string fields are capped at this (the launcher already truncates tool I/O to 2-4 KB). */
const EVENT_STRING_MAX = 8000
const RUN_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString()
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 && t.length <= max ? t : null
}

export function isRunId(v: unknown): v is string {
  return typeof v === 'string' && RUN_ID_RE.test(v)
}

// ── Heartbeat: the device and its grants ────────────────────────────────────

export interface DeviceGrantInput {
  grantId: string
  label: string
  path: string
  mode: LocalAgentMode
  isGit: boolean
}

export interface HeartbeatInput {
  deviceId: string
  name: string
  platform: string
  appVersion: string
  grants: DeviceGrantInput[]
  /** Optional: the jobs Rust reports live. When given, only these sessions' leases are renewed. */
  liveJobIds?: string[]
  /**
   * Migration 420: sent by the add-folder path only (a native folder pick on
   * this Mac). Brings a removed Mac back; every other beat from a removed Mac
   * is refused (DEVICE_REMOVED).
   */
  rejoin?: true
  /**
   * What the Mac's app says it can do (E2, user_device.capabilities): only
   * names in MAC_CAPABILITIES, today `baseBranch` (the relay sends it from
   * `local_agent_status`'s `baseBranch: true`). A beat without it clears
   * them, so an older relay or app never keeps a newer one's word.
   * parseHeartbeat always sets it.
   */
  capabilities?: MacCapability[]
}

/** A removed Mac's heartbeat (environments, "Remove this Mac"): 409 details.code. */
export const DEVICE_REMOVED_CODE = 'DEVICE_REMOVED'
export const DEVICE_REMOVED_REASON = 'This Mac was removed from Native Intelligence. Add a folder on it again to bring it back.'

/** Parse a heartbeat body; throws a bad_request LocalAgentError on anything off-shape. */
export function parseHeartbeat(body: unknown): HeartbeatInput {
  const b = (body ?? {}) as Record<string, unknown>
  if (!isUuid(b.deviceId)) throw new LocalAgentError('bad_request', 'deviceId must be a uuid')
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 200) : ''
  const platform = typeof b.platform === 'string' ? b.platform.trim().slice(0, 40) : ''
  const appVersion = typeof b.appVersion === 'string' ? b.appVersion.trim().slice(0, 40) : ''
  if (!Array.isArray(b.grants)) throw new LocalAgentError('bad_request', 'grants must be an array')
  if (b.grants.length > MAX_GRANTS) throw new LocalAgentError('bad_request', `at most ${MAX_GRANTS} grants`)
  const seen = new Set<string>()
  const grants: DeviceGrantInput[] = []
  for (const raw of b.grants as unknown[]) {
    const g = (raw ?? {}) as Record<string, unknown>
    const grantId = str(g.grantId, 200)
    const label = str(g.label, 255)
    const path = str(g.path, 4096)
    if (!grantId || !label || !path) throw new LocalAgentError('bad_request', 'each grant needs grantId, label and path')
    if (g.mode !== 'read' && g.mode !== 'edit') throw new LocalAgentError('bad_request', 'grant mode must be read or edit')
    if (seen.has(grantId)) continue
    seen.add(grantId)
    grants.push({ grantId, label, path, mode: g.mode, isGit: g.isGit === true })
  }
  // Known names only, each once; anything else (a newer app's word this
  // server doesn't know, junk, a field of the wrong shape) is dropped, never
  // the beat: a bad capabilities field only means none.
  const rawCaps = Array.isArray(b.capabilities) ? (b.capabilities as unknown[]).slice(0, 50) : []
  const capabilities = [...new Set(rawCaps.filter(isMacCapability))]
  let liveJobIds: string[] | undefined
  if (b.liveJobIds !== undefined) {
    if (!Array.isArray(b.liveJobIds) || b.liveJobIds.length > 500) throw new LocalAgentError('bad_request', 'liveJobIds must be an array')
    liveJobIds = (b.liveJobIds as unknown[]).filter(isUuid)
  }
  return {
    deviceId: b.deviceId,
    name,
    platform,
    appVersion,
    grants,
    capabilities,
    ...(liveJobIds ? { liveJobIds } : {}),
    ...(b.rejoin === true ? { rejoin: true as const } : {}),
  }
}

/**
 * The 60 s heartbeat: upsert the device (last_seen_at), mirror its grants
 * (upsert; revoke any it no longer sends), renew the leases of its working
 * sessions (a long tool call sends no events) and beat their ledger rows.
 * A removed Mac (user_device.removed_at) is refused, unless the beat is a
 * rejoin (a folder just added on it): then it is back, with the same device,
 * folder and environment ids, and its folders' settings.
 */
export async function heartbeat(
  svc: Svc,
  userId: string,
  input: HeartbeatInput,
): Promise<{ folders: Array<{ id: string; grantId: string; label: string; mode: LocalAgentMode; isGit: boolean }> }> {
  const now = Date.now()
  // At most MAX_DEVICES per person (removed Macs don't count): a new or
  // returning device beyond that is refused.
  const { data: known, error: knownError } = await svc.from('user_device').select('id, removed_at').eq('user_id', userId)
  if (knownError) throw new Error(`devices read failed: ${knownError.message}`)
  const devices = (known ?? []) as Array<{ id: string; removed_at?: string | null }>
  const mine = devices.find((d) => d.id === input.deviceId)
  const isNewDevice = !mine
  const returning = !!mine?.removed_at
  if (returning && !input.rejoin) throw new LocalAgentError('conflict', DEVICE_REMOVED_REASON, { code: DEVICE_REMOVED_CODE })
  const activeOthers = devices.filter((d) => d.id !== input.deviceId && !d.removed_at).length
  if ((isNewDevice || returning) && activeOthers >= MAX_DEVICES) {
    throw new LocalAgentError('conflict', `At most ${MAX_DEVICES} Macs can run local agents; remove one first`, { code: 'TOO_MANY_DEVICES' })
  }
  const { error: devError } = await svc.from('user_device').upsert(
    {
      user_id: userId,
      id: input.deviceId,
      name: input.name,
      platform: input.platform,
      app_version: input.appVersion,
      last_seen_at: nowIso(now),
      capabilities: input.capabilities ?? [],
      ...(returning ? { removed_at: null } : {}),
    },
    { onConflict: 'user_id,id' },
  )
  if (devError) throw new Error(`device upsert failed: ${devError.message}`)
  // Back from a remove: its environment is live again (same id).
  if (returning) {
    const { error } = await svc
      .from('environment')
      .update({ archived_at: null })
      .eq('kind', 'mac')
      .eq('owner_user_id', userId)
      .eq('device_id', input.deviceId)
    if (error) console.warn('[local-agent] mac environment restore failed:', error.message)
  }
  // Its environment (migration 420) is made with the Mac, on its first beat:
  // one insert, ON CONFLICT DO NOTHING, and nothing on every later beat.
  if (isNewDevice) {
    try {
      await ensureMacEnvironment(svc, userId, input.deviceId, input.name)
    } catch (err) {
      // The environments list makes a missing one on its next read.
      console.warn('[local-agent] mac environment insert failed:', err instanceof Error ? err.message : err)
    }
  }

  if (input.grants.length > 0) {
    const { error } = await svc.from('device_folder').upsert(
      input.grants.map((g) => ({
        user_id: userId,
        device_id: input.deviceId,
        grant_id: g.grantId,
        label: g.label,
        path: g.path,
        mode: g.mode,
        is_git: g.isGit,
        revoked_at: null,
      })),
      { onConflict: 'user_id,device_id,grant_id' },
    )
    if (error) throw new Error(`folder mirror failed: ${error.message}`)
  }

  // Revoke what the Mac no longer grants (by row id: grant ids are the Mac's text).
  const { data: current, error: readError } = await svc
    .from('device_folder')
    .select('id, grant_id, label, mode, is_git')
    .eq('user_id', userId)
    .eq('device_id', input.deviceId)
    .is('revoked_at', null)
  if (readError) throw new Error(`folder mirror read failed: ${readError.message}`)
  const sent = new Set(input.grants.map((g) => g.grantId))
  const rows = (current ?? []) as Array<{ id: string; grant_id: string; label: string; mode: LocalAgentMode; is_git: boolean }>
  const gone = rows.filter((r) => !sent.has(r.grant_id)).map((r) => r.id)
  if (gone.length > 0) {
    const { error } = await svc
      .from('device_folder')
      .update({ revoked_at: nowIso(now) })
      .eq('user_id', userId)
      .eq('device_id', input.deviceId)
      .in('id', gone)
    if (error) console.warn('[local-agent] folder revoke failed:', error.message)
    else await endSessionsInFolders(svc, userId, gone, now)
  }

  await renewLeases(svc, userId, input.deviceId, input.liveJobIds, now)

  return {
    folders: rows
      .filter((r) => sent.has(r.grant_id))
      .map((r) => ({ id: r.id, grantId: r.grant_id, label: r.label, mode: r.mode, isGit: r.is_git })),
  }
}

/** Why a removed folder's local agents ended (the panel and read_local_agent show it). */
export const FOLDER_REMOVED = 'Its folder was removed from your environment.'

/**
 * Removing a folder ends its local agents (Liam, 2026-10-21). A turn still in
 * flight is cancelled, ledger row too. An idle one (its turn ended) just ends:
 * its finished turn row (done, or a branch to review) stays as it is, so a
 * removal never wipes a review or posts a "stopped" report for work that
 * finished. The Mac already stopped or parked them before it dropped the grant.
 */
async function endSessionsInFolders(svc: Svc, userId: string, folderIds: string[], now: number): Promise<void> {
  try {
    const { data, error } = await svc
      .from('local_agent_session')
      .select(SESSION_SELECT)
      .eq('user_id', userId)
      .in('folder_id', folderIds)
      .in('status', ['queued', 'starting', 'running', 'waiting', 'interrupted'])
    if (error) throw new Error(error.message)
    for (const r of (data ?? []) as DbSession[]) {
      const { data: ended } = await svc
        .from('local_agent_session')
        .update({ status: 'cancelled', error: FOLDER_REMOVED, stop_requested_at: nowIso(now), ended_at: nowIso(now), lease_expires_at: null })
        .eq('id', r.id)
        .eq('user_id', userId)
        .eq('status', r.status)
        .select(SESSION_SELECT)
        .maybeSingle()
      if (ended && r.status !== 'waiting') await moveTurn(svc, ledgerSessionOf(r), { type: 'cancel' })
      if (ended) await settleActionRunStatus(svc, r, ended as DbSession)
    }
  } catch (err) {
    console.warn('[local-agent] ending a removed folder’s sessions failed:', err instanceof Error ? err.message : err)
  }
}

async function renewLeases(svc: Svc, userId: string, deviceId: string, liveJobIds: string[] | undefined, now: number) {
  try {
    // Only leases that lapse within LEASE_RENEW_BELOW_MS: fewer row updates (and realtime payloads).
    let q = svc
      .from('local_agent_session')
      .update({ lease_expires_at: nowIso(now + LEASE_MS) })
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .in('status', ['starting', 'running'])
      .lt('lease_expires_at', nowIso(now + LEASE_RENEW_BELOW_MS))
    if (liveJobIds) {
      if (liveJobIds.length === 0) return
      q = q.in('id', liveJobIds)
    }
    const { data } = await q.select(SESSION_SELECT)
    for (const row of (data ?? []) as DbSession[]) {
      if (row.status === 'running') await moveTurn(svc, ledgerSessionOf(row), { type: 'beat' })
    }
  } catch (err) {
    console.warn('[local-agent] lease renewal failed:', err instanceof Error ? err.message : err)
  }
}

// ── Pending work for one device ─────────────────────────────────────────────

export interface PendingWork {
  start: Array<{
    sessionId: string
    grantId: string
    mode: LocalAgentMode
    request: string
    resume: { eveSessionId: string; streamIndex: number } | null
  }>
  messages: Array<{ id: string; sessionId: string; text: string; policy: 'steer' | 'queue'; author: 'agent' | 'person' }>
  stops: Array<{ sessionId: string }>
}

function resumeOf(r: DbSession): { eveSessionId: string; streamIndex: number } | null {
  return r.eve_session_id ? { eveSessionId: r.eve_session_id, streamIndex: r.stream_index ?? 0 } : null
}

/** What this device should do now. Lazy reaping applies; a start in a folder the Mac revoked fails. */
export async function pendingFor(svc: Svc, userId: string, deviceId: string): Promise<PendingWork> {
  if (!isUuid(deviceId)) throw new LocalAgentError('bad_request', 'deviceId must be a uuid')
  const { data, error } = await svc
    .from('local_agent_session')
    .select(SESSION_SELECT)
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .in('status', ['queued', 'starting', 'running', 'waiting', 'interrupted'])
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) throw new Error(`pending read failed: ${error.message}`)

  const now = Date.now()
  const out: PendingWork = { start: [], messages: [], stops: [] }
  const onDevice: string[] = []
  const sessions = new Map<string, DbSession>()
  for (const raw of (data ?? []) as DbSession[]) {
    const r = staleness(raw, now) ? await reapIfStale(svc, raw, now) : raw
    // Idle for 24 h on the Mac: expired here, so tell the Mac to stop it too.
    if (r.status === 'expired' && (raw.status === 'waiting' || raw.status === 'interrupted')) {
      out.stops.push({ sessionId: r.id })
      continue
    }
    // Interrupted with a live lease: the Mac woke up and holds it again.
    const liveAgain = r.status === 'interrupted' && !!r.lease_expires_at && Date.parse(r.lease_expires_at) >= now
    if (r.status === 'queued') {
      if (r.stop_requested_at) continue
      if (r.folder?.revoked_at || !r.folder?.grant_id) {
        await failSession(svc, r, 'This folder is no longer granted on your Mac.')
        continue
      }
      out.start.push({ sessionId: r.id, grantId: r.folder.grant_id, mode: r.mode, request: r.request, resume: resumeOf(r) })
    } else if (r.status === 'starting' || r.status === 'running' || r.status === 'waiting' || liveAgain) {
      onDevice.push(r.id)
      sessions.set(r.id, r)
      if (r.stop_requested_at) out.stops.push({ sessionId: r.id })
    }
  }

  if (onDevice.length > 0) {
    const { data: msgs, error: msgError } = await svc
      .from('local_agent_message')
      .select('id, session_id, text, policy, author, idempotency_key, created_at')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .in('session_id', onDevice)
      .order('created_at', { ascending: true })
      .limit(200)
    if (msgError) throw new Error(`pending messages read failed: ${msgError.message}`)
    const stopping = new Set(out.stops.map((s) => s.sessionId))
    for (const m of (msgs ?? []) as PendingMessageRow[]) {
      if (stopping.has(m.session_id)) continue
      // A loop's request the Mac didn't take in its 15 minutes (it slept, say)
      // never runs later, with nobody expecting it.
      if (isLoopStart(m) && Date.parse(m.created_at) < now - LOOP_QUEUED_TTL_MS) {
        const session = sessions.get(m.session_id)
        if (session) await expireLoopMessage(svc, userId, m, session)
        continue
      }
      out.messages.push({ id: m.id, sessionId: m.session_id, text: m.text, policy: m.policy, author: m.author })
    }
  }
  return out
}

type PendingMessageRow = {
  id: string
  session_id: string
  text: string
  policy: 'steer' | 'queue'
  author: 'agent' | 'person'
  idempotency_key: string | null
  created_at: string
}

/** An unattended request (a loop's, an action's Start) that joined a live job (store.ts claimFolder keys it `start:<its key>`). */
function isLoopStart(m: Pick<PendingMessageRow, 'idempotency_key'>): boolean {
  return typeof m.idempotency_key === 'string' && m.idempotency_key.startsWith('start:') && isUnattendedKey(m.idempotency_key.slice('start:'.length))
}

/** Why a loop's request that joined a job was dropped (the thread and the ledger say it). */
export const LOOP_MESSAGE_EXPIRED = "your Mac didn't take it within 15 minutes, so the loop's request was dropped"

/**
 * Drop a loop's request the Mac didn't take in time: the message fails (CAS
 * on pending), the thread says so, a turn queued behind the one running no
 * longer opens for it, and a turn opened for it (still queued, never started,
 * no other message on its way) fails, which reports in the chat.
 */
async function expireLoopMessage(svc: Svc, userId: string, m: PendingMessageRow, r: DbSession): Promise<void> {
  const { data } = await svc
    .from('local_agent_message')
    .update({ status: 'failed', error: LOOP_MESSAGE_EXPIRED })
    .eq('id', m.id)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (!data) return
  try {
    await svc.from('local_agent_event').insert({
      session_id: r.id,
      user_id: userId,
      source: 'server',
      kind: 'error',
      payload: { kind: 'error', message: `Your Mac couldn't take a message: ${LOOP_MESSAGE_EXPIRED}`, messageId: m.id },
    })
    if (r.pending_turn_text === m.text) {
      await svc.from('local_agent_session').update({ pending_turn_text: null }).eq('id', r.id).eq('user_id', userId).eq('pending_turn_text', m.text)
    }
    // A queued turn with no other message on its way was opened for this one.
    const { data: others } = await svc.from('local_agent_message').select('id').eq('session_id', r.id).eq('user_id', userId).eq('status', 'pending').limit(1)
    const ledger = ledgerSessionOf(r)
    if (((others ?? []) as unknown[]).length === 0 && (await turnStatus(svc, ledger)) === 'queued') {
      await moveTurn(svc, ledger, { type: 'fail', message: `Not run: ${LOOP_MESSAGE_EXPIRED}.` })
    }
    // An action's re-Start that joined this job and never ran: its turn is
    // over, so the action it marked working settles (store.ts).
    await settleDroppedStart(svc, userId, r.id, m.idempotency_key)
  } catch (err) {
    console.warn('[local-agent] dropping a late loop request failed:', err instanceof Error ? err.message : err)
  }
}

/** The message key an action's Start that joined a job carries (store.ts claimFolder: `start:<its key>`). */
function isActionStartMessage(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(`start:${ACTION_JOB_KEY_PREFIX}`)
}

/**
 * A joined action Start that never reached the Mac (dropped after 15
 * minutes, or its delivery failed): the job's turn for it is over, so the
 * action settles from the job as it is now (settleActionRunStatus, which
 * leaves it while anything else is on its way).
 */
async function settleDroppedStart(svc: Svc, userId: string, sessionId: string, messageKey: string | null | undefined): Promise<void> {
  if (!isActionStartMessage(messageKey)) return
  const { data } = await svc.from('local_agent_session').select(SESSION_SELECT).eq('id', sessionId).eq('user_id', userId).maybeSingle()
  if (data) await settleActionRunStatus(svc, null, data as DbSession)
}

async function failSession(svc: Svc, r: DbSession, message: string): Promise<void> {
  const { data } = await svc
    .from('local_agent_session')
    .update({ status: 'failed', error: message, ended_at: nowIso(), lease_expires_at: null })
    .eq('id', r.id)
    .eq('user_id', r.user_id)
    .eq('status', r.status)
    .select(SESSION_SELECT)
    .maybeSingle()
  if (data) {
    await moveTurn(svc, ledgerSessionOf(r), { type: 'fail', message })
    await settleActionRunStatus(svc, r, data as DbSession)
  }
}

// ── Claim ───────────────────────────────────────────────────────────────────

export interface ClaimResult {
  session: DbSession
  grantId: string
  mode: LocalAgentMode
  request: string
  resume: { eveSessionId: string; streamIndex: number } | null
  /** The model the session is recorded on now (migration 418): the relay hands it to the Mac's start and resume. */
  localModel: boolean
  /**
   * An edit job's base branch (E3, local_agent_session.base_branch, stamped
   * at its start only for a Mac whose app resolves one): a local branch name
   * the Mac resolves itself (refs/heads/<name>, exact). Null: HEAD, and
   * always for a read job.
   */
  baseBranch: string | null
}

/** A session's base branch as a claim hands it on: an edit job's, the strict pattern again, else null. */
export function claimBaseBranch(row: Pick<DbSession, 'mode' | 'base_branch'>): string | null {
  return row.mode === 'edit' && isBaseBranch(row.base_branch) ? row.base_branch : null
}

/** What a claim answers when the Mac runs its own model and the server can't record it (migration 418). */
export const LOCAL_MODEL_UNRECORDED = 'LOCAL_MODEL_UNRECORDED'

/**
 * CAS queued → starting on this device's folder and set the lease. Null when
 * the CAS lost (another claim won, the session moved on, a stop was asked, or
 * it isn't this device's): the route answers 409.
 *
 * `localModel` (teammate plan, decided after the review of #892): a Mac on its
 * own model is recorded in the claim's own write, so C1 narrows the tools for
 * it. When that can't be written (migration 418 not applied) the claim is
 * refused (409 LOCAL_MODEL_UNRECORDED) and the job stays queued: it fails
 * closed. A relay Mac's `false` is written after, error-tolerant.
 */
export async function claimSession(
  svc: Svc,
  userId: string,
  sessionId: string,
  input: { deviceId: string; runId: string; localModel?: boolean },
): Promise<ClaimResult | null> {
  if (!isUuid(sessionId)) throw new LocalAgentError('not_found', 'Local agent not found')
  if (!isUuid(input.deviceId)) throw new LocalAgentError('bad_request', 'deviceId must be a uuid')
  if (!isRunId(input.runId)) throw new LocalAgentError('bad_request', 'runId is required')
  const now = Date.now()
  const { data, error } = await svc
    .from('local_agent_session')
    .update({
      status: 'starting',
      run_id: input.runId,
      claimed_at: nowIso(now),
      lease_expires_at: nowIso(now + LEASE_MS),
      ...(input.localModel === true ? { local_model: true } : {}),
    })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .eq('device_id', input.deviceId)
    .eq('status', 'queued')
    .is('stop_requested_at', null)
    .gt('expires_at', nowIso(now))
    .select(SESSION_SELECT)
    .maybeSingle()
  if (error) {
    if (input.localModel === true && /local_model/.test(error.message ?? '')) {
      throw new LocalAgentError(
        'conflict',
        "This Mac runs its own model, and Native Intelligence can't record that yet, so the job waits. Switch the Mac to Native Intelligence's model to run it now.",
        { code: LOCAL_MODEL_UNRECORDED },
      )
    }
    throw new Error(`claim failed: ${error.message}`)
  }
  if (!data) return null
  const row = data as DbSession
  if (!row.folder?.grant_id || row.folder.revoked_at) {
    await failSession(svc, row, 'This folder is no longer granted on your Mac.')
    return null
  }
  await moveTurn(svc, ledgerSessionOf(row), { type: 'step', text: 'Starting on your Mac' })
  // A relay Mac resets a session a local-model launch had marked (true went in the claim itself).
  if (input.localModel === false && row.local_model === true) await recordLocalModel(svc, userId, row.id, false)
  const localModel = input.localModel ?? row.local_model === true
  return {
    session: row,
    grantId: row.folder.grant_id,
    mode: row.mode,
    request: row.request,
    resume: resumeOf(row),
    localModel,
    baseBranch: claimBaseBranch(row),
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

export interface DeviceEventInput {
  seq: number
  event: Record<string, unknown> & { kind: string }
}

/**
 * Kinds only the server writes. A device event of one of these is dropped at
 * the door, so the Mac can never write "the person" (or the Native Intelligence agent) into
 * its own transcript. `branch` is not reserved: Rust makes it.
 */
export const RESERVED_EVENT_KINDS: ReadonlySet<string> = new Set(['inbound'])

/** A device event's whole payload stays under this (migration 410's CHECK is 64 KiB of jsonb text). */
export const EVENT_BYTES_MAX = 48 * 1024

function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8')
}

/** Text Postgres jsonb accepts: no NUL, no lone surrogate. */
function storable(text: string): string {
  return text.replace(/\u0000/g, '').toWellFormed()
}

function cutText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).toWellFormed()}…` : text
}

/**
 * A device event's payload, flattened and capped: strings cut (and made
 * storable), nested values as JSON text, at most 20 fields, and the whole
 * payload within EVENT_BYTES_MAX (the longest fields are cut first). Null for
 * an off-shape event or a reserved kind.
 */
export function sanitizeEvent(event: unknown): (Record<string, unknown> & { kind: string }) | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const e = event as Record<string, unknown>
  const kind = typeof e.kind === 'string' ? e.kind.trim() : ''
  if (!/^[a-z_]{1,40}$/.test(kind) || RESERVED_EVENT_KINDS.has(kind)) return null
  const out: Record<string, unknown> & { kind: string } = { kind }
  let n = 0
  for (const [key, value] of Object.entries(e)) {
    if (key === 'kind' || !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key)) continue
    if (++n > 20) break
    if (typeof value === 'string') out[key] = cutText(storable(value), EVENT_STRING_MAX)
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : null
    else if (typeof value === 'boolean' || value === null) out[key] = value
    else if (value !== undefined) out[key] = cutText(storable(JSON.stringify(value) ?? ''), EVENT_STRING_MAX)
  }
  // The byte budget: escapes (a control character is six bytes of JSON) and
  // multibyte text can outgrow the character caps. Cut the longest string
  // until the payload fits; bounded by the field count.
  for (let guard = 0; guard < 64; guard++) {
    const size = jsonBytes(out)
    if (size <= EVENT_BYTES_MAX) break
    let longest: string | null = null
    let longestBytes = 0
    for (const [key, value] of Object.entries(out)) {
      if (key === 'kind' || typeof value !== 'string') continue
      const b = jsonBytes(value)
      if (b > longestBytes) {
        longest = key
        longestBytes = b
      }
    }
    if (!longest) break
    const text = out[longest] as string
    const keepBytes = Math.max(0, longestBytes - (size - EVENT_BYTES_MAX) - 64)
    const keepChars = Math.floor((text.length * keepBytes) / Math.max(1, longestBytes))
    out[longest] = keepChars > 0 ? cutText(text, keepChars) : ''
  }
  return out
}

export function parseEventUpload(body: unknown): { runId: string; events: DeviceEventInput[] } {
  const b = (body ?? {}) as Record<string, unknown>
  if (!isRunId(b.runId)) throw new LocalAgentError('bad_request', 'runId is required')
  if (!Array.isArray(b.events)) throw new LocalAgentError('bad_request', 'events must be an array')
  if (b.events.length > MAX_EVENTS_PER_UPLOAD) throw new LocalAgentError('bad_request', `at most ${MAX_EVENTS_PER_UPLOAD} events per upload`)
  const bySeq = new Map<number, DeviceEventInput>()
  for (const raw of b.events as unknown[]) {
    const r = (raw ?? {}) as Record<string, unknown>
    const seq = r.seq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > 2_000_000_000) {
      throw new LocalAgentError('bad_request', 'each event needs an integer seq')
    }
    const rawKind = (r.event as { kind?: unknown } | null | undefined)?.kind
    // A server-only kind from a device is dropped (not stored, not derived); the rest of the upload stands.
    if (typeof rawKind === 'string' && RESERVED_EVENT_KINDS.has(rawKind.trim())) continue
    const event = sanitizeEvent(r.event)
    if (!event) throw new LocalAgentError('bad_request', 'each event needs a kind')
    if (!bySeq.has(seq)) bySeq.set(seq, { seq, event })
  }
  return { runId: b.runId, events: [...bySeq.values()].sort((a, b) => a.seq - b.seq) }
}

/** The device's job status as the session's. */
export function sessionStatusOf(deviceStatus: unknown): LocalAgentStatus | null {
  switch (deviceStatus) {
    case 'starting':
    case 'running':
    case 'waiting':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      return deviceStatus
    // A completed job is idle, still open to a message (it is not a server status).
    case 'completed':
      return 'waiting'
    default:
      return null
  }
}

const SETTLED: ReadonlySet<LocalAgentStatus> = new Set(['cancelled', 'failed', 'expired'])
/** A device may still report on these (interrupted: the Mac woke up and carries on). */
const DEVICE_WRITABLE: ReadonlySet<LocalAgentStatus> = new Set(['starting', 'running', 'waiting', 'interrupted'])
const LIVE: ReadonlySet<LocalAgentStatus> = new Set(['starting', 'running'])

export interface Derived {
  patch: Record<string, unknown>
  moves: LedgerMove[]
  status: LocalAgentStatus
  /** The turn ended in this upload with no question: a summary may need the last stored message. */
  needsLastMessage: boolean
  /** The upload ended the turn (turn_end, or a question the turn ended on). */
  turnEnded: boolean
  /** The turn ended on a NEW question in this upload. */
  askedAtEnd: boolean
}

/**
 * Fold one upload's NEW device events (in seq order) into the session's FINAL
 * state and at most one ledger move of each kind: whatever a Mac replays
 * inside one upload, it yields at most one step, one question, one turn end.
 * The moves follow from where the upload leaves the session, never from each
 * status on the way (a replayed running → finish → waiting ×100 is one turn
 * end, and a settled turn is never reopened by a device: ledger.ts).
 * An `interrupted` session that gets any new event of its current run is
 * running again (the Mac woke up), unless the upload says otherwise. Pure.
 */
export function deriveFromEvents(
  row: Pick<DbSession, 'status' | 'last_signal' | 'last_signal_text' | 'error'> & { mode?: LocalAgentMode },
  events: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>,
  opts: { lastMessage?: string | null; serverAsk?: boolean } = {},
): Derived {
  // The session's open question is the Mac body's to its teammate
  // (message_teammate: the server recorded it as it asked), not one the Mac
  // asked itself (an `ask` it uploaded). Only that one outlives a turn.
  const standing = row.last_signal === 'ask' && opts.serverAsk === true
  let status = row.status
  if (status === 'interrupted' && events.length > 0) status = 'running'
  let lastSignal = row.last_signal
  let lastSignalText = row.last_signal_text
  let lastMessage: string | null = opts.lastMessage ?? null
  let sawMessage = false
  let step: string | null = null
  let askedInBatch: string | null = null
  let endedInBatch = false
  let failure: string | null = null
  const patch: Record<string, unknown> = {}

  for (const { kind, payload } of events) {
    if (SETTLED.has(status)) break
    switch (kind) {
      case 'tool': {
        const name = typeof payload.name === 'string' ? payload.name : 'a tool'
        // The Mac body's teammate tools: the server records what they do.
        if (LEDGER_SILENT_TOOLS.has(name)) break
        step = stepFromTool(name, typeof payload.input === 'string' ? payload.input : '')
        break
      }
      case 'message':
        if (typeof payload.text === 'string' && payload.text.trim()) {
          lastMessage = payload.text
          sawMessage = true
        }
        break
      case 'ask': {
        const q = typeof payload.question === 'string' ? payload.question : ''
        lastSignal = 'ask'
        lastSignalText = q.slice(0, 20_000)
        askedInBatch = q
        break
      }
      case 'finish':
        // The Mac body asked its teammate during this turn (message_teammate:
        // the server set the question as it asked, so it isn't in this batch).
        // The question stands until it's answered; the finish stays in the
        // transcript, and the answer's turn reports when it ends.
        if (standing && lastSignal === 'ask' && askedInBatch === null) break
        lastSignal = 'finish'
        lastSignalText = (typeof payload.summary === 'string' ? payload.summary : '').slice(0, 20_000)
        break
      case 'branch':
        if (typeof payload.branch === 'string' && payload.branch) patch.branch = payload.branch.slice(0, 300)
        if (typeof payload.commit === 'string' && payload.commit) patch.commit_sha = payload.commit.slice(0, 64)
        break
      case 'error':
        if (typeof payload.message === 'string' && payload.message) patch.error = payload.message.slice(0, 4000)
        break
      case 'status': {
        const next = sessionStatusOf(payload.status)
        if (!next) break
        const reason = typeof payload.reason === 'string' && payload.reason ? payload.reason.slice(0, 4000) : null
        if (LIVE.has(next)) {
          // A new turn after an idle one: the last turn's signal is spent.
          // Except the Mac body's question to its teammate, set by the server
          // as it asked (this upload doesn't carry it): only an answer clears
          // that (addMessage), and the upload may simply be late. A question
          // the Mac asked itself is spent like any signal: the turn it runs
          // now (a queued message) is a new one.
          const keep = standing && lastSignal === 'ask' && askedInBatch === null
          if ((status === 'waiting' || status === 'interrupted') && lastSignal && !keep) {
            lastSignal = null
            lastSignalText = null
            askedInBatch = null
          }
          endedInBatch = false
        } else if (next === 'waiting') {
          // Only a turn that ran ends here: a resume of an idle session goes
          // starting → waiting and must not read as "finished".
          if (status === 'running' || status === 'interrupted') endedInBatch = true
        } else if (next === 'failed') {
          failure = reason ?? (patch.error as string | undefined) ?? row.error ?? 'The local agent failed on your Mac.'
          if (reason) patch.error = reason
        }
        status = next
        break
      }
      default:
        break
    }
  }

  const moves: LedgerMove[] = []
  let needsLastMessage = false
  let turnEnded = false
  let askedAtEnd = false
  if (!SETTLED.has(row.status)) {
    if (status === 'failed') moves.push({ type: 'fail', message: failure ?? row.error ?? 'The local agent failed on your Mac.' })
    else if (status === 'cancelled') moves.push({ type: 'cancel' })
    else if (status === 'interrupted') moves.push({ type: 'interrupted' })
    else if (status === 'waiting') {
      if (lastSignal === 'ask') {
        if (askedInBatch !== null) {
          moves.push({ type: 'ask', question: askedInBatch })
          askedAtEnd = true
          turnEnded = true
        }
      } else if (endedInBatch) {
        const summary = lastSignal === 'finish' ? lastSignalText : lastMessage
        if (!summary && !sawMessage && lastSignal !== 'finish') needsLastMessage = true
        // For you holds delivered artifacts only: an EDIT turn that finished
        // (the app commits every finish on its branch) is a review; anything
        // else is done, reported in the chat.
        const review = row.mode === 'edit' && (lastSignal === 'finish' || typeof patch.branch === 'string')
        moves.push({ type: 'turn_end', summary: summary ?? '', review })
        turnEnded = true
      }
    } else if (LIVE.has(status)) {
      const changed = status !== row.status
      moves.push(step !== null || changed ? { type: 'step', text: step ?? (status === 'starting' ? 'Starting on your Mac' : 'Working on your Mac') } : { type: 'beat' })
    }
  }

  if (status !== row.status) patch.status = status
  if (lastSignal !== row.last_signal) patch.last_signal = lastSignal
  if (lastSignalText !== row.last_signal_text) patch.last_signal_text = lastSignalText
  if (SETTLED.has(status) && !SETTLED.has(row.status)) patch.ended_at = nowIso()
  return { patch, moves, status, needsLastMessage, turnEnded, askedAtEnd }
}

/** The latest agent message stored for a session: a turn-end summary when the batch held none. */
async function lastStoredMessage(svc: Svc, userId: string, sessionId: string): Promise<string | null> {
  const { data } = await svc
    .from('local_agent_event')
    .select('payload')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .eq('kind', 'message')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  const text = (data as { payload?: { text?: unknown } } | null)?.payload?.text
  return typeof text === 'string' ? text : null
}

/**
 * The session's open question is the Mac body's to its teammate: the newest
 * server `ask` (askTeammate) holds the open question's words, and is newer
 * than the newest device `ask` of the session's current run. Another run's
 * events (a gap-fill after a restart, stored late with higher ids) don't
 * count: they're never derived. And after a relaunch (a new run), the Mac's
 * own question from the run before is invisible here, so the words decide: an
 * old, answered teammate question isn't the one open. An upload's own events
 * are stored before it's derived, so a question in this upload makes it the
 * device's; deriveFromEvents reads that one from the batch.
 */
async function serverAskIsNewest(svc: Svc, row: DbSession): Promise<boolean> {
  const asks = () => svc.from('local_agent_event').select('id, payload').eq('session_id', row.id).eq('user_id', row.user_id).eq('kind', 'ask')
  const [server, device] = await Promise.all([
    asks().eq('source', 'server').order('id', { ascending: false }).limit(SERVER_ASK_SCAN),
    row.run_id ? asks().eq('source', 'device').eq('run_id', row.run_id).order('id', { ascending: false }).limit(1).maybeSingle() : { data: null },
  ])
  // The server ask holding the open question's words: the newest few, since
  // two questions asked at once may land in either order.
  const held = ((server.data ?? []) as Array<{ id?: unknown; payload?: { question?: unknown } | null }>).find(
    (e) => typeof e.id === 'number' && e.payload?.question === row.last_signal_text,
  )
  const d = (device.data as { id?: unknown } | null)?.id
  if (!held) return false
  return typeof d !== 'number' || (held.id as number) > d
}

/** How many of a session's newest server asks the open question's words are looked for in. */
const SERVER_ASK_SCAN = 5

/** The lease patch for a session now in `status`: renewed only when it lapses within LEASE_RENEW_BELOW_MS. */
function leasePatch(row: Pick<DbSession, 'status' | 'lease_expires_at'>, status: LocalAgentStatus, now = Date.now()): Record<string, unknown> {
  if (LIVE.has(status)) {
    const left = row.lease_expires_at ? Date.parse(row.lease_expires_at) - now : -1
    return left < LEASE_RENEW_BELOW_MS ? { lease_expires_at: nowIso(now + LEASE_MS) } : {}
  }
  return row.lease_expires_at ? { lease_expires_at: null } : {}
}

/**
 * Apply derived state to the session (CAS on the status it was read with,
 * retried once on a lost race) and move the ledger. A turn that ends with a
 * queued message waiting (pending_turn_text) opens the next turn, the one
 * place besides addMessage that does. Returns the row as written.
 */
async function applyDerived(
  svc: Svc,
  row: DbSession,
  events: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>,
  extra: Record<string, unknown>,
): Promise<DbSession> {
  let current = row
  for (let attempt = 0; attempt < 2; attempt++) {
    const serverAsk = current.last_signal === 'ask' && (await serverAskIsNewest(svc, current))
    let derived = deriveFromEvents(current, events, { serverAsk })
    if (derived.needsLastMessage) {
      derived = deriveFromEvents(current, events, { serverAsk, lastMessage: await lastStoredMessage(svc, current.user_id, current.id) })
    }
    const nextTurnText = derived.turnEnded && !derived.askedAtEnd ? current.pending_turn_text ?? null : null
    const patch: Record<string, unknown> = {
      ...extra,
      ...derived.patch,
      ...leasePatch(current, derived.status),
      ...(derived.turnEnded && current.pending_turn_text ? { pending_turn_text: null } : {}),
    }
    let written: DbSession | null = current
    if (Object.keys(patch).length > 0) {
      const { data } = await svc
        .from('local_agent_session')
        .update(patch)
        .eq('id', current.id)
        .eq('user_id', current.user_id)
        .eq('status', current.status)
        .select(SESSION_SELECT)
        .maybeSingle()
      written = (data as DbSession | null) ?? null
    }
    if (written) {
      let ledger = ledgerSessionOf(written)
      for (const move of derived.moves) ledger = await moveTurn(svc, ledger, move)
      if (nextTurnText) await nextTurn(svc, ledger, { text: nextTurnText, status: 'queued' })
      // An action's Mac job (environments E2): its turn ended, it failed or
      // it was stopped, so the action's run status settles (store.ts), only
      // when this ended the job's own working turn: one that ran in this
      // upload, or that was open before it. (Not when a queued message opens
      // its next turn: it works on.)
      const ranHere = derived.turnEnded || events.some((e) => e.kind === 'status' && (e.payload.status === 'running' || e.payload.status === 'starting'))
      if (!nextTurnText && (written.status !== current.status || derived.turnEnded)) await settleActionRunStatus(svc, ranHere ? null : current, written)
      return written
    }
    const { data: fresh } = await svc
      .from('local_agent_session')
      .select(SESSION_SELECT)
      .eq('id', current.id)
      .eq('user_id', current.user_id)
      .maybeSingle()
    if (!fresh) return current
    current = fresh as DbSession
    if (!DEVICE_WRITABLE.has(current.status)) return current
  }
  return current
}

/** Postgres refusals a retry can't fix (a CHECK, untranslatable text, bad JSON): 400, so the relay drops the batch. */
const REFUSED_SQLSTATES: ReadonlySet<string> = new Set(['23514', '22P05', '22021', '22P02', '22001'])

/**
 * Store a batch of device events (deduped on session, run, seq: a retried or
 * overlapping upload inserts nothing twice), derive the session's state from
 * the NEW events of its current run past the highest seq stored (a late older
 * batch can't reopen a turn), renew the lease and move the ledger. Events of
 * an older run (a gap-fill after a restart) are stored for the transcript
 * only; a settled session's are discarded.
 */
export async function ingestEvents(
  svc: Svc,
  userId: string,
  sessionId: string,
  input: { runId: string; events: DeviceEventInput[] },
): Promise<{ stopRequested: boolean; inserted: number }> {
  if (!isUuid(sessionId)) throw new LocalAgentError('not_found', 'Local agent not found')
  const { data: found, error } = await svc
    .from('local_agent_session')
    .select(SESSION_SELECT)
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`session read failed: ${error.message}`)
  if (!found) throw new LocalAgentError('not_found', 'Local agent not found')
  const row = found as DbSession
  // Settled: nothing more to keep, but the pull request of a push the person
  // allowed before it ended (C5: a stop, or another chat taking the folder,
  // mid-push). OK either way, so the relay moves on.
  if (input.events.length > 0 && SETTLED.has(row.status)) {
    const prs = input.events.filter((e) => e.event.kind === 'pull_request')
    if (prs.length > 0 && row.mode === 'edit' && (await pushWasAllowed(svc, row))) {
      const { data: kept } = await svc
        .from('local_agent_event')
        .upsert(
          prs.map((e) => ({ session_id: row.id, user_id: userId, source: 'device', run_id: input.runId, seq: e.seq, kind: e.event.kind, payload: e.event })),
          { onConflict: 'session_id,run_id,seq', ignoreDuplicates: true },
        )
        .select('seq, kind, payload')
      const fresh = (kept ?? []) as Array<{ kind: string; payload: Record<string, unknown> }>
      await keepPullRequest(svc, row, fresh)
      return { stopRequested: !!row.stop_requested_at, inserted: fresh.length }
    }
  }
  // Settled (or never claimed): nothing more to keep. OK, so the relay moves on.
  if (input.events.length === 0 || SETTLED.has(row.status) || (row.status === 'queued' && row.run_id === null)) {
    return { stopRequested: !!row.stop_requested_at, inserted: 0 }
  }

  const { data: inserted, error: insError } = await svc
    .from('local_agent_event')
    .upsert(
      input.events.map((e) => ({
        session_id: row.id,
        user_id: userId,
        source: 'device',
        run_id: input.runId,
        seq: e.seq,
        kind: e.event.kind,
        payload: e.event,
      })),
      { onConflict: 'session_id,run_id,seq', ignoreDuplicates: true },
    )
    .select('seq, kind, payload')
  if (insError) {
    if (insError.code && REFUSED_SQLSTATES.has(insError.code)) {
      throw new LocalAgentError('bad_request', 'These events cannot be stored', { sqlstate: insError.code })
    }
    throw new Error(`event insert failed: ${insError.message}`)
  }
  const fresh = ((inserted ?? []) as Array<{ seq: number; kind: string; payload: Record<string, unknown> }>).sort(
    (a, b) => a.seq - b.seq,
  )

  // Rust's seq is monotonic per job within one app run and restarts per run
  // (a relaunch starts at 1 again), so the mark (last_seq) only counts for the
  // run it was set on. It moves for the CURRENT run's uploads: onto this run
  // when it belonged to another, or up when this upload went past it.
  const maxSeq = input.events[input.events.length - 1].seq
  const currentRun = row.run_id === input.runId
  const markIsThisRun = row.last_seq_run_id === input.runId && typeof row.last_seq === 'number'
  const seqPatch: Record<string, unknown> =
    currentRun && (!markIsThisRun || maxSeq > (row.last_seq as number))
      ? { last_seq: maxSeq, last_seq_run_id: input.runId }
      : {}

  let after = row
  // Derive only past this run's mark (a late older batch of the same run can't reopen a turn).
  const floor = markIsThisRun ? (row.last_seq as number) : -1
  const derivable = currentRun && DEVICE_WRITABLE.has(row.status) ? fresh.filter((e) => e.seq > floor) : []
  if (derivable.length > 0) {
    after = await applyDerived(svc, row, derivable, seqPatch)
  } else {
    // Nothing new to derive (a duplicate upload, a late older batch, an old run's gap-fill): keep the seq mark and, for the live run, the lease.
    const live = currentRun && LIVE.has(row.status)
    const patch = { ...seqPatch, ...(live ? leasePatch(row, row.status) : {}) }
    if (Object.keys(patch).length > 0) {
      await svc.from('local_agent_session').update(patch).eq('id', row.id).eq('user_id', userId)
    }
    if (live) await moveTurn(svc, ledgerSessionOf(row), { type: 'beat' })
  }
  await keepPullRequest(svc, after, fresh)
  return { stopRequested: !!after.stop_requested_at, inserted: fresh.length }
}

/**
 * The Mac opened (or found) the pull request for the session's own branch
 * (teammate plan C5: Rust's `pull_request` event, gh or the server route):
 * the session keeps its URL. From any run, since a push running at quit is
 * reported at the next launch.
 */
async function keepPullRequest(svc: Svc, row: DbSession, events: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>): Promise<void> {
  if (row.mode !== 'edit') return
  const pr = events.findLast(
    (e) => e.kind === 'pull_request' && e.payload.ok === true && isGithubPullRequestUrl(e.payload.url) && isSessionBranch(e.payload.branch, row),
  )
  const url = pr?.payload.url as string | undefined
  if (url && url !== row.pr_url) await recordPullRequest(svc, row.user_id, row.id, url)
}

// ── State lines (session, cursor, process exit) ─────────────────────────────

export interface StateUpdate {
  runId: string
  /**
   * Rebind: the run the session is bound to now (the claim's provisional run,
   * or the run a resume replaced). Rust mints the real run id only inside
   * local_agent_start / local_agent_resume, after the claim returned the
   * model token, so the relay claims with a provisional id P and then sends
   * `{runId: R, previousRunId: P}`.
   */
  previousRunId?: string
  /** Optional: when given, it must be the session's device. */
  deviceId?: string
  eveSessionId?: string
  streamIndex?: number
  status?: LocalAgentStatus
  error?: string
}

export function parseStateUpdate(body: unknown): StateUpdate {
  const b = (body ?? {}) as Record<string, unknown>
  if (!isRunId(b.runId)) throw new LocalAgentError('bad_request', 'runId is required')
  const out: StateUpdate = { runId: b.runId }
  if (b.previousRunId !== undefined && b.previousRunId !== null) {
    if (!isRunId(b.previousRunId)) throw new LocalAgentError('bad_request', 'invalid previousRunId')
    out.previousRunId = b.previousRunId
  }
  if (b.deviceId !== undefined && b.deviceId !== null) {
    if (!isUuid(b.deviceId)) throw new LocalAgentError('bad_request', 'deviceId must be a uuid')
    out.deviceId = b.deviceId
  }
  if (b.eveSessionId !== undefined && b.eveSessionId !== null) {
    if (typeof b.eveSessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(b.eveSessionId)) {
      throw new LocalAgentError('bad_request', 'invalid eveSessionId')
    }
    out.eveSessionId = b.eveSessionId
  }
  if (b.streamIndex !== undefined && b.streamIndex !== null) {
    if (typeof b.streamIndex !== 'number' || !Number.isInteger(b.streamIndex) || b.streamIndex < 0) {
      throw new LocalAgentError('bad_request', 'invalid streamIndex')
    }
    out.streamIndex = b.streamIndex
  }
  if (b.status !== undefined && b.status !== null) {
    const s = sessionStatusOf(b.status)
    if (!s) throw new LocalAgentError('bad_request', 'invalid status')
    out.status = s
  }
  if (typeof b.error === 'string' && b.error.trim()) out.error = b.error.trim().slice(0, 4000)
  return out
}

/**
 * The launcher's `session` / `cursor` lines and process exits. Only the
 * session's current run may write; another run's line is ignored
 * (`applied: false`). With `previousRunId`, the line first rebinds the
 * session from that run to `runId` (CAS on run_id, a device-writable status
 * and, when `deviceId` is given, the session's device), then applies.
 */
export async function updateState(
  svc: Svc,
  userId: string,
  sessionId: string,
  input: StateUpdate,
): Promise<{ applied: boolean; stopRequested: boolean }> {
  if (!isUuid(sessionId)) throw new LocalAgentError('not_found', 'Local agent not found')
  const { data: found, error } = await svc
    .from('local_agent_session')
    .select(SESSION_SELECT)
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`session read failed: ${error.message}`)
  if (!found) throw new LocalAgentError('not_found', 'Local agent not found')
  let row = found as DbSession
  if (input.deviceId && row.device_id !== input.deviceId) {
    return { applied: false, stopRequested: !!row.stop_requested_at }
  }
  if (input.previousRunId && input.previousRunId !== input.runId && row.run_id !== input.runId) {
    if (row.run_id !== input.previousRunId || !DEVICE_WRITABLE.has(row.status)) {
      return { applied: false, stopRequested: !!row.stop_requested_at }
    }
    const { data: rebound } = await svc
      .from('local_agent_session')
      .update({ run_id: input.runId })
      .eq('id', row.id)
      .eq('user_id', userId)
      .eq('device_id', row.device_id)
      .eq('run_id', input.previousRunId)
      .in('status', [...DEVICE_WRITABLE])
      .select(SESSION_SELECT)
      .maybeSingle()
    if (!rebound) return { applied: false, stopRequested: !!row.stop_requested_at }
    row = rebound as DbSession
  }
  if (row.run_id !== input.runId || !DEVICE_WRITABLE.has(row.status)) {
    return { applied: false, stopRequested: !!row.stop_requested_at }
  }
  const extra: Record<string, unknown> = {}
  if (input.eveSessionId) extra.eve_session_id = input.eveSessionId
  if (input.streamIndex !== undefined) extra.stream_index = input.streamIndex
  if (input.error) extra.error = input.error
  const events = input.status ? [{ kind: 'status', payload: { status: input.status, ...(input.error ? { reason: input.error } : {}) } }] : []
  if (events.length === 0) {
    if (Object.keys(extra).length > 0) {
      await svc.from('local_agent_session').update(extra).eq('id', row.id).eq('user_id', userId).eq('run_id', input.runId)
    }
    return { applied: true, stopRequested: !!row.stop_requested_at }
  }
  const after = await applyDerived(svc, row, events, extra)
  return { applied: true, stopRequested: !!after.stop_requested_at }
}

// ── Message ack ─────────────────────────────────────────────────────────────

/** The Mac delivered (or failed to deliver) a message. Idempotent: an already-acked message answers `changed: false`. */
export async function ackMessage(
  svc: Svc,
  userId: string,
  messageId: string,
  input: { ok: boolean; error?: string | null },
): Promise<{ changed: boolean; status: 'pending' | 'delivered' | 'failed' }> {
  if (!isUuid(messageId)) throw new LocalAgentError('not_found', 'Message not found')
  const patch = input.ok
    ? { status: 'delivered', delivered_at: nowIso(), error: null }
    : { status: 'failed', error: (input.error ?? 'The Mac could not deliver this message.').slice(0, 4000) }
  const { data, error } = await svc
    .from('local_agent_message')
    .update(patch)
    .eq('id', messageId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('id, status, session_id, idempotency_key')
    .maybeSingle()
  if (error) throw new Error(`ack failed: ${error.message}`)
  if (data) {
    const status = (data as { status: 'delivered' | 'failed' }).status
    if (status === 'failed') await undelivered(svc, userId, data as { id: string; session_id?: string; idempotency_key?: string | null }, patch.error as string)
    return { changed: true, status }
  }
  const { data: existing } = await svc
    .from('local_agent_message')
    .select('id, status')
    .eq('id', messageId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!existing) throw new LocalAgentError('not_found', 'Message not found')
  return { changed: false, status: (existing as { status: 'pending' | 'delivered' | 'failed' }).status }
}

/**
 * A message the Mac could not take: a server `error` event in the transcript
 * (the panel and read_local_agent show it) and, when its turn was waiting on
 * it, the ledger parks the turn on "send it again".
 */
async function undelivered(svc: Svc, userId: string, msg: { id: string; session_id?: string; idempotency_key?: string | null }, reason: string): Promise<void> {
  if (!msg.session_id) return
  try {
    const { error } = await svc.from('local_agent_event').insert({
      session_id: msg.session_id,
      user_id: userId,
      source: 'server',
      kind: 'error',
      payload: { kind: 'error', message: `Your Mac couldn't take a message: ${reason}`, messageId: msg.id },
    })
    if (error) console.warn('[local-agent] undelivered event insert failed:', error.message)
    const { data: row } = await svc
      .from('local_agent_session')
      .select(SESSION_SELECT)
      .eq('id', msg.session_id)
      .eq('user_id', userId)
      .maybeSingle()
    if (row) await moveTurn(svc, ledgerSessionOf(row as DbSession), { type: 'undelivered', reason })
    // An action's re-Start whose delivery failed: its turn is over (store.ts).
    if (row && isActionStartMessage(msg.idempotency_key)) await settleActionRunStatus(svc, null, row as DbSession)
  } catch (err) {
    console.warn('[local-agent] undelivered report failed:', err instanceof Error ? err.message : err)
  }
}
