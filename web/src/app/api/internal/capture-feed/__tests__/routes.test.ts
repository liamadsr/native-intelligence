/**
 * The capture feed's routes and the call recorder's work route
 * (src/app/api/internal/capture-feed/*, team-call-recorder/work): nothing
 * without the feed's secret (404 while the feed is off, 401 without it);
 * each request handed to its one function of 588 as it should be; the
 * answers a producer acts on (409 once the capture is finished, 503 to send
 * again, 'not_wanted' when this server takes no feed of that kind); the
 * hook where phase 2's live turns attach runs once per batch the capture
 * took; and the recorder's tokens: one room, hidden, a recorder, subscribe
 * only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TokenVerifier } from 'livekit-server-sdk'
import { memoryDb } from '@/test/memory-db'
import { KEY, LIVEKIT_ENV, SECRET } from '@/lib/team-calls/__tests__/signing'
import { onFeedAppended } from '@/lib/capture-feed/hooks'

const CALL = '77777777-7777-4777-8777-777777777777'
const CH = '55555555-5555-4555-8555-555555555555'
const SESSION = '99999999-9999-4999-8999-999999999999'
const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const MEMBER = '33333333-3333-4333-8333-333333333333'
const FEED = 'capture-feed-secret-of-its-own-0123456789'
const producer = { kind: 'livekit_recorder', id: 'recorder' }
const GUEST = '44444444-4444-4444-8444-444444444444'

const h = vi.hoisted(() => ({
  svc: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  answers: {} as Record<string, { data: unknown; error: unknown }>,
  afters: [] as Array<() => Promise<unknown>>,
  roomPeople: (async () => 0) as (room: string) => Promise<number>,
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.svc }))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => void h.afters.push(task),
}))
vi.mock('@/lib/team-calls/livekit', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/livekit')>()),
  teamCallRoomPeople: (_config: unknown, room: string) => h.roomPeople(room),
}))

import { POST as start } from '../start/route'
import { POST as heartbeat } from '../heartbeat/route'
import { POST as segments } from '../sessions/[id]/segments/route'
import { POST as roster } from '../sessions/[id]/roster/route'
import { POST as end } from '../sessions/[id]/end/route'
import { POST as work } from '../../team-call-recorder/work/route'

let tables: Record<string, Array<Record<string, unknown>>>

beforeEach(() => {
  vi.stubEnv('CAPTURE_FEED_SECRET', FEED)
  vi.stubEnv('TEAM_CALL_RECORDER', 'on')
  for (const [k, v] of Object.entries(LIVEKIT_ENV)) vi.stubEnv(k, v)
  tables = {
    team_call: [{ id: CALL, channel_id: CH, workspace_id: 'ws', started_by: MEMBER, notes_by: MEMBER }],
    team_chat_channel: [{ id: CH, kind: 'channel', name: 'launch', dm_key: null }],
  }
  h.rpcs = []
  h.answers = {}
  const db = memoryDb(tables) as unknown as { rpc: unknown }
  db.rpc = async (name: string, args: Record<string, unknown>) => {
    h.rpcs.push([name, args])
    return h.answers[name] ?? { data: null, error: { message: `no answer for ${name}` } }
  }
  h.svc = db as unknown as SupabaseClient
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const post = (body: unknown, auth = `Bearer ${FEED}`) =>
  new Request('http://localhost/api/internal/capture-feed/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: auth } })
const params = (id = SESSION) => ({ params: Promise.resolve({ id }) })
const seg = { key: 'p.TR_1.1', speaker: MEMBER, text: 'Shall we start?', startMs: 1200, endMs: 1800 }

describe('the secret first', () => {
  it('404 while the feed is off here, 401 without its secret, 400 for a body that is not the contract', async () => {
    vi.stubEnv('CAPTURE_FEED_SECRET', '')
    expect((await start(post({ source: { kind: 'team_call', ref: CALL }, producer }))).status).toBe(404)
    vi.stubEnv('CAPTURE_FEED_SECRET', FEED)
    expect((await start(post({ source: { kind: 'team_call', ref: CALL }, producer }, 'Bearer nope'))).status).toBe(401)
    expect((await segments(post({ producer, segments: [] }, ''), params())).status).toBe(401)
    expect((await start(post({ source: { kind: 'team_call' }, producer }))).status).toBe(400)
    expect(h.rpcs).toEqual([])
  })

  it('413 for a body over its size in bytes, said or not: fewer characters than the cap, more bytes', async () => {
    // 600,000 characters of two bytes each: 1.2 MB, over the 1 MB cap, though under it in UTF-16 units.
    const big = JSON.stringify({ producer, segments: [{ ...seg, text: 'é'.repeat(600_000) }] })
    expect(big.length).toBeLessThan(1024 * 1024)
    expect((await segments(post(JSON.parse(big)), params())).status).toBe(413)
    // No Content-Length (a stream): read no further than the cap.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big))
        c.close()
      },
    })
    const streamed = new Request('http://localhost/api/internal/capture-feed/x', {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${FEED}` },
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    expect((await segments(streamed, params())).status).toBe(413)
    // Said to be too large: refused before it is read.
    const said = new Request('http://localhost/api/internal/capture-feed/x', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${FEED}`, 'content-length': String(2 * 1024 * 1024) },
    })
    expect((await segments(said, params())).status).toBe(413)
    expect(h.rpcs).toEqual([])
  })
})

describe('start', () => {
  it('the session for the call’s round, with the capture’s title from its conversation, and the guests it may hear', async () => {
    h.answers.capture_feed_start = { data: [{ outcome: 'started', session_id: SESSION, capture_id: CAPTURE, started_at: '2026-11-11T10:00:00+00:00', round: 2, guests: [GUEST] }], error: null }
    const res = await start(post({ source: { kind: 'team_call', ref: CALL }, producer }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'started', session: { id: SESSION, startedAt: '2026-11-11T10:00:00.000Z', round: 2, captureId: CAPTURE, guests: [GUEST], audio: false } })
    expect(h.rpcs).toEqual([
      ['capture_feed_start', { p_source_kind: 'team_call', p_source_ref: CALL, p_producer_kind: 'livekit_recorder', p_producer_id: 'recorder', p_capture_title: 'Call in #launch' }],
    ])
  })

  it('busy or not wanted: no session; the recorder switch off: not wanted, nothing asked', async () => {
    h.answers.capture_feed_start = { data: [{ outcome: 'busy', session_id: SESSION, capture_id: CAPTURE, started_at: '2026-11-11T10:00:00Z', round: 1 }], error: null }
    expect(await (await start(post({ source: { kind: 'team_call', ref: CALL }, producer }))).json()).toEqual({ outcome: 'busy', session: null })
    vi.stubEnv('TEAM_CALL_RECORDER', '')
    h.rpcs = []
    expect(await (await start(post({ source: { kind: 'team_call', ref: CALL }, producer }))).json()).toEqual({ outcome: 'not_wanted', session: null })
    expect(h.rpcs).toEqual([])
  })

  it('a failed write: 503, send it again', async () => {
    h.answers.capture_feed_start = { data: null, error: { message: 'lock timeout' } }
    expect((await start(post({ source: { kind: 'team_call', ref: CALL }, producer }))).status).toBe(503)
  })
})

describe('segments', () => {
  it('handed over as 588 reads them; the hook runs once for the batch the capture took', async () => {
    const seen: unknown[] = []
    const off = onFeedAppended(async (_svc, appended) => {
      seen.push(appended)
    })
    h.answers.capture_feed_append = { data: [{ outcome: 'applied', accepted: 1, duplicate: 0, dropped: 0, transcript_length: 30, capture_id: CAPTURE }], error: null }
    const res = await segments(post({ producer, segments: [seg] }), params(SESSION.toUpperCase()))
    expect(res.status).toBe(200)
    expect(h.rpcs).toEqual([
      ['capture_feed_append', { p_session: SESSION, p_producer_id: 'recorder', p_segments: [{ key: 'p.TR_1.1', speaker: MEMBER, text: 'Shall we start?', start_ms: 1200, end_ms: 1800 }] }],
    ])
    expect(seen).toEqual([{ sessionId: SESSION, captureId: CAPTURE, accepted: 1, transcriptLength: 30 }])
    // A retry of the same batch: all duplicates, the hook has nothing to do.
    h.answers.capture_feed_append = { data: [{ outcome: 'applied', accepted: 0, duplicate: 1, dropped: 0, transcript_length: 30, capture_id: CAPTURE }], error: null }
    expect((await (await segments(post({ producer, segments: [seg] }), params())).json()).duplicate).toBe(1)
    expect(seen).toHaveLength(1)
    off()
  })

  it('409 once the capture is finished or the session another producer’s; 404 for none; 503 to send again', async () => {
    h.answers.capture_feed_append = { data: [{ outcome: 'locked', accepted: 0, duplicate: 0, dropped: 1, transcript_length: 30, capture_id: CAPTURE }], error: null }
    const locked = await segments(post({ producer, segments: [seg] }), params())
    expect(locked.status).toBe(409)
    expect((await locked.json()).code).toBe('FEED_LOCKED')
    h.answers.capture_feed_append = { data: [{ outcome: 'taken', accepted: 0, duplicate: 0, dropped: 1, transcript_length: null, capture_id: null }], error: null }
    expect((await (await segments(post({ producer, segments: [seg] }), params())).json()).code).toBe('FEED_TAKEN')
    h.answers.capture_feed_append = { data: [{ outcome: 'unknown', accepted: 0, duplicate: 0, dropped: 1, transcript_length: null, capture_id: null }], error: null }
    expect((await segments(post({ producer, segments: [seg] }), params())).status).toBe(404)
    h.answers.capture_feed_append = { data: null, error: { message: 'capture feed: the transcript did not take the append (conflict)' } }
    expect((await segments(post({ producer, segments: [seg] }), params())).status).toBe(503)
    expect((await segments(post({ producer, segments: [seg] }), params('not-a-uuid'))).status).toBe(404)
  })
})

describe('roster, heartbeat, end', () => {
  it('roster events with their identity, each outcome by key', async () => {
    h.answers.capture_feed_roster = { data: [{ key: 'r1', outcome: 'applied' }, { key: 'r2', outcome: 'refused' }], error: null }
    const res = await roster(
      post({ producer, events: [{ key: 'r1', speaker: MEMBER, kind: 'joined', atMs: 0, identity: { memberId: MEMBER } }, { key: 'r2', speaker: 'guest-x', kind: 'joined', atMs: 5, identity: { name: 'Someone' } }] }),
      params(),
    )
    expect(await res.json()).toEqual({ results: [{ key: 'r1', outcome: 'applied' }, { key: 'r2', outcome: 'refused' }] })
    expect(h.rpcs[0][1].p_events).toEqual([
      { key: 'r1', speaker: MEMBER, kind: 'joined', at_ms: 0, identity: { member_id: MEMBER } },
      { key: 'r2', speaker: 'guest-x', kind: 'joined', at_ms: 5, identity: { name: 'Someone' } },
    ])
    h.answers.capture_feed_roster = { data: [{ key: 'r1', outcome: 'locked' }], error: null }
    expect((await roster(post({ producer, events: [{ key: 'r1', speaker: MEMBER, kind: 'left', atMs: 9 }] }), params())).status).toBe(409)
  })

  it('a heartbeat says which to keep and which to stop, and whom a kept one may hear', async () => {
    const OTHER = '88888888-8888-4888-8888-888888888888'
    h.answers.capture_feed_heartbeat = {
      data: [
        { session_id: SESSION, keep: false, reason: 'notes_off', guests: null },
        { session_id: OTHER, keep: true, reason: null, guests: [GUEST] },
      ],
      error: null,
    }
    expect(await (await heartbeat(post({ producer, sessions: [SESSION, OTHER] }))).json()).toEqual({
      sessions: [
        { id: SESSION, keep: false, reason: 'notes_off', guests: [] },
        { id: OTHER, keep: true, reason: null, guests: [GUEST] },
      ],
    })
    expect(h.rpcs[0]).toEqual(['capture_feed_heartbeat', { p_producer_id: 'recorder', p_sessions: [SESSION, OTHER] }])
  })

  it('the recorder switch turned off here: every session is told to stop (feed_off), nothing asked of the database', async () => {
    vi.stubEnv('TEAM_CALL_RECORDER', '')
    expect(await (await heartbeat(post({ producer, sessions: [SESSION] }))).json()).toEqual({ sessions: [{ id: SESSION, keep: false, reason: 'feed_off', guests: [] }] })
    expect(h.rpcs).toEqual([])
  })

  it('a producer id that cannot name a LiveKit identity is refused', async () => {
    expect((await heartbeat(post({ producer: { kind: 'livekit_recorder', id: 'two words' }, sessions: [SESSION] }))).status).toBe(400)
    expect((await heartbeat(post({ producer: { kind: 'livekit_recorder', id: 'x'.repeat(41) }, sessions: [SESSION] }))).status).toBe(400)
    expect(h.rpcs).toEqual([])
  })

  it('end, by the producer that holds it', async () => {
    h.answers.capture_feed_end = { data: true, error: null }
    expect(await (await end(post({ producer, reason: 'told' }), params())).json()).toEqual({ ended: true })
    expect(h.rpcs[0]).toEqual(['capture_feed_end', { p_session: SESSION, p_producer_id: 'recorder', p_reason: 'told' }])
  })
})

describe('the recorder’s work', () => {
  it('404 unless the recorder is on here', async () => {
    vi.stubEnv('TEAM_CALL_RECORDER', '')
    expect((await work(post({ producer, running: [], capacity: 3 }))).status).toBe(404)
    vi.stubEnv('TEAM_CALL_RECORDER', 'on')
    vi.stubEnv('LIVEKIT_URL', '')
    expect((await work(post({ producer, running: [], capacity: 3 }))).status).toBe(404)
  })

  it('the calls nobody feeds, each with a token for its room alone: hidden, a recorder, subscribe only', async () => {
    tables.team_call[0].peak_participants = 2
    h.answers.team_call_recorder_work = { data: [{ call_id: CALL, room: `tc-${CALL}`, round: 1 }], error: null }
    const res = await work(post({ producer, running: [SESSION], capacity: 3 }))
    const body = (await res.json()) as { jobs: Array<{ callId: string; room: string; round: number; token: string }>; pollMs: number }
    // 589 filters lone calls before its limit: exactly what fits is asked for.
    expect(h.rpcs.find((r) => r[0] === 'team_call_recorder_work')).toEqual(['team_call_recorder_work', { p_producer_id: 'recorder', p_running: [SESSION], max_jobs: 3 }])
    expect(body.jobs.map(({ token: _t, ...j }) => j)).toEqual([{ callId: CALL, room: `tc-${CALL}`, round: 1 }])
    const claims = await new TokenVerifier(KEY, SECRET).verify(body.jobs[0].token)
    // One identity per producer (notes-recorder-<id>): what 588 puts on the eject outbox for it.
    expect(claims.sub).toBe('notes-recorder-recorder')
    expect(claims.video).toMatchObject({ room: `tc-${CALL}`, roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false, hidden: true, recorder: true, roomAdmin: false })
    expect(body.pollMs).toBeGreaterThan(0)
    // No room to take more: nothing is asked.
    h.rpcs = []
    expect((await (await work(post({ producer, running: [], capacity: 0 }))).json()).jobs).toEqual([])
    expect(h.rpcs).toEqual([])
  })

  it('the answer never waits on LiveKit: lone calls are counted after it, and a LiveKit that never answers changes nothing', async () => {
    const LONE = '66666666-6666-4666-8666-666666666666'
    tables.team_call.push({ id: LONE, room: `tc-${LONE}`, channel_id: CH, workspace_id: 'ws', status: 'live', notes: true, peak_participants: 1, started_at: new Date(Date.now() - 60_000).toISOString() })
    tables.team_call[0].peak_participants = 2
    let asked = 0
    h.roomPeople = () => (asked++, new Promise<number>(() => undefined))
    h.afters = []
    h.answers.team_call_recorder_work = { data: [{ call_id: CALL, room: `tc-${CALL}`, round: 1 }], error: null }
    const res = await work(post({ producer, running: [], capacity: 3 }))
    // Answered before LiveKit was asked at all: the look runs after the answer.
    expect(res.status).toBe(200)
    expect(((await res.json()) as { jobs: Array<{ callId: string }> }).jobs.map((j) => j.callId)).toEqual([CALL])
    expect(asked).toBe(0)
    expect(h.afters).toHaveLength(1)
    // The look itself gives up on a LiveKit that hangs (its 2 s deadline): it settles, nothing raised.
    vi.useFakeTimers()
    try {
      const done = h.afters[0]()
      await vi.advanceTimersByTimeAsync(2_100)
      expect(await done).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    expect(asked).toBe(1)
    expect(h.rpcs.some((r) => r[0] === 'team_call_people_seen')).toBe(false)
  })

  it('nothing is heard until two people were in the call at once: a ringing or missed DM, one person waiting, no job (no socket, no capture); from then on, to its end', async () => {
    const RINGING = '66666666-6666-4666-8666-666666666666'
    const DROPPED = '44444444-4444-4444-8444-444444444444'
    tables.team_call.push(
      { id: RINGING, channel_id: CH, workspace_id: 'ws', participant_count: 1, peak_participants: 1 },
      // Two were in it, one left: still heard.
      { id: DROPPED, channel_id: CH, workspace_id: 'ws', participant_count: 1, peak_participants: 2 },
    )
    tables.team_call[0].peak_participants = 0
    h.answers.team_call_recorder_work = {
      data: [
        { call_id: CALL, room: `tc-${CALL}`, round: 1 },
        { call_id: RINGING, room: `tc-${RINGING}`, round: 1 },
        { call_id: DROPPED, room: `tc-${DROPPED}`, round: 1 },
      ],
      error: null,
    }
    const jobs = ((await (await work(post({ producer, running: [], capacity: 3 }))).json()) as { jobs: Array<{ callId: string }> }).jobs
    expect(jobs.map((j) => j.callId)).toEqual([DROPPED])
    // The second person joins (575 raises the peak): heard from the next ask.
    tables.team_call.find((c) => c.id === RINGING)!.peak_participants = 2
    const next = ((await (await work(post({ producer, running: [DROPPED], capacity: 1 }))).json()) as { jobs: Array<{ callId: string }> }).jobs
    expect(next.map((j) => j.callId)).toEqual([RINGING])
  })
})
