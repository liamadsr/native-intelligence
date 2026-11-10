/**
 * The Agents panel's calls to the person-side local-agent routes (contract B
 * shapes, fetch faked) and the realtime row mapping.
 *
 * Locked in: a whole session is read page by page while a page comes back
 * full (and stops at the cap); a later page failing keeps the earlier ones; a
 * message names its policy and its request id; Stop posts to the session's
 * stop route; errors carry the route's words; every event keeps its
 * `source` (the route's, a page read's, realtime's: the fold reads a
 * message to the agent only from the server); a page read goes newest first
 * under owner RLS; realtime rows of another session are dropped, and a
 * session row that says nothing new (or is older) keeps the object held.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SessionRow } from '@/lib/local-agent/store'
import {
  eventFromRow,
  EVENTS_PAGE,
  fetchEventsBefore,
  fetchSessionSince,
  postSessionMessage,
  postSessionStop,
  SESSION_PAGE_MAX,
  SESSION_PAGES_MAX,
  sessionFromRow,
  type PanelSession,
} from '../session-api'

const SID = '11111111-2222-4333-8444-555555555555'

const SESSION: SessionRow = {
  id: SID,
  folderId: 'f1',
  folderLabel: 'native-intelligence',
  deviceId: 'd1',
  deviceName: 'Liam’s MacBook',
  conversationId: null,
  mode: 'read',
  request: 'Take a look at this repository',
  status: 'running',
  lastSignal: null,
  lastSignalText: null,
  branch: null,
  commitSha: null,
  error: null,
  trackedJobId: 'job-1',
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:05.000Z',
  endedAt: null,
  lastDeviceSeq: null,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function events(from: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: from + i,
    at: '2026-10-20T10:00:00.000Z',
    source: 'device',
    runId: 'r1',
    seq: i,
    kind: 'text',
    payload: { kind: 'text', delta: 'x' },
  }))
}

describe('fetchSessionSince', () => {
  it('reads page by page while a page is full, from afterId', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const after = Number(new URL(url, 'http://x').searchParams.get('afterId') ?? 0)
      if (after === 0) return json({ session: SESSION, events: events(1, SESSION_PAGE_MAX), lastId: SESSION_PAGE_MAX })
      return json({ session: { ...SESSION, status: 'waiting' }, events: events(after + 1, 3), lastId: after + 3 })
    })
    const res = await fetchSessionSince(SID, 0, fetchImpl)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(fetchImpl.mock.calls.map(([u]) => u)).toEqual([
      `/api/local-agent/sessions/${SID}`,
      `/api/local-agent/sessions/${SID}?afterId=${SESSION_PAGE_MAX}`,
    ])
    expect(res.value.events).toHaveLength(SESSION_PAGE_MAX + 3)
    expect(res.value.lastId).toBe(SESSION_PAGE_MAX + 3)
    // The newest page's session.
    expect(res.value.session.status).toBe('waiting')
  })

  it('stops at the page cap', async () => {
    let next = 1
    const fetchImpl = vi.fn(async () => {
      const page = events(next, SESSION_PAGE_MAX)
      next += SESSION_PAGE_MAX
      return json({ session: SESSION, events: page, lastId: next - 1 })
    })
    const res = await fetchSessionSince(SID, 0, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(SESSION_PAGES_MAX)
    expect(res.ok && res.value.lastId).toBe(SESSION_PAGES_MAX * SESSION_PAGE_MAX)
  })

  it('a first page refused is the error, in the route’s words; a later one keeps what was read', async () => {
    const gone = await fetchSessionSince(SID, 0, async () => json({ error: 'Local agent not found' }, 404))
    expect(gone).toEqual({ ok: false, status: 404, message: 'Local agent not found' })

    let call = 0
    const partial = await fetchSessionSince(SID, 0, async () => {
      call++
      return call === 1 ? json({ session: SESSION, events: events(1, SESSION_PAGE_MAX), lastId: SESSION_PAGE_MAX }) : json({}, 500)
    })
    expect(partial.ok && partial.value.events.length).toBe(SESSION_PAGE_MAX)
    expect(partial.ok && partial.value.lastId).toBe(SESSION_PAGE_MAX)
  })

  it('keeps each event’s source (the S4 fold needs it)', async () => {
    const res = await fetchSessionSince(SID, 0, async () =>
      json({
        session: SESSION,
        events: [
          { id: 1, source: 'server', kind: 'inbound', payload: { author: 'person', text: 'hi' } },
          { id: 2, source: 'device', kind: 'text', payload: { delta: 'x' } },
          { id: 3, source: 'elsewhere', kind: 'text', payload: { delta: 'y' } },
        ],
        lastId: 3,
      }),
    )
    expect(res.ok && res.value.events.map((e) => e.source)).toEqual(['server', 'device', null])
  })

  it('drops malformed events and refuses a body without a session', async () => {
    const res = await fetchSessionSince(SID, 4, async () =>
      json({ session: SESSION, events: [{ id: 'x', kind: 'text' }, { id: 5 }, { id: 6, kind: 'text', payload: [1] }], lastId: 6 }),
    )
    expect(res.ok && res.value.events).toEqual([{ id: 6, kind: 'text', payload: {}, source: null }])
    const bad = await fetchSessionSince(SID, 0, async () => json({ events: [] }))
    expect(bad.ok).toBe(false)
  })

  it('a network failure is a quiet error', async () => {
    const res = await fetchSessionSince(SID, 0, async () => {
      throw new Error('offline')
    })
    expect(res).toMatchObject({ ok: false, status: 0 })
  })
})

describe('postSessionMessage / postSessionStop', () => {
  it('posts the text, its policy and its request id as the person', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json({ messageId: 'm1', requeued: true }))
    const res = await postSessionMessage(SID, 'also check auth', 'queue', 'req-1', fetchImpl)
    expect(res).toEqual({ ok: true, value: { messageId: 'm1', requeued: true } })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`/api/local-agent/sessions/${SID}/messages`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'also check auth', policy: 'queue', requestId: 'req-1' })
  })

  it('a refused message says why', async () => {
    const res = await postSessionMessage(SID, 'x', 'steer', 'req-2', async () => json({ error: 'This local agent has been stopped; start a new one' }, 409))
    expect(res).toEqual({ ok: false, status: 409, message: 'This local agent has been stopped; start a new one' })
  })

  it('Stop posts to the session’s stop route and hands back its session', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json({ session: { ...SESSION, status: 'cancelled' } }))
    const res = await postSessionStop(SID, fetchImpl)
    expect(fetchImpl.mock.calls[0][0]).toBe(`/api/local-agent/sessions/${SID}/stop`)
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST')
    expect(res.ok && res.value?.status).toBe('cancelled')
  })
})

/** A fake browser client: records the query and answers with `rows` (newest first, as asked). */
function fakeClient(rows: unknown[], error: { message: string } | null = null) {
  const calls: Array<[string, ...unknown[]]> = []
  const q = {
    select: (...a: unknown[]) => (calls.push(['select', ...a]), q),
    eq: (...a: unknown[]) => (calls.push(['eq', ...a]), q),
    lt: (...a: unknown[]) => (calls.push(['lt', ...a]), q),
    order: (...a: unknown[]) => (calls.push(['order', ...a]), q),
    limit: async (...a: unknown[]) => (calls.push(['limit', ...a]), { data: rows, error }),
  }
  return { client: { from: (table: string) => (calls.push(['from', table]), q) } as never, calls }
}

