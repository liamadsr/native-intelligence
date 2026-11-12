/**
 * The end of a call whose notes the call recorder took
 * (src/lib/team-calls/fed-notes.ts, and the finish in
 * src/lib/inngest/team-call-notes.ts): the capture is locked with its
 * transcript written once more in the order things were said, the notes
 * open with what they lack (a stretch the recorder did not hear, notes on
 * for part of the call), words that came in between the read and the lock
 * are read again; a silent call leaves no capture; the end-of-meeting pass
 * runs as the owner (the batch only when anything was said); the finish's
 * retries spent: the capture is locked as it stands, never left open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { withTableSchema } from '@/test/table-schema'

const CALL = '77777777-7777-4777-8777-777777777777'
const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const h = vi.hoisted(() => ({
  svc: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  locks: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.svc }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: () => ({}) } }))
vi.mock('@/lib/inngest/capture-finalizer', () => ({
  runOwnerBatch: async (_svc: unknown, args: { captureId: string; ownerId: string }) => {
    h.calls.push(`batch:${args.captureId}:${args.ownerId}`)
    return 'completed'
  },
  postExtraction: async (_svc: unknown, args: { captureId: string; captureProcessed: boolean }) => {
    h.calls.push(`post:${args.captureId}:${args.captureProcessed}`)
  },
}))

import { fedNotesStatus, writeFedNotes } from '../fed-notes'
import { runTeamCallNotesFinish, teamCallNotesFinishFailed } from '@/lib/inngest/team-call-notes'

let tables: Record<string, Array<Record<string, unknown>>>
let lockAnswers: Array<Record<string, unknown>>

function seed() {
  tables = {
    team_call: [
      {
        id: CALL,
        status: 'ended',
        started_at: '2026-11-11T10:00:00.000Z',
        ended_at: '2026-11-11T10:30:00.000Z',
        duration_seconds: 1800,
        notes_seconds: 1800,
        notes_state: 'transcribing',
        capture_id: CAPTURE,
      },
    ],
    capture_feed_session: [
      { id: 's1', source_kind: 'team_call', source_ref: CALL, round: 1, status: 'ended', started_at: '2026-11-11T10:00:00.000Z', ended_at: '2026-11-11T10:30:00.000Z', gaps: [{ from: '2026-11-11T10:10:00.000Z', to: '2026-11-11T10:12:00.000Z' }] },
    ],
    capture_feed_segment: [
      { session_id: 's1', capture_id: CAPTURE, key: 'k2', speaker_key: 'b', said_at: '2026-11-11T10:00:04.000Z', start_ms: 4000, end_ms: 5000, text: 'Sounds good.' },
      { session_id: 's1', capture_id: CAPTURE, key: 'k1', speaker_key: 'a', said_at: '2026-11-11T10:00:01.000Z', start_ms: 1000, end_ms: 2000, text: 'Shall we start?' },
    ],
    capture_feed_speaker: [
      { capture_id: CAPTURE, speaker_key: 'a', participant_id: 'p-a' },
      { capture_id: CAPTURE, speaker_key: 'b', participant_id: 'p-b' },
    ],
    capture_participant: [
      { id: 'p-a', capture_id: CAPTURE, source: 'call_roster', speaker_label: 'Rosa Lind' },
      { id: 'p-b', capture_id: CAPTURE, source: 'call_roster', speaker_label: 'Lee Park' },
    ],
  }
  // Every table and column read here is one the migrations make (src/test/table-schema.ts).
  const db = withTableSchema(memoryDb(tables), ['team_call', 'capture_feed_session', 'capture_feed_segment', 'capture_feed_speaker', 'capture_participant']) as SupabaseClient & { rpc: unknown }
  db.rpc = async (name: string, args: Record<string, unknown>) => {
    h.rpcs.push([name, args])
    if (name === 'team_call_capture_lock') {
      h.locks.push(args)
      return { data: [lockAnswers.shift() ?? { outcome: 'ready', capture_id: CAPTURE, owner_user: 'u-rosa', workspace_id: 'ws', spoke: true }], error: null }
    }
    return { data: null, error: { message: `no answer for ${name}` } }
  }
  h.svc = db
}

beforeEach(() => {
  h.rpcs = []
  h.locks = []
  h.calls = []
  lockAnswers = []
  seed()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('writeFedNotes', () => {
  it('locks the capture with the words in the order said, and what the notes missed first', async () => {
    const out = await writeFedNotes(h.svc, CALL)
    expect(out).toEqual({ outcome: 'ready', captureId: CAPTURE, ownerUserId: 'u-rosa', workspaceId: 'ws', spoke: true })
    expect(h.locks).toEqual([
      {
        target_call: CALL,
        transcript_text: '[Rosa Lind] Shall we start?\n[Lee Park] Sounds good.',
        preamble_text: 'Notes missed about 2 min from 10 min into the call (the recorder stopped hearing it).',
        segment_count: 2,
      },
    ])
  })

  it('words that came between the read and the lock: read again', async () => {
    lockAnswers = [{ outcome: 'changed', capture_id: CAPTURE, owner_user: 'u-rosa', workspace_id: 'ws', spoke: true }]
    expect((await writeFedNotes(h.svc, CALL)).outcome).toBe('ready')
    expect(h.locks).toHaveLength(2)
  })

  it('nothing said: silent, no capture left', async () => {
    lockAnswers = [{ outcome: 'silent', capture_id: null, owner_user: null, workspace_id: 'ws', spoke: false }]
    expect(await writeFedNotes(h.svc, CALL)).toEqual({ outcome: 'silent' })
  })

  it('a live call is not written; a call that is one of Egress’s is not the recorder’s', async () => {
    tables.team_call[0].status = 'live'
    expect(await writeFedNotes(h.svc, CALL)).toEqual({ outcome: 'skipped' })
    expect(h.locks).toEqual([])
    tables.capture_feed_session.splice(0)
    tables.team_call[0].capture_id = null
    expect((await fedNotesStatus(h.svc, CALL)).fed).toBe(false)
  })
})

describe('the finish, for the recorder’s notes', () => {
  const step = () => ({
    run: async <T,>(_id: string, fn: () => Promise<T>) => fn(),
    sleep: async (id: string) => {
      h.calls.push(`sleep:${id}`)
    },
  })

  it('gives the recorder its tail, locks, then the batch and the title and index as the owner', async () => {
    const out = await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(out).toEqual({ status: 'ready', captureId: CAPTURE })
    expect(h.calls).toEqual(['sleep:let-feed-finish', `batch:${CAPTURE}:u-rosa`, `post:${CAPTURE}:false`])
  })

  it('nothing said but the owner wrote notes in it: no batch, the record closed', async () => {
    lockAnswers = [{ outcome: 'ready', capture_id: CAPTURE, owner_user: 'u-rosa', workspace_id: 'ws', spoke: false }]
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(h.calls).toEqual(['sleep:let-feed-finish', `post:${CAPTURE}:true`])
  })

  it('a call still live, or notes already locked: skipped', async () => {
    tables.team_call[0].status = 'live'
    expect(await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })).toEqual({ status: 'skipped', reason: 'live' })
    tables.team_call[0].status = 'ended'
    tables.team_call[0].notes_state = 'ready'
    expect(await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })).toEqual({ status: 'skipped', reason: 'ready' })
    expect(h.locks).toEqual([])
  })

  it('retries spent: the capture is locked as it stands', async () => {
    await teamCallNotesFinishFailed({ event: { data: { event: { data: { callId: CALL } } } } })
    expect(h.locks).toEqual([{ target_call: CALL, transcript_text: null, preamble_text: '', segment_count: -1 }])
  })
})
