/**
 * The local agent's work-ledger mirror: ONE `tracked_job` ROW PER TURN
 * (contract B, decided after the x2 explorer's §1).
 *
 * Why per turn: the recorder's CAS fences let needs_review never go back to
 * running, and a report is written once per (item, status), so a session that
 * finishes a turn (needs_review, reported) and then takes a new message
 * cannot reuse its row. Each turn is its own row, keyed
 * `local_agent:<sessionId>:<turn>` (idempotent under the unique
 * (kind, run_key)); the session keeps `current_turn` and
 * `current_tracked_job_id`.
 *
 * The moves follow the Mac:
 *   starting / running        → step (the latest tool activity) / beat;
 *                               a settled row stays settled (turns open only
 *                               from messages: store.ts addMessage)
 *   ask                       → needInput(question); the answer → resume()
 *   turn end, no open ask     → an edit turn that committed: finish({ review })
 *                               → needs_review; otherwise finish({ reportDone })
 *                               → done, still reported in the chat
 *   cancelled / failed        → cancel / fail (only an OPEN row: a turn
 *                               already settled for review keeps its result)
 *   expired                   → fail("your Mac didn't connect within 6 hours")
 *   interrupted               → needInput("your Mac app closed …")
 *
 * Every function here never throws: a ledger gap is a UI gap, never a failed
 * job (the recorder's own rule).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { attachWork, startWork, type WorkHandle } from '@/lib/work/recorder'
import { resolveMemberId } from '@/lib/work/agent-run-mirror'
import { systemTeammateId } from '@/lib/work/system-teammates'
import type { WorkItem, WorkStatus } from '@/lib/work/types'
import { LOCAL_AGENT_INTERRUPTED_NEEDS_ID, LOCAL_AGENT_TEAMMATE_NEEDS_ID } from '@/lib/chat/teammate-report'
import { MAC_TEAMMATE_TOOL_NAMES, macTeammateName } from './teammate'

export const LOCAL_AGENT_WORK_KIND = 'local_agent'

/** The ledger row title's prefix before the teammate plan (old rows keep it); teammate-report.ts reads both. */
export const LOCAL_AGENT_TITLE_PREFIX = 'Your Mac · '

export const INTERRUPTED_QUESTION = 'your Mac app closed while it was working. Message it to resume.'
/** The needs id of an interruption (teammate-report.ts words it as one, not as a question). */
export const INTERRUPTED_NEEDS_ID = LOCAL_AGENT_INTERRUPTED_NEEDS_ID
export const EXPIRED_REASON = "your Mac didn't connect within 6 hours"
/**
 * The needs id of a question the Mac body asked its teammate in the cloud
 * (message_teammate, teammate plan C4). The turn parks on it as it asks, so
 * its later tool activity doesn't resume it; the answer does (store.ts
 * addMessage).
 */
export const TEAMMATE_NEEDS_ID = LOCAL_AGENT_TEAMMATE_NEEDS_ID
/**
 * The Mac body's teammate tools: the server records what they do (the
 * thread, the question), so their tool calls never make a step line.
 */
export const LEDGER_SILENT_TOOLS: ReadonlySet<string> = new Set(MAC_TEAMMATE_TOOL_NAMES)

/** The request (or the turn's message) in a row title. */
const TITLE_TEXT_MAX = 60
/** What the report carries of a finish summary or last message. */
export const REPORT_TEXT_MAX = 2000
/** A step line. */
const STEP_MAX = 60

/** What the ledger needs to know about a session. */
export interface LedgerSession {
  id: string
  userId: string
  workspaceId: string
  conversationId: string | null
  folderLabel: string
  deviceName: string
  request: string
  currentTurn: number
  currentTrackedJobId: string | null
  trackedJobId: string | null
  /** Migration 658: the coding agent it runs on (null or absent: Native Intelligence's own agent). */
  worker?: string | null
  /** The action an action's Start made it for (its key), or null. */
  actionId?: string | null
}

export type LedgerMove =
  /** The Mac is working: the latest tool activity, or a bare status. */
  | { type: 'step'; text: string }
  | { type: 'beat' }
  /** `from: 'teammate'`: the Mac body's message_teammate, recorded as it asks (TEAMMATE_NEEDS_ID). */
  | { type: 'ask'; question: string; from?: 'teammate' }
  /**
   * The turn ended with no open question. `review`: an edit turn that
   * committed its branch → needs_review (For you holds delivered artifacts
   * only); otherwise → done, still reported in the chat (reportDone).
   */
  | { type: 'turn_end'; summary: string; review?: boolean }
  /** A message the Mac could not take: a live turn waiting on it parks on "send it again". */
  | { type: 'undelivered'; reason: string }
  | { type: 'fail'; message: string }
  | { type: 'cancel' }
  | { type: 'interrupted' }
  /** A message answered the open question. */
  | { type: 'resume' }

