/**
 * A local agent's transcript, folded for display. Pure, so a backfill and the
 * live stream can arrive in any order and give the same transcript. Two
 * callers share one fold:
 *
 * - The L0 dev page (`/dev/local-agent`): one job's `local-agent://event`
 *   envelopes from the desktop (`applyEnvelopes`). Dedupe is on `seq`: a batch
 *   is sorted, and anything at or below the highest seq already applied is
 *   dropped (the desktop's seq is monotonic per job).
 * - The Agents panel (LocalAgentPanel, contract G): a SESSION, across its
 *   turns and its runs, from the server's stored events (the newest page
 *   first, older pages on demand: `prependStoredEvents`; the forward
 *   catch-up and realtime inserts: `applyStoredEvents`). Order and dedupe are
 *   on the event id. The raw events are NOT kept (a long session would hold
 *   every delta): the last RECENT_IDS ids tell a repeat from a late commit,
 *   and an unseen id below the highest applied marks the transcript `stale`,
 *   so the caller reads it again in the server's order. The server's
 *   `inbound` events (a message from the Native Intelligence agent or the person; ONLY a
 *   `source: 'server'` row, never a device's) and the Mac's `branch` event
 *   fold in too, and a server `error` naming a `messageId` is a message that
 *   couldn't be delivered.
 * - The teammate plan (docs/plans/teammate-agent.md): the Mac body's
 *   message_teammate and report_to_person show as the `ask` / `report` the
 *   server wrote for them (marked `teammate`), never again as tool calls; the
 *   Mac's own `prompt` events (a native question on the Mac, C3) fold into one
 *   line per prompt that follows its state; its `pull_request` event (C5) is
 *   the pull request's line.
 *
 * The fold:
 * - `text` deltas append to the open assistant item while it is the last
 *   item; anything in between (a tool call, a message to the agent) starts a
 *   new one. `message` closes the open items, and is the text of a single
 *   open one.
 * - `tool_result` lands on its `tool` item by callId.
 * - A status that ends the turn closes the open items.
 * - Every batch copies `items` once and replaces only the items it touched,
 *   so a memoized row re-renders only when its own item changed.
 *
 * Also here, as pure helpers the panel, the Agents widget and the stop route
 * map share: the session id a ledger row names, what a session's status lets
 * the person do, and a tool call's one-line label.
 */

import type { LocalAgentEventEnvelope, LocalAgentJobStatus, LocalAgentPolicy } from '@/lib/tauri-bridge'
import type { LocalAgentStatus } from './store'
import { isPullRequestUrl } from './pull-request'
import { isMacTeammateTool } from './teammate'

/** A native question on the Mac (C3): `push` asks to push and open a pull request, `fence` to read one more folder. */
export type PromptKind = 'push' | 'fence'
/** Where it stands: on screen, answered yes or no, refused before it was shown, or nobody answered in time. */
export type PromptState = 'asking' | 'allowed' | 'denied' | 'refused' | 'expired'

export type TranscriptItem =
  | { type: 'assistant'; key: string; text: string; open: boolean }
  | {
      type: 'tool'
      key: string
      callId: string
      name: string
      input: string
      result: { ok: boolean; output: string } | null
    }
  /** `teammate`: the Mac body's report_to_person (a report) or message_teammate (an ask, to Native Intelligence in the cloud). */
  | { type: 'report' | 'ask' | 'finish' | 'error'; key: string; text: string; teammate?: true }
  | { type: 'status'; key: string; status: LocalAgentJobStatus; reason: string | null }
  /** A native question on the Mac, one line that follows its state (by its id); `at`, when it was last written. */
  | { type: 'prompt'; key: string; id: string; prompt: PromptKind; state: PromptState; why: string | null; at?: string }
  /** The Mac pushed the job's branch and opened its pull request, or couldn't (C5). */
  | {
      type: 'pull_request'
      key: string
      ok: boolean
      url: string | null
      branch: string
      via: 'gh' | 'server' | null
      /** false: the push itself failed; null: unknown (a push cut off by quitting). */
      pushed: boolean | null
      error: string | null
    }
  /** A message the dev page sent. Local only: a reload doesn't bring it back. */
  | { type: 'sent'; key: string; text: string; policy: LocalAgentPolicy }
  /** A message to the local agent, stored by the server: the Native Intelligence agent's (`agent`) or the person's. */
  | { type: 'inbound'; key: string; author: 'agent' | 'person'; text: string; policy: LocalAgentPolicy }
  /** A message to the agent that couldn't be delivered (a server `error` naming its messageId). */
  | { type: 'undelivered'; key: string; messageId: string; reason: string }
  /** An edit job's commit, made by the app when the agent finished (contract C5). */
  | {
      type: 'branch'
      key: string
      name: string
      commit: string
      filesChanged: number
      insertions: number
      deletions: number
    }

