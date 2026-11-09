/**
 * The main agent's check-in (docs/plans/now-file.md "Following up (Slice 2)"
 * → "The check-in"): a few times a working day, code checks whether anything
 * the person's Now file tracks is due, and only then does the main agent
 * wake, in a fresh session of its own, to bring its note up to date.
 *
 * THE CRON (src/lib/inngest/agent-events.ts agentEventDigest, hourly; the
 * digest's own member scan, at the slot hours CHECK_IN_SLOTS): per candidate
 * (planCheckInFor), all in code and with no model call, cheapest first:
 *   • a note with lines but none tracked → skip (one indexed read);
 *   • no Now file, or one with nothing in it → the START (below) instead of
 *     the due lines, under the same gates (its one round of reads runs
 *     before the switch and activity checks: most such people stop there);
 *   • no home thread → skip (its reply has nowhere to land);
 *   • this slot's turn (`check_in:<local date>:<hour>`) already exists → skip;
 *   • autonomy off (FAILS CLOSED: a switch that can't be read is off) or a
 *     dormant workspace → skip;
 *   • the person wrote in one of their chats in the last 30 minutes → skip
 *     (their own turn keeps the note; server rows bump
 *     chat_conversations.updated_at, so it reads the newest user message in
 *     their most recent chats, never that column alone);
 *   • nothing due → skip;
 *   • else one `home/turn.requested` (reason 'check_in', the slot).
 *
 * DUE (checkInDue), for tracked lines only:
 *   • new: an agent event for its item (by occurs_at, never before the line
 *     was tracked): work.done, work.failed, work.needs_input,
 *     work.needs_review or pr.changed; for a tracked ask, an answer from the
 *     other agent since the last check-in that ran to the end. An event an
 *     ACTING turn already carried (its home_turn_id set by an event or helper
 *     report turn, or by a check-in that wrote its reply; the digest, which
 *     only reports, doesn't count) is left out, and so is an event from
 *     before the last check-in that ran to the end and chose to say nothing
 *     (it saw them; a minute's margin covers its gather). So what a check-in
 *     left out (past the 12 lines, or after its gather) or never finished
 *     (failed, cut off: its row's error is set) is due at the next one. An
 *     item a check-in's helper is still working on is left out;
 *   • stale: a line under In flight or Waiting on others dated before today
 *     whose item isn't done, at most once a day (only until the day's first
 *     check-in ran).
 *
 * THE START (10-27: no Now file had been written on PROD a day after launch,
 * because nothing but the person's own turn ever began one): an empty note,
 * once a day (no check-in ran to the end today), at the first slot where
 * Native Intelligence's own records show something in motion for the person
 * (readStartItems: their open work items and the confirmed actions assigned
 * to them in a started state, from the last two weeks, and their pull
 * requests left open by their newest change). A start that wrote nothing
 * goes again only once one of them moved since. The body lists each with its
 * item key, and the agent starts the note from them, every line tracked
 * (update_now refuses an untracked add from a check-in on an empty note), so
 * the due lines above can follow it.
 *
 * FINISHED: a tracked line under In flight, Waiting on you or Waiting on
 * others whose item is done is due (once a day) so it comes off: nothing
 * reports an action finishing, and an acting turn may have carried a run's.
 * An action line is never stale: it is the person's own work.
 *
 * THE TURN (src/lib/chat/home-turn-server.ts planHomeTurn 'check_in'): the
 * plan re-gathers all of this (never trusting the payload) and the body is
 * Native Intelligence's templates only (checkInBody): each due line with its number, its
 * item's status, title and times (never tracked_job.result_summary or its
 * question), and the new events as log lines. A reply sends one
 * `agent_check_in` notice (sendCheckInNotice) and marks the events it carried
 * delivered; a no_reply marks nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createNotification } from '@/lib/notifications'
import { botNoticeCopy, botNoticeMetadata, noticeTeammateName } from '@/lib/bots/bot-notice'
import { systemTeammateId } from '@/lib/work/system-teammates'
import { CHECK_IN_SLOTS, HOME_TURN_REQUESTED_EVENT, checkInTurnKey, type HomeTurnCheckIn, type HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { awayLineFor } from '@/lib/agent-events/away-section'
import { localDateOf } from '@/lib/agent-events/work'
import type { AgentEventFacts, AgentEventKind } from '@/lib/agent-events/types'
import type { DigestCandidate } from '@/lib/agent-events/digest'
import { clipLogText } from '@/lib/log/agent-log'
import { formatLogTime } from '@/lib/log/log-section'
import type { AgentPausedState } from '@/lib/work/agent-paused'
import { loadNowNote, nowContentEmpty, nowLineHash, nowLines, type NowNote, type NowTrack } from './now-file'

export { CHECK_IN_SLOTS }

/** How recently the person wrote for a check-in to stay out of their way. */
export const CHECK_IN_ACTIVE_MS = 30 * 60_000
/** The most due lines one check-in carries (the rest wait for the next). */
export const CHECK_IN_MAX_LINES = 12
/** The most new events one due line lists. */
const CHECK_IN_MAX_EVENTS_PER_LINE = 3
/** How far back a check-in looks for events when it has never run. */
const CHECK_IN_LOOKBACK_MS = 7 * 24 * 60 * 60_000
/** The most event rows one gather reads. */
const CHECK_IN_EVENT_ROWS = 100
/** The most recent chats the "active" check reads. */
const ACTIVE_CHATS = 5

/** The events a check-in follows (the plan's list). */
export const CHECK_IN_EVENT_KINDS: readonly AgentEventKind[] = ['work.done', 'work.failed', 'work.needs_input', 'work.needs_review', 'pr.changed']
const FOLLOWED_KINDS: ReadonlySet<string> = new Set(CHECK_IN_EVENT_KINDS)

/** The sections whose old lines go stale: what is in motion. */
const STALE_SECTIONS: ReadonlySet<string> = new Set(['in flight', 'waiting on others'])
/** The sections a finished item's line comes off: what is in motion or waits on someone. */
const FINISHED_SECTIONS: ReadonlySet<string> = new Set(['in flight', 'waiting on you', 'waiting on others'])

