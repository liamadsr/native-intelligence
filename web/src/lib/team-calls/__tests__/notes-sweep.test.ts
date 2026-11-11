/**
 * The sweeper's part for notes and recordings (src/lib/team-calls/notes-sweep.ts):
 * notes past 3 hours go off and their egresses stop; a recording past 2
 * hours stops; an egress whose end was lost is settled from LiveKit's own
 * list (a finished notes file then asks for its words), one LiveKit no
 * longer knows after its call ended or one that never got an id is failed,
 * and nothing is decided while LiveKit can't be asked; notes whose finish was
 * lost are asked for again.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import type { ListedEgress, TeamCallEgressPort } from '../egress'
import { sweepTeamCallEgress } from '../notes-sweep'

const CALL = '77777777-7777-4777-8777-777777777777'
const CALL2 = '88888888-8888-4888-8888-888888888888'
const ROW_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ROW_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ROW_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NOW = new Date('2026-11-11T14:00:00.000Z')
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()

let tables: Record<string, Array<Record<string, unknown>>>
let rpcs: Array<[string, Record<string, unknown>]>
let sent: Array<{ name: string; id: string }>
let svc: SupabaseClient

function port(over: Partial<TeamCallEgressPort> = {}): TeamCallEgressPort & { stopped: string[] } {
  const stopped: string[] = []
  return {
    stopped,
    startTrack: async () => ({ egressId: 'x' }),
    startRecording: async () => ({ egressId: 'x' }),
    stop: async (id) => {
      stopped.push(id)
    },
    list: async () => [],
    microphones: async () => [],
    ...over,
  }
}

beforeEach(() => {
  tables = { team_call: [], team_call_egress: [] }
  rpcs = []
  sent = []
  svc = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args])
      if (name === 'team_call_notes_stop') return { data: true, error: null }
      if (name === 'team_call_egress_event') return { data: [{ outcome: 'applied', egress_row: args.row_ref, call_id: CALL, kind: 'notes', status: args.new_status }], error: null }
      return { data: null, error: null }
    },
  }) as unknown as SupabaseClient
})

const deps = (p: TeamCallEgressPort | null) => ({ egress: p, now: () => NOW, send: async (events: Array<{ name: string; id: string }>) => void sent.push(...events) })

describe('the bounds', () => {
  it('notes on past 3 hours go off, by the server, and their egresses stop; under it, nothing', async () => {
    tables.team_call.push(
      { id: CALL, notes: true, notes_on_since: ago(60), notes_seconds: 2.5 * 3600, room: 'r1', status: 'live', recording: 'off' },
      { id: CALL2, notes: true, notes_on_since: ago(10), notes_seconds: 0, room: 'r2', status: 'live', recording: 'off' },
    )
    tables.team_call_egress.push({ id: ROW_A, call_id: CALL, kind: 'notes', status: 'active', egress_id: 'EG_a', created_at: ago(1) })
    const p = port()
    const result = await sweepTeamCallEgress(svc, deps(p))
    expect(result.notesStopped).toBe(1)
    expect(rpcs.filter((r) => r[0] === 'team_call_notes_stop').map((r) => r[1].target_call)).toEqual([CALL])
    expect(p.stopped).toEqual(['EG_a'])
  })

  it('a recording past 2 hours is stopped', async () => {
    tables.team_call.push({ id: CALL, notes: false, recording: 'on', recording_started_at: ago(121), room: 'r1', status: 'live' })
    tables.team_call_egress.push({ id: ROW_C, call_id: CALL, kind: 'recording', status: 'active', egress_id: 'EG_rec', created_at: ago(1) })
    const p = port()
    expect((await sweepTeamCallEgress(svc, deps(p))).recordingsStopped).toBe(1)
    expect(p.stopped).toEqual(['EG_rec'])
  })
})

describe('egresses whose end was lost', () => {
  it("settled from LiveKit's own list; a finished notes file asks for its words", async () => {
    tables.team_call.push({ id: CALL, room: 'r1', status: 'ended', ended_at: ago(5), notes: false, recording: 'off' })
    tables.team_call_egress.push({ id: ROW_A, call_id: CALL, kind: 'notes', status: 'active', egress_id: 'EG_a', created_at: ago(30) })
    const listed: ListedEgress[] = [
      {
        egressId: 'EG_a',
        status: 3,
        updatedAtNs: BigInt(NOW.getTime()) * BigInt(1_000_000),
        startedAtNs: BigInt(0),
        endedAtNs: BigInt(0),
        error: '',
        file: { filename: 'f', startedAtNs: BigInt(Date.parse(ago(30))) * BigInt(1_000_000), endedAtNs: BigInt(Date.parse(ago(5))) * BigInt(1_000_000), durationNs: BigInt(25 * 60) * BigInt(1_000_000_000), size: BigInt(4_000_000) },
      },
    ]
    const result = await sweepTeamCallEgress(svc, deps(port({ list: async () => listed })))
    expect(result.egressesSettled).toBe(1)
    const ev = rpcs.find((r) => r[0] === 'team_call_egress_event')![1]
    expect(ev).toMatchObject({ row_ref: ROW_A, egress_ref: 'EG_a', new_status: 'complete', file_duration_ms: 1_500_000, file_size: 4_000_000, file_started: ago(30) })
    expect(sent).toEqual([{ name: 'team-calls/notes.file', id: `team-call-notes-file-${ROW_A}`, data: { rowId: ROW_A } }])
  })

  it("one LiveKit no longer knows, 10 minutes after its call ended, is lost; one with no egress id after 5 minutes never started; a young one waits", async () => {
    tables.team_call.push({ id: CALL, room: 'r1', status: 'ended', ended_at: ago(15), notes: false, recording: 'off' })
    tables.team_call_egress.push(
      { id: ROW_A, call_id: CALL, kind: 'notes', status: 'active', egress_id: 'EG_gone', created_at: ago(40) },
      { id: ROW_B, call_id: CALL, kind: 'notes', status: 'starting', egress_id: null, created_at: ago(6) },
      { id: ROW_C, call_id: CALL, kind: 'notes', status: 'starting', egress_id: null, created_at: ago(3) },
    )
    const result = await sweepTeamCallEgress(svc, deps(port()))
    expect(result.egressesLost).toBe(2)
    expect(rpcs.filter((r) => r[0] === 'team_call_egress_event').map((r) => [r[1].row_ref, r[1].new_status, r[1].failure])).toEqual([
      [ROW_A, 'failed', 'lost: LiveKit no longer knows this egress'],
      [ROW_B, 'failed', 'lost: never started'],
    ])
  })

  it('a recording LiveKit no longer lists, in a call still live, is lost after 10 minutes (it no longer holds the cap)', async () => {
    tables.team_call.push({ id: CALL, room: 'r1', status: 'live', ended_at: null, notes: false, recording: 'starting' })
    tables.team_call_egress.push(
      { id: ROW_C, call_id: CALL, kind: 'recording', status: 'starting', egress_id: 'EG_rec', created_at: ago(12) },
      { id: ROW_A, call_id: CALL, kind: 'notes', status: 'active', egress_id: 'EG_young', created_at: ago(4) },
    )
    const result = await sweepTeamCallEgress(svc, deps(port()))
    expect(result.egressesLost).toBe(1)
    expect(rpcs.filter((r) => r[0] === 'team_call_egress_event').map((r) => r[1].row_ref)).toEqual([ROW_C])
  })

  it("LiveKit can't be asked: nothing decided", async () => {
    tables.team_call.push({ id: CALL, room: 'r1', status: 'ended', ended_at: ago(60), notes: false, recording: 'off' })
    tables.team_call_egress.push({ id: ROW_A, call_id: CALL, kind: 'notes', status: 'active', egress_id: 'EG_a', created_at: ago(90) })
    const result = await sweepTeamCallEgress(svc, deps(port({ list: async () => Promise.reject(new Error('ECONNREFUSED')) })))
    expect(result.unreachable).toBe(true)
    expect(rpcs.filter((r) => r[0] === 'team_call_egress_event')).toEqual([])
  })

  it('with no egress service, only the notes bound and the lost finishes run', async () => {
    tables.team_call.push({ id: CALL, room: 'r1', status: 'ended', ended_at: ago(30), notes: false, recording: 'off', notes_state: 'transcribing' })
    tables.team_call_egress.push({ id: ROW_A, call_id: CALL, kind: 'notes', status: 'active', egress_id: 'EG_a', created_at: ago(90) })
    const result = await sweepTeamCallEgress(svc, deps(null))
    expect(result.egressesChecked).toBe(0)
    expect(result.finishesAsked).toBe(1)
  })
})

describe('notes egresses nobody wants any more (the off switch\'s own stop failed)', () => {
  it('stops one whose notes are off, on in a newer round, whose call ended, or whose person left; keeps the wanted and the young', async () => {
    const C3 = '99999999-9999-4999-8999-999999999999'
    tables.team_call.push(
      { id: CALL, room: 'r1', status: 'live', notes: false, notes_round: 1, recording: 'off' },
      { id: CALL2, room: 'r2', status: 'live', notes: true, notes_round: 2, recording: 'off' },
      { id: C3, room: 'r3', status: 'ended', ended_at: ago(1), notes: false, notes_round: 1, recording: 'off' },
    )
    tables.team_call_participant = [
      { call_id: CALL2, member_id: 'm-in', state: 'joined' },
      { call_id: CALL2, member_id: 'm-gone', state: 'left' },
    ]
    tables.team_call_egress.push(
      { id: 'e-off', call_id: CALL, kind: 'notes', member_id: 'm-in', round: 1, status: 'active', egress_id: 'EG_off', created_at: ago(3) },
      { id: 'e-old-round', call_id: CALL2, kind: 'notes', member_id: 'm-in', round: 1, status: 'active', egress_id: 'EG_old', created_at: ago(3) },
      { id: 'e-wanted', call_id: CALL2, kind: 'notes', member_id: 'm-in', round: 2, status: 'active', egress_id: 'EG_ok', created_at: ago(3) },
      { id: 'e-left', call_id: CALL2, kind: 'notes', member_id: 'm-gone', round: 2, status: 'active', egress_id: 'EG_left', created_at: ago(3) },
      { id: 'e-ended', call_id: C3, kind: 'notes', member_id: 'm-in', round: 1, status: 'starting', egress_id: 'EG_end', created_at: ago(3) },
      { id: 'e-young', call_id: CALL, kind: 'notes', member_id: 'm-in', round: 1, status: 'active', egress_id: 'EG_young', created_at: new Date(NOW.getTime() - 20_000).toISOString() },
    )
    const p = port()
    const result = await sweepTeamCallEgress(svc, deps(p))
    expect(p.stopped.sort()).toEqual(['EG_end', 'EG_left', 'EG_off', 'EG_old'])
    expect(result.unwantedStopped).toBe(4)
  })
})

describe('notes whose finish was lost', () => {
  it('asked for again 20 minutes after their call ended, not before', async () => {
    tables.team_call.push(
      { id: CALL, room: 'r1', status: 'ended', ended_at: ago(25), notes: false, recording: 'off', notes_state: 'transcribing' },
      { id: CALL2, room: 'r2', status: 'ended', ended_at: ago(5), notes: false, recording: 'off', notes_state: 'transcribing' },
    )
    await sweepTeamCallEgress(svc, deps(port()))
    expect(sent).toEqual([{ name: 'team-calls/notes.finish', id: `team-call-notes-finish-${CALL}`, data: { callId: CALL } }])
  })
})
