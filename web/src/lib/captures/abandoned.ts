import type { SupabaseClient } from '@supabase/supabase-js'
import { shouldRunPostLiveBatch } from '@/lib/live-agent/default-agent'

/**
 * ABANDONED RECORDINGS — a capture whose recorder died before Stop.
 *
 * Only the recording client finishes a capture: its Stop stamps `ended_at` and
 * runs the end-of-meeting pass (the batch, or index-content closing a live
 * record), which is what emits `flow/capture.processed` → Triage. When the
 * recorder dies mid-meeting (2026-09-28: an update restarted Native Intelligence mid-
 * recording and macOS's audio daemon then deadlocked, twice in one afternoon)
 * no Stop ever comes, and nothing on the server finished the capture: the
 * index-reconciler heals only captures that already have an ai_summary, and the
 * triage-reconciler only captures that already have pending proposals. The
 * capture sat open, unextracted, untriaged, forever.
 *
 * A capture is ABANDONED when it is still open (`ended_at` null) and its row
 * has not been written for ABANDONED_QUIET_MS. A live recorder writes the row
 * on every finalized utterance (transcript-append), so an hour with no write at
 * all is a dead recorder, not a quiet meeting. The close is a CAS on the exact
 * `updated_at` it read: a recorder that writes in between always wins, and the
 * capture is left alone.
 *
 * Closing locks the transcript (the `lock_transcript_on_end` trigger), exactly
 * as Stop does, and the recovery prompt then skips the capture ("already
 * ended"). Resume (POST /captures/[id]/resume) still reopens it.
 *
 * A TEAM CALL'S NOTES (captures.notes_channel_id) are never abandoned: the
 * call recorder fills them in on the server, and the call's end finishes
 * them, however long nobody spoke.
 *
 * DECLINED RECOVERY is the same gap from the client side: when the app comes
 * back within ten minutes of a recorder that died, it offers to resume the
 * capture. Declining it used to stamp `ended_at` and run nothing, so the
 * meeting was never extracted or triaged, and this sweep, which reads only
 * open captures, never saw it. The decline now closes the capture here
 * (`declineRecovery`, the same close with reason `recovery_declined`) and the
 * finalizer runs the end-of-meeting pass on it (`loadDeclinedCapture`).
 *
 * RETIRED CAPTURES are the open ones the finish never reaches: quiet past the
 * lookback (an old stray must not fire a batch, a title, an index and Triage on
 * a meeting from weeks ago), or with no meeting in them (nothing to finish).
 * Nothing else ever closed those, so they stayed open for good (PROD
 * 2026-10-21: dozens, back to April), each one still "recording" to whatever
 * reads `ended_at IS NULL`. The sweep now retires an open capture once its row
 * has not been written for the whole lookback: `ended_at` at the last write and
 * `metadata.finalized` marked, nothing else (`retireStaleCapture`), and no pass.
 * A near-empty capture is retired at the lookback too, not at the hour: the
 * recorder saves nothing while nobody speaks, so an hour of silence on a blank
 * capture can be a live recorder waiting for its meeting, and the close's
 * transcript lock is terminal for it. Three days of silence is not a recorder.
 */

/** Why the server closed a capture: its recorder went quiet, or its owner
 *  declined to resume it. Recorded as `metadata.finalized.reason`; a retired
 *  capture's is `'stale'` (`retireStaleCapture`). */
export type FinalizeReason = 'recorder_quiet' | 'recovery_declined'

/** No write to the row for this long ⇒ the recorder is gone. */
export const ABANDONED_QUIET_MS = 60 * 60 * 1000
/** Only captures that went quiet within this window are finished: the
 *  finalizer is for a recorder that just died, not a sweep over old strays.
 *  An open capture quiet for longer is retired instead (no pass). */
export const ABANDONED_LOOKBACK_MS = 72 * 60 * 60 * 1000
/** Non-whitespace transcript chars below which there is no meeting to finish.
 *  An empty open row is not finished (a blank start, or a calendar-synced row
 *  waiting for its meeting); a started one is retired at the lookback. */
export const MIN_ABANDONED_TRANSCRIPT_CHARS = 200
/** Captures finalized per sweep; the rest wait for the next tick. */
export const ABANDONED_SWEEP_CAP = 5
/** Captures retired per sweep: one UPDATE each, so a backlog clears in a few ticks. */
export const RETIRE_SWEEP_CAP = 50
/** Open rows scanned per sweep (rows with no transcript are excluded in SQL). */
const CANDIDATE_SCAN_LIMIT = 50

