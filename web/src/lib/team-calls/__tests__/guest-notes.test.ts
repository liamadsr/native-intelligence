/**
 * Meeting guests in a call's notes (phase 7): a guest's microphone gets its
 * own file only through 574's claim for a guest let into the call; the notes
 * name them as the name they typed, "(guest)"; the capture's people are its
 * members only (a guest never reaches the capture); the sweeper keeps an
 * admitted guest's running file and stops a removed one's.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import type { TeamCallEgressPort } from '../egress'
import { startNotesForGuestTrack, startNotesForRoom, writeNotes } from '../notes-store'
import { stopUnwanted } from '../notes-sweep'

const WS = '11111111-1111-4111-8111-111111111111'
const CH = '22222222-2222-4222-8222-222222222222'
const CALL = '33333333-3333-4333-8333-333333333333'
const ANA = '44444444-4444-4444-8444-444444444444'
const GUEST = '55555555-5555-4555-8555-555555555555'
const GONE = '66666666-6666-4666-8666-666666666666'
const ANA_USER = '77777777-7777-4777-8777-777777777777'
const ROW_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ROW_G = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ROW_X = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const T0 = '2026-11-11T10:00:00.000Z'
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString()

let tables: Record<string, Array<Record<string, unknown>>>
let rpcs: Array<[string, Record<string, unknown>]>
let answers: Record<string, { data: unknown; error: unknown }>
let svc: SupabaseClient

function port(): TeamCallEgressPort & { started: string[]; stopped: string[] } {
  const started: string[] = []
  const stopped: string[] = []
  return {
    started,
    stopped,
    startTrack: async (_room, track) => {
      started.push(track)
      return { egressId: `EG_${track}` }
    },
    startRecording: async () => ({ egressId: 'x' }),
    stop: async (id) => void stopped.push(id),
    list: async () => [],
    microphones: async () => [
      { identity: ANA, trackSid: 'TR_ana' },
      { identity: `guest-${GUEST}`, trackSid: 'TR_guest' },
      { identity: 'someone-else', trackSid: 'TR_x' },
    ],
  }
}

const egress = (over: Record<string, unknown>) => ({
  id: ROW_A,
  call_id: CALL,
  kind: 'notes',
  member_id: ANA,
  guest_id: null,
  file_path: `${CH}/${CALL}/notes/${ROW_A}.ogg`,
  status: 'complete',
  started_at: at(0),
  created_at: at(0),
  duration_ms: 60_000,
  transcript_status: 'done',
  transcript: null,
  audio_deleted_at: null,
  error: null,
  cutoff_at: null,
  round: 1,
  ...over,
})

beforeEach(() => {
  tables = {
    team_call: [
      { id: CALL, workspace_id: WS, channel_id: CH, message_id: null, started_by: ANA, notes_by: ANA, status: 'ended', started_at: T0, ended_at: at(600), duration_seconds: 600, notes_seconds: 600, notes_state: 'transcribing', notes_changed_at: T0, capture_id: null, recording: 'off', room: `tc-${CALL}`, notes: false, notes_round: 1 },
    ],
    team_call_egress: [],
    team_call_participant: [{ call_id: CALL, member_id: ANA, first_joined_at: at(0), left_at: at(600), state: 'joined' }],
    member: [{ id: ANA, user_id: ANA_USER, workspace_id: WS, display_name: 'Ana Ruiz' }],
    meeting_guest: [
      { id: GUEST, call_id: CALL, name: 'Dana Lee', state: 'admitted', in_call: true },
      { id: GONE, call_id: CALL, name: 'Lee', state: 'removed', in_call: false },
    ],
    team_chat_channel: [{ id: CH, workspace_id: WS, kind: 'meeting', name: 'Design review', dm_key: null }],
  }
  rpcs = []
  answers = {}
  svc = Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args])
      return answers[name] ?? { data: null, error: null }
    },
  }) as unknown as SupabaseClient
})

describe('a guest’s microphone', () => {
  it('is claimed as the guest’s, through 574’s claim for a guest let into the call', async () => {
    answers.meeting_guest_egress_claim = { data: [{ egress_row: ROW_G, file_path: `${CH}/${CALL}/notes/${ROW_G}.ogg` }], error: null }
    const p = port()
    expect(await startNotesForGuestTrack(svc, p, { id: CALL, room: 'r' }, GUEST, 'TR_guest')).toBe('started')
    expect(rpcs[0]).toEqual(['meeting_guest_egress_claim', { target_call: CALL, guest_ref: GUEST, track_ref: 'TR_guest' }])
    expect(p.started).toEqual(['TR_guest'])
  })

  it('notes going on start every microphone in the room, members’ and guests’ each by their own claim', async () => {
    answers.team_call_egress_claim = { data: [{ egress_row: ROW_A, file_path: `${CH}/${CALL}/notes/${ROW_A}.ogg` }], error: null }
    answers.meeting_guest_egress_claim = { data: [{ egress_row: ROW_G, file_path: `${CH}/${CALL}/notes/${ROW_G}.ogg` }], error: null }
    tables.team_call[0].status = 'live'
    tables.team_call[0].notes = true
    expect(await startNotesForRoom(svc, port(), { id: CALL, room: 'r' })).toBe(2)
    expect(rpcs.filter((r) => r[0].endsWith('egress_claim')).map((r) => [r[0], r[1].member_ref ?? r[1].guest_ref])).toEqual([
      ['team_call_egress_claim', ANA],
      ['meeting_guest_egress_claim', GUEST],
    ])
  })
})

describe('the notes', () => {
  it('name a guest as the name they typed, "(guest)"; the capture’s people are members only; titled for the meeting', async () => {
    tables.team_call_egress.push(
      egress({ id: ROW_A, transcript: [{ start: 1, end: 2, text: 'Welcome.' }] }),
      egress({ id: ROW_G, member_id: null, guest_id: GUEST, started_at: at(10), transcript: [{ start: 1, end: 2, text: 'Thanks for having me.' }] }),
      egress({ id: ROW_X, member_id: null, guest_id: GONE, status: 'failed', transcript_status: 'none' }),
    )
    answers.team_call_attach_notes = { data: CAPTURE, error: null }
    expect((await writeNotes(svc, CALL)).outcome).toBe('ready')
    const args = rpcs.find((r) => r[0] === 'team_call_attach_notes')![1]
    expect(args.capture_title).toBe('Design review')
    expect(args.transcript_text).toBe('[Ana Ruiz] Welcome.\n[Dana Lee (guest)] Thanks for having me.')
    expect(args.notes_text).toBe('Not in these notes: Lee (guest) (their audio could not be recorded).')
    expect((args.people as Array<Record<string, unknown>>).map((p) => p.member_id)).toEqual([ANA])
    expect(args.meta).toEqual({ capture_mode: 'team_call', missing: [{ guest_id: GONE, why: 'not_recorded' }] })
  })
})

describe('the sweeper’s unwanted files', () => {
  it('keeps an admitted guest’s running file, stops a removed one’s', async () => {
    tables.team_call[0] = { ...tables.team_call[0], status: 'live', notes: true }
    const old = new Date(Date.now() - 5 * 60_000).toISOString()
    tables.team_call_egress.push(
      egress({ id: ROW_A, status: 'active', egress_id: 'EG_ana', created_at: old }),
      egress({ id: ROW_G, member_id: null, guest_id: GUEST, status: 'active', egress_id: 'EG_guest', created_at: old }),
      egress({ id: ROW_X, member_id: null, guest_id: GONE, status: 'active', egress_id: 'EG_gone', created_at: old }),
    )
    const p = port()
    expect(await stopUnwanted(svc, p, new Date())).toBe(1)
    expect(p.stopped).toEqual(['EG_gone'])
  })
})
