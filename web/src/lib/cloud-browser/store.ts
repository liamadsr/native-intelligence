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

/**
 * Why a browser was stopped. Never listed by the sweep: `evicted`, it gave its
 * slot to another person's browser (slots.ts); `start_failed`, the ensure that
 * started it failed and paused what it had woken (host.ts).
 */
export type StopReason = 'idle' | 'session_limit' | 'stuck_starting' | 'stuck_stopping' | 'evicted' | 'start_failed'
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
 *
 * `moved`: THIS call made the row `starting` (it inserted it, or it was the one
 * update that found it `stopped`; Postgres lets only one of two racing ensures
 * match). Only such an ensure takes a shared slot for it, and only it may put
 * the row back after it failed (host.ts). `at`: the activity it wrote, which a
 * compare-and-set on the row later checks (nobody touched it since).
 *
 * `started_at` is set when the row BECOMES starting: while it is starting it
 * says when this start began (the sweep's stuck-starting stop is judged by it,
 * not by the activity every retry renews); markRunning then writes the run's
 * own start over it, which is what the session cap reads on a running row.
 */
export async function markStarting(ref: CloudBrowserRef, sandboxName: string): Promise<{ moved: boolean; at: string }> {
  const now = new Date().toISOString()
  const inserted = await db().upsert(
    { ...own(ref), sandbox_name: sandboxName, status: 'starting', started_at: now, last_active_at: now },
    { onConflict: 'user_id,workspace_id', ignoreDuplicates: true },
  ).select('user_id')
  check(inserted.error, 'insert')
  const woken = await db().update({ status: 'starting', stop_reason: null, started_at: now }).match(own(ref)).eq('status', 'stopped').select('user_id')
  check(woken.error, 'mark starting')
  const touched = await db().update({ last_active_at: now }).match(own(ref))
  check(touched.error, 'touch on start')
  const rows = (result: { data?: unknown }) => (Array.isArray(result.data) ? result.data.length : 0)
  return { moved: rows(inserted) + rows(woken) > 0, at: now }
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
export async function markStopped(ref: CloudBrowserRef, reason: string, options: { keepSession?: boolean } = {}): Promise<void> {
  // A stopped browser has no tunnel and starts again in cloud mode (its new relay's hub does).
  // `keepSession` (the runtime backend): the row keeps naming the sandbox its profile is in,
  // which chooses the copy to wake. Every reader of a session checks the status first.
  const { error } = await db().update({ status: 'stopped', ...(options.keepSession ? {} : { session_id: null }), stop_reason: reason.slice(0, 64), driver: 'agent',
    exit_mode: null, exit_device_id: null, exit_connected_at: null })
    .match(own(ref)).eq('status', 'stopping')
  check(error, 'mark stopped')
}

/** The browser's whole row with who drives it, as it is now (a stop's compare-and-set is made against it); null when it has never run. */
export async function readRow(ref: CloudBrowserRef): Promise<(CloudBrowserRow & { driver: CloudBrowserDriver }) | null> {
  const { data, error } = await db().select(`${COLUMNS}, driver`).match(own(ref)).maybeSingle()
  check(error, 'read row')
  const row = data as (CloudBrowserRow & { driver?: string | null }) | null
  return row ? { ...row, driver: row.driver === 'person' ? 'person' : 'agent' } : null
}

/** The browser's state as the host last recorded it; null when it has never run. */
export async function readStatus(ref: CloudBrowserRef): Promise<CloudBrowserStatus | null> {
  const { data, error } = await db().select('status').match(own(ref)).maybeSingle()
  check(error, 'read status')
  return (data as { status?: CloudBrowserStatus } | null)?.status ?? null
}

/** The browser's state and its session as the host last recorded them (the runtime backend reads its hub from the session); null when it has never run. */
export async function readSession(ref: CloudBrowserRef): Promise<{ status: CloudBrowserStatus; sessionId: string | null } | null> {
  const { data, error } = await db().select('status, session_id').match(own(ref)).maybeSingle()
  check(error, 'read session')
  const row = data as { status?: CloudBrowserStatus; session_id?: string | null } | null
  return row?.status ? { status: row.status, sessionId: row.session_id ?? null } : null
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

/**
 * Browsers stopped and unused since before `cutoff` (the runtime backend's
 * expiry, host.ts reconcile), oldest first, at most `limit`.
 */
export async function listUnusedStopped(cutoff: Date, limit: number): Promise<CloudBrowserRow[]> {
  const { data, error } = await db().select(COLUMNS).eq('status', 'stopped').lt('last_active_at', cutoff.toISOString())
    .order('last_active_at', { ascending: true }).limit(limit)
  check(error, 'list unused')
  return (data ?? []) as CloudBrowserRow[]
}

/** The stop_reason that marks a row the expiry claimed (status `stopping`). */
export const EXPIRING = 'expiring'

/**
 * Claim a browser unused since `lastActiveAt` for the expiry (the runtime
 * backend; host.ts reconcile): compare-and-set from `stopped` with that same
 * last activity to `stopping` + stop_reason `expiring`. An ensure that began in
 * between moved the row off `stopped` (markStarting), so the claim fails and
 * the browser is left alone; an ensure that begins after it finds the claim
 * (isExpiring) and fails, to be retried. `stopping` is one of the states the
 * column's CHECK allows (migration 421): no migration. Its other readers stay
 * right: touch() and the relay acceptance ignore it, markStarting leaves it,
 * and the sweep's stuck_stopping retry turns a claim whose run died back into
 * `stopped` after stoppingStaleMs (the next reconcile then tries again).
 * True when this call claimed it.
 */
export async function claimUnusedForExpiry(ref: CloudBrowserRef, lastActiveAt: string): Promise<boolean> {
  const { data, error } = await db().update({ status: 'stopping', stop_reason: EXPIRING })
    .match(own(ref)).eq('status', 'stopped').eq('last_active_at', lastActiveAt).select('user_id').maybeSingle()
  check(error, 'claim unused')
  return data !== null
}

/** Whether the expiry holds this browser's row (an ensure must not start it). */
export async function isExpiring(ref: CloudBrowserRef): Promise<boolean> {
  const { data, error } = await db().select('status, stop_reason').match(own(ref)).maybeSingle()
  check(error, 'read expiring')
  const row = data as { status?: string; stop_reason?: string | null } | null
  return row?.status === 'stopping' && row.stop_reason === EXPIRING
}

/** Delete a row the expiry still holds (its VM is gone). True when it was deleted. */
export async function deleteExpiringRow(ref: CloudBrowserRef): Promise<boolean> {
  const { data, error } = await db().delete().match(own(ref)).eq('status', 'stopping').eq('stop_reason', EXPIRING).select('user_id').maybeSingle()
  check(error, 'delete expiring')
  return data !== null
}

/**
 * The sandbox id the row of browser `sandboxName` names (its session id's
 * first part, the runtime backend's `<sandbox id>.<ms>`), or null: no row,
 * or no session (a stopped browser's session is null).
 */
export async function sessionOfSandboxName(sandboxName: string): Promise<string | null> {
  const { data, error } = await db().select('session_id').eq('sandbox_name', sandboxName).maybeSingle()
  check(error, 'read session by name')
  return (data as { session_id?: string | null } | null)?.session_id ?? null
}

/**
 * Whether a browser whose session is on sandbox `sandboxId` is starting or
 * running (the hub's certificate question, hub-tls.ts). `sandboxId` must be
 * the runtime's id shape; the match is an exact prefix `<id>.`, escaped.
 */
export async function hubSessionLive(sandboxId: string): Promise<boolean> {
  if (!/^[a-z0-9]{1,63}$/.test(sandboxId)) return false
  const escaped = sandboxId.replace(/[\\%_]/g, ch => `\\${ch}`)
  const { data, error } = await db().select('user_id').in('status', ['starting', 'running']).like('session_id', `${escaped}.%`).limit(1)
  check(error, 'hub session')
  return Array.isArray(data) && data.length > 0
}

/**
 * The runtime backend, as soon as an ensure knows the sandbox it uses (a create
 * it keeps, or a wake): the row of browser `sandboxName` names it, so the hub's
 * certificate question (hubSessionLive) says yes while the row is `starting`
 * and the edge can get the certificate before the live view's first handshake.
 * Only a `starting` row: a running one already names its sandbox (and the
 * sweep's session_limit compare-and-set reads it), a stopping or stopped one is
 * not this ensure's to rename. `<id>.0` is a session with no run yet (the form
 * the operator's guide uses, runtime-browser.ts); markRunning writes the real
 * one. What chooseSandbox reads stays true: the id is the sandbox this ensure
 * took up, the one that holds the person's newest profile from now on.
 */
export async function recordStartingSandbox(sandboxName: string, sandboxId: string): Promise<boolean> {
  if (!/^[a-z0-9]{1,63}$/.test(sandboxId)) return false
  const { data, error } = await db().update({ session_id: `${sandboxId}.0` }).eq('sandbox_name', sandboxName).eq('status', 'starting').select('user_id')
  check(error, 'record starting sandbox')
  // False when no starting row was there to name it (then nothing may ask the edge for it).
  return Array.isArray(data) && data.length > 0
}

/**
 * An ensure the shared slots refused (slots.ts): nothing of the browser came
 * up, so its row goes back to `stopped` (reason `busy`) and holds no slot. A
 * compare-and-set on the row as that ensure left it (`starting`, the activity
 * `at` it wrote): one that is running, being stopped, or touched since (another
 * ensure of the person's began, a command, a viewer) is not this ensure's to
 * put back. The session is kept (the runtime backend's row names the sandbox
 * its profile is in). True when it did.
 */
export async function releaseStart(ref: CloudBrowserRef, at: string): Promise<boolean> {
  const { data, error } = await db().update({ status: 'stopped', stop_reason: 'busy' }).match(own(ref)).eq('status', 'starting')
    .eq('last_active_at', at).select('user_id').maybeSingle()
  check(error, 'release start')
  return data !== null
}

/** A row holding a slot, with what the eviction's compare-and-set needs (slots.ts). */
export type SlotHolder = CloudBrowserRow & { stop_reason: string | null; driver: string | null }

/** More rows than any cap: past this the slots are full whatever the rest are. */
const SLOT_SCAN_LIMIT = 200

/**
 * The browsers that hold memory on the runtime now, as far as the rows tell:
 * `starting` (an ensure on it, or a failed one the sweep will stop), `running`,
 * and `stopping` but for the expiry's claim (its VM is paused already; a stop's
 * VM is not until its pause lands). Idle longest first.
 */
export async function listSlotHolders(): Promise<SlotHolder[]> {
  const { data, error } = await db().select(`${COLUMNS}, stop_reason, driver`).in('status', ['starting', 'running', 'stopping'])
    .order('last_active_at', { ascending: true }).limit(SLOT_SCAN_LIMIT)
  check(error, 'slot holders')
  return ((data ?? []) as SlotHolder[]).filter(row => !(row.status === 'stopping' && row.stop_reason === EXPIRING))
}

/**
 * Of `refs`, the browsers in use though nobody touches them, as
 * `<user>:<workspace>` keys. Such a browser never gives its slot away:
 *  - a command in flight or about to be: claimed or running under a lease
 *    that has not run out, or waiting to be claimed and not expired (a task's
 *    claim and settle are its only touches, and it can outlast the floor);
 *  - a browser step waiting on the person: a pending, unexpired approval of
 *    `run_browser_task` (approval-card.ts raises it when a task reaches a
 *    sensitive step, and the task's command ends there). Accepting replays the
 *    task in the same tab, so the page it is about (a filled form, a checkout)
 *    must still be open; a pause closes Chrome. The idle sweep still stops it
 *    after its idle time, as before: this only keeps the slots from doing so sooner.
 * One query per browser, each stopping at its first row: no person's backlog
 * hides another's live command. At most the 20 candidates host.ts asks about.
 */
export async function browsersInUse(refs: CloudBrowserRef[], now = Date.now()): Promise<Set<string>> {
  const nowIso = new Date(now).toISOString()
  const live = new Set<string>()
  await Promise.all(refs.map(async ref => {
    const key = `${ref.userId}:${ref.workspaceId}`
    const [commands, approvals] = await Promise.all([
      getServiceClient().from('browser_command_queue').select('id').eq('user_id', ref.userId).eq('workspace_id', ref.workspaceId)
        .or(`and(status.in.(claimed,running),lease_expires_at.gt."${nowIso}"),and(status.eq.waiting_for_device,expires_at.gt."${nowIso}")`).limit(1),
      getServiceClient().from('tool_approval').select('id').eq('user_id', ref.userId).eq('workspace_id', ref.workspaceId)
        .eq('tool', 'run_browser_task').eq('status', 'pending').gt('expires_at', nowIso).limit(1),
    ])
    check(commands.error, 'live commands')
    check(approvals.error, 'pending approvals')
    if ((commands.data?.length ?? 0) > 0 || (approvals.data?.length ?? 0) > 0) live.add(key)
  }))
  return live
}

/** How many browsers stopped in the last `withinMs` gave their slot away (the sweep's report): rows whose last stop was one. */
export async function countRecentEvictions(withinMs: number, now = Date.now()): Promise<number> {
  const { count, error } = await db().select('user_id', { count: 'exact', head: true }).eq('stop_reason', 'evicted')
    .gt('updated_at', new Date(now - withinMs).toISOString())
  check(error, 'recent evictions')
  return count ?? 0
}

/** Whether a row owns this sandbox name (the orphan reconcile's question). */
export async function sandboxNamesWithRows(names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  const { data, error } = await db().select('sandbox_name').in('sandbox_name', names)
  check(error, 'owners')
  return new Set(((data ?? []) as { sandbox_name: string }[]).map(row => row.sandbox_name))
}

const PRIORITY: Record<StopReason, number> = { stuck_stopping: 0, session_limit: 1, stuck_starting: 2, idle: 3, evicted: 4, start_failed: 5 }

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
    // An expiry's claim only much later: its destroy may still be on its way (claimUnusedForExpiry).
    db().select(COLUMNS).eq('status', 'stopping').lt('updated_at', iso(CLOUD_BROWSER.stoppingStaleMs))
      .or(`stop_reason.is.null,stop_reason.neq.${EXPIRING},updated_at.lt."${iso(CLOUD_BROWSER.expiringStaleMs)}"`).limit(limit),
    db().select(COLUMNS).eq('status', 'running').lt('started_at', capCutoff).order('started_at', { ascending: true }).limit(limit),
    // By when the start BEGAN (markStarting's started_at), not its activity: a person retrying a start that keeps
    // failing touches the row each time, and must not hold it (and a slot) for good. A row from before that, or
    // with none, by its activity.
    db().select(COLUMNS).eq('status', 'starting')
      .or(`started_at.lt."${iso(CLOUD_BROWSER.startingStaleMs)}",and(started_at.is.null,last_active_at.lt."${iso(CLOUD_BROWSER.startingStaleMs)}")`).limit(limit),
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