const OPEN: ReadonlySet<WorkStatus> = new Set(['queued', 'running', 'needs_input', 'waiting_on_child'])
const LIVE: ReadonlySet<WorkStatus> = new Set(['queued', 'running'])

/** The row is parked on the Mac body's question to its teammate. */
export function isTeammateQuestion(row: Pick<WorkItem, 'status' | 'needs'> | null | undefined): boolean {
  if (!row || row.status !== 'needs_input' || row.needs?.kind !== 'input') return false
  return row.needs.questions.some((q) => !!q && typeof q === 'object' && (q as { id?: unknown }).id === TEAMMATE_NEEDS_ID)
}

function oneLine(text: string | null | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

export function turnRunKey(sessionId: string, turn: number): string {
  return `local_agent:${sessionId}:${turn}`
}

/** "Native Intelligence on Liam's MacBook Pro · web: Take a look at this repository" (the teammate, C4) */
export function turnTitle(deviceName: string, folderLabel: string, text: string): string {
  const prefix = `${macTeammateName(oneLine(deviceName, 80))} · `
  const label = oneLine(folderLabel, 80) || 'a folder'
  const what = oneLine(text, TITLE_TEXT_MAX)
  return what ? `${prefix}${label}: ${what}` : `${prefix}${label}`
}

/** A step line from a tool call: "Reading src/app/page.tsx", ≤60 chars. */
export function stepFromTool(name: string, input: string): string {
  let arg = ''
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>
    for (const key of ['path', 'file', 'command', 'pattern', 'query']) {
      const v = parsed?.[key]
      if (typeof v === 'string' && v.trim()) {
        arg = v.trim()
        break
      }
    }
  } catch {
    /* input is truncated JSON text: name only */
  }
  const verb = (() => {
    const n = name.toLowerCase()
    if (/read|cat|view|open/.test(n)) return 'Reading'
    if (/write|edit|patch|apply/.test(n)) return 'Editing'
    if (/grep|search|find|glob|list|ls/.test(n)) return 'Searching'
    if (/bash|shell|exec|run|command/.test(n)) return 'Running'
    if (/report/.test(n)) return 'Reporting'
    return `Using ${name}`
  })()
  return oneLine(arg ? `${verb} ${arg}` : verb, STEP_MAX)
}

/** The summary the Native Intelligence agent gets, capped. */
export function reportText(text: string | null | undefined): string {
  const t = (text ?? '').trim()
  return t.length > REPORT_TEXT_MAX ? `${t.slice(0, REPORT_TEXT_MAX - 1).trimEnd()}…` : t
}