/** A tracked item's key, `<kind>:<id>`: the start_helper `item` and agent_run.server_helper_item (migration 443). */
export function checkInItemKey(track: Pick<NowTrack, 'kind' | 'id'>): string {
  return `${track.kind}:${track.id}`
}

// ── Pure: the note's tracked lines ───────────────────────────────────────────

/** One line the note tracks, as the now section numbers it. */
export interface TrackedLine {
  /** 1-based, as the now section and update_now number it. */
  line: number
  /** The heading above it, as written (null before the first). */
  section: string | null
  /** The line as the note has it. */
  text: string
  track: NowTrack
}

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/

/**
 * The note's lines that a live track names (its hash is a line still in the
 * note: a person's edit that changed the line orphans the track, and it is
 * dropped here). Pure.
 */
export function trackedLines(note: Pick<NowNote, 'content' | 'tracks'>): TrackedLine[] {
  const byHash = new Map<string, NowTrack[]>()
  for (const t of note.tracks) byHash.set(t.hash, [...(byHash.get(t.hash) ?? []), t])
  const out: TrackedLine[] = []
  let section: string | null = null
  nowLines(note.content).forEach((raw, i) => {
    const heading = HEADING_RE.exec(raw)
    if (heading) {
      section = heading[1].replace(/[:\s]+$/, '').trim() || null
      return
    }
    if (!raw.trim()) return
    for (const track of byHash.get(nowLineHash(raw)) ?? []) out.push({ line: i + 1, section, text: raw.trim(), track })
  })
  return out
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const LINE_DATE_RE = /\((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.? (\d{1,2})\)\s*$/i

/**
 * The local date (YYYY-MM-DD) a line was written: its closing "(Oct 26)" in
 * the year that puts it on or before `today` (a December line read in
 * January is last year's), else the track's `added_at` in `timeZone`, else
 * null. Pure.
 */
export function lineDate(text: string, addedAt: string, today: string, timeZone: string): string | null {
  const m = LINE_DATE_RE.exec(text)
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1
    const day = Number(m[2])
    const [y, tm, td] = today.split('-').map(Number)
    if (month >= 1 && day >= 1 && day <= 31 && Number.isInteger(y)) {
      const year = month > tm || (month === tm && day > td) ? y - 1 : y
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  return Number.isFinite(Date.parse(addedAt)) ? localDateOf(addedAt, timeZone) : null
}

// ── Pure: what is due ────────────────────────────────────────────────────────

/** What Native Intelligence knows of a tracked item, templated (status, title, times; never a summary or a question). */
export interface CheckInItemState {
  /** The item is finished: a stale line about it has nothing left to follow. */
  done: boolean
  /** One line for the body. */
  line: string
  /** What matches its events: a work item's tracked_job id, an action's id and identifier, a PR's ref id, an ask's exchange id. */
  workItemId?: string
  actionKeys?: string[]
  prRef?: string
  exchangeId?: string
  /** A check-in already retried it (agent_run.server_helper_item): its helper's status. */
  retried?: string
}

/** An agent_event row as the check-in reads it. */
export interface CheckInEvent {
  id: string
  kind: AgentEventKind
  facts: AgentEventFacts
  occurs_at: string
  ref_type: string | null
  ref_id: string | null
  home_turn_id: string | null
  delivered_key: string | null
}

/** The other agent's reply on a tracked ask (agent_link_message). */
export interface CheckInAnswer {
  id: string
  exchange_id: string
  kind: 'answer' | 'decline' | 'note'
  created_at: string
  home_turn_id: string | null
}

/** One due line: what changed for its item, or that it went stale. */
export interface DueLine {
  line: TrackedLine
  state: CheckInItemState | null
  events: CheckInEvent[]
  answers: CheckInAnswer[]
  stale: boolean
  /** Its item is finished and the line still stands where things in motion go: it comes off. */
  finished?: boolean
}

export interface CheckInDueInput {
  lines: readonly TrackedLine[]
  /** By item key (checkInItemKey). */
  states: ReadonlyMap<string, CheckInItemState>
  events: readonly CheckInEvent[]
  answers: readonly CheckInAnswer[]
  /** Item keys a check-in's helper is still working on. */
  running: ReadonlySet<string>
  /** When the last check-in that ran to the end started (done, no error), or null: answers count from it. */
  lastCheckInAt: string | null
  /**
   * When the last check-in that ran to the end and wrote nothing started, or
   * null: events count from a minute before it (it saw them and marked
   * none). A written one marked what it carried (carriedByActingTurn).
   */
  lastQuietCheckInAt?: string | null
  /** A check-in already ran to the end today: stale lines wait for tomorrow. */
  ranToday: boolean
  /** The person's local date (YYYY-MM-DD). */
  today: string
  timeZone: string
}

/** True when an event was carried by a turn that acts (an event or a helper's report): the digest only reports. Pure. */
export function carriedByActingTurn(e: Pick<CheckInEvent, 'home_turn_id' | 'delivered_key'>): boolean {
  return !!e.home_turn_id && !(e.delivered_key ?? '').startsWith('digest:')
}

/** Whether an event is about this item. Pure. */
function eventIsFor(e: CheckInEvent, track: NowTrack, state: CheckInItemState | null): boolean {
  switch (track.kind) {
    case 'work':
      return e.ref_type === 'work_item' && !!e.ref_id && e.ref_id === (state?.workItemId ?? track.id)
    case 'pr':
      return e.ref_type === 'github_pr' && !!e.ref_id && e.ref_id.toLowerCase() === (state?.prRef ?? track.id).toLowerCase()
    case 'action': {
      // A linked pull request's change names the action (pr.changed facts.action: its identifier, else its id).
      const keys = new Set((state?.actionKeys ?? [track.id]).map((k) => k.toLowerCase()))
      return e.kind === 'pr.changed' && typeof e.facts?.action === 'string' && keys.has(e.facts.action.toLowerCase())
    }
    default:
      return false
  }
}

const ms = (iso: string | null | undefined) => (typeof iso === 'string' && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : 0)

/** How far before a quiet check-in's row its gather may have read (checkInDue). */
const CHECK_IN_GATHER_MARGIN_MS = 60_000

/** The instant a quiet check-in's events count from, or 0 with none. */
const quietSince = (iso: string | null | undefined) => (ms(iso) > 0 ? ms(iso) - CHECK_IN_GATHER_MARGIN_MS : 0)

/**
 * The tracked lines due now (see the header), in note order, at most
 * CHECK_IN_MAX_LINES. Pure.
 */
export function checkInDue(input: CheckInDueInput): DueLine[] {
  const out: DueLine[] = []
  const last = ms(input.lastCheckInAt)
  const quiet = quietSince(input.lastQuietCheckInAt)
  for (const line of input.lines) {
    const key = checkInItemKey(line.track)
    // A check-in's helper is on it: its report comes back first.
    if (input.running.has(key)) continue
    const state = input.states.get(key) ?? null
    const tracked = ms(line.track.added_at)
    const since = Math.max(last, tracked)
    const eventsSince = Math.max(quiet, tracked)
    const events = input.events
      .filter((e) => FOLLOWED_KINDS.has(e.kind) && ms(e.occurs_at) > eventsSince && !carriedByActingTurn(e) && eventIsFor(e, line.track, state))
      .sort((a, b) => ms(a.occurs_at) - ms(b.occurs_at))
    const answers =
      line.track.kind === 'ask'
        ? input.answers.filter((a) => a.exchange_id === (state?.exchangeId ?? line.track.id) && ms(a.created_at) > since && !a.home_turn_id)
        : []
    const written = lineDate(line.text, line.track.added_at, input.today, input.timeZone)
    const section = line.section?.toLowerCase() ?? null
    // An action is the person's own work: days in progress isn't stale (no
    // daily nudge, no helper on it). Its line moves on its PR's changes and
    // comes off once it's finished.
    const stale =
      !input.ranToday &&
      line.track.kind !== 'action' &&
      !!section &&
      STALE_SECTIONS.has(section) &&
      written !== null &&
      written < input.today &&
      !state?.done
    // A finished item's line that still stands (no event says so: an action's
    // change, or one an acting turn carried), at most once a day.
    const finished = !input.ranToday && !!section && FINISHED_SECTIONS.has(section) && state?.done === true
    if (events.length === 0 && answers.length === 0 && !stale && !finished) continue
    out.push({ line, state, events: events.slice(-CHECK_IN_MAX_EVENTS_PER_LINE), answers, stale, ...(finished ? { finished } : {}) })
    if (out.length >= CHECK_IN_MAX_LINES) break
  }
  return out
}

const ANSWER_PHRASE: Record<CheckInAnswer['kind'], string> = {
  answer: "The other person's agent answered",
  decline: "The other person's agent declined",
  note: "The other person's agent couldn't answer",
}

/**
 * The check-in's body input for these due lines, or null when none is due.
 * Every line is Native Intelligence's template around the note's own line, the item's
 * state line and the events' log lines (awayLineFor: a fixed phrase and a
 * clipped title). Pure.
 */
export function checkInBody(due: readonly DueLine[], args: { date: string; hour: number; timeZone: string; revision: number }): HomeTurnCheckIn | null {
  if (due.length === 0) return null
  const lines: string[] = []
  const eventIds: string[] = []
  for (const d of due) {
    const key = checkInItemKey(d.line.track)
    lines.push(`Line ${d.line.line}${d.line.section ? ` (${d.line.section})` : ''}, item ${key}: ${d.line.text}`)
    lines.push(`- Item: ${d.state?.line ?? "not found in Native Intelligence's records (gone, or not the person's)"}${d.state?.retried ? `; a check-in already retried it (that helper: ${d.state.retried})` : ''}`)
    for (const e of d.events) {
      lines.push(`- New: ${formatLogTime(e.occurs_at, args.timeZone)} ${awayLineFor(e, args.timeZone)}`)
      eventIds.push(e.id)
    }
    for (const a of d.answers) lines.push(`- New: ${formatLogTime(a.created_at, args.timeZone)} ${ANSWER_PHRASE[a.kind]}`)
    if (d.stale) lines.push("- Stale: dated before today, and its item isn't done")
    if (d.finished) lines.push('- Finished: its item is done, so the line comes off')
  }
  return { date: args.date, hour: args.hour, timeZone: args.timeZone, revision: args.revision, lines, eventIds: [...new Set(eventIds)] }
}

// ── Pure: the item states ───────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const WORK_STATUS_PHRASE: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  waiting_on_child: 'waiting on a sub-task',
  needs_input: 'waiting on the person (it has a question)',
  needs_review: 'ready for the person’s review',
  done: 'done',
  failed: 'failed',
  canceled: 'canceled',
  skipped: 'skipped',
}
const WORK_DONE: ReadonlySet<string> = new Set(['done', 'canceled', 'skipped'])

/** A work item's state line (tracked_job: status, title, times; never its result_summary or progress). Pure. */
export function workItemState(row: { id: string; title?: unknown; status?: unknown; created_at?: unknown; started_at?: unknown; finished_at?: unknown }, timeZone: string): CheckInItemState {
  const status = typeof row.status === 'string' ? row.status : 'unknown'
  const times = [
    typeof row.started_at === 'string' ? `started ${formatLogTime(row.started_at, timeZone)}` : typeof row.created_at === 'string' ? `created ${formatLogTime(row.created_at, timeZone)}` : null,
    typeof row.finished_at === 'string' ? `finished ${formatLogTime(row.finished_at, timeZone)}` : null,
  ].filter(Boolean)
  const title = clipLogText(typeof row.title === 'string' ? row.title : null, 80) ?? 'Untitled work'
  return {
    done: WORK_DONE.has(status),
    line: `work item "${title}", ${WORK_STATUS_PHRASE[status] ?? status}${times.length ? `; ${times.join(', ')}` : ''}`,
    workItemId: row.id,
  }
}

/** An action's state line (its identifier, title, workflow state and last change). Pure. */
export function actionState(
  row: { id: string; identifier?: unknown; title?: unknown; updated_at?: unknown; workflow_state?: unknown },
  timeZone: string,
): CheckInItemState {
  const ws = (Array.isArray(row.workflow_state) ? row.workflow_state[0] : row.workflow_state) as { name?: unknown; category?: unknown } | null | undefined
  const category = typeof ws?.category === 'string' ? ws.category : null
  const stateName = clipLogText(typeof ws?.name === 'string' ? ws.name : null, 40)
  const identifier = typeof row.identifier === 'string' && row.identifier ? row.identifier : null
  const title = clipLogText(typeof row.title === 'string' ? row.title : null, 80) ?? 'Untitled action'
  return {
    done: category === 'completed' || category === 'canceled',
    line: `action ${identifier ?? row.id} "${title}", ${stateName ?? 'no state'}${category ? ` (${category})` : ''}${typeof row.updated_at === 'string' ? `; last changed ${formatLogTime(row.updated_at, timeZone)}` : ''}`,
    actionKeys: [row.id, ...(identifier ? [identifier] : [])],
  }
}

const PR_STATE_PHRASE: Record<string, string> = { merged: 'merged', closed: 'closed without merging', reopened: 'reopened', ci_failed: 'checks failing' }

/** A pull request's state line, from its newest pr.changed event (Native Intelligence's own values: never its title). Pure. */
export function prState(ref: string, latest: { facts?: AgentEventFacts; occurs_at?: string } | null, timeZone: string): CheckInItemState {
  const state = typeof latest?.facts?.prState === 'string' ? latest.facts.prState : null
  return {
    done: state === 'merged' || state === 'closed',
    line: state
      ? `pull request ${ref}, ${PR_STATE_PHRASE[state] ?? state}${latest?.occurs_at ? ` (${formatLogTime(latest.occurs_at, timeZone)})` : ''}`
      : `pull request ${ref}, no change recorded since it was tracked`,
    prRef: ref,
  }
}

/** An ask's state line (agent links): answered or not, and when. Never its topic (another turn's words). Pure. */
export function askState(row: { id: string; state?: unknown; created_at?: unknown }, answers: readonly CheckInAnswer[], timeZone: string): CheckInItemState {
  const replies = answers.filter((a) => a.exchange_id === row.id).sort((a, b) => ms(a.created_at) - ms(b.created_at))
  const latest = replies.at(-1)
  const asked = typeof row.created_at === 'string' ? `asked ${formatLogTime(row.created_at, timeZone)}` : 'asked'
  const reply = latest ? `${latest.kind === 'answer' ? 'answered' : latest.kind === 'decline' ? 'declined' : 'no answer it could give'} ${formatLogTime(latest.created_at, timeZone)}` : 'no answer yet'
  return {
    done: !!latest || row.state === 'done',
    line: `ask to another person's agent, ${asked}, ${reply}${typeof row.state === 'string' ? ` (exchange ${row.state})` : ''}`,
    exchangeId: row.id,
  }
}

// ── The reads ────────────────────────────────────────────────────────────────

/** The check-in's history in this conversation: the last ones that ran to the end, and whether one did today. */
export interface CheckInHistory {
  lastCheckInAt: string | null
  lastQuietCheckInAt: string | null
  ranToday: boolean
  /** This slot's own row, when one exists (a failed one may go again). */
  slotStatus: string | null
}

/** Read this conversation's recent check-ins. Throws on a failed read. */
export async function readCheckInHistory(supabase: SupabaseClient, args: { conversationId: string; date: string; hour: number }): Promise<CheckInHistory> {
  const { data, error } = await supabase
    .from('home_turn')
    .select('created_at, dedupe_key, status, error, message_written')
    .eq('conversation_id', args.conversationId)
    .eq('reason', 'check_in')
    .order('created_at', { ascending: false })
    .limit(12)
  if (error) throw new Error(`home_turn read failed: ${error.message}`)
  const rows = ((data as Array<Record<string, unknown>> | null) ?? []).filter((r) => typeof r.dedupe_key === 'string')
  const slotKey = checkInTurnKey(args.date, args.hour)
  // Ran to the end: done with no error (finishHomeTurn sets one for a failed,
  // canceled or cut-off turn, whose events are due again).
  const ran = rows.filter(
    (r) => r.dedupe_key !== slotKey && r.status === 'done' && !r.error && typeof r.created_at === 'string' && Number.isFinite(Date.parse(r.created_at)),
  )
  const last = ran[0]
  const quiet = ran.find((r) => r.message_written !== true)
  return {
    lastCheckInAt: last ? (last.created_at as string) : null,
    lastQuietCheckInAt: quiet ? (quiet.created_at as string) : null,
    ranToday: ran.some((r) => String(r.dedupe_key).startsWith(`check_in:${args.date}:`)),
    slotStatus: (rows.find((r) => r.dedupe_key === slotKey)?.status as string | undefined) ?? null,
  }
}

/** Throws a read's error, else returns its rows. */
function rowsOf(result: { data: unknown; error: { message: string } | null }, what: string): Array<Record<string, unknown>> {
  if (result.error) throw new Error(`${what} read failed: ${result.error.message}`)
  return Array.isArray(result.data) ? (result.data as Array<Record<string, unknown>>) : []
}

/** The columns an action's state line reads (actionState). */
const ACTION_COLUMNS = 'id, identifier, title, updated_at, workflow_state:workflow_state!status_id(name, category)'
/** The columns a work item's state line reads (workItemState). */
const WORK_COLUMNS = 'id, agent_run_id, title, status, created_at, started_at, finished_at'

/**
 * Each tracked item's state, by key, read for this person only (a work item
 * of their member row, an action of the workspace, their own PR events, an
 * ask they started), plus the asks' answers and which items a check-in
 * already retried. Throws on a failed read.
 */
export async function readItemStates(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; memberId: string; tracks: readonly NowTrack[]; timeZone: string },
): Promise<{ states: Map<string, CheckInItemState>; answers: CheckInAnswer[]; running: Set<string> }> {
  const ids = (kind: NowTrack['kind'], uuidOnly = false) => [...new Set(args.tracks.filter((t) => t.kind === kind).map((t) => t.id))].filter((id) => !uuidOnly || UUID_RE.test(id))
  const work = ids('work', true)
  const actions = ids('action')
  const actionUuids = actions.filter((id) => UUID_RE.test(id))
  const actionIdentifiers = actions.filter((id) => !UUID_RE.test(id))
  const prs = ids('pr')
  const asks = ids('ask', true)
  const keys = [...new Set(args.tracks.map(checkInItemKey))]
  const none = Promise.resolve({ data: [], error: null })
  const [workById, workByRun, actionById, actionByIdentifier, prEvents, exchanges, answers, helpers] = await Promise.all([
    work.length ? supabase.from('tracked_job').select(WORK_COLUMNS).eq('workspace_id', args.workspaceId).eq('member_id', args.memberId).in('id', work) : none,
    work.length ? supabase.from('tracked_job').select(WORK_COLUMNS).eq('workspace_id', args.workspaceId).eq('member_id', args.memberId).in('agent_run_id', work) : none,
    actionUuids.length ? supabase.from('actions').select(ACTION_COLUMNS).eq('workspace_id', args.workspaceId).in('id', actionUuids) : none,
    actionIdentifiers.length ? supabase.from('actions').select(ACTION_COLUMNS).eq('workspace_id', args.workspaceId).in('identifier', actionIdentifiers) : none,
    prs.length
      ? supabase
          .from('agent_event')
          .select('ref_id, facts, occurs_at')
          .eq('workspace_id', args.workspaceId)
          .eq('user_id', args.userId)
          .eq('kind', 'pr.changed')
          .eq('ref_type', 'github_pr')
          .in('ref_id', prs)
          .order('occurs_at', { ascending: false })
          .limit(50)
      : none,
    asks.length ? supabase.from('agent_link_exchange').select('id, state, created_at').eq('started_by_user_id', args.userId).in('id', asks) : none,
    asks.length
      ? supabase
          .from('agent_link_message')
          .select('id, exchange_id, kind, created_at, home_turn_id')
          .in('exchange_id', asks)
          .neq('from_user_id', args.userId)
          .in('kind', ['answer', 'decline', 'note'])
          .order('created_at', { ascending: false })
          .limit(50)
      : none,
    keys.length
      ? supabase
          .from('agent_run')
          .select('server_helper_item, status')
          .eq('workspace_id', args.workspaceId)
          .eq('triggered_by', args.userId)
          .eq('server_helper', 'check_in')
          .in('server_helper_item', keys)
      : none,
  ])
  const states = new Map<string, CheckInItemState>()
  const z = args.timeZone
  // A work track names its tracked_job, or the run behind it (start_helper answers both).
  const workRows = [...rowsOf(workById, 'tracked_job'), ...rowsOf(workByRun, 'tracked_job')]
  for (const id of work) {
    const row = workRows.find((r) => r.id === id) ?? workRows.find((r) => r.agent_run_id === id)
    if (row && typeof row.id === 'string') states.set(`work:${id}`, workItemState(row as { id: string }, z))
  }
  const actionRows = [...rowsOf(actionById, 'actions'), ...rowsOf(actionByIdentifier, 'actions')]
  for (const id of actions) {
    const row = actionRows.find((r) => r.id === id || (typeof r.identifier === 'string' && r.identifier.toLowerCase() === id.toLowerCase()))
    if (row && typeof row.id === 'string') states.set(`action:${id}`, actionState(row as { id: string }, z))
  }
  const prRows = rowsOf(prEvents, 'agent_event')
  for (const ref of prs) {
    const latest = prRows.find((r) => typeof r.ref_id === 'string' && r.ref_id.toLowerCase() === ref.toLowerCase()) ?? null
    states.set(`pr:${ref}`, prState(ref, latest as { facts?: AgentEventFacts; occurs_at?: string } | null, z))
  }
  const answerRows: CheckInAnswer[] = rowsOf(answers, 'agent_link_message')
    .filter((r) => typeof r.id === 'string' && typeof r.exchange_id === 'string' && typeof r.created_at === 'string' && (r.kind === 'answer' || r.kind === 'decline' || r.kind === 'note'))
    .map((r) => ({ id: r.id as string, exchange_id: r.exchange_id as string, kind: r.kind as CheckInAnswer['kind'], created_at: r.created_at as string, home_turn_id: typeof r.home_turn_id === 'string' ? r.home_turn_id : null }))
  for (const row of rowsOf(exchanges, 'agent_link_exchange')) {
    if (typeof row.id === 'string') states.set(`ask:${row.id}`, askState(row as { id: string }, answerRows, z))
  }
  // What a check-in already started for an item: still working (not due), or done with (said in the body).
  const running = new Set<string>()
  for (const row of rowsOf(helpers, 'agent_run')) {
    const key = typeof row.server_helper_item === 'string' ? row.server_helper_item : null
    if (!key) continue
    if (row.status === 'queued' || row.status === 'running') running.add(key)
    const state = states.get(key)
    if (state && typeof row.status === 'string') states.set(key, { ...state, retried: row.status })
  }
  return { states, answers: answerRows, running }
}

/** The events of the followed kinds since `sinceIso`, for this person. Throws on a failed read. */
export async function readCheckInEvents(supabase: SupabaseClient, args: { workspaceId: string; userId: string; sinceIso: string }): Promise<CheckInEvent[]> {
  const result = await supabase
    .from('agent_event')
    .select('id, kind, facts, occurs_at, ref_type, ref_id, home_turn_id, delivered_key')
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .in('kind', [...CHECK_IN_EVENT_KINDS])
    .gt('occurs_at', args.sinceIso)
    .order('occurs_at', { ascending: false })
    .limit(CHECK_IN_EVENT_ROWS)
  return rowsOf(result, 'agent_event')
    .filter((r) => r.id != null && typeof r.kind === 'string' && typeof r.occurs_at === 'string')
    .map((r) => ({
      id: String(r.id),
      kind: r.kind as AgentEventKind,
      facts: r.facts && typeof r.facts === 'object' && !Array.isArray(r.facts) ? (r.facts as AgentEventFacts) : {},
      occurs_at: r.occurs_at as string,
      ref_type: typeof r.ref_type === 'string' ? r.ref_type : null,
      ref_id: typeof r.ref_id === 'string' ? r.ref_id : null,
      home_turn_id: typeof r.home_turn_id === 'string' ? r.home_turn_id : null,
      delivered_key: typeof r.delivered_key === 'string' ? r.delivered_key : null,
    }))
}

// ── The start: an empty note ─────────────────────────────────────────────────

/** The most items of each kind one start carries. */
export const CHECK_IN_START_MAX_PER_KIND = 6
/** How far back a start looks for pull requests. */
const START_PR_LOOKBACK_MS = 7 * 24 * 60 * 60_000
/** How far back a start looks for work and actions: older ones are likely abandoned, never a line to nag about. */
const START_ITEM_LOOKBACK_MS = 14 * 24 * 60 * 60_000
/** Work still in motion (tracked_job.status). */
const OPEN_WORK_STATUSES = ['queued', 'running', 'waiting_on_child', 'needs_input', 'needs_review']
/** The columns a started action is read with: only a started state joins (`!inner`). */
const STARTED_ACTION_COLUMNS = 'id, identifier, title, updated_at, workflow_state:workflow_state!status_id!inner(name, category)'

/** One item a start offers: its key (checkInItemKey, what `track` names), its state, and when it last moved. */
export interface StartItem {
  key: string
  state: CheckInItemState
  /** When it was created or last changed (ISO), or null. */
  at: string | null
}

/** True when there is no note, or it holds nothing yet (now-file.ts nowContentEmpty): the check-in starts it. Pure. */
export function nowNoteEmpty(note: Pick<NowNote, 'content'> | null): boolean {
  return !note || nowContentEmpty(note.content)
}

/**
 * What is in motion for the person in Native Intelligence's own records, to start an empty
 * note from: their work still running or waiting on them (tracked_job of
 * their member row), the confirmed actions assigned to them in a started
 * state, and their pull requests whose newest change in the last week left
 * them open (checks failing, reopened). Work and actions from the last two
 * weeks only (older ones are likely abandoned). At most
 * CHECK_IN_START_MAX_PER_KIND of each, newest first. States only, templated
 * like a due line's (never a run's summary or its question). Throws on a
 * failed read.
 */
export async function readStartItems(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; memberId: string; timeZone: string; nowMs: number },
): Promise<StartItem[]> {
  const [work, actions, prEvents] = await Promise.all([
    supabase
      .from('tracked_job')
      .select(WORK_COLUMNS)
      .eq('workspace_id', args.workspaceId)
      .eq('member_id', args.memberId)
      .in('status', OPEN_WORK_STATUSES)
      .gte('created_at', new Date(args.nowMs - START_ITEM_LOOKBACK_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(CHECK_IN_START_MAX_PER_KIND),
    supabase
      .from('actions')
      .select(STARTED_ACTION_COLUMNS)
      .eq('workspace_id', args.workspaceId)
      .eq('assignee_id', args.memberId)
      .eq('confirmation', 'confirmed')
      .eq('workflow_state.category', 'started')
      .gte('updated_at', new Date(args.nowMs - START_ITEM_LOOKBACK_MS).toISOString())
      .order('updated_at', { ascending: false })
      .limit(CHECK_IN_START_MAX_PER_KIND),
    supabase
      .from('agent_event')
      .select('ref_id, facts, occurs_at')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .eq('kind', 'pr.changed')
      .eq('ref_type', 'github_pr')
      .gt('occurs_at', new Date(args.nowMs - START_PR_LOOKBACK_MS).toISOString())
      .order('occurs_at', { ascending: false })
      .limit(50),
  ])
  const z = args.timeZone
  const items: StartItem[] = []
  for (const row of rowsOf(work, 'tracked_job')) {
    if (typeof row.id === 'string') items.push({ key: `work:${row.id}`, state: workItemState(row as { id: string }, z), at: latestOf(row.started_at, row.created_at) })
  }
  for (const row of rowsOf(actions, 'actions')) {
    if (typeof row.id !== 'string') continue
    const state = actionState(row as { id: string }, z)
    if (!state.done) items.push({ key: `action:${typeof row.identifier === 'string' && row.identifier ? row.identifier : row.id}`, state, at: latestOf(row.updated_at) })
  }
  // The newest change per pull request (the rows come newest first).
  const seen = new Set<string>()
  let prs = 0
  for (const row of rowsOf(prEvents, 'agent_event')) {
    const ref = typeof row.ref_id === 'string' ? row.ref_id : null
    if (!ref || seen.has(ref.toLowerCase())) continue
    seen.add(ref.toLowerCase())
    const state = prState(ref, row as { facts?: AgentEventFacts; occurs_at?: string }, z)
    if (state.done || prs >= CHECK_IN_START_MAX_PER_KIND) continue
    items.push({ key: `pr:${ref}`, state, at: latestOf(row.occurs_at) })
    prs++
  }
  return items
}

/** The latest of these timestamps (ISO), or null with none. Pure. */
function latestOf(...values: unknown[]): string | null {
  const times = values.filter((v): v is string => typeof v === 'string' && ms(v) > 0)
  return times.length ? times.reduce((a, b) => (ms(b) > ms(a) ? b : a)) : null
}

/**
 * The start's body input: each item with its key, for `track` on the add, or
 * null when there is nothing to start the note from. Pure.
 */
export function checkInStartBody(items: readonly StartItem[], args: { date: string; hour: number; timeZone: string; revision: number }): HomeTurnCheckIn | null {
  if (items.length === 0) return null
  return { date: args.date, hour: args.hour, timeZone: args.timeZone, revision: args.revision, lines: items.map((i) => `Item ${i.key}: ${i.state.line}`), eventIds: [], start: true }
}

/** Why a gather found nothing to say. */
export type CheckInGatherSkip = 'no_tracks' | 'nothing_due' | 'started_today' | 'nothing_to_start'

export type CheckInGather = { ok: true; body: HomeTurnCheckIn } | { ok: false; reason: CheckInGatherSkip }

/**
 * What a check-in for this slot would carry: the note's tracked lines due
 * now, rendered (checkInDue, checkInBody). `note` skips the note read when
 * the caller already has it. Throws on a failed read.
 */
export async function gatherCheckIn(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    memberId: string
    conversationId: string
    date: string
    hour: number
    timeZone: string
    nowMs?: number
    note?: NowNote | null
    history?: CheckInHistory
  },
): Promise<CheckInGather> {
  const nowMs = args.nowMs ?? Date.now()
  let note = args.note
  if (note === undefined) {
    const loaded = await loadNowNote(supabase, { workspaceId: args.workspaceId, memberId: args.memberId })
    if (!loaded.ok) throw new Error(`now note read failed: ${loaded.error}`)
    note = loaded.note
  }
  if (!note || nowNoteEmpty(note)) {
    // Nothing written yet: start it from Native Intelligence's own records, once a day (a
    // check-in that ran to the end today, start or not, had its chance).
    const history = args.history ?? (await readCheckInHistory(supabase, { conversationId: args.conversationId, date: args.date, hour: args.hour }))
    if (history.ranToday) return { ok: false, reason: 'started_today' }
    const items = await readStartItems(supabase, { workspaceId: args.workspaceId, userId: args.userId, memberId: args.memberId, timeZone: args.timeZone, nowMs })
    // A start that wrote nothing saw these: it goes again only once something moved since.
    const since = ms(history.lastCheckInAt)
    if (since > 0 && !items.some((i) => ms(i.at) > since)) return { ok: false, reason: 'nothing_to_start' }
    const body = checkInStartBody(items, { date: args.date, hour: args.hour, timeZone: args.timeZone, revision: note?.revision ?? 0 })
    return body ? { ok: true, body } : { ok: false, reason: 'nothing_to_start' }
  }
  const lines = trackedLines(note)
  if (lines.length === 0) return { ok: false, reason: 'no_tracks' }
  const history = args.history ?? (await readCheckInHistory(supabase, { conversationId: args.conversationId, date: args.date, hour: args.hour }))
  // The earliest instant any line still counts events from (checkInDue: after
  // the last quiet check-in and after the line was tracked), at most a week back.
  const oldestTrack = Math.min(...lines.map((l) => ms(l.track.added_at)))
  const sinceMs = Math.max(nowMs - CHECK_IN_LOOKBACK_MS, quietSince(history.lastQuietCheckInAt), oldestTrack)
  const [items, events] = await Promise.all([
    readItemStates(supabase, { workspaceId: args.workspaceId, userId: args.userId, memberId: args.memberId, tracks: lines.map((l) => l.track), timeZone: args.timeZone }),
    readCheckInEvents(supabase, { workspaceId: args.workspaceId, userId: args.userId, sinceIso: new Date(sinceMs).toISOString() }),
  ])
  const due = checkInDue({
    lines,
    states: items.states,
    events,
    answers: items.answers,
    running: items.running,
    lastCheckInAt: history.lastCheckInAt,
    lastQuietCheckInAt: history.lastQuietCheckInAt,
    ranToday: history.ranToday,
    today: args.date,
    timeZone: args.timeZone,
  })
  const body = checkInBody(due, { date: args.date, hour: args.hour, timeZone: args.timeZone, revision: note.revision })
  return body ? { ok: true, body } : { ok: false, reason: 'nothing_due' }
}

/**
 * Whether the person wrote in one of their chats since `sinceMs`: the newest
 * user message in their home thread and their most recent chats (a guest's
 * thread is someone else's words). Server rows bump updated_at too, so the
 * column only picks which chats to look in. Throws on a failed read.
 */
export async function personActiveSince(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; homeConversationId: string; sinceMs: number },
): Promise<boolean> {
  const chats = rowsOf(
    await supabase
      .from('chat_conversations')
      .select('id')
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .is('agent_guest_id', null)
      .order('updated_at', { ascending: false })
      .limit(ACTIVE_CHATS),
    'chat_conversations',
  )
  const ids = [...new Set([args.homeConversationId, ...chats.map((c) => c.id).filter((id): id is string => typeof id === 'string')])]
  const recent = rowsOf(
    await supabase
      .from('chat_messages')
      .select('created_at')
      .in('conversation_id', ids)
      .eq('user_id', args.userId)
      .eq('role', 'user')
      .gte('created_at', new Date(args.sinceMs).toISOString())
      .limit(1),
    'chat_messages',
  )
  return recent.length > 0
}

