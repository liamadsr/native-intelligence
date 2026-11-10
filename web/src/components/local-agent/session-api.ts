/**
 * The Agents panel's calls to the person-side local-agent routes (contract
 * B), with the cookie session the app already has:
 *
 *   GET  /api/local-agent/sessions/[id]?afterId=…   {session, events, lastId}
 *                                                   (the session row, and the forward catch-up)
 *   POST /api/local-agent/sessions/[id]/messages     {text, policy, requestId} (author person;
 *                                                   a retried requestId sends once)
 *   POST /api/local-agent/sessions/[id]/stop
 *
 * the session's event pages read newest first (`fetchEventsBefore`: the
 * browser client, owner RLS select on local_agent_event, the same rows
 * realtime delivers, `source` included), and the mapping of the realtime rows
 * (raw local_agent_event / local_agent_session rows, snake_case) onto what
 * the panel holds. Pure except for `fetch` and the client, which a test
 * passes in.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

import type { LocalAgentPolicy } from '@/lib/tauri-bridge'
import type { LocalAgentStatus, SessionRow } from '@/lib/local-agent/store'
import type { StoredEventLike } from '@/lib/local-agent/transcript-view'

/** The route's page size (EVENTS_PAGE_MAX): a full page means there may be more. */
export const SESSION_PAGE_MAX = 500
/** A whole session is read in at most this many pages (10k events); the rest arrive as it streams. */
export const SESSION_PAGES_MAX = 20

/**
 * The session as the panel holds it. `startedBy` is optional in the
 * library's SessionRow; a session without it is read as the Native Intelligence agent's
 * (the tools start them).
 */
export type PanelSession = SessionRow & { startedBy?: 'agent' | 'person' }

export interface SessionPage {
  session: PanelSession
  events: StoredEventLike[]
  lastId: number
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const STATUSES: ReadonlySet<string> = new Set<LocalAgentStatus>([
  'queued',
  'starting',
  'running',
  'waiting',
  'cancelled',
  'failed',
  'interrupted',
  'expired',
])

function sessionUrl(sessionId: string, tail = ''): string {
  return `/api/local-agent/sessions/${encodeURIComponent(sessionId)}${tail}`
}

async function errorOf(res: Response, fallback: string): Promise<{ ok: false; status: number; message: string }> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  const message = typeof body?.error === 'string' && body.error ? body.error : fallback
  return { ok: false, status: res.status, message }
}

function isSession(v: unknown): v is PanelSession {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return typeof s.id === 'string' && typeof s.status === 'string' && STATUSES.has(s.status)
}

function eventOf(raw: unknown): StoredEventLike | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = Number(r.id)
  if (!Number.isSafeInteger(id) || id <= 0 || typeof r.kind !== 'string') return null
  const payload = r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload) ? (r.payload as Record<string, unknown>) : {}
  // The writer: the fold reads a message to the agent only from the server (S4).
  const source = r.source === 'server' || r.source === 'device' ? r.source : null
  // When it was written (a row's created_at, the route page's at): a question on the Mac times out.
  const at = typeof r.created_at === 'string' ? r.created_at : typeof r.at === 'string' ? r.at : null
  return { id, kind: r.kind, payload, source, ...(at ? { at } : {}) }
}

/** How many events a page read from the newest end holds. */
export const EVENTS_PAGE = 300

/**
 * The newest `limit` events below `beforeId` (null: the newest of all), in id
 * order, read with the browser client (owner RLS). `more`: the page came back
 * full, so older ones may be there.
 */
export async function fetchEventsBefore(
  client: Pick<SupabaseClient, 'from'>,
  sessionId: string,
  beforeId: number | null,
  limit = EVENTS_PAGE,
): Promise<ApiResult<{ events: StoredEventLike[]; more: boolean }>> {
  try {
    let q = client.from('local_agent_event').select('id, source, kind, payload').eq('session_id', sessionId)
    if (beforeId !== null) q = q.lt('id', beforeId)
    const { data, error } = await q.order('id', { ascending: false }).limit(limit)
    if (error) return { ok: false, status: 500, message: 'Could not load this local agent.' }
    const rows = (data ?? []) as unknown[]
    const events = rows.map(eventOf).filter((e): e is StoredEventLike => e !== null).reverse()
    return { ok: true, value: { events, more: rows.length >= limit } }
  } catch {
    return { ok: false, status: 0, message: 'Could not load this local agent.' }
  }
}

/** One page of the session's events after `afterId`. */
export async function fetchSessionPage(
  sessionId: string,
  afterId: number,
  fetchImpl: FetchLike = fetch,
): Promise<ApiResult<SessionPage>> {
  try {
    const qs = afterId > 0 ? `?afterId=${Math.floor(afterId)}` : ''
    const res = await fetchImpl(sessionUrl(sessionId, qs), { cache: 'no-store' })
    if (!res.ok) {
      return errorOf(res, res.status === 404 ? 'This local agent is no longer available.' : 'Could not load this local agent.')
    }
    const body = (await res.json().catch(() => null)) as { session?: unknown; events?: unknown; lastId?: unknown } | null
    if (!body || !isSession(body.session)) return { ok: false, status: 502, message: 'Could not load this local agent.' }
    const events = Array.isArray(body.events) ? body.events.map(eventOf).filter((e): e is StoredEventLike => e !== null) : []
    const lastId = Number(body.lastId)
    return {
      ok: true,
      value: {
        session: body.session,
        events,
        lastId: Number.isFinite(lastId) ? lastId : events.length > 0 ? events[events.length - 1].id : afterId,
      },
    }
  } catch {
    return { ok: false, status: 0, message: 'Could not load this local agent.' }
  }
}