describe('fetchEventsBefore (a page read, newest first, owner RLS)', () => {
  it('the newest page: this session’s events, newest first, handed back in id order with their source', async () => {
    const { client, calls } = fakeClient([
      { id: 12, source: 'device', kind: 'text', payload: { delta: 'b' } },
      { id: 11, source: 'server', kind: 'inbound', payload: { author: 'person', text: 'hi' } },
    ])
    const res = await fetchEventsBefore(client, SID, null)
    expect(calls).toEqual([
      ['from', 'local_agent_event'],
      ['select', 'id, source, kind, payload'],
      ['eq', 'session_id', SID],
      ['order', 'id', { ascending: false }],
      ['limit', EVENTS_PAGE],
    ])
    expect(res).toEqual({
      ok: true,
      value: {
        events: [
          { id: 11, source: 'server', kind: 'inbound', payload: { author: 'person', text: 'hi' } },
          { id: 12, source: 'device', kind: 'text', payload: { delta: 'b' } },
        ],
        more: false,
      },
    })
  })

  it('an older page reads below the oldest held; a full page says there may be more; an error is quiet', async () => {
    const { client, calls } = fakeClient([{ id: 4, source: 'device', kind: 'text', payload: {} }, { id: 3, source: 'device', kind: 'text', payload: {} }])
    const res = await fetchEventsBefore(client, SID, 5, 2)
    expect(calls).toContainEqual(['lt', 'id', 5])
    expect(res.ok && res.value.more).toBe(true)
    const failed = await fetchEventsBefore(fakeClient([], { message: 'rls' }).client, SID, null)
    expect(failed.ok).toBe(false)
  })
})

