/**
 * The notes and recording routes (phase 6). Absent ("not available") without
 * the egress service, notes without a Deepgram key, recording without
 * TEAM_CALL_RECORDING=on; who may (someone in the call: 567 decides, the
 * route says so); notes on starts every microphone in the room and off stops
 * them, only when it changed; the recording's cap answers "another
 * recording is running"; a recording's link is made only for someone who may
 * read the call (an outsider's read finds no call: 404) and only once saved,
 * as them; a call that ended, or whose conversation was archived, takes no
 * change. A new call starts with its notes on only when asked and offered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ME = '33333333-3333-4333-8333-333333333333'
const CH = '55555555-5555-4555-8555-555555555555'
const CALL = '77777777-7777-4777-8777-777777777777'
const MSG = '88888888-8888-4888-8888-888888888888'
const REC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  db: null as unknown as SupabaseClient,
  svc: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  svcRpcs: [] as Array<[string, Record<string, unknown>]>,
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
  port: { started: [] as string[], stopped: [] as string[], mics: [] as Array<{ identity: string; trackSid: string }> },
  signed: [] as Array<[string, number]>,
  events: [] as Array<{ name: string; id?: string; data: unknown }>,
  allowed: [] as Array<[string, string]>,
  notConnected: false,
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/api-auth', () => ({ requireUser: async () => ({ supabase: h.db, user: { id: USER, user_metadata: {} } }) }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.svc }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: async (events: unknown) => {
      for (const e of (Array.isArray(events) ? events : [events]) as Array<{ name: string; id?: string; data: unknown }>) h.events.push(e)
      return { ids: [] }
    },
  },
}))
vi.mock('@/lib/team-calls/egress', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/egress')>()),
  liveKitEgress: () => ({
    startTrack: async (_room: string, track: string) => {
      h.port.started.push(track)
      return { egressId: `EG_${track}` }
    },
    startRecording: async () => {
      h.port.started.push('composite')
      return { egressId: 'EG_rec' }
    },
    stop: async (id: string) => {
      h.port.stopped.push(id)
    },
    list: async () => [],
    microphones: async () => h.port.mics,
  }),
}))
vi.mock('@/lib/team-calls/livekit', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/livekit')>()),
  createTeamCallRoom: async () => {},
  openTeamCallRooms: async (_c: unknown, names: string[]) => new Set(names),
  allowTeamCallPublish: async (_c: unknown, room: string, identity: string) => {
    if (h.notConnected) throw new Error('participant not found')
    h.allowed.push([room, identity])
  },
}))

import { POST as notes } from '../[id]/notes/route'
import { GET as recordingLink, POST as recording } from '../[id]/recording/route'
import { POST as startCall } from '../route'
import { POST as token } from '../[id]/token/route'
import { POST as notice } from '../[id]/notice/route'
import { TokenVerifier } from 'livekit-server-sdk'
import { KEY, SECRET } from '@/lib/team-calls/__tests__/signing'

let tables: Record<string, Array<Record<string, unknown>>>
let svcTables: Record<string, Array<Record<string, unknown>>>

const call = (over: Record<string, unknown> = {}) => ({
  id: CALL,
  workspace_id: WS,
  channel_id: CH,
  message_id: MSG,
  started_by: ME,
  room: `tc-${CALL}`,
  status: 'live',
  started_at: new Date().toISOString(),
  ringing: [],
  declined: [],
  notes: false,
  notes_by: null,
  notes_state: 'none',
  capture_id: null,
  recording: 'off',
  recording_by: null,
  ...over,
})

beforeEach(() => {
  Object.assign(process.env, LIVEKIT_ENV, { LIVEKIT_EGRESS: 'on', DEEPGRAM_API_KEY: 'dg-test', TEAM_CALL_RECORDING: 'on' })
  tables = {
    member: [{ id: ME, user_id: USER, workspace_id: WS, display_name: 'Ana Ruiz' }],
    team_chat_channel: [{ id: CH, workspace_id: WS, kind: 'channel', name: 'launch', dm_key: null, archived_at: null }],
    team_call: [call()],
    team_call_participant: [{ call_id: CALL, member_id: ME, state: 'joined' }],
  }
  svcTables = { team_call_egress: [] }
  const signer = {
    from: () => ({
      createSignedUrl: async (path: string, ttl: number) => {
        h.signed.push([path, ttl])
        return { data: { signedUrl: `https://sb.example.invalid/storage/v1/object/sign/${path}?token=t` }, error: null }
      },
    }),
  }
  h.db = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcs.push([name, args])
      return h.rpc[name] ?? { data: null, error: null }
    },
    storage: signer,
  }) as unknown as SupabaseClient
  h.svc = Object.assign(memoryDb(svcTables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.svcRpcs.push([name, args])
      return h.rpc[`svc:${name}`] ?? { data: null, error: null }
    },
  }) as unknown as SupabaseClient
  h.afters = []
  h.rpcs = []
  h.svcRpcs = []
  h.rpc = {}
  h.port = { started: [], stopped: [], mics: [] }
  h.signed = []
  h.events = []
  h.allowed = []
  h.notConnected = false
})
afterEach(() => {
  for (const name of [...Object.keys(LIVEKIT_ENV), 'LIVEKIT_EGRESS', 'DEEPGRAM_API_KEY', 'TEAM_CALL_RECORDING', 'TEAM_CALL_RECORDING_MAX']) delete process.env[name]
})

const params = { params: Promise.resolve({ id: CALL }) }
const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const runAfters = async () => {
  for (const t of h.afters.splice(0)) await t()
}

describe('POST /api/account/team-calls/[id]/notes', () => {
  it('not available without the egress service, or without a Deepgram key: the control is absent', async () => {
    delete process.env.LIVEKIT_EGRESS
    expect((await notes(post('/n', { on: true }), params)).status).toBe(404)
    process.env.LIVEKIT_EGRESS = 'on'
    delete process.env.DEEPGRAM_API_KEY
    const res = await notes(post('/n', { on: true }), params)
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('CALLS_NOT_AVAILABLE')
    expect(h.rpcs).toEqual([])
  })

  it('on: as the person (567 decides who may), then every microphone in the room gets its file', async () => {
    h.rpc.team_call_set_notes = { data: [{ notes: true, notes_round: 1, changed: true }], error: null }
    h.rpc['svc:team_call_egress_claim'] = { data: [{ egress_row: REC, file_path: 'p' }], error: null }
    h.rpc['svc:team_call_egress_event'] = { data: [{ outcome: 'applied' }], error: null }
    h.port.mics = [{ identity: ME, trackSid: 'TR_a' }]
    const res = await notes(post('/n', { on: true }), params)
    expect(await res.json()).toEqual({ notes: true })
    expect(h.rpcs).toEqual([['team_call_set_notes', { target_call: CALL, turn_on: true }]])
    await runAfters()
    expect(h.port.started).toEqual(['TR_a'])
  })

  it('off: the running files are stopped through Inngest (retried until LiveKit takes it), one event per round', async () => {
    h.rpc.team_call_set_notes = { data: [{ notes: false, notes_round: 3, changed: true }], error: null }
    await notes(post('/n', { on: false }), params)
    await runAfters()
    expect(h.events).toEqual([{ name: 'team-calls/notes.stop', id: `team-call-notes-stop-${CALL}-3`, data: { callId: CALL } }])
  })

  it('a press that changed nothing starts or stops nothing', async () => {
    h.rpc.team_call_set_notes = { data: [{ notes: true, notes_round: 1, changed: false }], error: null }
    await notes(post('/n', { on: true }), params)
    expect(h.afters).toEqual([])
  })

  it('someone not in the call: 403; past the bound: 400 NOTES_FULL', async () => {
    h.rpc.team_call_set_notes = { data: null, error: { code: '42501', message: 'only someone in the call' } }
    expect((await notes(post('/n', { on: true }), params)).status).toBe(403)
    h.rpc.team_call_set_notes = { data: null, error: { code: '22023', message: '3 hours' } }
    const full = await notes(post('/n', { on: true }), params)
    expect(full.status).toBe(400)
    expect((await full.json()).code).toBe('NOTES_FULL')
  })

  it('a call the person may not read is not found; an ended or archived one takes no change', async () => {
    tables.team_call.splice(0)
    expect((await notes(post('/n', { on: true }), params)).status).toBe(404)
    tables.team_call.push(call({ status: 'ended' }))
    expect((await notes(post('/n', { on: true }), params)).status).toBe(409)
    tables.team_call[0] = call()
    tables.team_chat_channel[0].archived_at = new Date().toISOString()
    expect((await notes(post('/n', { on: true }), params)).status).toBe(409)
    expect(h.rpcs).toEqual([])
  })
})

describe('POST /api/account/team-calls/[id]/recording', () => {
  it('absent unless the server allows recording', async () => {
    delete process.env.TEAM_CALL_RECORDING
    expect((await recording(post('/r', { action: 'start' }), params)).status).toBe(404)
    expect(h.svcRpcs).toEqual([])
  })

  it('start: claimed under the cap (default 1), then LiveKit\'s composite', async () => {
    h.rpc['svc:team_call_recording_begin'] = { data: [{ outcome: 'claimed', egress_row: REC, file_path: 'f.mp4' }], error: null }
    h.rpc['svc:team_call_egress_event'] = { data: [{ outcome: 'applied' }], error: null }
    const res = await recording(post('/r', { action: 'start' }), params)
    expect(await res.json()).toEqual({ recording: 'starting' })
    expect(h.svcRpcs[0]).toEqual(['team_call_recording_begin', { target_call: CALL, member_ref: ME, max_live: 1 }])
    expect(h.port.started).toEqual(['composite'])
  })

  it('a second recording across the server: "another recording is running"', async () => {
    process.env.TEAM_CALL_RECORDING_MAX = '2'
    h.rpc['svc:team_call_recording_begin'] = { data: [{ outcome: 'busy' }], error: null }
    const res = await recording(post('/r', { action: 'start' }), params)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'Another recording is running', code: 'RECORDING_BUSY' })
    expect(h.svcRpcs[0][1].max_live).toBe(2)
    expect(h.port.started).toEqual([])
  })

  it('someone not in the call is refused; a start LiveKit refuses is a 503 that says so', async () => {
    h.rpc['svc:team_call_recording_begin'] = { data: [{ outcome: 'not_in_call' }], error: null }
    expect((await recording(post('/r', { action: 'start' }), params)).status).toBe(403)
    h.rpc['svc:team_call_recording_begin'] = { data: [{ outcome: 'claimed', egress_row: REC, file_path: 'f.mp4' }], error: null }
    process.env.LIVEKIT_URL = LIVEKIT_ENV.LIVEKIT_URL
    const failing = await import('@/lib/team-calls/egress')
    const spy = vi.spyOn(failing, 'liveKitEgress').mockReturnValue({
      startTrack: async () => ({ egressId: 'x' }),
      startRecording: async () => Promise.reject(new Error('resource exhausted')),
      stop: async () => {},
      list: async () => [],
      microphones: async () => [],
    })
    const res = await recording(post('/r', { action: 'start' }), params)
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('RECORDING_FAILED')
    spy.mockRestore()
  })

  it('stop: anyone in the call; a person not in it is refused', async () => {
    svcTables.team_call_egress.push({ id: REC, call_id: CALL, kind: 'recording', status: 'active', egress_id: 'EG_rec' })
    expect(await (await recording(post('/r', { action: 'stop' }), params)).json()).toEqual({ stopping: true })
    expect(h.port.stopped).toEqual(['EG_rec'])
    tables.team_call_participant[0].state = 'left'
    expect((await recording(post('/r', { action: 'stop' }), params)).status).toBe(403)
  })
})

describe('GET /api/account/team-calls/[id]/recording', () => {
  it('a saved recording: a link made as the person, an hour long', async () => {
    tables.team_call[0] = call({ status: 'ended', recording: 'saved' })
    svcTables.team_call_egress.push({ id: REC, call_id: CALL, kind: 'recording', status: 'complete', file_path: `${CH}/${CALL}/recording/${REC}.mp4`, created_at: '2026-11-11T10:00:00Z' })
    const res = await recordingLink(new Request('http://localhost/r'), params)
    const json = await res.json()
    expect(json.url).toContain(`/${CH}/${CALL}/recording/${REC}.mp4`)
    expect(h.signed).toEqual([[`${CH}/${CALL}/recording/${REC}.mp4`, 3600]])
  })

  it('someone who may not read the conversation (their read finds no call), or no saved recording: 404, nothing signed', async () => {
    tables.team_call.splice(0)
    expect((await recordingLink(new Request('http://localhost/r'), params)).status).toBe(404)
    tables.team_call.push(call({ recording: 'on' }))
    expect((await recordingLink(new Request('http://localhost/r'), params)).status).toBe(404)
    expect(h.signed).toEqual([])
  })
})

describe('starting a call with notes on', () => {
  it('a new call, asked and offered: notes on as the starter; the answer says what the server offers', async () => {
    tables.team_call.splice(0)
    h.rpc.team_call_start = { data: [{ call_id: CALL, room: `tc-${CALL}`, message_id: MSG, created: true }], error: null }
    h.rpc.team_call_set_notes = { data: [{ notes: true, notes_round: 1, changed: true }], error: null }
    const res = await startCall(post('/api/account/team-calls', { channelId: CH, notes: true }))
    const json = await res.json()
    expect(h.rpcs.map((r) => r[0])).toEqual(['team_call_start', 'team_call_set_notes'])
    expect(json.call).toMatchObject({ memberId: ME, features: { notes: true, recording: true }, notes: { notes: true, notes_by: ME, notes_state: 'capturing' } })
  })

  it('not asked, or not offered: no notes', async () => {
    tables.team_call.splice(0)
    h.rpc.team_call_start = { data: [{ call_id: CALL, room: `tc-${CALL}`, message_id: MSG, created: true }], error: null }
    await startCall(post('/api/account/team-calls', { channelId: CH }))
    delete process.env.DEEPGRAM_API_KEY
    const res = await startCall(post('/api/account/team-calls', { channelId: CH, notes: true }))
    expect(h.rpcs.map((r) => r[0])).toEqual(['team_call_start', 'team_call_start'])
    expect((await res.json()).call.features).toEqual({ notes: false, recording: true, liveNotes: false })
  })
})

describe('joining a call whose notes are on: listen-only until the notice was seen', () => {
  const grantOf = async (jwt: string) => (await new TokenVerifier(KEY, SECRET).verify(jwt)).video
  const tokenReq = (body?: unknown) =>
    new Request('http://localhost/t', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })

  it("notes on by someone else: a token that can't publish, unless the join says the notice was seen", async () => {
    tables.team_call[0] = call({ notes: true, notes_by: 'someone-else', notes_state: 'capturing' })
    const quiet = await (await token(tokenReq(), params)).json()
    expect(quiet.join.canPublish).toBe(false)
    expect(await grantOf(quiet.join.token)).toMatchObject({ canPublish: false, canSubscribe: true })
    const seen = await (await token(tokenReq({ noticeSeen: true }), params)).json()
    expect(seen.join.canPublish).toBe(true)
    expect(await grantOf(seen.join.token)).toMatchObject({ canPublish: true })
  })

  it('being recorded: listen-only too; nothing on: publish as before', async () => {
    tables.team_call[0] = call({ recording: 'on', recording_by: ME })
    expect((await (await token(tokenReq(), params)).json()).join.canPublish).toBe(false)
    tables.team_call[0] = call()
    expect((await (await token(tokenReq(), params)).json()).join.canPublish).toBe(true)
  })

  it('their own notes (their Auto-record started them): no wait', async () => {
    tables.team_call[0] = call({ notes: true, notes_by: ME, notes_state: 'capturing' })
    expect((await (await token(tokenReq(), params)).json()).join.canPublish).toBe(true)
  })

  it('POST notice: LiveKit lets their connection publish; not connected is a 409; an ended call takes nothing', async () => {
    expect(await (await notice(new Request('http://localhost/n', { method: 'POST' }), params)).json()).toEqual({ ok: true })
    expect(h.allowed).toEqual([[`tc-${CALL}`, ME]])
    h.notConnected = true
    expect((await notice(new Request('http://localhost/n', { method: 'POST' }), params)).status).toBe(409)
    tables.team_call[0] = call({ status: 'ended' })
    expect((await notice(new Request('http://localhost/n', { method: 'POST' }), params)).status).toBe(409)
  })
})

describe('the call recorder takes the notes (TEAM_CALL_RECORDER=on)', () => {
  beforeEach(() => {
    delete process.env.LIVEKIT_EGRESS
    delete process.env.DEEPGRAM_API_KEY
    Object.assign(process.env, { TEAM_CALL_RECORDER: 'on', CAPTURE_FEED_SECRET: 'capture-feed-secret-of-its-own-0123456789' })
  })
  afterEach(() => {
    delete process.env.TEAM_CALL_RECORDER
    delete process.env.CAPTURE_FEED_SECRET
  })

  it('on: no egress, no Deepgram key here; the call’s one capture is made now, so the call links to it', async () => {
    h.rpc.team_call_set_notes = { data: [{ notes: true, notes_round: 1, changed: true }], error: null }
    h.rpc['svc:team_call_capture_ensure'] = { data: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', error: null }
    h.port.mics = [{ identity: ME, trackSid: 'TR_a' }]
    const res = await notes(post('/n', { on: true }), params)
    expect(await res.json()).toEqual({ notes: true })
    expect(h.svcRpcs.map((r) => r[0])).toEqual(['team_call_capture_ensure'])
    expect(h.svcRpcs[0][1]).toEqual({ target_call: CALL, capture_title: 'Call' })
    await runAfters()
    expect(h.port.started).toEqual([])
  })

  it('off: the round’s feed ends in the database, and the recorder is put out of the room at once (the eject outbox, filled by 588)', async () => {
    h.rpc.team_call_set_notes = { data: [{ notes: false, notes_round: 2, changed: true }], error: null }
    await notes(post('/n', { on: false }), params)
    await runAfters()
    // Nothing to stop here (no Egress); the drain of the outbox the database just filled is asked for.
    expect(h.events).toEqual([{ name: 'team-calls/eject.requested', data: {} }])
    expect(h.svcRpcs).toEqual([])
  })

  it('a new call started with notes on gets its capture at once, and says the notes are live', async () => {
    tables.team_call.splice(0)
    h.rpc.team_call_start = { data: [{ call_id: CALL, room: `tc-${CALL}`, message_id: MSG, created: true }], error: null }
    h.rpc.team_call_set_notes = { data: [{ notes: true, notes_round: 1, changed: true }], error: null }
    h.rpc['svc:team_call_capture_ensure'] = { data: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', error: null }
    const res = await startCall(post('/api/account/team-calls', { channelId: CH, notes: true }))
    const body = await res.json()
    expect(body.call.features).toEqual({ notes: true, recording: false, liveNotes: true })
    expect(body.call.notes).toMatchObject({ notes: true, capture_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })
  })
})