export const ABANDONED_CAPTURE_SELECT =
  'id, workspace_id, user_id, started_at, updated_at, duration_seconds, live_mode, ai_summary, transcript, metadata, is_eval, status, notes_channel_id'

export interface AbandonedCaptureRow {
  id: string
  workspace_id: string | null
  user_id: string | null
  started_at: string | null
  updated_at: string
  duration_seconds: number | null
  live_mode: boolean | null
  ai_summary: string | null
  transcript: string | null
  metadata: Record<string, unknown> | null
  is_eval: boolean | null
  status: string | null
  /** A team call's notes (566): its call finishes it, never this sweep. */
  notes_channel_id?: string | null
}

/**
 * The row-level rules, PURE (the quiet window is the query's). Never an eval
 * or demo capture (they never fire loops), never an archived one, never one
 * without an owner and a workspace (the pass runs as the owner, in the
 * capture's workspace), and never one with no meeting in it.
 */
export function isAbandonedCandidate(row: AbandonedCaptureRow): boolean {
  if (row.is_eval === true) return false
  // A call's notes have no recorder on anyone's machine: the call's own end finishes them
  // (src/lib/team-calls/fed-notes.ts), even after an hour in which nobody spoke or notes were off.
  if (row.notes_channel_id) return false
  if (row.metadata?.demo === true) return false
  if (row.status === 'archived') return false
  if (!row.user_id || !row.workspace_id) return false
  return (row.transcript ?? '').replace(/\s/g, '').length >= MIN_ABANDONED_TRANSCRIPT_CHARS
}

/** Is the row past the quiet window, and inside the lookback, at `now`? */
export function isQuiet(row: Pick<AbandonedCaptureRow, 'updated_at'>, now: number): boolean {
  const at = Date.parse(row.updated_at)
  return Number.isFinite(at) && at < now - ABANDONED_QUIET_MS && at >= now - ABANDONED_LOOKBACK_MS
}

/** Open captures that went quiet within the lookback, oldest quiet first. */
export async function findAbandonedCaptures(
  service: SupabaseClient,
  now = Date.now(),
): Promise<AbandonedCaptureRow[]> {
  const { data, error } = await service
    .from('captures')
    .select(ABANDONED_CAPTURE_SELECT)
    .is('ended_at', null)
    // Eval fence in the query (is_eval is NOT NULL, default false), and again
    // in isAbandonedCandidate for the per-capture re-read.
    .neq('is_eval', true)
    .lt('updated_at', new Date(now - ABANDONED_QUIET_MS).toISOString())
    .gte('updated_at', new Date(now - ABANDONED_LOOKBACK_MS).toISOString())
    // Rows that can never qualify are dropped IN the query: left to the code
    // filter, empty open rows (calendar placeholders, blank starts) filled the
    // scan window and starved a real abandoned recording behind them.
    .not('transcript', 'is', null)
    .neq('transcript', '')
    .not('user_id', 'is', null)
    .not('workspace_id', 'is', null)
    .is('notes_channel_id', null)
    .order('updated_at', { ascending: true })
    .limit(CANDIDATE_SCAN_LIMIT)
  if (error) {
    console.warn('[abandoned-capture] candidate scan failed:', error.message)
    return []
  }
  return ((data ?? []) as AbandonedCaptureRow[]).filter(isAbandonedCandidate)
}

/**
 * Re-read one capture and apply every rule again at `now` — the per-capture
 * finalize must not act on the sweep's snapshot. Null when it is no longer
 * abandoned (ended, written since, archived…) or its owner is no longer a
 * member of its workspace (the pass would run as someone the workspace
 * removed).
 */
export async function loadAbandonedCapture(
  service: SupabaseClient,
  args: { captureId: string; workspaceId: string },
  now = Date.now(),
): Promise<AbandonedCaptureRow | null> {
  const { data } = await service
    .from('captures')
    .select(ABANDONED_CAPTURE_SELECT)
    .eq('id', args.captureId)
    .eq('workspace_id', args.workspaceId)
    .is('ended_at', null)
    .maybeSingle()
  const row = data as AbandonedCaptureRow | null
  if (!row || !isAbandonedCandidate(row) || !isQuiet(row, now)) return null
  return (await ownerIsMember(service, row, args.workspaceId)) ? row : null
}