type AssistantItem = Extract<TranscriptItem, { type: 'assistant' }>

/** One event as the fold reads it, whichever side it came from. */
export type ViewEvent =
  | { kind: 'status'; status: LocalAgentJobStatus; reason?: string }
  | { kind: 'text'; delta: string }
  | { kind: 'message'; text: string }
  | { kind: 'tool'; callId: string; name: string; input: string }
  | { kind: 'tool_result'; callId: string; name: string; ok: boolean; output: string }
  | { kind: 'report'; text: string; teammate?: true }
  | { kind: 'ask'; question: string; teammate?: true }
  | { kind: 'finish'; summary: string }
  | { kind: 'error'; message: string }
  | { kind: 'branch'; branch: string; commit: string; filesChanged: number; insertions: number; deletions: number }
  | { kind: 'inbound'; author: 'agent' | 'person'; text: string; policy: LocalAgentPolicy }
  | { kind: 'undelivered'; messageId: string; reason: string }
  | { kind: 'prompt'; id: string; prompt: PromptKind; state: PromptState; why: string | null; at?: string }
  | {
      kind: 'pull_request'
      ok: boolean
      url: string | null
      branch: string
      via: 'gh' | 'server' | null
      pushed: boolean | null
      error: string | null
    }

const PROMPT_STATES: ReadonlySet<string> = new Set<PromptState>(['asking', 'allowed', 'denied', 'refused', 'expired'])