// ── The cron's plan ──────────────────────────────────────────────────────────

/** Why the cron sent no check-in for a person. */
export type CheckInSkip = 'no_home_thread' | 'already_sent' | 'paused' | 'dormant' | 'active' | CheckInGatherSkip | 'lookup_failed'

export interface CheckInRequest {
  /** Inngest's event id: one request per conversation, local date and slot. */
  id: string
  name: typeof HOME_TURN_REQUESTED_EVENT
  data: HomeTurnRequestedData
}

export interface CheckInPlanDeps {
  /** The kill switch's three states (readAgentPausedState): anything but 'active' skips (fail closed). */
  pausedState: (supabase: SupabaseClient, workspaceId: string) => Promise<AgentPausedState>
  isDormant: (supabase: SupabaseClient, workspaceId: string) => Promise<boolean>
}

/** The request the cron sends for one person and slot. Pure. */
export function checkInRequest(conversationId: string, c: Pick<DigestCandidate, 'userId' | 'workspaceId' | 'date'> & { hour: number }): CheckInRequest {
  return {
    id: `home-turn-check-in:${conversationId}:${c.date}:${c.hour}`,
    name: HOME_TURN_REQUESTED_EVENT,
    data: { conversationId, userId: c.userId, workspaceId: c.workspaceId, workItemIds: [], reason: 'check_in', checkInSlot: { date: c.date, hour: c.hour } },
  }
}