/** The pass runs as the capture's owner: never as someone the workspace removed. */
async function ownerIsMember(
  service: SupabaseClient,
  row: Pick<AbandonedCaptureRow, 'user_id'>,
  workspaceId: string,
): Promise<boolean> {
  const { data: member } = await service
    .from('member')
    .select('id')
    .eq('user_id', row.user_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return !!member
}

/**
 * Close the capture the way Stop does, CAS-guarded on the `updated_at` read:
 * any write since (a recorder that came back) makes this a no-op. `ended_at`
 * is the last write to the row — when the recorder went quiet, not when the
 * sweep noticed. A duration the client already set is kept; otherwise it is
 * the wall-clock span to that last write. `metadata.finalized` records why the
 * server closed it. Returns whether this call closed it.
 */
export async function closeAbandonedCapture(
  service: SupabaseClient,
  row: AbandonedCaptureRow,
  now = Date.now(),
  reason: FinalizeReason = 'recorder_quiet',
): Promise<boolean> {
  const started = row.started_at ? Date.parse(row.started_at) : NaN
  const lastWrite = Date.parse(row.updated_at)
  const span = Number.isFinite(started) && lastWrite > started ? Math.round((lastWrite - started) / 1000) : null
  const { data, error } = await service
    .from('captures')
    .update({
      ended_at: row.updated_at,
      duration_seconds: row.duration_seconds ?? span,
      ai_processed: true,
      metadata: {
        ...(row.metadata ?? {}),
        finalized: {
          by: reason === 'recovery_declined' ? 'owner' : 'server',
          reason,
          at: new Date(now).toISOString(),
        },
      },
    })
    .eq('id', row.id)
    .eq('workspace_id', row.workspace_id)
    .is('ended_at', null)
    .eq('updated_at', row.updated_at)
    .select('id')
  if (error) {
    console.warn('[abandoned-capture] close failed:', row.id, error.message)
    return false
  }
  return (data ?? []).length > 0
}

export type StaleCaptureRow = Pick<AbandonedCaptureRow, 'id' | 'workspace_id' | 'updated_at' | 'metadata'>

/**
 * Open captures quiet past the lookback, oldest quiet first, at most `limit`.
 * Every fence is in the query, so rows that may never be retired cannot fill
 * the window: never an eval or demo capture, never an archived one, and never
 * one that was never started (calendar sync's and the agent's pending rows for
 * a meeting ahead have no `started_at`).
 */
export async function findStaleCaptures(
  service: SupabaseClient,
  now = Date.now(),
  limit = RETIRE_SWEEP_CAP,
): Promise<StaleCaptureRow[]> {
  const { data, error } = await service
    .from('captures')
    .select('id, workspace_id, updated_at, metadata')
    .is('ended_at', null)
    .neq('is_eval', true)
    .not('started_at', 'is', null)
    .not('workspace_id', 'is', null)
    // A NULL is never `neq` anything in Postgres, so each NULL is let through
    // by name (the two filters AND).
    .or('status.is.null,status.neq.archived')
    .or('metadata->>demo.is.null,metadata->>demo.neq.true')
    .lt('updated_at', new Date(now - ABANDONED_LOOKBACK_MS).toISOString())
    .order('updated_at', { ascending: true })
    .limit(limit)
  if (error) {
    console.warn('[abandoned-capture] stale scan failed:', error.message)
    return []
  }
  return (data ?? []) as StaleCaptureRow[]
}

/**
 * Retire a stale capture: `ended_at` at its last write and
 * `metadata.finalized = { by: 'server', reason: 'stale' }`, nothing else of its
 * own (the row's triggers still lock the transcript and bump `updated_at`),
 * under the finish's CAS (a write since the read, or an end already stamped,
 * makes it a no-op). Not the finish's close: its duration, the span to the last
 * write, may be weeks of later edits, and `ai_processed` would say a pass ran.
 * The triage reconciler never fires for a retired capture (captureReadiness).
 * The owner can still Resume or Reprocess it. Returns whether this call closed
 * it.
 */
export async function retireStaleCapture(
  service: SupabaseClient,
  row: StaleCaptureRow,
  now = Date.now(),
): Promise<boolean> {
  const { data, error } = await service
    .from('captures')
    .update({
      ended_at: row.updated_at,
      metadata: {
        ...(row.metadata ?? {}),
        finalized: { by: 'server', reason: 'stale', at: new Date(now).toISOString() },
      },
    })
    .eq('id', row.id)
    .eq('workspace_id', row.workspace_id)
    .is('ended_at', null)
    .eq('updated_at', row.updated_at)
    .select('id')
  if (error) {
    console.warn('[abandoned-capture] retire failed:', row.id, error.message)
    return false
  }
  return (data ?? []).length > 0
}

/** The sweep's retire pass: up to RETIRE_SWEEP_CAP stale captures, each on its
 *  own CAS. Returns how many it closed. */
export async function retireStaleCaptures(service: SupabaseClient, now = Date.now()): Promise<number> {
  let retired = 0
  for (const row of await findStaleCaptures(service, now)) {
    if (await retireStaleCapture(service, row, now)) retired += 1
  }
  return retired
}

/** What declining the recovery prompt did. */
export type DeclineOutcome =
  /** Not this caller's capture (or not in this workspace). */
  | { status: 'not_found' }
  /** Already ended (Stop, the sweep, or an earlier decline): left as it is. */
  | { status: 'already_ended' }
  /** Written between the read and the close: left open, nothing done. */
  | { status: 'changed' }
  /** Closed now. `finish`: it has a meeting in it, so the end-of-meeting pass
   *  should run (a blank or a blip is only closed, as Stop would leave it).
   *  `endedAt`: the `ended_at` it was closed at, which tells this close apart
   *  from an earlier one of the same capture (resumed, then declined again). */
  | { status: 'ended'; finish: boolean; endedAt: string }

/**
 * The owner declined to resume their interrupted capture: close it as Stop
 * does. The same close as the sweep's (CAS on the last write, `ended_at` at the
 * last write — when the recorder died, not when the prompt was answered), with
 * `metadata.finalized = { by: 'owner', reason: 'recovery_declined' }`, which is
 * what `loadDeclinedCapture` later requires. Only the capture's own recorder
 * owner can decline it. No quiet window: the owner says it is over.
 */
export async function declineRecovery(
  service: SupabaseClient,
  args: { captureId: string; workspaceId: string; userId: string },
  now = Date.now(),
): Promise<DeclineOutcome> {
  const read = async () => {
    const { data } = await service
      .from('captures')
      .select(`${ABANDONED_CAPTURE_SELECT}, ended_at`)
      .eq('id', args.captureId)
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .maybeSingle()
    return data as (AbandonedCaptureRow & { ended_at: string | null }) | null
  }
  const row = await read()
  if (!row) return { status: 'not_found' }
  if (row.ended_at) return { status: 'already_ended' }
  if (await closeAbandonedCapture(service, row, now, 'recovery_declined')) {
    return { status: 'ended', finish: isAbandonedCandidate(row), endedAt: row.updated_at }
  }
  const after = await read()
  return after?.ended_at ? { status: 'already_ended' } : { status: 'changed' }
}

/**
 * Re-read a capture its owner declined to resume, for the finalizer: closed by
 * `declineRecovery` (never one Stop or the sweep closed, which run their own
 * pass), not processed yet, still a candidate, and its owner still a member.
 * Null otherwise.
 */
export async function loadDeclinedCapture(
  service: SupabaseClient,
  args: { captureId: string; workspaceId: string },
): Promise<AbandonedCaptureRow | null> {
  const { data } = await service
    .from('captures')
    .select(`${ABANDONED_CAPTURE_SELECT}, ended_at, batch_processed_at`)
    .eq('id', args.captureId)
    .eq('workspace_id', args.workspaceId)
    .is('batch_processed_at', null)
    .maybeSingle()
  const row = data as (AbandonedCaptureRow & { ended_at: string | null }) | null
  if (!row?.ended_at) return null
  const finalized = row.metadata?.finalized as { reason?: unknown } | undefined
  if (finalized?.reason !== 'recovery_declined') return null
  if (!isAbandonedCandidate(row)) return null
  return (await ownerIsMember(service, row, args.workspaceId)) ? row : null
}

/**
 * Does the record still have to be written — the batch pass — or was it
 * written live? Stop decides with `shouldRunPostLiveBatch` from client state
 * the server does not have (which agent drove the call). Server-side: live mode
 * off, or an edition that names a batch persona, runs the batch exactly as
 * Stop would; a live capture with NO summary runs it too, since nothing wrote
 * the record (an assist-only live agent, or a live agent that died with the
 * recorder). Only a live capture whose summary exists is closed without one.
 */
export function needsBatchPass(
  row: Pick<AbandonedCaptureRow, 'live_mode' | 'ai_summary'>,
  hasBatchDefault: boolean,
): boolean {
  // The column defaults to true (legacy live behavior), so only false is off.
  const liveMode = row.live_mode !== false
  return shouldRunPostLiveBatch({ liveMode, hasBatchDefault }) || !(row.ai_summary ?? '').trim()
}