const JOB_STATUSES: ReadonlySet<string> = new Set<LocalAgentJobStatus>([
  'starting',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

/** Statuses after which the agent no longer streams this turn. */
const TURN_OVER: ReadonlySet<LocalAgentJobStatus> = new Set([
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)
}

function count(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

/**
 * An event's kind and body (a stored event's `kind` + `payload`, or an
 * envelope's event) → the fold's event, or null for anything it doesn't show
 * (an unknown kind, a status it doesn't know, a tool call without its id).
 */
export function toViewEvent(kind: string, body: Record<string, unknown> | null | undefined): ViewEvent | null {
  const p = body ?? {}
  switch (kind) {
    case 'status': {
      const status = str(p.status)
      if (!JOB_STATUSES.has(status)) return null
      const reason = typeof p.reason === 'string' && p.reason ? p.reason : undefined
      return reason
        ? { kind: 'status', status: status as LocalAgentJobStatus, reason }
        : { kind: 'status', status: status as LocalAgentJobStatus }
    }
    case 'text':
      return typeof p.delta === 'string' ? { kind: 'text', delta: p.delta } : null
    case 'message':
      return typeof p.text === 'string' ? { kind: 'message', text: p.text } : null
    case 'tool': {
      const callId = str(p.callId)
      // The Mac body's teammate tools show as the server's ask / report instead.
      if (isMacTeammateTool(p.name)) return null
      return callId ? { kind: 'tool', callId, name: str(p.name), input: str(p.input) } : null
    }
    case 'tool_result': {
      const callId = str(p.callId)
      if (isMacTeammateTool(p.name)) return null
      return callId ? { kind: 'tool_result', callId, name: str(p.name), ok: p.ok === true, output: str(p.output) } : null
    }
    case 'report':
      return p.via === 'report_to_person' ? { kind: 'report', text: str(p.text), teammate: true } : { kind: 'report', text: str(p.text) }
    case 'ask':
      return p.via === 'message_teammate' ? { kind: 'ask', question: str(p.question), teammate: true } : { kind: 'ask', question: str(p.question) }
    case 'prompt': {
      const id = str(p.id)
      const prompt = p.prompt === 'push' || p.prompt === 'fence' ? p.prompt : null
      const state = str(p.state)
      if (!id || !prompt || !PROMPT_STATES.has(state)) return null
      return { kind: 'prompt', id, prompt, state: state as PromptState, why: typeof p.why === 'string' && p.why ? p.why : null }
    }
    case 'pull_request': {
      const ok = p.ok === true && isPullRequestUrl(p.url)
      return {
        kind: 'pull_request',
        ok,
        url: ok ? (p.url as string) : null,
        branch: str(p.branch),
        via: p.via === 'gh' || p.via === 'server' ? p.via : null,
        pushed: typeof p.pushed === 'boolean' ? p.pushed : ok ? true : null,
        error: ok ? null : str(p.error) || null,
      }
    }
    case 'finish':
      return { kind: 'finish', summary: str(p.summary) }
    case 'error':
      return { kind: 'error', message: str(p.message) }
    case 'branch': {
      const branch = str(p.branch ?? p.name)
      if (!branch) return null
      return {
        kind: 'branch',
        branch,
        commit: str(p.commit),
        filesChanged: count(p.filesChanged),
        insertions: count(p.insertions),
        deletions: count(p.deletions),
      }
    }
    case 'inbound': {
      const text = str(p.text)
      if (!text) return null
      return {
        kind: 'inbound',
        author: p.author === 'agent' ? 'agent' : 'person',
        text,
        policy: p.policy === 'queue' ? 'queue' : 'steer',
      }
    }
    default:
      return null
  }
}

/** The working copy one batch folds into. */
interface Fold {
  items: TranscriptItem[]
  status: LocalAgentJobStatus | null
}

function closeOpen(items: TranscriptItem[]) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type === 'assistant' && item.open) items[i] = { ...item, open: false }
  }
}