describe('realtime rows', () => {
  it('an event row of this session maps, with its source; another session’s is dropped', () => {
    expect(eventFromRow({ id: 9, session_id: SID, source: 'server', kind: 'ask', payload: { question: 'Which?' } }, SID)).toEqual({
      id: 9,
      kind: 'ask',
      payload: { question: 'Which?' },
      source: 'server',
    })
    expect(eventFromRow({ id: 9, session_id: 'other', kind: 'ask', payload: {} }, SID)).toBeNull()
    expect(eventFromRow({ id: 0, session_id: SID, kind: 'ask' }, SID)).toBeNull()
  })

  it('a session row patches what it carries and keeps the names it doesn’t', () => {
    const held: PanelSession = SESSION
    const next = sessionFromRow(held, {
      id: SID,
      status: 'waiting',
      mode: 'edit',
      last_signal: 'ask',
      last_signal_text: 'Which branch?',
      branch: null,
      commit_sha: null,
      error: null,
      ended_at: null,
      updated_at: '2026-10-20T10:01:00.000Z',
      current_tracked_job_id: 'job-2',
      started_by: 'person',
    })
    expect(next).toMatchObject({
      status: 'waiting',
      mode: 'edit',
      lastSignal: 'ask',
      lastSignalText: 'Which branch?',
      trackedJobId: 'job-2',
      startedBy: 'person',
      folderLabel: 'native-intelligence',
      deviceName: 'Liam’s MacBook',
    })
  })

  it('takes the pull request and the model from a row that carries them (migration 418), and keeps them from one that doesn’t', () => {
    const row = { id: SID, status: 'waiting', mode: 'edit', updated_at: '2026-10-20T10:02:00.000Z', pr_url: 'https://github.com/o/r/pull/3', local_model: true }
    const next = sessionFromRow(SESSION, row)
    expect(next).toMatchObject({ prUrl: 'https://github.com/o/r/pull/3', localModel: true })
    const older = { id: SID, status: 'waiting', mode: 'edit', updated_at: '2026-10-20T10:03:00.000Z' }
    expect(sessionFromRow(next, older)).toMatchObject({ prUrl: 'https://github.com/o/r/pull/3', localModel: true })
  })

  it('keeps the held object for an unchanged, older, foreign or malformed row', () => {
    const same = {
      id: SID,
      status: 'running',
      mode: 'read',
      last_signal: null,
      last_signal_text: null,
      branch: null,
      commit_sha: null,
      error: null,
      ended_at: null,
      updated_at: SESSION.updatedAt,
      current_tracked_job_id: 'job-1',
    }
    expect(sessionFromRow(SESSION, same)).toBe(SESSION)
    expect(sessionFromRow(SESSION, { ...same, status: 'waiting', updated_at: '2026-10-20T09:00:00.000Z' })).toBe(SESSION)
    expect(sessionFromRow(SESSION, { ...same, id: 'other', status: 'waiting' })).toBe(SESSION)
    expect(sessionFromRow(SESSION, { ...same, status: 'exploded' })).toBe(SESSION)
  })
})
