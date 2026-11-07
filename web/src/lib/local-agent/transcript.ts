/**
 * A local agent's transcript, server side (contract B): the raw event page the
 * Agents panel folds itself (`readEvents`), and a compact view for the Dial8
 * agent's `read_local_agent` tool (`readTranscript`).
 *
 * Events are local_agent_event rows in id order: the device's normalized
 * launcher events (payload = the event, `kind` = its kind) and the server's
 * `inbound` events (a message to the agent, written by addMessage).
 *
 * `compact` merges text deltas into whole messages, truncates tool input and
 * output to 300 characters, any one message to 4000 and a report, question,
 * finish or error to 2000, drops every status but the last, and keeps the
 * newest items within a 24k-character budget (`truncated` says older ones
 * were left out). Only a SERVER `inbound` event reads as a message to the
 * agent. The Mac body's teammate tools (message_teammate, report_to_person)
 * show as the `ask` / `report` the server wrote for them, not again as tool
 * calls; the Mac's `pull_request` event (C5) reads as one line.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { LocalAgentError, loadSession, toSessionRow, type SessionRow } from './store'
import { isMacTeammateTool } from './teammate'

export interface TranscriptItem {
  id: number
  at: string
  kind: 'inbound' | 'text' | 'tool' | 'report' | 'ask' | 'finish' | 'branch' | 'status' | 'error' | 'pull_request'
  author?: 'agent' | 'person'
  text?: string
  tool?: { name: string; input: string; ok?: boolean; output?: string }
  status?: string
  branch?: { name: string; commit: string; filesChanged: number; insertions: number; deletions: number }
}

/** One stored event as the panel reads it. */
export interface StoredEvent {
  id: number
  at: string
  source: 'device' | 'server'
  runId: string | null
  seq: number | null
  kind: string
  payload: Record<string, unknown>
}

export const EVENTS_PAGE_MAX = 500
const COMPACT_DEFAULT = 200
const TOOL_TEXT_MAX = 300
const COMPACT_TEXT_MAX = 4000
/** A report, question, finish or error in the compact view. */
const COMPACT_SIGNAL_MAX = 2000
/** The compact view's whole budget, in characters (the newest items win). */
export const COMPACT_BUDGET = 24_000

export interface TranscriptEventRow {
  id: number
  created_at: string
  source: 'device' | 'server'
  run_id: string | null
  seq: number | null
  kind: string
  payload: Record<string, unknown> | null
}

const EVENT_SELECT = 'id, created_at, source, run_id, seq, kind, payload'

function clampLimit(limit: number | undefined, fallback: number): number {
  const n = Math.floor(Number(limit))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, EVENTS_PAGE_MAX)
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Events of one session: after `afterId` ascending (the panel's page and its
 * catch-up), or, with `latest`, the newest `limit` in ascending order.
 */
async function fetchEvents(
  svc: SupabaseClient,
  userId: string,
  sessionId: string,
  opts: { afterId?: number; limit: number; latest?: boolean; skipDeltas?: boolean },
): Promise<TranscriptEventRow[]> {
  let q = svc.from('local_agent_event').select(EVENT_SELECT).eq('session_id', sessionId).eq('user_id', userId)
  // The compact view reads whole messages (`message` carries the text), not
  // the deltas that would otherwise fill its page.
  if (opts.skipDeltas) q = q.neq('kind', 'text')
  const afterId = Math.floor(Number(opts.afterId))
  if (Number.isFinite(afterId) && afterId > 0) q = q.gt('id', afterId)
  const newestFirst = !!opts.latest && !(afterId > 0)
  const { data, error } = await q.order('id', { ascending: !newestFirst }).limit(opts.limit)
  if (error) throw new Error(`local agent events read failed: ${error.message}`)
  const rows = (data ?? []) as TranscriptEventRow[]
  return newestFirst ? rows.reverse() : rows
}