/** Fold one event into the batch's working copy, as item `key`. */
function foldOne(f: Fold, key: string, event: ViewEvent): void {
  const { items } = f
  switch (event.kind) {
    case 'text': {
      if (!event.delta) break
      const last = items[items.length - 1]
      if (last?.type === 'assistant' && last.open) {
        items[items.length - 1] = { ...last, text: last.text + event.delta }
      } else {
        items.push({ type: 'assistant', key, text: event.delta, open: true })
      }
      break
    }
    case 'message': {
      const open: number[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.type === 'assistant' && item.open) open.push(i)
      }
      if (open.length === 0) {
        // A status already closed the deltas that make this message.
        const lastAssistant = items.findLast((item): item is AssistantItem => item.type === 'assistant')
        if (event.text && lastAssistant?.text !== event.text) {
          items.push({ type: 'assistant', key, text: event.text, open: false })
        }
      } else if (open.length === 1) {
        const item = items[open[0]] as AssistantItem
        items[open[0]] = { ...item, text: event.text || item.text, open: false }
      } else {
        // Split by a tool call or a message to the agent: the deltas already hold it.
        closeOpen(items)
      }
      break
    }
    case 'tool':
      items.push({ type: 'tool', key, callId: event.callId, name: event.name, input: event.input, result: null })
      break
    case 'tool_result': {
      const result = { ok: event.ok, output: event.output }
      let found = false
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        if (item.type === 'tool' && item.callId === event.callId) {
          items[i] = { ...item, result }
          found = true
          break
        }
      }
      // Its call fell out of the desktop's 500-event ring.
      if (!found) items.push({ type: 'tool', key, callId: event.callId, name: event.name, input: '', result })
      break
    }
    case 'report':
      items.push(event.teammate ? { type: 'report', key, text: event.text, teammate: true } : { type: 'report', key, text: event.text })
      break
    case 'ask':
      items.push(event.teammate ? { type: 'ask', key, text: event.question, teammate: true } : { type: 'ask', key, text: event.question })
      break
    case 'prompt': {
      const item: TranscriptItem = { type: 'prompt', key, id: event.id, prompt: event.prompt, state: event.state, why: event.why, ...(event.at ? { at: event.at } : {}) }
      // One line per prompt: its later state replaces the earlier one where it stands.
      const at = items.findLastIndex((it) => it.type === 'prompt' && it.id === event.id)
      if (at >= 0) items[at] = { ...item, key: items[at].key }
      else items.push(item)
      break
    }
    case 'pull_request':
      items.push({ type: 'pull_request', key, ok: event.ok, url: event.url, branch: event.branch, via: event.via, pushed: event.pushed, error: event.error })
      break
    case 'finish':
      items.push({ type: 'finish', key, text: event.summary })
      break
    case 'error':
      items.push({ type: 'error', key, text: event.message })
      break
    case 'branch':
      items.push({
        type: 'branch',
        key,
        name: event.branch,
        commit: event.commit,
        filesChanged: event.filesChanged,
        insertions: event.insertions,
        deletions: event.deletions,
      })
      break
    case 'inbound':
      items.push({ type: 'inbound', key, author: event.author, text: event.text, policy: event.policy })
      break
    case 'undelivered':
      items.push({ type: 'undelivered', key, messageId: event.messageId, reason: event.reason })
      break
    case 'status': {
      if (TURN_OVER.has(event.status)) closeOpen(items)
      if (event.status !== f.status || event.reason) {
        items.push({ type: 'status', key, status: event.status, reason: event.reason ?? null })
      }
      f.status = event.status
      break
    }
  }
}

// ── The dev page: one job's envelopes, by seq ───────────────────────────────

export interface Transcript {
  jobId: string
  /** Highest seq applied; -1 before any. */
  lastSeq: number
  items: readonly TranscriptItem[]
  /** The last status event's status, or null. */
  status: LocalAgentJobStatus | null
  sentCount: number
}

export function emptyTranscript(jobId: string): Transcript {
  return { jobId, lastSeq: -1, items: [], status: null, sentCount: 0 }
}

/** Apply a batch of envelopes. Other jobs' envelopes and seqs already seen are
 *  skipped; returns `t` itself when nothing changed. */
export function applyEnvelopes(t: Transcript, envelopes: readonly LocalAgentEventEnvelope[]): Transcript {
  const fresh = envelopes.filter((e) => e.jobId === t.jobId && e.seq > t.lastSeq).sort((a, b) => a.seq - b.seq)
  if (fresh.length === 0) return t

  const f: Fold = { items: t.items.slice(), status: t.status }
  let lastSeq = t.lastSeq
  for (const { seq, event } of fresh) {
    // Same seq twice inside one batch (backfill + live overlap).
    if (seq <= lastSeq) continue
    lastSeq = seq
    // A desktop envelope is never a message to the agent (those are the server's).
    const view = (event.kind as string) === 'inbound' ? null : toViewEvent(event.kind, event as unknown as Record<string, unknown>)
    if (view) foldOne(f, `s${seq}`, view)
  }
  return { ...t, lastSeq, items: f.items, status: f.status }
}

/** Show a message this page sent, where it was sent. */
export function appendSent(t: Transcript, text: string, policy: LocalAgentPolicy): Transcript {
  const item: TranscriptItem = { type: 'sent', key: `sent-${t.sentCount}`, text, policy }
  return { ...t, items: [...t.items, item], sentCount: t.sentCount + 1 }
}

// ── The Agents panel: a whole session's stored events, by id ───────────────

