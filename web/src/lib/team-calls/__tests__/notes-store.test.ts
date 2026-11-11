/**
 * Call notes' work as the service role (src/lib/team-calls/notes-store.ts):
 * a published microphone's egress (claimed once, started, its id bound; a
 * refused start is that file failed), the recording under the server's cap,
 * each file's words (Deepgram done, empty, refused for good, worth another
 * try), the notes written (silent, failed, or one capture naming who is
 * missing), and the raw audio removed after (kept beside a recording, and
 * kept when its words never came).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import type { TeamCallEgressPort } from '../egress'
import {
  DeepgramError,
  removeNotesAudio,
  requestNotesFinish,
  startNotesForRoom,
  startNotesForTrack,
  startRecording,
  stopEgresses,
  transcribeNotesFile,
  writeNotes,
} from '../notes-store'

const WS = '11111111-1111-4111-8111-111111111111'
const CH = '22222222-2222-4222-8222-222222222222'
const CALL = '33333333-3333-4333-8333-333333333333'
const ANA = '44444444-4444-4444-8444-444444444444'
const BEN = '55555555-5555-4555-8555-555555555555'
const CY = '66666666-6666-4666-8666-666666666666'
const ANA_USER = '77777777-7777-4777-8777-777777777777'
const ROW_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ROW_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ROW_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const T0 = '2026-11-11T10:00:00.000Z'
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString()
const path = (row: string) => `${CH}/${CALL}/notes/${row}.ogg`

type Rpc = { data: unknown; error: unknown }
let tables: Record<string, Array<Record<string, unknown>>>
let rpcs: Array<[string, Record<string, unknown>]>
let answers: Record<string, Rpc | ((args: Record<string, unknown>) => Rpc)>
let removed: string[][]
let svc: SupabaseClient

function makeSvc() {
  return Object.assign(memoryDb(tables), {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push([name, args])
      const a = answers[name]
      return typeof a === 'function' ? a(args) : a ?? { data: null, error: null }
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          removed.push(paths)
          return { data: [], error: null }
        },
      }),
    },
  }) as unknown as SupabaseClient
}

function port(over: Partial<TeamCallEgressPort> = {}): TeamCallEgressPort & { started: Array<[string, string, string]>; stopped: string[] } {
  const started: Array<[string, string, string]> = []
  const stopped: string[] = []
  return {
    started,
    stopped,
    startTrack: async (room, track, file) => {
      started.push([room, track, file])
      return { egressId: `EG_${track}` }
    },
    startRecording: async (room, file) => {
      started.push([room, 'composite', file])
      return { egressId: 'EG_rec' }
    },
    stop: async (id) => {
      stopped.push(id)
    },
    list: async () => [],
    microphones: async () => [],
    ...over,
  }
}

const egress = (over: Record<string, unknown>) => ({
  id: ROW_A,
  call_id: CALL,
  kind: 'notes',
  member_id: ANA,
  file_path: path(ROW_A),
  status: 'complete',
  started_at: at(0),
  created_at: at(0),
  duration_ms: 60_000,
  transcript_status: 'pending',
  transcript: null,
  audio_deleted_at: null,
  error: null,
  ...over,
})

beforeEach(() => {
  tables = {
    team_call: [
      {
        id: CALL,
        workspace_id: WS,
        channel_id: CH,
        message_id: null,
        started_by: ANA,
        notes_by: ANA,
        status: 'ended',
        started_at: T0,
        ended_at: at(600),
        duration_seconds: 600,
        notes_seconds: 600,
        notes_state: 'transcribing',
        notes_changed_at: T0,
        capture_id: null,
        recording: 'off',
        room: `tc-${CALL}`,
        notes: false,
      },
    ],
    team_call_egress: [],
    team_call_participant: [
      { call_id: CALL, member_id: ANA, first_joined_at: at(0), left_at: at(600) },
      { call_id: CALL, member_id: BEN, first_joined_at: at(30), left_at: at(600) },
    ],
    member: [
      { id: ANA, user_id: ANA_USER, workspace_id: WS, display_name: 'Ana Ruiz' },
      { id: BEN, user_id: 'u-ben', workspace_id: WS, display_name: 'Ben Okafor' },
      { id: CY, user_id: 'u-cy', workspace_id: WS, display_name: 'Cy Lane' },
    ],
    team_chat_channel: [{ id: CH, workspace_id: WS, kind: 'channel', name: 'launch', dm_key: null }],
  }
  rpcs = []
  removed = []
  answers = {
    team_call_egress_event: (args) => ({ data: [{ outcome: 'applied', egress_row: args.row_ref, call_id: CALL, kind: 'notes', status: args.new_status }], error: null }),
  }
  svc = makeSvc()
})

describe('a microphone\'s notes file', () => {
  it('claims its row, starts LiveKit\'s egress on the row\'s file name, and binds the egress id', async () => {
    answers.team_call_egress_claim = { data: [{ egress_row: ROW_A, file_path: path(ROW_A) }], error: null }
    const p = port()
    expect(await startNotesForTrack(svc, p, { id: CALL, room: `tc-${CALL}` }, ANA, 'TR_mic')).toBe('started')
    expect(p.started).toEqual([[`tc-${CALL}`, 'TR_mic', path(ROW_A)]])
    expect(rpcs.map((r) => r[0])).toEqual(['team_call_egress_claim', 'team_call_egress_event'])
    expect(rpcs[1][1]).toMatchObject({ row_ref: ROW_A, egress_ref: 'EG_TR_mic', new_status: 'starting', at_ns: '0' })
  })

  it('a repeated webhook for the same track and round starts nothing', async () => {
    answers.team_call_egress_claim = { data: [], error: null }
    const p = port()
    expect(await startNotesForTrack(svc, p, { id: CALL, room: 'r' }, ANA, 'TR_mic')).toBe('claimed_already')
    expect(p.started).toEqual([])
  })

  it('a refused start (the egress service full or down) is that file failed: the notes will say whose words are missing', async () => {
    answers.team_call_egress_claim = { data: [{ egress_row: ROW_A, file_path: path(ROW_A) }], error: null }
    const p = port({ startTrack: async () => Promise.reject(new Error('twirp error unavailable: no response from servers')) })
    expect(await startNotesForTrack(svc, p, { id: CALL, room: 'r' }, ANA, 'TR_mic')).toBe('failed')
    expect(rpcs[1][1]).toMatchObject({ row_ref: ROW_A, egress_ref: null, new_status: 'failed' })
    expect(String(rpcs[1][1].failure)).toContain('no response from servers')
  })

  it('notes turned on: every member\'s microphone in the room now, other identities skipped', async () => {
    let n = 0
    answers.team_call_egress_claim = () => ({ data: [{ egress_row: [ROW_A, ROW_B][n], file_path: path([ROW_A, ROW_B][n++]) }], error: null })
    const p = port({ microphones: async () => [{ identity: ANA, trackSid: 'TR_a' }, { identity: 'egress-bot', trackSid: 'TR_x' }, { identity: BEN, trackSid: 'TR_b' }] })
    expect(await startNotesForRoom(svc, p, { id: CALL, room: 'r' })).toBe(2)
    expect(p.started.map((s) => s[1])).toEqual(['TR_a', 'TR_b'])
  })

  it('notes off: the running files are stopped (one already over is fine), the finished left alone', async () => {
    tables.team_call_egress.push(egress({ id: ROW_A, status: 'active', egress_id: 'EG_a' }), egress({ id: ROW_B, status: 'complete', egress_id: 'EG_b' }), egress({ id: ROW_C, status: 'starting', egress_id: null }))
    const p = port()
    expect(await stopEgresses(svc, p, CALL, 'notes')).toBe(1)
    expect(p.stopped).toEqual(['EG_a'])
  })
})

describe('the recording', () => {
  it('starts only once the cap allows it, and says why not otherwise', async () => {
    const p = port()
    answers.team_call_recording_begin = { data: [{ outcome: 'busy', egress_row: null, file_path: null }], error: null }
    expect(await startRecording(svc, p, { id: CALL, room: 'r' }, ANA, 1)).toBe('busy')
    expect(p.started).toEqual([])
    expect(rpcs[0][1]).toMatchObject({ target_call: CALL, member_ref: ANA, max_live: 1 })
    answers.team_call_recording_begin = { data: [{ outcome: 'claimed', egress_row: ROW_C, file_path: `${CH}/${CALL}/recording/${ROW_C}.mp4` }], error: null }
    expect(await startRecording(svc, p, { id: CALL, room: 'r' }, ANA, 1)).toBe('claimed')
    expect(p.started).toEqual([['r', 'composite', `${CH}/${CALL}/recording/${ROW_C}.mp4`]])
  })

  it('a refused start is the recording failed (another may be tried)', async () => {
    answers.team_call_recording_begin = { data: [{ outcome: 'claimed', egress_row: ROW_C, file_path: 'x' }], error: null }
    const p = port({ startRecording: async () => Promise.reject(new Error('resource exhausted')) })
    expect(await startRecording(svc, p, { id: CALL, room: 'r' }, ANA, 1)).toBe('failed')
    expect(rpcs.at(-1)![1]).toMatchObject({ row_ref: ROW_C, new_status: 'failed' })
  })
})

describe("a file's words", () => {
  it('done: Deepgram\'s utterances stored on the row, the audio\'s seconds logged against the call\'s starter', async () => {
    tables.team_call_egress.push(egress({}))
    const logged: Array<[string, number]> = []
    const out = await transcribeNotesFile(svc, ROW_A, {
      download: async (p) => {
        expect(p).toBe(path(ROW_A))
        return new ArrayBuffer(8)
      },
      transcribe: async () => ({ metadata: { duration: 59.6 }, results: { utterances: [{ start: 1, end: 2, transcript: 'Hello.' }] } }),
      logUsage: async (u, s) => {
        logged.push([u, s])
      },
    })
    expect(out).toBe('done')
    expect(tables.team_call_egress[0]).toMatchObject({ transcript_status: 'done', transcript: [{ start: 1, end: 2, text: 'Hello.' }] })
    expect(logged).toEqual([[ANA_USER, 60]])
  })

  it('empty: a person who never spoke', async () => {
    tables.team_call_egress.push(egress({}))
    expect(await transcribeNotesFile(svc, ROW_A, { download: async () => new ArrayBuffer(1), transcribe: async () => ({ results: { utterances: [] } }), logUsage: async () => 0 })).toBe('empty')
    expect(tables.team_call_egress[0].transcript_status).toBe('empty')
  })

  it('a Deepgram failure worth another try throws (Inngest retries), leaving the file pending', async () => {
    tables.team_call_egress.push(egress({}))
    await expect(
      transcribeNotesFile(svc, ROW_A, { download: async () => new ArrayBuffer(1), transcribe: async () => Promise.reject(new DeepgramError('Deepgram 503', true)) }),
    ).rejects.toThrow('Deepgram 503')
    expect(tables.team_call_egress[0].transcript_status).toBe('pending')
  })

  it('one that never will (a 4xx) is the file failed, its audio kept', async () => {
    tables.team_call_egress.push(egress({}))
    expect(await transcribeNotesFile(svc, ROW_A, { download: async () => new ArrayBuffer(1), transcribe: async () => Promise.reject(new DeepgramError('Deepgram 400', false)) })).toBe('failed')
    expect(tables.team_call_egress[0]).toMatchObject({ transcript_status: 'failed', audio_deleted_at: null })
  })

  it('skips a file already done, one not finished, and a recording', async () => {
    tables.team_call_egress.push(egress({ transcript_status: 'done' }), egress({ id: ROW_B, status: 'active' }), egress({ id: ROW_C, kind: 'recording', transcript_status: 'none' }))
    const transcribe = vi.fn()
    for (const r of [ROW_A, ROW_B, ROW_C]) expect(await transcribeNotesFile(svc, r, { transcribe })).toBe('skipped')
    expect(transcribe).not.toHaveBeenCalled()
  })
})

describe('writing the notes', () => {
  it('merges the files by time under each name and makes one capture, its owner the starter, saying who is missing', async () => {
    tables.team_call_egress.push(
      egress({ id: ROW_A, member_id: ANA, started_at: at(0), transcript_status: 'done', transcript: [{ start: 2, end: 3, text: 'Shall we start?' }] }),
      egress({ id: ROW_B, member_id: BEN, started_at: at(30), transcript_status: 'done', transcript: [{ start: 1, end: 2, text: 'Ready.' }] }),
      egress({ id: ROW_C, member_id: CY, status: 'failed', transcript_status: 'none', error: 'not started' }),
    )
    answers.team_call_attach_notes = { data: CAPTURE, error: null }
    const written = await writeNotes(svc, CALL)
    expect(written).toEqual({ outcome: 'ready', captureId: CAPTURE, ownerUserId: ANA_USER, workspaceId: WS })
    const args = rpcs.find((r) => r[0] === 'team_call_attach_notes')![1]
    expect(args.capture_title).toBe('Call in #launch')
    expect(args.owner_user).toBe(ANA_USER)
    expect(args.transcript_text).toBe('[Ana Ruiz] Shall we start?\n[Ben Okafor] Ready.')
    expect(args.notes_text).toBe('Not in these notes: Cy Lane (their audio could not be recorded).')
    const people = args.people as Array<Record<string, unknown>>
    expect(people.map((p) => [p.member_id, p.label])).toEqual([
      [ANA, 'Ana Ruiz'],
      [BEN, 'Ben Okafor'],
      [CY, null],
    ])
    expect(args.meta).toEqual({ capture_mode: 'team_call', missing: [{ member_id: CY, why: 'not_recorded' }] })
  })

  it('a DM\'s notes are titled for the other person', async () => {
    tables.team_chat_channel[0] = { id: CH, workspace_id: WS, kind: 'dm', name: null, dm_key: [ANA, BEN].sort().join(':') }
    tables.team_call_egress.push(egress({ transcript_status: 'done', transcript: [{ start: 1, end: 2, text: 'Hi.' }] }))
    answers.team_call_attach_notes = { data: CAPTURE, error: null }
    await writeNotes(svc, CALL)
    expect(rpcs.find((r) => r[0] === 'team_call_attach_notes')![1].capture_title).toBe('Call with Ben Okafor')
  })

  it('nothing said at all: no capture, the notes are silent', async () => {
    tables.team_call_egress.push(egress({ transcript_status: 'empty' }))
    answers.team_call_notes_settle = { data: true, error: null }
    expect(await writeNotes(svc, CALL)).toEqual({ outcome: 'silent' })
    expect(rpcs.map((r) => [r[0], r[1].final_state])).toEqual([['team_call_notes_settle', 'silent']])
  })

  it('a call that ended before any egress started: silent, nothing to write', async () => {
    answers.team_call_notes_settle = { data: true, error: null }
    expect(await writeNotes(svc, CALL)).toEqual({ outcome: 'silent' })
  })

  it('every file lost: failed, no capture', async () => {
    tables.team_call_egress.push(egress({ status: 'failed', transcript_status: 'none' }), egress({ id: ROW_B, member_id: BEN, transcript_status: 'failed' }))
    answers.team_call_notes_settle = { data: true, error: null }
    expect(await writeNotes(svc, CALL)).toEqual({ outcome: 'failed' })
    expect(rpcs.find((r) => r[0] === 'team_call_attach_notes')).toBeUndefined()
  })

  it('a call still live, or notes not being written, writes nothing', async () => {
    tables.team_call[0].status = 'live'
    expect(await writeNotes(svc, CALL)).toEqual({ outcome: 'skipped' })
    tables.team_call[0].status = 'ended'
    tables.team_call[0].notes_state = 'none'
    expect(await writeNotes(svc, CALL)).toEqual({ outcome: 'skipped' })
  })
})

describe('the raw audio, after', () => {
  it('removes the files whose words are in (done or empty), keeps one whose words never came', async () => {
    tables.team_call_egress.push(egress({ transcript_status: 'done' }), egress({ id: ROW_B, file_path: path(ROW_B), transcript_status: 'empty' }), egress({ id: ROW_C, file_path: path(ROW_C), transcript_status: 'failed' }))
    expect(await removeNotesAudio(svc, CALL)).toBe(2)
    expect(removed).toEqual([[path(ROW_A), path(ROW_B)]])
    expect(tables.team_call_egress.map((r) => !!r.audio_deleted_at)).toEqual([true, true, false])
    // Again: nothing left to remove.
    expect(await removeNotesAudio(svc, CALL)).toBe(0)
  })

  it('keeps every file when the call was also recorded', async () => {
    tables.team_call[0].recording = 'saved'
    tables.team_call_egress.push(egress({ transcript_status: 'done' }))
    expect(await removeNotesAudio(svc, CALL)).toBe(0)
    expect(removed).toEqual([])
  })
})

describe('asking for the notes when a call ends', () => {
  it('only a call whose notes are being written; never throws', async () => {
    const sent: unknown[] = []
    expect(await requestNotesFinish(svc, CALL, async (e) => sent.push(...e))).toBe(true)
    expect(sent).toEqual([{ name: 'team-calls/notes.finish', id: `team-call-notes-finish-${CALL}`, data: { callId: CALL } }])
    tables.team_call[0].notes_state = 'none'
    expect(await requestNotesFinish(svc, CALL, async (e) => sent.push(...e))).toBe(false)
    tables.team_call[0].notes_state = 'transcribing'
    expect(await requestNotesFinish(svc, CALL, async () => Promise.reject(new Error('inngest down')))).toBe(false)
  })
})