/**
 * Everything after `afterId`, page by page while a page comes back full (at
 * most SESSION_PAGES_MAX pages), with the newest session row.
 */
export async function fetchSessionSince(
  sessionId: string,
  afterId: number,
  fetchImpl: FetchLike = fetch,
): Promise<ApiResult<SessionPage>> {
  let cursor = afterId
  let session: PanelSession | null = null
  const events: StoredEventLike[] = []
  for (let page = 0; page < SESSION_PAGES_MAX; page++) {
    const res = await fetchSessionPage(sessionId, cursor, fetchImpl)
    if (!res.ok) {
      // A later page failing keeps what the earlier ones read; the next catch-up continues.
      if (!session) return res
      break
    }
    session = res.value.session
    events.push(...res.value.events)
    const next = res.value.lastId
    if (res.value.events.length < SESSION_PAGE_MAX || !(next > cursor)) {
      cursor = Math.max(cursor, next)
      break
    }
    cursor = next
  }
  return { ok: true, value: { session: session!, events, lastId: cursor } }
}

/** The person's message (Steer or Queue). `requestId`: one per submit; a retry with it sends once. */
export async function postSessionMessage(
  sessionId: string,
  text: string,
  policy: LocalAgentPolicy,
  requestId: string,
  fetchImpl: FetchLike = fetch,
): Promise<ApiResult<{ messageId: string | null; requeued: boolean }>> {
  try {
    const res = await fetchImpl(sessionUrl(sessionId, '/messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, policy, requestId }),
    })
    if (!res.ok) return errorOf(res, 'Nothing was sent.')
    const body = (await res.json().catch(() => null)) as { messageId?: unknown; requeued?: unknown } | null
    return {
      ok: true,
      value: { messageId: typeof body?.messageId === 'string' ? body.messageId : null, requeued: body?.requeued === true },
    }
  } catch {
    return { ok: false, status: 0, message: 'Nothing was sent.' }
  }
}

/** Stop it: a queued one is cancelled at once, a live one stops on the Mac. */
export async function postSessionStop(sessionId: string, fetchImpl: FetchLike = fetch): Promise<ApiResult<PanelSession | null>> {
  try {
    const res = await fetchImpl(sessionUrl(sessionId, '/stop'), { method: 'POST' })
    if (!res.ok) return errorOf(res, 'Could not stop it.')
    const body = (await res.json().catch(() => null)) as { session?: unknown } | null
    return { ok: true, value: isSession(body?.session) ? body.session : null }
  } catch {
    return { ok: false, status: 0, message: 'Could not stop it.' }
  }
}

// ── Realtime rows ───────────────────────────────────────────────────────────

/** A realtime INSERT on local_agent_event for this session, as a stored event; null for another session's or a bad row. */
export function eventFromRow(row: Record<string, unknown>, sessionId: string): StoredEventLike | null {
  if (row.session_id !== undefined && row.session_id !== sessionId) return null
  return eventOf(row)
}

const nullable = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * A realtime UPDATE on local_agent_session (the raw row; the folder and
 * device names aren't in it, so they stay as held) over the session held.
 * Returns `prev` itself when the row says nothing new.
 */
export function sessionFromRow(prev: PanelSession, row: Record<string, unknown>): PanelSession {
  if (row.id !== prev.id || typeof row.status !== 'string' || !STATUSES.has(row.status)) return prev
  const lastSignal = row.last_signal === 'ask' || row.last_signal === 'finish' ? row.last_signal : null
  const mode = row.mode === 'edit' ? 'edit' : row.mode === 'read' ? 'read' : prev.mode
  const updatedAt = nullable(row.updated_at) ?? prev.updatedAt
  // An older row than the one held (a page read after this change landed).
  if (updatedAt && prev.updatedAt && Date.parse(updatedAt) < Date.parse(prev.updatedAt)) return prev
  const next: PanelSession = {
    ...prev,
    status: row.status as LocalAgentStatus,
    mode,
    lastSignal,
    lastSignalText: nullable(row.last_signal_text),
    branch: nullable(row.branch),
    commitSha: nullable(row.commit_sha),
    error: nullable(row.error),
    endedAt: nullable(row.ended_at),
    updatedAt,
    trackedJobId: nullable(row.current_tracked_job_id) ?? nullable(row.tracked_job_id) ?? prev.trackedJobId,
    ...(row.started_by === 'agent' || row.started_by === 'person' ? { startedBy: row.started_by } : {}),
    // Migration 418: absent from a row before it (keep what's held).
    ...('pr_url' in row ? { prUrl: nullable(row.pr_url) } : {}),
    ...(typeof row.local_model === 'boolean' ? { localModel: row.local_model } : {}),
  }
  const same =
    next.status === prev.status &&
    next.mode === prev.mode &&
    next.lastSignal === prev.lastSignal &&
    next.lastSignalText === prev.lastSignalText &&
    next.branch === prev.branch &&
    next.commitSha === prev.commitSha &&
    next.error === prev.error &&
    next.endedAt === prev.endedAt &&
    next.updatedAt === prev.updatedAt &&
    next.trackedJobId === prev.trackedJobId &&
    next.startedBy === prev.startedBy &&
    next.prUrl === prev.prUrl &&
    next.localModel === prev.localModel
  return same ? prev : next
}