/** The session and up to 500 raw events after `afterId`: GET /api/local-agent/sessions/[id]. */
export async function readEvents(
  svc: SupabaseClient,
  userId: string,
  sessionId: string,
  opts: { afterId?: number; limit?: number } = {},
): Promise<{ session: SessionRow; events: StoredEvent[]; lastId: number } | null> {
  const row = await loadSession(svc, userId, sessionId)
  if (!row) return null
  const events = await fetchEvents(svc, userId, sessionId, {
    afterId: opts.afterId,
    limit: clampLimit(opts.limit, EVENTS_PAGE_MAX),
  })
  const lastId = events.length > 0 ? events[events.length - 1].id : Math.max(0, Math.floor(Number(opts.afterId)) || 0)
  return {
    session: toSessionRow(row),
    events: events.map((e) => ({
      id: e.id,
      at: e.created_at,
      source: e.source,
      runId: e.run_id,
      seq: e.seq,
      kind: e.kind,
      payload: e.payload ?? {},
    })),
    lastId,
  }
}

/** Fold events into transcript items (pure; exported for tests). */
export function foldEvents(events: readonly TranscriptEventRow[], compact: boolean): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const signal = (text: string) => (compact ? cut(text, COMPACT_SIGNAL_MAX) : text)
  // The text item deltas append to, while nothing else came between.
  let openText: number | null = null
  // Deltas seen since the open text began (non-compact keeps each as its own item).
  let openDeltas = false

  for (const e of events) {
    const p = e.payload ?? {}
    const base = { id: e.id, at: e.created_at }
    switch (e.kind) {
      case 'inbound': {
        // Only the server writes a message to the agent; a device row of this
        // kind (which ingest refuses anyway) is never read as one.
        if (e.source !== 'server') break
        openText = null
        openDeltas = false
        const author = p.author === 'agent' ? 'agent' : 'person'
        const text = str(p.text)
        items.push({ ...base, kind: 'inbound', author, text: compact ? cut(text, COMPACT_TEXT_MAX) : text })
        break
      }
      case 'text': {
        const delta = str(p.delta)
        if (!delta) break
        if (compact && openText !== null) {
          const prev = items[openText]
          items[openText] = { ...prev, text: (prev.text ?? '') + delta }
        } else {
          items.push({ ...base, kind: 'text', text: delta })
          openText = items.length - 1
        }
        openDeltas = true
        break
      }
      case 'message': {
        const text = str(p.text)
        if (openDeltas) {
          // The deltas already hold it: compact takes the message's whole text.
          if (compact && openText !== null && text) items[openText] = { ...items[openText], text }
        } else if (text) {
          items.push({ ...base, kind: 'text', text })
        }
        openText = null
        openDeltas = false
        break
      }
      case 'tool': {
        openText = null
        openDeltas = false
        // A teammate tool: its server-written ask / report is the line.
        if (isMacTeammateTool(p.name)) break
        const input = str(p.input)
        items.push({
          ...base,
          kind: 'tool',
          tool: { name: str(p.name), input: compact ? cut(input, TOOL_TEXT_MAX) : input },
          ...({ callId: str(p.callId) } as object),
        } as TranscriptItem)
        break
      }
      case 'tool_result': {
        if (isMacTeammateTool(p.name)) break
        const output = str(p.output)
        const result = { ok: p.ok === true, output: compact ? cut(output, TOOL_TEXT_MAX) : output }
        const callId = str(p.callId)
        let found = false
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i] as TranscriptItem & { callId?: string }
          if (it.kind === 'tool' && it.callId === callId && it.tool && it.tool.ok === undefined) {
            items[i] = { ...it, tool: { ...it.tool, ...result } }
            found = true
            break
          }
        }
        if (!found) items.push({ ...base, kind: 'tool', tool: { name: str(p.name), input: '', ...result } })
        break
      }
      case 'report':
        items.push({ ...base, kind: 'report', text: signal(str(p.text)) })
        break
      case 'ask':
        items.push({ ...base, kind: 'ask', text: signal(str(p.question)) })
        break
      case 'finish':
        items.push({ ...base, kind: 'finish', text: signal(str(p.summary)) })
        break
      case 'error':
        items.push({ ...base, kind: 'error', text: signal(str(p.message)) })
        break
      case 'branch':
        items.push({
          ...base,
          kind: 'branch',
          branch: {
            name: str(p.branch),
            commit: str(p.commit),
            filesChanged: num(p.filesChanged),
            insertions: num(p.insertions),
            deletions: num(p.deletions),
          },
        })
        break
      case 'pull_request': {
        // The Mac pushed the branch and opened its pull request, or couldn't (C5).
        const text =
          p.ok === true && typeof p.url === 'string'
            ? `Pull request opened: ${p.url}`
            : p.pushed === true
              ? `The branch was pushed, but no pull request was opened: ${str(p.error) || 'unknown reason'}`
              : p.pushed === false
                ? `The push failed: ${str(p.error) || 'unknown reason'}`
                : `The push didn't finish: ${str(p.error) || 'unknown reason'}`
        items.push({ ...base, kind: 'pull_request', text: signal(text) })
        break
      }
      case 'status': {
        if (p.status !== 'running' && p.status !== 'starting') {
          openText = null
          openDeltas = false
        }
        const reason = typeof p.reason === 'string' && p.reason ? p.reason : undefined
        items.push({ ...base, kind: 'status', status: str(p.status), ...(reason ? { text: reason } : {}) })
        break
      }
      default:
        break
    }
  }

  // Strip the internal callId; compact keeps only the last status.
  let lastStatus = -1
  if (compact) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'status') {
        lastStatus = i
        break
      }
    }
  }
  const out: TranscriptItem[] = []
  items.forEach((it, i) => {
    if (compact && it.kind === 'status' && i !== lastStatus) return
    const { callId: _callId, ...rest } = it as TranscriptItem & { callId?: string }
    if (compact && rest.kind === 'text' && rest.text) rest.text = cut(rest.text, COMPACT_TEXT_MAX)
    out.push(rest)
  })
  return out
}

