/**
 * The parked session of a loop's skill run (bots v3 Phase 4, migration 303;
 * docs/plans/bots-v3.md "the exact chat for loop runs").
 *
 * A server skill run whose ledger row names a teammate keeps its eve session
 * (runViaEve `park`). When the run ends cleanly the session
 * stays parked at `session.waiting`, holding everything the run read, called
 * and decided. This module keeps the handle to it, one per ledger row
 * (`tracked_job_session`, keyed on `tracked_job.id`), so Reply and Open in Native Intelligence
 * on the loop's item continue THAT chat (/api/account/activity/[id]/chat).
 *
 * Why its own table, never a column on `tracked_job`: `tracked_job` is in the
 * `supabase_realtime` publication with REPLICA IDENTITY FULL (migrations 272 and
 * 295), so a column there would broadcast the session handle to every
 * subscriber on each update. `tracked_job_session` stays out of the
 * publication, and its RLS has no policy at all: only the service role reads
 * or writes it, as `agent_run.session_state` is written (migration 200).
 *
 * What the browser learns is one boolean on the ledger row the owner already
 * reads, `source.run_chat` (lib/bots/item-run-chat.ts routes on it): never the
 * session id, never the cursor.
 *
 * Two jsonb blobs on the row:
 *   session_state — the eve cursor, the agent_run contract (migration 200):
 *                   { sessionId, streamIndex, settleStreamIndex, previous? }.
 *                   streamIndex advances after each follow-up turn;
 *                   settleStreamIndex is frozen at the park (GET replay starts
 *                   there, so the run's own turn, an internal task message,
 *                   never shows). `previous` lists the chat's earlier sessions
 *                   once its session expired and it reopened in a new one
 *                   (loop-run-chat-reopen.ts, swapSkillRunSession): the replay
 *                   shows them first. A new run's park starts a new chat, so it
 *                   writes none.
 *   run_facts     — what a follow-up turn's fresh run token is minted from
 *                   (skill-run-token.ts RunTokenClaims): the skill, its mode,
 *                   the capture flag, the contract, the model and the run-as
 *                   user. Copied from the run's spec at park time, so the chat
 *                   never re-derives who the run was.
 *
 * Every write here is best-effort and never throws: a lost handle only means
 * the item keeps the teammate's own thread plus the run's "about" section
 * (bots v3 1d), as runs from before this phase do.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WorkHandle } from '@/lib/work/recorder'
import { parsePreviousSessions, type RunChatPreviousSession } from '@/lib/agent-run/run-chat-previous'
import type { ParkedSkillSession } from './run-skill-eve'
import type { SkillRunSpec } from './run-skill'

export const SKILL_RUN_SESSION_TABLE = 'tracked_job_session'

/** The eve cursor of a parked skill-run session (the agent_run.session_state contract). */
export interface SkillRunSessionState {
  sessionId: string
  /** The ADVANCING read cursor: a follow-up POST resumes streaming here. */
  streamIndex: number
  /** The FROZEN boundary at the park: GET replay starts here. */
  settleStreamIndex: number
  /** The chat's earlier, expired sessions, oldest first (run-chat-previous.ts). */
  previous?: RunChatPreviousSession[]
}

/** What a follow-up turn's run token is minted from (RunTokenClaims, less the chat and expiry). */
export interface SkillRunFacts {
  skillId: string
  mode: 'report' | 'act'
  hasCapture: boolean
  outputContract: 'verdict' | 'prose'
  model: string
  runAsUserId: string
}

/** A parked skill-run session as the chat route reads it. */
export interface SkillRunSessionRecord {
  workItemId: string
  workspaceId: string
  state: SkillRunSessionState
  facts: SkillRunFacts
}

/**
 * Whether a run should park its session: a server run with a real ledger row
 * that names its teammate. The chat is the bot's (its attended chat limit is
 * the follow-up ceiling), so a run nobody fronts keeps its task session, and an
 * inert handle has no row to key the handle on.
 */