/** Start turn `turn`'s row. The row id, or null when nothing could be recorded. */
export async function startTurnRow(
  svc: SupabaseClient,
  s: LedgerSession,
  opts: { turn: number; text: string; status: 'queued' | 'running' },
): Promise<string | null> {
  try {
    const memberId = await resolveMemberId(svc, s.workspaceId, s.userId)
    if (!memberId) return null
    const teammateId = await systemTeammateId(svc, s.workspaceId, 'assistant')
    const handle = await startWork(svc, {
      workspaceId: s.workspaceId,
      memberId,
      kind: LOCAL_AGENT_WORK_KIND,
      title: turnTitle(s.deviceName, s.folderLabel, opts.text),
      actor: 'agent',
      status: opts.status,
      runKey: turnRunKey(s.id, opts.turn),
      ...(s.conversationId ? { origin: 'chat' as const } : {}),
      source: {
        ...(s.conversationId ? { chat_conversation_id: s.conversationId } : {}),
        local_agent_session_id: s.id,
        folder_label: s.folderLabel,
        device_name: s.deviceName,
        turn: opts.turn,
        // Who does the work, and the action a Start made it for: a board card names the agent working it.
        ...(s.worker ? { worker: s.worker } : {}),
        ...(s.actionId ? { local_agent_action_id: s.actionId } : {}),
      },
      ...(teammateId ? { aiTeamMemberId: teammateId } : {}),
    })
    return handle.id
  } catch (err) {
    console.error('[local-agent] ledger start failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Open the next turn's row and point the session at it (CAS on current_turn:
 * a concurrent caller converges on the same turn, and the run key makes its
 * startWork return the same row).
 */
export async function nextTurn(
  svc: SupabaseClient,
  s: LedgerSession,
  opts: { text: string; status: 'queued' | 'running' },
): Promise<LedgerSession> {
  const turn = s.currentTurn + 1
  const rowId = await startTurnRow(svc, s, { turn, text: opts.text, status: opts.status })
  try {
    const { data } = await svc
      .from('local_agent_session')
      .update({ current_turn: turn, current_tracked_job_id: rowId })
      .eq('id', s.id)
      .eq('user_id', s.userId)
      .eq('current_turn', s.currentTurn)
      .select('current_turn, current_tracked_job_id')
      .maybeSingle()
    if (data) return { ...s, currentTurn: turn, currentTrackedJobId: rowId }
    // Lost the race: whoever won pointed the session at the same turn.
    const { data: now } = await svc
      .from('local_agent_session')
      .select('current_turn, current_tracked_job_id')
      .eq('id', s.id)
      .eq('user_id', s.userId)
      .maybeSingle()
    const row = now as { current_turn?: number; current_tracked_job_id?: string | null } | null
    if (row?.current_turn) {
      return { ...s, currentTurn: row.current_turn, currentTrackedJobId: row.current_tracked_job_id ?? null }
    }
  } catch (err) {
    console.error('[local-agent] ledger next turn failed:', err instanceof Error ? err.message : err)
  }
  return { ...s, currentTurn: turn, currentTrackedJobId: rowId }
}

async function loadTurnRow(svc: SupabaseClient, s: LedgerSession): Promise<WorkItem | null> {
  if (!s.currentTrackedJobId) return null
  try {
    const { data } = await svc
      .from('tracked_job')
      .select('*')
      .eq('id', s.currentTrackedJobId)
      .maybeSingle()
    return (data as WorkItem | null) ?? null
  } catch {
    return null
  }
}

/**
 * The current turn's handle when it is still open. A settled turn stays
 * settled: a new turn opens only from a message (store.ts addMessage, or the
 * turn end of a queued one), never from a device event, so a Mac cannot mint
 * turns (and reports) by replaying statuses. A session whose turn 1 was never
 * recorded (no member then) records it now: the same turn, not a new one.
 */
async function liveTurn(
  svc: SupabaseClient,
  s: LedgerSession,
): Promise<{ s: LedgerSession; row: WorkItem | null; handle: WorkHandle | null }> {
  const row = await loadTurnRow(svc, s)
  if (row) return OPEN.has(row.status) ? { s, row, handle: attachWork(svc, row) } : { s, row, handle: null }
  if (s.currentTrackedJobId) return { s, row: null, handle: null }
  const first = await recordFirstTurn(svc, s)
  const firstRow = await loadTurnRow(svc, first)
  return { s: first, row: firstRow, handle: firstRow && OPEN.has(firstRow.status) ? attachWork(svc, firstRow) : null }
}

/** A session with no ledger row yet: record turn `currentTurn` now (running). */
async function recordFirstTurn(svc: SupabaseClient, s: LedgerSession): Promise<LedgerSession> {
  const rowId = await startTurnRow(svc, s, { turn: s.currentTurn, text: s.request, status: 'running' })
  if (!rowId) return s
  try {
    await svc
      .from('local_agent_session')
      .update({ current_tracked_job_id: rowId, ...(s.trackedJobId ? {} : { tracked_job_id: rowId }) })
      .eq('id', s.id)
      .eq('user_id', s.userId)
  } catch {
    /* the next move re-finds it by run key */
  }
  return { ...s, currentTrackedJobId: rowId, trackedJobId: s.trackedJobId ?? rowId }
}

/**
 * Apply one move to the session's current turn row. Returns the session as the
 * ledger left it (a step on a settled turn opens the next one).
 */
export async function moveTurn(svc: SupabaseClient, s: LedgerSession, move: LedgerMove): Promise<LedgerSession> {
  try {
    switch (move.type) {
      case 'step': {
        const live = await liveTurn(svc, s)
        if (!live.handle || !live.row) return live.s
        // The question to its teammate stands until it's answered.
        if (isTeammateQuestion(live.row)) return live.s
        if (live.row.status === 'needs_input' || live.row.status === 'waiting_on_child') await live.handle.resume()
        await live.handle.step(oneLine(move.text, STEP_MAX) || 'Working on your Mac')
        await live.handle.flush()
        return live.s
      }
      case 'beat': {
        const row = await loadTurnRow(svc, s)
        if (row && LIVE.has(row.status)) await attachWork(svc, row).beat()
        return s
      }
      case 'ask': {
        const live = await liveTurn(svc, s)
        if (!live.handle || !live.row) return live.s
        const question = { id: move.from === 'teammate' ? TEAMMATE_NEEDS_ID : 'local-agent-ask', question: oneLine(move.question, 1000) }
        if (LIVE.has(live.row.status)) {
          await live.handle.needInput([question])
        } else if (move.from === 'teammate' && (live.row.status === 'needs_input' || live.row.status === 'waiting_on_child')) {
          // Parked on something else (the Mac app closed, an undelivered
          // message): the Mac body is plainly back, and asks this now.
          await live.handle.resume()
          await live.handle.needInput([question])
        }
        return live.s
      }
      case 'turn_end': {
        const row = await loadTurnRow(svc, s)
        // The question to its teammate stands until it's answered (store.ts addMessage resumes it).
        if (row && OPEN.has(row.status) && !isTeammateQuestion(row)) {
          await attachWork(svc, row).finish(
            move.review
              ? { summary: reportText(move.summary) || null, review: { kind: 'review', verb: 'review' } }
              : { summary: reportText(move.summary) || null, reportDone: true },
          )
        }
        return s
      }
      case 'undelivered': {
        const row = await loadTurnRow(svc, s)
        if (row && LIVE.has(row.status)) {
          await attachWork(svc, row).needInput([
            { id: 'local-agent-undelivered', question: oneLine(`Your Mac couldn't take a message (${move.reason}). Send it again.`, 500) },
          ])
        }
        return s
      }
      case 'fail': {
        const row = await loadTurnRow(svc, s)
        if (row && OPEN.has(row.status)) await attachWork(svc, row).fail(oneLine(move.message, 500) || 'failed')
        return s
      }
      case 'cancel': {
        const row = await loadTurnRow(svc, s)
        if (row && OPEN.has(row.status)) await attachWork(svc, row).cancel()
        return s
      }
      case 'interrupted': {
        const row = await loadTurnRow(svc, s)
        if (row && LIVE.has(row.status)) {
          await attachWork(svc, row).needInput([{ id: INTERRUPTED_NEEDS_ID, question: INTERRUPTED_QUESTION }])
        }
        return s
      }
      case 'resume': {
        const row = await loadTurnRow(svc, s)
        if (row && row.status === 'needs_input') await attachWork(svc, row).resume()
        return s
      }
    }
  } catch (err) {
    console.error(`[local-agent] ledger ${move.type} failed:`, err instanceof Error ? err.message : err)
  }
  return s
}

/** The current turn row's status, or null. */
export async function turnStatus(svc: SupabaseClient, s: LedgerSession): Promise<WorkStatus | null> {
  return (await loadTurnRow(svc, s))?.status ?? null
}

/**
 * The current turn as far as idleness goes: its status, 'none' when there is
 * no row (never recorded, or pruned: the session doesn't depend on it), or
 * 'unknown' when it couldn't be read.
 */
export async function turnState(svc: SupabaseClient, s: LedgerSession): Promise<WorkStatus | 'none' | 'unknown'> {
  if (!s.currentTrackedJobId) return 'none'
  try {
    const { data, error } = await svc.from('tracked_job').select('status').eq('id', s.currentTrackedJobId).maybeSingle()
    if (error) return 'unknown'
    return (data as { status?: WorkStatus } | null)?.status ?? 'none'
  } catch {
    return 'unknown'
  }
}

/** The current turn is parked on this question to the teammate already (as the `ask` move words it). */
export async function parkedOnTeammate(svc: SupabaseClient, s: LedgerSession, question: string): Promise<boolean> {
  const row = await loadTurnRow(svc, s)
  if (!isTeammateQuestion(row) || row?.needs?.kind !== 'input') return false
  const words = oneLine(question, 1000)
  return row.needs.questions.some((q) => !!q && typeof q === 'object' && (q as { id?: unknown }).id === TEAMMATE_NEEDS_ID && (q as { question?: unknown }).question === words)
}
