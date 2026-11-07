import 'server-only'
import { getServiceClient } from '@/lib/supabase/service'
import { CLOUD_BROWSER } from './config'

/** Whose browser: one per (user, workspace). */
export interface CloudBrowserRef {
  userId: string
  workspaceId: string
}

export type CloudBrowserStatus = 'starting' | 'running' | 'stopping' | 'stopped'

export interface CloudBrowserRow {
  user_id: string
  workspace_id: string
  sandbox_name: string
  session_id: string | null
  status: CloudBrowserStatus
  started_at: string | null
  last_active_at: string
  updated_at: string
}

export type StopReason = 'idle' | 'session_limit' | 'stuck_starting' | 'stuck_stopping'
export type StopCandidate = CloudBrowserRow & { reason: StopReason }

const TABLE = 'cloud_browser'
const COLUMNS = 'user_id, workspace_id, sandbox_name, session_id, status, started_at, last_active_at, updated_at'
const own = (ref: CloudBrowserRef) => ({ user_id: ref.userId, workspace_id: ref.workspaceId })
const db = () => getServiceClient().from(TABLE)

function check(error: { message: string } | null, what: string) {
  if (error) throw new Error(`cloud_browser ${what}: ${error.message}`)
}

/**
 * An ensure began: create the row on first use, mark a stopped browser
 * starting, and count it as activity. A running or stopping browser keeps its
 * status (a stop in progress finishes, then the ensure resumes it).
 */
export async function markStarting(ref: CloudBrowserRef, sandboxName: string): Promise<void> {
  const now = new Date().toISOString()
  const inserted = await db().upsert(
    { ...own(ref), sandbox_name: sandboxName, status: 'starting', last_active_at: now },
    { onConflict: 'user_id,workspace_id', ignoreDuplicates: true },
  )
  check(inserted.error, 'insert')
  const woken = await db().update({ status: 'starting', stop_reason: null }).match(own(ref)).eq('status', 'stopped')
  check(woken.error, 'mark starting')
  const touched = await db().update({ last_active_at: now }).match(own(ref))
  check(touched.error, 'touch on start')
}

/** Chrome answers in session `sessionId`, which the platform started at `startedAt`. */
export async function markRunning(ref: CloudBrowserRef, sessionId: string, startedAt: Date): Promise<void> {
  const { error } = await db()
    .update({ status: 'running', session_id: sessionId, started_at: startedAt.toISOString(), last_active_at: new Date().toISOString() })
    .match(own(ref))
  check(error, 'mark running')
}

/** Activity keeps a running browser from the idle stop. */
export async function touch(ref: CloudBrowserRef): Promise<void> {
  const { error } = await db().update({ last_active_at: new Date().toISOString() })
    .match(own(ref)).in('status', ['starting', 'running'])
  check(error, 'touch')
}

/**
 * Claim a browser for stopping. Compare-and-set against what the sweep read, so a
 * browser an ensure touched (or resumed) in between is left alone. Returns false
 * when it changed.
 */
export async function markStopping(ref: CloudBrowserRef, seen: StopCandidate | null): Promise<boolean> {
  let query = db().update({ status: 'stopping' }).match(own(ref))
  if (!seen) query = query.in('status', ['starting', 'running', 'stopping']) // an explicit stop
  else {
    query = query.eq('status', seen.status)
    // A busy browser near the session cap is stopped while still in use: match
    // the session, not the activity. Everything else must still be untouched.
    if (seen.reason === 'session_limit') query = seen.session_id ? query.eq('session_id', seen.session_id) : query.is('session_id', null)
    else if (seen.reason === 'stuck_stopping') query = query.eq('updated_at', seen.updated_at)
    else query = query.eq('last_active_at', seen.last_active_at)
  }
  const { data, error } = await query.select('user_id').maybeSingle()
  check(error, 'mark stopping')
  return data !== null
}

/**
 * The stop finished. Only a row still "stopping" is marked stopped: an ensure
 * that resumed the browser meanwhile has set it running (markRunning always
 * writes), so it keeps that, and a late write here can't hide a live VM.
 * A stopped browser is the agent's again: a take-over never outlives its session.
 */
export async function markStopped(ref: CloudBrowserRef, reason: string): Promise<void> {
  // A stopped browser has no tunnel and starts again in cloud mode (its new relay's hub does).
  const { error } = await db().update({ status: 'stopped', session_id: null, stop_reason: reason.slice(0, 64), driver: 'agent',
    exit_mode: null, exit_device_id: null, exit_connected_at: null })
    .match(own(ref)).eq('status', 'stopping')
  check(error, 'mark stopped')
}

/** The browser's state as the host last recorded it; null when it has never run. */
export async function readStatus(ref: CloudBrowserRef): Promise<CloudBrowserStatus | null> {
  const { data, error } = await db().select('status').match(own(ref)).maybeSingle()
  check(error, 'read status')
  return (data as { status?: CloudBrowserStatus } | null)?.status ?? null
}

export type CloudBrowserDriver = 'agent' | 'person'

/** What the computer card shows (C3): the browser's state and who drives it; null when the person has none yet. */
export async function readComputer(ref: CloudBrowserRef): Promise<{ status: CloudBrowserStatus; driver: CloudBrowserDriver; macConnected: boolean } | null> {
  const { data, error } = await db().select('status, driver, exit_connected_at').match(own(ref)).maybeSingle()
  check(error, 'read computer')
  const row = data as { status?: CloudBrowserStatus; driver?: string; exit_connected_at?: string | null } | null
  return row?.status ? { status: row.status, driver: row.driver === 'person' ? 'person' : 'agent', macConnected: !!row.exit_connected_at } : null
}