export function shouldParkSkillRun(work: WorkHandle | null | undefined): work is WorkHandle & { id: string } {
  return !!work && !work.inert && typeof work.id === 'string' && work.id.length > 0 && !!work.aiTeamMemberId
}

/**
 * Keep the handle of a run that parked, then tell the ledger row its chat can
 * be continued (`source.run_chat`). A later run on the same row (a loop with
 * two skill steps) replaces the handle: the newest run's chat is the one to
 * continue. Never throws; resolves whether the handle was kept.
 */
export async function parkSkillRunSession(
  supabase: SupabaseClient,
  args: {
    work: WorkHandle & { id: string }
    workspaceId: string
    parked: ParkedSkillSession
    spec: Pick<SkillRunSpec, 'skillId' | 'mode' | 'outputContract' | 'model' | 'runAsUserId'>
    hasCapture: boolean
    /** Stops the session of a handle this one replaces, once it's replaced (it can't be continued any more). */
    onReplaced?: (sessionId: string) => Promise<unknown>
  },
): Promise<boolean> {
  const { work, workspaceId, parked, spec, hasCapture, onReplaced } = args
  try {
    // The handle a previous run on this row kept, if any (read before it's replaced).
    let replaced: string | null = null
    // Best effort: a failed read only leaves that older session parked.
    if (onReplaced) {
      try {
        const { data: prior } = await supabase
          .from(SKILL_RUN_SESSION_TABLE)
          .select('session_state')
          .eq('tracked_job_id', work.id)
          .maybeSingle()
        const priorId = parseSkillRunSessionState((prior as { session_state?: unknown } | null)?.session_state)?.sessionId ?? null
        replaced = priorId && priorId !== parked.sessionId ? priorId : null
      } catch {
        replaced = null
      }
    }
    const state: SkillRunSessionState = {
      sessionId: parked.sessionId,
      streamIndex: parked.streamIndex,
      settleStreamIndex: parked.streamIndex,
    }
    const facts: SkillRunFacts = {
      skillId: spec.skillId,
      mode: spec.mode,
      hasCapture,
      outputContract: spec.outputContract === 'verdict' ? 'verdict' : 'prose',
      model: spec.model,
      runAsUserId: spec.runAsUserId,
    }
    const { error } = await supabase.from(SKILL_RUN_SESSION_TABLE).upsert(
      {
        tracked_job_id: work.id,
        workspace_id: workspaceId,
        session_state: state,
        run_facts: facts,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tracked_job_id' },
    )
    if (error) throw new Error(error.message)
    if (replaced && onReplaced) await onReplaced(replaced).catch(() => {})
    await work.link({ source: { run_chat: true } })
    return true
  } catch (err) {
    console.warn('[skill-run-session] could not keep the parked session', {
      workItemId: work.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/** A row's session_state, or null when it isn't a usable cursor. Pure. */
export function parseSkillRunSessionState(raw: unknown): SkillRunSessionState | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  // A continuation token predates eve 0.31: never resumable (conversation-session.ts).
  if (typeof s.continuationToken === 'string' && s.continuationToken) return null
  if (typeof s.sessionId !== 'string' || !s.sessionId) return null
  if (typeof s.streamIndex !== 'number' || !Number.isInteger(s.streamIndex) || s.streamIndex < 0) return null
  const settle =
    typeof s.settleStreamIndex === 'number' && Number.isInteger(s.settleStreamIndex) ? s.settleStreamIndex : s.streamIndex
  const previous = parsePreviousSessions(s.previous)
  return {
    sessionId: s.sessionId,
    streamIndex: s.streamIndex,
    settleStreamIndex: Math.min(settle, s.streamIndex),
    ...(previous.length > 0 ? { previous } : {}),
  }
}

/** A row's run_facts, or null when any routing fact is missing. Pure. */
export function parseSkillRunFacts(raw: unknown): SkillRunFacts | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Record<string, unknown>
  if (typeof f.skillId !== 'string' || !f.skillId) return null
  if (f.mode !== 'report' && f.mode !== 'act') return null
  if (f.outputContract !== 'verdict' && f.outputContract !== 'prose') return null
  if (typeof f.model !== 'string' || !f.model) return null
  if (typeof f.runAsUserId !== 'string' || !f.runAsUserId) return null
  return {
    skillId: f.skillId,
    mode: f.mode,
    hasCapture: f.hasCapture === true,
    outputContract: f.outputContract,
    model: f.model,
    runAsUserId: f.runAsUserId,
  }
}

/**
 * The parked session of ledger row `workItemId` in `workspaceId`, on a SERVICE
 * client (the table has no RLS policy). Null when there is none or it can't be
 * used. Throws on a read error, so a caller can tell "no chat" from "couldn't look".
 */
export async function readSkillRunSession(
  supabase: SupabaseClient,
  workItemId: string,
  workspaceId: string,
): Promise<SkillRunSessionRecord | null> {
  const { data, error } = await supabase
    .from(SKILL_RUN_SESSION_TABLE)
    .select('tracked_job_id, workspace_id, session_state, run_facts')
    .eq('tracked_job_id', workItemId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const row = data as { session_state: unknown; run_facts: unknown }
  const state = parseSkillRunSessionState(row.session_state)
  const facts = parseSkillRunFacts(row.run_facts)
  if (!state || !facts) return null
  return { workItemId, workspaceId, state, facts }
}

/**
 * After a follow-up turn drains, move the read cursor past it (keeping the
 * frozen settle boundary and the earlier sessions), so the next turn streams
 * only itself. Only while the row still names this session: a cursor never
 * lands on a newer run's handle, or on the session a reopened chat moved to.
 * A no-op when the cursor didn't move. Never throws: a lost advance replays
 * one turn.
 */
export async function advanceSkillRunCursor(
  supabase: SupabaseClient,
  record: Pick<SkillRunSessionRecord, 'workItemId' | 'workspaceId' | 'state'>,
  nextStreamIndex: number | null | undefined,
): Promise<void> {
  if (typeof nextStreamIndex !== 'number' || nextStreamIndex <= record.state.streamIndex) return
  try {
    const next: SkillRunSessionState = { ...record.state, streamIndex: nextStreamIndex }
    await supabase
      .from(SKILL_RUN_SESSION_TABLE)
      .update({ session_state: next, updated_at: new Date().toISOString() })
      .eq('tracked_job_id', record.workItemId)
      .eq('workspace_id', record.workspaceId)
      .eq('session_state->>sessionId', record.state.sessionId)
  } catch {
    /* best-effort */
  }
}

/**
 * Point ledger row `workItemId`'s chat at a different session, only while the
 * row still names session `from`: a loop run's chat that reopened after its
 * session expired registers its new session this way, and puts the gone one
 * back when the new one never took its first turn (loop-run-chat-reopen.ts).
 * Two sends racing on an expired chat open one session: the loser's swap
 * finds the row moved on. `fromStreamIndex` also requires the row's cursor to
 * still be there: a put-back never undoes a turn another send already took in
 * the new session. Resolves whether it swapped; throws on a write error, so a
 * caller can tell "lost the race" from "couldn't write".
 */
export async function swapSkillRunSession(
  supabase: SupabaseClient,
  ref: Pick<SkillRunSessionRecord, 'workItemId' | 'workspaceId'>,
  swap: { from: string; fromStreamIndex?: number; to: SkillRunSessionState },
): Promise<boolean> {
  let update = supabase
    .from(SKILL_RUN_SESSION_TABLE)
    .update({ session_state: swap.to, updated_at: new Date().toISOString() })
    .eq('tracked_job_id', ref.workItemId)
    .eq('workspace_id', ref.workspaceId)
    .eq('session_state->>sessionId', swap.from)
  // `->>` reads jsonb as text: the cursor compares as its decimal string.
  if (swap.fromStreamIndex !== undefined) update = update.eq('session_state->>streamIndex', String(swap.fromStreamIndex))
  const { data, error } = await update.select('tracked_job_id')
  if (error) throw new Error(error.message)
  return Array.isArray(data) && data.length > 0
}