/**
 * One candidate's decision (see the header), cheapest reads first. Never
 * throws: a failed read is `lookup_failed` (no check-in this slot).
 */
export async function planCheckInFor(
  supabase: SupabaseClient,
  c: DigestCandidate & { hour: number },
  deps: CheckInPlanDeps,
  nowMs = Date.now(),
): Promise<{ ok: true; request: CheckInRequest } | { ok: false; reason: CheckInSkip }> {
  try {
    // The note first: a note with lines but nothing tracked costs this one
    // indexed read. An empty one (or none) goes on: the check-in starts it
    // (gatherCheckIn, once a day).
    const loaded = await loadNowNote(supabase, { workspaceId: c.workspaceId, memberId: c.memberId })
    if (!loaded.ok) return { ok: false, reason: 'lookup_failed' }
    const note = loaded.note
    const empty = nowNoteEmpty(note)
    if (!empty && note && trackedLines(note).length === 0) return { ok: false, reason: 'no_tracks' }

    const { data: convs, error: convError } = await supabase
      .from('chat_conversations')
      .select('id')
      .eq('user_id', c.userId)
      .eq('workspace_id', c.workspaceId)
      .eq('is_home', true)
      .limit(1)
    if (convError) return { ok: false, reason: 'lookup_failed' }
    const conversationId = (convs as Array<{ id?: unknown }> | null)?.[0]?.id
    if (typeof conversationId !== 'string') return { ok: false, reason: 'no_home_thread' }

    const history = await readCheckInHistory(supabase, { conversationId, date: c.date, hour: c.hour })
    // A failed turn may go again (the consumer decides whether its claim can be retaken).
    if (history.slotStatus && history.slotStatus !== 'failed') return { ok: false, reason: 'already_sent' }

    const gather = () =>
      gatherCheckIn(supabase, {
        workspaceId: c.workspaceId,
        userId: c.userId,
        memberId: c.memberId,
        conversationId,
        date: c.date,
        hour: c.hour,
        timeZone: c.timeZone,
        nowMs,
        note: loaded.note,
        history,
      })
    // An empty note's start reads in one round trip, before the gates: most
    // people with one have nothing in motion (or started today), and stop here.
    if (empty) {
      const started = await gather()
      if (!started.ok) return { ok: false, reason: started.reason }
    }

    // Fails CLOSED: this spends money, so a switch that can't be read is off.
    const state = await deps.pausedState(supabase, c.workspaceId).catch((): AgentPausedState => 'unknown')
    if (state !== 'active') return { ok: false, reason: 'paused' }
    if (await deps.isDormant(supabase, c.workspaceId).catch(() => false)) return { ok: false, reason: 'dormant' }

    if (await personActiveSince(supabase, { workspaceId: c.workspaceId, userId: c.userId, homeConversationId: conversationId, sinceMs: nowMs - CHECK_IN_ACTIVE_MS })) {
      return { ok: false, reason: 'active' }
    }

    if (!empty) {
      const gathered = await gather()
      if (!gathered.ok) return { ok: false, reason: gathered.reason }
    }
    return { ok: true, request: checkInRequest(conversationId, c) }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }
}

