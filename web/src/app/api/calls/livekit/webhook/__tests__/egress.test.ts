/**
 * LiveKit's webhook for call notes and recordings (phase 6), as LiveKit sends
 * them (protobuf JSON, signed): a member's microphone published while notes
 * are on starts its file (once per track; nothing for a camera, a stranger,
 * notes off, or a server with no egress); egress_started / _updated / _ended
 * reach 567's ordering function with the row read from the file's name, the
 * egress id, LiveKit's updatedAt in nanoseconds and the file's times; a
 * finished notes file asks for its words; repeats are skipped; a room of no
 * call of ours is ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { LIVEKIT_ENV, signWebhook } from '@/lib/team-calls/__tests__/signing'

const CALL = '77777777-7777-4777-8777-777777777777'
const CH = '55555555-5555-4555-8555-555555555555'
const MEMBER = '33333333-3333-4333-8333-333333333333'
const ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ROOM = `tc-${CALL}`
const FILE = `${CH}/${CALL}/notes/${ROW}.ogg`

const h = vi.hoisted(() => ({
  db: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
  events: [] as Array<{ name: string; id?: string; data: unknown }>,
  started: [] as Array<[string, string, string]>,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.db }))
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
    startTrack: async (room: string, track: string, file: string) => {
      h.started.push([room, track, file])
      return { egressId: 'EG_new' }
    },
    startRecording: async () => ({ egressId: 'EG_rec' }),
    stop: async () => {},
    list: async () => [],
    microphones: async () => [],
  }),
}))

import { POST } from '../route'

let tables: Record<string, Array<Record<string, unknown>>>
beforeEach(() => {
  Object.assign(process.env, LIVEKIT_ENV, { LIVEKIT_EGRESS: 'on' })
  tables = {
    team_call: [{ id: CALL, room: ROOM, status: 'live', notes: true }],
    team_call_webhook_event: [],
    team_call_eject: [],
  }
  h.db = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcs.push([name, args])
      return h.rpc[name] ?? { data: null, error: null }
    },
  }) as unknown as SupabaseClient
  h.rpcs = []
  h.events = []
  h.started = []
  h.rpc = {
    team_call_egress_claim: { data: [{ egress_row: ROW, file_path: FILE }], error: null },
    team_call_egress_event: { data: [{ outcome: 'applied', egress_row: ROW, call_id: CALL, kind: 'notes', status: 'starting' }], error: null },
  }
})
afterEach(() => {
  for (const name of [...Object.keys(LIVEKIT_ENV), 'LIVEKIT_EGRESS']) delete process.env[name]
})

async function deliver(event: Record<string, unknown>) {
  const body = JSON.stringify(event)
  return POST(
    new NextRequest('http://localhost/api/calls/livekit/webhook', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/webhook+json', authorization: await signWebhook(body) },
    }),
  )
}

const published = (id: string, track: Record<string, unknown>, identity = MEMBER) => ({
  id,
  event: 'track_published',
  createdAt: '1762850000',
  room: { name: ROOM },
  participant: { identity, sid: 'PA_1' },
  track,
})
const MIC = { sid: 'TR_mic', type: 'AUDIO', source: 'MICROPHONE' }

const egressEvent = (id: string, event: string, info: Record<string, unknown>) => ({ id, event, createdAt: '1762850100', egressInfo: { roomName: ROOM, ...info } })
const trackRequest = (filepath: string) => ({ track: { roomName: ROOM, trackId: 'TR_mic', file: { filepath } } })

describe('track_published', () => {
  it("a member's microphone while notes are on: its file claimed and started, its egress id bound", async () => {
    const res = await deliver(published('EV_1', MIC))
    expect(await res.json()).toEqual({ ok: true, outcome: 'notes_started' })
    expect(h.rpcs[0]).toEqual(['team_call_egress_claim', { target_call: CALL, member_ref: MEMBER, track_ref: 'TR_mic' }])
    expect(h.started).toEqual([[ROOM, 'TR_mic', FILE]])
    expect(h.rpcs[1][1]).toMatchObject({ row_ref: ROW, egress_ref: 'EG_new', new_status: 'starting' })
  })

  it('the same track again (a repeated webhook): the claim answers nothing, no second file', async () => {
    h.rpc.team_call_egress_claim = { data: [], error: null }
    const res = await deliver(published('EV_2', MIC))
    expect(await res.json()).toEqual({ ok: true, outcome: 'notes_not_started' })
    expect(h.started).toEqual([])
  })

  it('a camera, a screen, an identity that is no member, or notes off: nothing', async () => {
    await deliver(published('EV_3', { sid: 'TR_cam', type: 'VIDEO', source: 'CAMERA' }))
    await deliver(published('EV_4', { sid: 'TR_scr', type: 'AUDIO', source: 'SCREEN_SHARE_AUDIO' }))
    await deliver(published('EV_5', MIC, 'EG_recorder'))
    tables.team_call[0].notes = false
    const off = await deliver(published('EV_6', MIC))
    expect(await off.json()).toEqual({ ok: true, outcome: 'ignored' })
    expect(h.rpcs).toEqual([])
    expect(h.started).toEqual([])
  })

  it('a server with no egress service starts nothing', async () => {
    delete process.env.LIVEKIT_EGRESS
    const res = await deliver(published('EV_7', MIC))
    expect(await res.json()).toEqual({ ok: true, outcome: 'ignored' })
    expect(h.rpcs).toEqual([])
  })
})

describe('egress events', () => {
  it('egress_started: the row from the file name, the egress id and LiveKit\'s nanosecond order', async () => {
    const res = await deliver(egressEvent('EV_10', 'egress_started', { egressId: 'EG_new', status: 'EGRESS_ACTIVE', updatedAt: '1762850001123456789', ...trackRequest(FILE) }))
    expect(await res.json()).toEqual({ ok: true, outcome: 'egress_applied' })
    expect(h.rpcs).toEqual([
      [
        'team_call_egress_event',
        {
          row_ref: ROW,
          egress_ref: 'EG_new',
          new_status: 'active',
          at_ns: '1762850001123456789',
          file_started: null,
          file_ended: null,
          file_duration_ms: null,
          file_size: null,
          failure: null,
        },
      ],
    ])
  })

  it('egress_ended with a file: its times and size, and its words asked for (one event per file)', async () => {
    h.rpc.team_call_egress_event = { data: [{ outcome: 'applied', egress_row: ROW, call_id: CALL, kind: 'notes', status: 'complete' }], error: null }
    await deliver(
      egressEvent('EV_11', 'egress_ended', {
        egressId: 'EG_new',
        status: 'EGRESS_COMPLETE',
        updatedAt: '1762850301000000000',
        ...trackRequest(FILE),
        fileResults: [{ filename: FILE, startedAt: '1762850001500000000', endedAt: '1762850300000000000', duration: '298500000000', size: '1200000' }],
      }),
    )
    expect(h.rpcs[0][1]).toMatchObject({
      new_status: 'complete',
      file_started: new Date(1762850001500).toISOString(),
      file_ended: new Date(1762850300000).toISOString(),
      file_duration_ms: 298500,
      file_size: 1200000,
    })
    expect(h.events).toEqual([{ name: 'team-calls/notes.file', id: `team-call-notes-file-${ROW}`, data: { rowId: ROW } }])
  })

  it('a late or repeated event: the ordering function says stale, nothing asked', async () => {
    h.rpc.team_call_egress_event = { data: [{ outcome: 'stale', egress_row: ROW, call_id: CALL, kind: 'notes', status: 'complete' }], error: null }
    const res = await deliver(egressEvent('EV_12', 'egress_updated', { egressId: 'EG_new', status: 'EGRESS_ACTIVE', updatedAt: '1', ...trackRequest(FILE) }))
    expect(await res.json()).toEqual({ ok: true, outcome: 'egress_stale' })
    expect(h.events).toEqual([])
  })

  it('a failed egress: its error goes with it, no words asked', async () => {
    h.rpc.team_call_egress_event = { data: [{ outcome: 'applied', egress_row: ROW, call_id: CALL, kind: 'notes', status: 'failed' }], error: null }
    await deliver(egressEvent('EV_13', 'egress_ended', { egressId: 'EG_new', status: 'EGRESS_FAILED', updatedAt: '5', error: 'EntityTooLarge', ...trackRequest(FILE) }))
    expect(h.rpcs[0][1]).toMatchObject({ new_status: 'failed', failure: 'EntityTooLarge' })
    expect(h.events).toEqual([])
  })

  it("a recording's composite: found by its file outputs' name", async () => {
    h.rpc.team_call_egress_event = { data: [{ outcome: 'applied', egress_row: REC, call_id: CALL, kind: 'recording', status: 'active' }], error: null }
    const recFile = `${CH}/${CALL}/recording/${REC}.mp4`
    await deliver(egressEvent('EV_14', 'egress_started', { egressId: 'EG_rec', status: 'EGRESS_ACTIVE', updatedAt: '9', roomComposite: { roomName: ROOM, fileOutputs: [{ filepath: recFile }] } }))
    expect(h.rpcs[0][1]).toMatchObject({ row_ref: REC, egress_ref: 'EG_rec', new_status: 'active' })
    expect(h.events).toEqual([])
  })

  it('an egress of a room that is none of ours, and a repeat, change nothing', async () => {
    await deliver({ id: 'EV_15', event: 'egress_started', egressInfo: { roomName: 'someone-else', egressId: 'EG_x', status: 'EGRESS_ACTIVE' } })
    expect(h.rpcs).toEqual([])
    await deliver(egressEvent('EV_16', 'egress_updated', { egressId: 'EG_new', status: 'EGRESS_ACTIVE', updatedAt: '2', ...trackRequest(FILE) }))
    const again = await deliver(egressEvent('EV_16', 'egress_updated', { egressId: 'EG_new', status: 'EGRESS_ACTIVE', updatedAt: '2', ...trackRequest(FILE) }))
    expect(await again.json()).toEqual({ ok: true, outcome: 'repeat' })
    expect(h.rpcs).toHaveLength(1)
  })

  it('a failed write is a 500, so LiveKit sends it again', async () => {
    h.rpc.team_call_egress_event = { data: null, error: { message: 'connection reset' } }
    const res = await deliver(egressEvent('EV_17', 'egress_updated', { egressId: 'EG_new', status: 'EGRESS_ACTIVE', updatedAt: '3', ...trackRequest(FILE) }))
    expect(res.status).toBe(500)
    expect(tables.team_call_webhook_event).toEqual([])
  })
})
