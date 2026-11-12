/**
 * The end of a call whose notes the call recorder took
 * (src/lib/team-calls/fed-notes.ts, and the finish in
 * src/lib/inngest/team-call-notes.ts): the finish waits for the recorder to
 * say it delivered its last words (its `end`), at most FED_TAIL_CAP_MS, and
 * not for one that had gone quiet before the call ended; then the capture is
 * locked by 588's team_call_capture_lock, which writes the transcript once
 * more in the order things were said from every segment, in the database
 * (the app reads no segment: no page cap), the notes opening with what they
 * lack (a stretch the recorder did not hear, notes on for part of the
 * call); a silent call leaves no capture; the end-of-meeting pass runs as
 * the owner (the batch only when anything was said); the finish's retries
 * spent: the capture is locked as it stands, never left open.
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

import { CLOSED_CAPTURE_PASS_ATTEMPTS, FED_TAIL_CAP_MS, closedCapturesToFinish, fedNotesStatus, writeFedNotes } from '../fed-notes'
import { closedCaptureFinishEvent } from '../notes-store'
import { runTeamCallNotesFinish, teamCallNotesFinishFailed } from '@/lib/inngest/team-call-notes'

let tables: Record<string, Array<Record<string, unknown>>>
let lockAnswers: Array<Record<string, unknown>>
let finishAnswers: Array<Record<string, unknown>>
let closedAnswer: Array<Record<string, unknown>> = []

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
      {
        id: 's1',
        source_kind: 'team_call',
        source_ref: CALL,
        round: 1,
        status: 'ended',
        started_at: '2026-11-11T10:00:00.000Z',
        ended_at: '2026-11-11T10:30:00.000Z',
        heartbeat_at: '2026-11-11T10:29:58.000Z',
        delivered_at: '2026-11-11T10:30:02.000Z',
        gaps: [{ from: '2026-11-11T10:10:00.000Z', to: '2026-11-11T10:12:00.000Z' }],
      },
    ],
  }
  // Every table and column read here is one the migrations make (src/test/table-schema.ts); no
  // segment is read in the app (the lock reads them all in the database).
  const db = withTableSchema(memoryDb(tables), ['team_call', 'capture_feed_session']) as unknown as { rpc: unknown }
  db.rpc = async (name: string, args: Record<string, unknown>) => {
    h.rpcs.push([name, args])
    if (name === 'team_call_capture_lock') {
      h.locks.push(args)
      return { data: [lockAnswers.shift() ?? { outcome: 'ready', capture_id: CAPTURE, owner_user: 'u-rosa', workspace_id: 'ws', spoke: true }], error: null }
    }
    if (name === 'team_call_capture_finish') {
      return { data: [finishAnswers.shift() ?? { outcome: 'done' }], error: null }
    }
    if (name === 'team_call_capture_pass_done') return { data: true, error: null }
    if (name === 'team_call_closed_captures') return { data: closedAnswer, error: null }
    return { data: null, error: { message: `no answer for ${name}` } }
  }
  h.svc = db as unknown as SupabaseClient
}

beforeEach(() => {
  h.rpcs = []
  h.locks = []
  h.calls = []
  lockAnswers = []
  finishAnswers = []
  seed()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('writeFedNotes', () => {
  it('locks the capture once, the transcript rebuilt in the database in the order said, what the notes missed first', async () => {
    const out = await writeFedNotes(h.svc, CALL)
    expect(out).toEqual({ outcome: 'ready', captureId: CAPTURE, ownerUserId: 'u-rosa', workspaceId: 'ws', spoke: true })
    expect(h.locks).toEqual([
      {
        target_call: CALL,
        preamble_text: 'Notes missed about 2 min from 10 min into the call (the recorder stopped hearing it).',
        rebuild: true,
      },
    ])
  })

  it('a session still waited on: one that has not said it delivered, unless it went quiet before the call ended', async () => {
    expect((await fedNotesStatus(h.svc, CALL)).undelivered).toBe(0)
    tables.capture_feed_session[0].delivered_at = null
    expect((await fedNotesStatus(h.svc, CALL)).undelivered).toBe(1)
    // Quiet for two minutes before the end (the sweeper's lost bound is 90 s): nothing more is coming from it.
    tables.capture_feed_session[0].heartbeat_at = '2026-11-11T10:28:00.000Z'
    expect((await fedNotesStatus(h.svc, CALL)).undelivered).toBe(0)
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
  const step = (onSleep?: (id: string) => void) => ({
    run: async <T,>(_id: string, fn: () => Promise<T>) => fn(),
    sleep: async (id: string) => {
      h.calls.push(`sleep:${id}`)
      onSleep?.(id)
    },
  })

  it('the recorder already said it delivered everything: locked at once, then the batch and the title and index as the owner', async () => {
    const out = await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(out).toEqual({ status: 'ready', captureId: CAPTURE })
    expect(h.calls).toEqual([`batch:${CAPTURE}:u-rosa`, `post:${CAPTURE}:false`])
    // The pass is marked done, so the sweeper never asks for it again.
    expect(h.rpcs.map(([name]) => name)).toEqual(['team_call_capture_lock', 'team_call_capture_pass_done'])
  })

  it('waits for the recorder’s last words (its end), looking every few seconds, then locks', async () => {
    tables.capture_feed_session[0].delivered_at = null
    const out = await runTeamCallNotesFinish({
      event: { data: { callId: CALL } },
      step: step((id) => {
        if (id === 'feed-tail-2') tables.capture_feed_session[0].delivered_at = '2026-11-11T10:30:09.000Z'
      }),
    })
    expect(out).toEqual({ status: 'ready', captureId: CAPTURE })
    expect(h.calls).toEqual(['sleep:feed-tail-1', 'sleep:feed-tail-2', `batch:${CAPTURE}:u-rosa`, `post:${CAPTURE}:false`])
    expect(h.locks).toHaveLength(1)
  })

  it('a recorder that never says it is done is waited for at most the cap; what it delivered by then is in the notes', async () => {
    tables.capture_feed_session[0].delivered_at = null
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    const sleeps = h.calls.filter((c) => c.startsWith('sleep:'))
    expect(sleeps).toHaveLength(Math.ceil(FED_TAIL_CAP_MS / 5000))
    expect(h.locks).toEqual([expect.objectContaining({ target_call: CALL, rebuild: true })])
  })

  it('nothing said but the owner wrote notes in it: no batch, the record closed', async () => {
    lockAnswers = [{ outcome: 'ready', capture_id: CAPTURE, owner_user: 'u-rosa', workspace_id: 'ws', spoke: false }]
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(h.calls).toEqual([`post:${CAPTURE}:true`])
  })

  it('a call still live, or notes already locked: skipped', async () => {
    tables.team_call[0].status = 'live'
    expect(await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })).toEqual({ status: 'skipped', reason: 'live' })
    tables.team_call[0].status = 'ended'
    tables.team_call[0].notes_state = 'ready'
    expect(await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })).toEqual({ status: 'skipped', reason: 'ready' })
    expect(h.locks).toEqual([])
  })

  it('a capture its owner closed by hand mid-call: finished then, and its end-of-meeting pass, as its owner', async () => {
    const EARLIER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    finishAnswers = [{ outcome: 'ready', call_id: CALL, capture_id: EARLIER, owner_user: 'u-rosa', workspace_id: 'ws', spoke: true }]
    const out = await runTeamCallNotesFinish({ event: { data: { callId: CALL, captureId: EARLIER } }, step: step() })
    expect(out).toEqual({ status: 'ready', captureId: EARLIER })
    expect(h.rpcs).toEqual([
      ['team_call_capture_finish', { target_capture: EARLIER }],
      ['team_call_capture_pass_done', { target_capture: EARLIER }],
    ])
    expect(h.calls).toEqual([`batch:${EARLIER}:u-rosa`, `post:${EARLIER}:false`])
    // Asked again (the sweeper, a retry): finished already, nothing run twice; the call's own finish is untouched.
    h.calls = []
    expect(await runTeamCallNotesFinish({ event: { data: { callId: CALL, captureId: EARLIER } }, step: step() })).toEqual({ status: 'skipped', reason: 'done' })
    expect(h.calls).toEqual([])
    expect(h.locks).toEqual([])
  })

  it('a closed capture where nothing was said: ended, the record closed, no batch', async () => {
    const EARLIER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    finishAnswers = [{ outcome: 'ready', call_id: CALL, capture_id: EARLIER, owner_user: 'u-rosa', workspace_id: 'ws', spoke: false }]
    await runTeamCallNotesFinish({ event: { data: { callId: CALL, captureId: EARLIER } }, step: step() })
    expect(h.calls).toEqual([`post:${EARLIER}:true`])
  })

  it('retries spent: the capture is locked as it stands', async () => {
    await teamCallNotesFinishFailed({ event: { data: { event: { data: { callId: CALL } } } } })
    expect(h.locks).toEqual([{ target_call: CALL, preamble_text: '', rebuild: false }])
  })

  it('retries spent on a closed capture: it is ended, its pass NOT marked done (the sweeper asks for it again)', async () => {
    const EARLIER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    await teamCallNotesFinishFailed({ event: { data: { event: { data: { callId: CALL, captureId: EARLIER } } } } })
    expect(h.rpcs).toEqual([['team_call_capture_finish', { target_capture: EARLIER }]])
    expect(h.locks).toEqual([])
  })

  it('the sweeper’s asks: each a fresh event (never deduplicated away), at most a few times, then given up', async () => {
    const EARLIER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    closedAnswer = [
      { kind: 'retry', call_id: CALL, capture_id: EARLIER, attempt: 2 },
      { kind: 'given_up', call_id: CALL, capture_id: CAPTURE, attempt: 3 },
    ]
    const asked = await closedCapturesToFinish(h.svc)
    expect(h.rpcs.at(-1)).toEqual(['team_call_closed_captures', { max_rows: 20, max_attempts: CLOSED_CAPTURE_PASS_ATTEMPTS }])
    expect(asked).toEqual({ retry: [{ callId: CALL, captureId: EARLIER, attempt: 2 }], givenUp: [{ callId: CALL, captureId: CAPTURE, attempts: 3 }] })
    const first = closedCaptureFinishEvent(CALL, EARLIER)
    const ids = [first.id, closedCaptureFinishEvent(CALL, EARLIER, 1).id, closedCaptureFinishEvent(CALL, EARLIER, 2).id]
    expect(new Set(ids).size).toBe(3)
    expect(closedCaptureFinishEvent(CALL, EARLIER, 2).data).toEqual({ callId: CALL, captureId: EARLIER })
  })
})