/** A stored event as the panel holds it (the route's page, or a realtime row mapped). */
export interface StoredEventLike {
  id: number
  kind: string
  payload: Record<string, unknown> | null
  /** The row's writer, when the caller carries it: an `inbound` folds only from the server. */
  source?: 'device' | 'server' | string | null
  /** When it was written, when the caller carries it (a question on the Mac times out). */
  at?: string | null
}

/**
 * A stored event the fold may read (S4). A message TO the agent (`inbound`)
 * is the server's alone: only a row whose `source` is 'server' is shown as
 * the person or the Native Intelligence agent, never a device's, nor one that doesn't say
 * (every caller carries the column: the route's page, realtime, the page
 * read). Ingest refuses that kind from devices anyway.
 */
function trustedKind(e: StoredEventLike): boolean {
  return e.kind !== 'inbound' || e.source === 'server'
}

/** A stored event → the fold's event (null: not shown). */
function viewOf(e: StoredEventLike): ViewEvent | null {
  if (!trustedKind(e)) return null
  const p = e.payload ?? {}
  // A failed delivery: the server's error about one message.
  if (e.kind === 'error' && e.source === 'server' && typeof p.messageId === 'string' && p.messageId) {
    return { kind: 'undelivered', messageId: p.messageId, reason: str(p.message ?? p.error) || 'unknown reason' }
  }
  const view = toViewEvent(e.kind, e.payload)
  return view?.kind === 'prompt' && e.at ? { ...view, at: e.at } : view
}

/** How long a native question on the Mac can still be open: its longest wait (30 min) and a minute's slack (store.ts PROMPT_OPEN_MS). */
export const PROMPT_OPEN_MS = 31 * 60_000

/** A question on the Mac that is still waiting for the person (not answered, not past its longest wait). */
export function isPromptOpen(item: { state: PromptState; at?: string }, now = Date.now()): boolean {
  if (item.state !== 'asking') return false
  if (!item.at) return true
  const at = Date.parse(item.at)
  return !Number.isFinite(at) || now - at < PROMPT_OPEN_MS
}

/** How many of the newest ids applied are kept to tell a repeat from a late commit. */
export const RECENT_IDS = 512

export interface SessionTranscript {
  sessionId: string
  /** Highest event id applied; 0 before any. Pass it as `afterId` to catch up. */
  lastId: number
  /** Lowest event id held (where an older page reads back from); 0 before any. */
  firstId: number
  /** The newest ids applied (at most RECENT_IDS), ascending. */
  recentIds: readonly number[]
  items: readonly TranscriptItem[]
  /** The last status event's status, or null. */
  status: LocalAgentJobStatus | null
  /** An unseen id below `lastId` landed (a late commit): read the session again. */
  stale: boolean
}

export function emptySessionTranscript(sessionId: string): SessionTranscript {
  return { sessionId, lastId: 0, firstId: 0, recentIds: [], items: [], status: null, stale: false }
}

/** Whether `ids` (ascending) holds `id`. */
function holds(ids: readonly number[], id: number): boolean {
  let lo = 0
  let hi = ids.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const at = ids[mid]
    if (at === id) return true
    if (at < id) lo = mid + 1
    else hi = mid - 1
  }
  return false
}

function validId(e: StoredEventLike): boolean {
  return Number.isSafeInteger(e.id) && e.id > 0
}

/**
 * Apply stored events going forward (a newest page, a catch-up, realtime
 * rows; any mix, any order, repeats). Ids already applied are skipped and
 * `t` itself comes back when nothing is new. An unseen id below the highest
 * applied (within the recent ids) marks it `stale` and folds nothing; one
 * older than those is a repeat of what an older page holds.
 */