// ── The notice ───────────────────────────────────────────────────────────────

/** The group key of one check-in's notice. */
export function checkInNoticeGroupKey(homeTurnId: string): string {
  return `agent_check_in:${homeTurnId}`
}

/** What a check-in's bubble says: Native Intelligence's words only (never the reply's). Pure. */
export function checkInNoticeCopy(): { title: string; sentence: string } {
  return { title: 'Your agent checked in', sentence: 'I checked on what I’m tracking for you and left a note in our thread.' }
}

/**
 * ONE `agent_check_in` notice for a check-in that replied, from the
 * Assistant (the one face), once per check-in (a notice already carrying its
 * group key is not sent again). Never forwarded to texts or Slack. Never
 * throws; resolves to whether one went out.
 */
export async function sendCheckInNotice(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; conversationId: string; homeTurnId: string; date: string; hour: number },
): Promise<boolean> {
  try {
    const { data: member, error } = await supabase.from('member').select('id').eq('workspace_id', args.workspaceId).eq('user_id', args.userId).maybeSingle()
    const memberId = (member as { id?: unknown } | null)?.id
    if (error || typeof memberId !== 'string') return false
    const groupKey = checkInNoticeGroupKey(args.homeTurnId)
    const { data: existing } = await supabase.from('notification').select('id').eq('recipient_id', memberId).eq('group_key', groupKey).eq('type', 'agent_check_in').limit(1)
    if (Array.isArray(existing) && existing.length > 0) return false
    const face = await systemTeammateId(supabase, args.workspaceId, 'assistant')
    const copy = checkInNoticeCopy()
    const bot = face ? botNoticeMetadata({ teammateId: face, teammateName: await noticeTeammateName(supabase, args.workspaceId, face), sentence: copy.sentence }) : {}
    const said = botNoticeCopy(bot, { title: copy.title, body: copy.sentence })
    await createNotification({
      workspaceId: args.workspaceId,
      recipientId: memberId,
      type: 'agent_check_in',
      title: said.title,
      body: said.body,
      groupKey,
      metadata: { conversation_id: args.conversationId, home_turn_id: args.homeTurnId, check_in_date: args.date, check_in_hour: args.hour, ...bot },
    })
    return true
  } catch (err) {
    console.warn('[now-check-in] notice skipped:', err instanceof Error ? err.message : err)
    return false
  }
}

/** One `[now-check-in]` line per pass. Pure. */
export function checkInLogLine(r: { candidates: number; sent: number; skips: Partial<Record<CheckInSkip, number>> }): string {
  const skips = Object.entries(r.skips)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ')
  return `[now-check-in] candidates=${r.candidates} sent=${r.sent}${skips ? ` ${skips}` : ''}`
}