/** Who drives the browser (C3): the person after Take over, until they hand it back. No row = the agent. */
export async function readDriver(ref: CloudBrowserRef): Promise<CloudBrowserDriver> {
  const { data, error } = await db().select('driver').match(own(ref)).maybeSingle()
  check(error, 'read driver')
  return (data as { driver?: string } | null)?.driver === 'person' ? 'person' : 'agent'
}

/** Take over or hand back. Counts as activity (the person is at the browser). False when the browser has no row yet. */
export async function setDriver(ref: CloudBrowserRef, driver: CloudBrowserDriver): Promise<boolean> {
  const { data, error } = await db().update({ driver, last_active_at: new Date().toISOString() }).match(own(ref)).select('user_id').maybeSingle()
  check(error, 'set driver')
  return data !== null
}

export type CloudBrowserExitMode = 'mac' | 'cloud'

/** Where the browser's traffic leaves now (C4): the relay's last switch; null until it made one (cloud). */
export async function readExitMode(ref: CloudBrowserRef): Promise<CloudBrowserExitMode | null> {
  const { data, error } = await db().select('exit_mode').match(own(ref)).maybeSingle()
  check(error, 'read exit mode')
  const mode = (data as { exit_mode?: string } | null)?.exit_mode
  return mode === 'mac' || mode === 'cloud' ? mode : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The relay's report (C4): the exit mode, and whether a Mac's tunnel is up (which Mac, since when). */
export async function recordExit(ref: CloudBrowserRef, mode: CloudBrowserExitMode, tunnel: { up: boolean; deviceId?: string | null }): Promise<void> {
  const connected = tunnel.up ? { exit_device_id: tunnel.deviceId && UUID.test(tunnel.deviceId) ? tunnel.deviceId : null } : { exit_device_id: null, exit_connected_at: null }
  const { error } = await db().update({ exit_mode: mode, ...connected }).match(own(ref))
  check(error, 'record exit')
  if (!tunnel.up) return
  // The first report of a tunnel stamps when it came up; later ones keep that.
  const stamped = await db().update({ exit_connected_at: new Date().toISOString() }).match(own(ref)).is('exit_connected_at', null)
  check(stamped.error, 'record exit connected')
}

/** The card's Mac row (C4): since when a Mac carries the browser's traffic, or null. */
export async function readExitConnected(ref: CloudBrowserRef): Promise<string | null> {
  const { data, error } = await db().select('exit_connected_at').match(own(ref)).maybeSingle()
  check(error, 'read exit connected')
  return (data as { exit_connected_at?: string | null } | null)?.exit_connected_at ?? null
}

export async function deleteRow(ref: CloudBrowserRef): Promise<void> {
  const { error } = await db().delete().match(own(ref))
  check(error, 'delete')
}

/** Whether a row owns this sandbox name (the orphan reconcile's question). */
export async function sandboxNamesWithRows(names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  const { data, error } = await db().select('sandbox_name').in('sandbox_name', names)
  check(error, 'owners')
  return new Set(((data ?? []) as { sandbox_name: string }[]).map(row => row.sandbox_name))
}

const PRIORITY: Record<StopReason, number> = { stuck_stopping: 0, session_limit: 1, stuck_starting: 2, idle: 3 }

/**
 * Browsers the idle cron should stop, most urgent first: a stop that never
 * finished, a browser near the platform's session cap (it would time out), one
 * stuck starting, then idle ones, oldest activity first. Bounded per run.
 */
export async function listStopCandidates(now = Date.now()): Promise<StopCandidate[]> {
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString()
  const capCutoff = iso(CLOUD_BROWSER.sessionTimeoutMs - CLOUD_BROWSER.stopBeforeTimeoutMs)
  const limit = CLOUD_BROWSER.maxStopsPerSweep
  const [stopping, nearCap, starting, idle] = await Promise.all([
    db().select(COLUMNS).eq('status', 'stopping').lt('updated_at', iso(CLOUD_BROWSER.stoppingStaleMs)).limit(limit),
    db().select(COLUMNS).eq('status', 'running').lt('started_at', capCutoff).order('started_at', { ascending: true }).limit(limit),
    db().select(COLUMNS).eq('status', 'starting').lt('last_active_at', iso(CLOUD_BROWSER.startingStaleMs)).limit(limit),
    db().select(COLUMNS).eq('status', 'running').lt('last_active_at', iso(CLOUD_BROWSER.idleStopMs))
      .order('last_active_at', { ascending: true }).limit(limit),
  ])
  for (const result of [stopping, nearCap, starting, idle]) check(result.error, 'list candidates')
  const tagged = (rows: unknown, reason: StopReason) => ((rows ?? []) as CloudBrowserRow[]).map(row => ({ ...row, reason }))
  const seen = new Set<string>()
  return [
    ...tagged(stopping.data, 'stuck_stopping'), ...tagged(nearCap.data, 'session_limit'),
    ...tagged(starting.data, 'stuck_starting'), ...tagged(idle.data, 'idle'),
  ]
    .sort((a, b) => PRIORITY[a.reason] - PRIORITY[b.reason])
    .filter(row => {
      const key = `${row.user_id}:${row.workspace_id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
}