export function applyStoredEvents(t: SessionTranscript, incoming: readonly StoredEventLike[]): SessionTranscript {
  const fresh = new Map<number, StoredEventLike>()
  let late = false
  const floor = t.recentIds.length > 0 ? t.recentIds[0] : 0
  for (const e of incoming) {
    if (!validId(e) || fresh.has(e.id)) continue
    if (e.id <= t.lastId) {
      if (e.id >= floor && !holds(t.recentIds, e.id)) late = true
      continue
    }
    fresh.set(e.id, e)
  }
  if (late) return t.stale ? t : { ...t, stale: true }
  if (fresh.size === 0) return t
  const batch = [...fresh.values()].sort((a, b) => a.id - b.id)

  const f: Fold = { items: t.items.slice(), status: t.status }
  for (const e of batch) {
    const view = viewOf(e)
    if (view) foldOne(f, `e${e.id}`, view)
  }
  const ids = batch.map((e) => e.id)
  const recentIds = t.recentIds.length + ids.length <= RECENT_IDS ? t.recentIds.concat(ids) : t.recentIds.concat(ids).slice(-RECENT_IDS)
  return {
    sessionId: t.sessionId,
    lastId: ids[ids.length - 1],
    firstId: t.firstId > 0 ? t.firstId : ids[0],
    recentIds,
    items: f.items,
    status: f.status,
    stale: t.stale,
  }
}

/**
 * Join an older fold onto the newer one where a page boundary split them: a
 * tool call whose result the newer page held on its own takes it back; text
 * still streaming at the end of the older page joins (or is replaced by) the
 * newer page's first text; a repeated status at the seam goes.
 */
function stitch(older: TranscriptItem[], olderStatus: LocalAgentJobStatus | null, newer: readonly TranscriptItem[]): TranscriptItem[] {
  const rest = newer.slice()
  // A call the older page holds, its result the newer page's (input '').
  for (let i = 0; i < older.length; i++) {
    const call = older[i]
    if (call.type !== 'tool' || call.result) continue
    const j = rest.findIndex((it) => it.type === 'tool' && it.callId === call.callId && it.input === '' && !!it.result)
    if (j < 0) continue
    const orphan = rest[j] as Extract<TranscriptItem, { type: 'tool' }>
    older[i] = { ...call, result: orphan.result }
    rest.splice(j, 1)
  }
  const first = rest[0]
  // The older page's last status again, with nothing new to say.
  if (first?.type === 'status' && first.status === olderStatus && !first.reason) rest.shift()
  const last = older[older.length - 1]
  const head = rest[0]
  if (last?.type === 'assistant' && last.open) {
    if (head?.type === 'assistant') {
      // The newer page's message holds it all, or its deltas carry on from it.
      const text = head.text.startsWith(last.text) ? head.text : last.text + head.text
      older.pop()
      rest[0] = { ...head, text }
    } else if (head?.type === 'status' && TURN_OVER.has(head.status)) {
      older[older.length - 1] = { ...last, open: false }
    }
  }
  return older.concat(rest)
}

/**
 * Put an older page (every id below `firstId`) in front of what is held. The
 * page folds on its own and is stitched onto the held items, which keep their
 * objects. Ids at or above `firstId` are skipped.
 */