function itemChars(it: TranscriptItem): number {
  return (it.text?.length ?? 0) + (it.tool ? it.tool.name.length + it.tool.input.length + (it.tool.output?.length ?? 0) : 0) + 40
}

/** The newest items that fit `budget` characters, in order, and whether older ones were left out. */
export function withinBudget(items: readonly TranscriptItem[], budget = COMPACT_BUDGET): { items: TranscriptItem[]; truncated: boolean } {
  let used = 0
  let from = items.length
  while (from > 0) {
    const next = used + itemChars(items[from - 1])
    if (next > budget && from < items.length) break
    used = next
    from--
  }
  return { items: items.slice(from), truncated: from > 0 }
}

/**
 * The transcript as items. Without `afterId`, a compact read returns the
 * newest `limit` events' items (default 200), a full read the oldest page;
 * with `afterId`, the page after it. `lastId` is the last event id read (pass
 * it back as `afterId` to continue).
 */
export async function readTranscript(
  svc: SupabaseClient,
  userId: string,
  sessionId: string,
  opts: { afterId?: number; limit?: number; compact?: boolean } = {},
): Promise<{ session: SessionRow; items: TranscriptItem[]; lastId: number; truncated: boolean }> {
  const row = await loadSession(svc, userId, sessionId)
  if (!row) throw new LocalAgentError('not_found', 'Local agent not found')
  const compact = opts.compact ?? false
  const events = await fetchEvents(svc, userId, sessionId, {
    afterId: opts.afterId,
    limit: clampLimit(opts.limit, compact ? COMPACT_DEFAULT : EVENTS_PAGE_MAX),
    latest: compact,
    skipDeltas: compact,
  })
  const lastId = events.length > 0 ? events[events.length - 1].id : Math.max(0, Math.floor(Number(opts.afterId)) || 0)
  const folded = foldEvents(events, compact)
  if (!compact) return { session: toSessionRow(row), items: folded, lastId, truncated: false }
  // The compact view (read_local_agent) is bounded as a whole: the newest items win.
  const bounded = withinBudget(folded)
  return { session: toSessionRow(row), items: bounded.items, lastId, truncated: bounded.truncated }
}