export function prependStoredEvents(t: SessionTranscript, page: readonly StoredEventLike[]): SessionTranscript {
  const seen = new Set<number>()
  const older = page
    .filter((e) => validId(e) && (t.firstId === 0 || e.id < t.firstId) && !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => a.id - b.id)
  if (older.length === 0) return t
  if (t.lastId === 0) return applyStoredEvents(t, older)
  const f: Fold = { items: [], status: null }
  for (const e of older) {
    const view = viewOf(e)
    if (view) foldOne(f, `e${e.id}`, view)
  }
  return {
    ...t,
    firstId: older[0].id,
    items: stitch(f.items, f.status, t.items),
    status: t.status ?? f.status,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** At most `max` characters, with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Stop and the message box go by `live` (a launcher runs), never by status:
 *  a launcher can outlive a terminal `failed`. */
export function isJobLive(job: { live: boolean }): boolean {
  return job.live
}

/** No launcher runs and there is an eve session to attach to again, whatever
 *  the status. */
export function canResumeJob(job: { live: boolean; sessionId: string | null }): boolean {
  return !job.live && job.sessionId !== null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The local agent session a ledger row is a turn of (`source.local_agent_session_id`), or null. */
export function localAgentSessionIdOf(row: {
  kind?: string | null
  source?: Record<string, unknown> | null
}): string | null {
  if (row.kind !== 'local_agent') return null
  const id = row.source?.local_agent_session_id
  return typeof id === 'string' && UUID.test(id) ? id : null
}

/** The session is over: nothing more can be sent to it, and Stop has nothing to stop. */
export function isSessionEnded(status: LocalAgentStatus): boolean {
  return status === 'cancelled' || status === 'failed' || status === 'expired'
}

/** The person can message it: live, idle (`waiting`), or interrupted (a message resumes it). */
export function canMessageSession(status: LocalAgentStatus): boolean {
  return !isSessionEnded(status)
}

/** Stop can end it: anything not over yet, idle included. */
export function canStopSession(status: LocalAgentStatus): boolean {
  return !isSessionEnded(status)
}

/** The reaper's (and migration 419's) words for a session that sat idle past its window. */
export const IDLE_REASON = 'it sat idle for 24 hours'
/** The reaper's (and migration 419's) words for a loop's job no Mac claimed in its 15 minutes (a person's waits 6 hours: ledger.ts EXPIRED_REASON). */
export const LOOP_EXPIRED_REASON = "your Mac didn't pick it up within 15 minutes"
/** The reaper's words for a card's job that waited its 6 hours on the server for a free slot on the Mac (migration 659). */
export const CARD_EXPIRED_REASON = 'it waited 6 hours for a free slot on your Mac'

/** The panel's line for an ended session, in place of its composer. */
export function sessionEndedText(status: LocalAgentStatus, error: string | null | undefined): string {
  if (status === 'expired') {
    if (error === IDLE_REASON) return 'It sat idle for 24 hours, so it ended.'
    if (error === LOOP_EXPIRED_REASON) return 'Your Mac didn’t pick this up within 15 minutes.'
    if (error === CARD_EXPIRED_REASON) return 'It waited 6 hours for a free slot on your Mac, so it ended. Press Start again when the Mac has room.'
    return 'Your Mac didn’t pick this up in time.'
  }
  if (status === 'failed') return 'This local agent failed.'
  return error ? `It ended: ${error}` : 'This local agent was stopped.'
}

/** The panel's status line for a session. */
export function sessionStatusText(status: LocalAgentStatus, lastSignal: 'ask' | 'finish' | null): string {
  switch (status) {
    case 'queued':
      return 'Waiting for your Mac'
    case 'starting':
      return 'Starting on your Mac'
    case 'running':
      return 'Working'
    case 'waiting':
      return lastSignal === 'ask' ? 'Has a question' : 'Idle · message it to continue'
    case 'interrupted':
      return 'Your Mac app closed · message it to resume'
    case 'cancelled':
      return 'Stopped'
    case 'failed':
      return 'Failed'
    case 'expired':
      return "Your Mac didn't connect in time"
  }
}

function parsedInput(input: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(input) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A tool call in one line: "Reading src/app/page.tsx", "Running git status", or its name. */
export function toolLine(name: string, input: string): string {
  const args = parsedInput(input)
  let arg = ''
  for (const key of ['path', 'file', 'filePath', 'command', 'cmd', 'pattern', 'query']) {
    const v = args?.[key]
    if (typeof v === 'string' && v.trim()) {
      arg = v.trim().replace(/\s+/g, ' ')
      break
    }
  }
  const n = name.toLowerCase()
  const verb = /read|cat|view|open/.test(n)
    ? 'Reading'
    : /write|edit|patch|apply/.test(n)
      ? 'Editing'
      : /grep|search|find|glob|list|ls/.test(n)
        ? 'Searching'
        : /bash|shell|exec|run|command/.test(n)
          ? 'Running'
          : null
  if (verb) return truncate(arg ? `${verb} ${arg}` : verb, 120)
  return truncate(arg ? `${name || 'Tool'} ${arg}` : name || 'Tool', 120)
}
