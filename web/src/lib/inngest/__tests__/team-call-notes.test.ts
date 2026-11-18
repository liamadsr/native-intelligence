/**
 * A call's notes after the call (src/lib/inngest/team-call-notes.ts): the
 * finish waits for every egress and every file's words, asks again for the
 * words still to come, asks LiveKit to stop egresses still running halfway,
 * gives up on what never came (failed, audio kept), then writes the notes
 * and runs the end-of-meeting batch as their owner, then removes the audio;
 * a silent call gets no capture; a call whose notes are not being written
 * is skipped. A file's retries spent: failed. The finish's retries spent:
 * the notes failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const CALL = '77777777-7777-4777-8777-777777777777'
const ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const h = vi.hoisted(() => ({
  statuses: [] as unknown[],
  written: { outcome: 'ready', captureId: '', ownerUserId: 'u-ana', workspaceId: 'ws' } as Record<string, unknown>,
  calls: [] as string[],
  asked: [] as string[][],
  stopped: 0,
  gaveUp: null as unknown,
  settled: [] as Array<[string, string]>,
  marked: [] as Array<[string, string]>,
  stopArgs: [] as Array<[string, boolean]>,
  stopFails: false,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: () => ({}) } }))
vi.mock('../capture-finalizer', () => ({
  CallNotesLiveError: class CallNotesLiveError extends Error {},
  runOwnerBatch: async (_svc: unknown, args: { captureId: string; ownerId: string }) => {
    h.calls.push(`batch:${args.captureId}:${args.ownerId}`)
    return 'completed'
  },
  postExtraction: async (_svc: unknown, args: { captureId: string; captureProcessed: boolean }) => {
    h.calls.push(`post:${args.captureId}:${args.captureProcessed}`)
  },
}))
vi.mock('@/lib/team-calls/egress', () => ({ teamCallEgressConfig: () => ({}), liveKitEgress: () => ({}) }))
// Egress's notes here; the call recorder's finish has its own file (fed-notes.test.ts).
vi.mock('@/lib/team-calls/fed-notes', () => ({
  FED_TAIL_CAP_MS: 120_000,
  markPassDone: async () => true,
  fedNotesStatus: async () => ({ fed: false, callStatus: 'ended', notesState: 'transcribing', endedAt: null, undelivered: 0 }),
  writeFedNotes: async () => ({ outcome: 'skipped' }),
  lockFedNotesAsTheyAre: async () => null,
}))
vi.mock('@/lib/team-calls/notes-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/notes-store')>()),
  notesStatus: async () => (h.statuses.length > 1 ? h.statuses.shift() : h.statuses[0]),
  requestNotesFiles: async (ids: string[]) => {
    h.asked.push(ids)
  },
  stopEgresses: async (_svc: unknown, _port: unknown, _call: string, kind: string, opts?: { strict?: boolean }) => {
    h.stopped++
    h.stopArgs.push([kind, opts?.strict === true])
    if (h.stopFails) throw new Error('1 egress(es) not stopped')
    return 1
  },
  giveUpOnNotes: async (_svc: unknown, s: unknown) => {
    h.gaveUp = s
  },
  writeNotes: async () => {
    h.calls.push('write')
    return h.written
  },
  removeNotesAudio: async () => {
    h.calls.push('remove-audio')
    return 2
  },
  settleNotes: async (_svc: unknown, id: string, state: string) => {
    h.settled.push([id, state])
    return true
  },
  markTranscript: async (_svc: unknown, id: string, state: string) => {
    h.marked.push([id, state])
  },
}))

import { FINISH_ROUNDS, runTeamCallNotesFinish, runTeamCallNotesStop, teamCallNotesFileFailed, teamCallNotesFinishFailed } from '../team-call-notes'

function stepTools() {
  const ids: string[] = []
  return {
    ids,
    step: {
      run: async <T,>(id: string, fn: () => Promise<T>) => {
        ids.push(id)
        return fn()
      },
      sleep: async (id: string) => {
        ids.push(id)
      },
    },
  }
}

const status = (over: Record<string, unknown> = {}) => ({ callStatus: 'ended', notesState: 'transcribing', settled: false, pending: [], running: [], ...over })

beforeEach(() => {
  h.statuses = []
  h.written = { outcome: 'ready', captureId: CAPTURE, ownerUserId: 'u-ana', workspaceId: 'ws' }
  h.calls = []
  h.asked = []
  h.stopped = 0
  h.gaveUp = null
  h.settled = []
  h.marked = []
  h.stopArgs = []
  h.stopFails = false
})

describe('the notes finish', () => {
  it('waits for the files, asks for the words still to come, then writes, batches as the owner, and removes the audio', async () => {
    h.statuses = [status({ running: ['r1'] }), status({ pending: [ROW] }), status({ settled: true })]
    const { step, ids } = stepTools()
    const out = await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step })
    expect(out).toEqual({ status: 'ready', captureId: CAPTURE })
    expect(h.asked).toEqual([[ROW]])
    expect(h.calls).toEqual(['write', `batch:${CAPTURE}:u-ana`, `post:${CAPTURE}:false`, 'remove-audio'])
    expect(ids.filter((i) => i.startsWith('wait-'))).toEqual(['wait-1', 'wait-2'])
    expect(h.gaveUp).toBeNull()
  })

  it('egresses still running halfway are asked to stop; what never came is given up on, then the notes are written with what there is', async () => {
    h.statuses = [status({ running: ['r1'], pending: [ROW] })]
    const { step } = stepTools()
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step })
    expect(h.stopped).toBe(1)
    expect(h.asked).toHaveLength(FINISH_ROUNDS)
    expect(h.gaveUp).toMatchObject({ running: ['r1'], pending: [ROW] })
    expect(h.calls[0]).toBe('write')
  })

  it('a silent call: no capture, no batch; its audio removed', async () => {
    h.statuses = [status({ settled: true })]
    h.written = { outcome: 'silent' }
    const { step } = stepTools()
    expect(await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step })).toEqual({ status: 'silent' })
    expect(h.calls).toEqual(['write', 'remove-audio'])
  })

  it('notes not being written (never on, written already, or the call is live): skipped', async () => {
    for (const s of [status({ notesState: 'none' }), status({ notesState: 'ready' }), status({ callStatus: 'live', notesState: 'capturing' })]) {
      h.statuses = [s]
      const { step } = stepTools()
      expect((await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step })).status).toBe('skipped')
    }
    expect(h.calls).toEqual([])
  })

  it('a malformed event does nothing', async () => {
    const { step, ids } = stepTools()
    expect(await runTeamCallNotesFinish({ event: { data: { callId: 'nope' } }, step })).toEqual({ status: 'skipped', reason: 'bad_event' })
    expect(ids).toEqual([])
  })
})

describe('when retries are spent', () => {
  it("a file's: failed (its audio kept, the notes name whose words are missing)", async () => {
    await teamCallNotesFileFailed({ event: { data: { event: { data: { rowId: ROW } } } } })
    expect(h.marked).toEqual([[ROW, 'failed']])
  })
  it("the finish's: the notes failed", async () => {
    await teamCallNotesFinishFailed({ event: { data: { event: { data: { callId: CALL } } } } })
    expect(h.settled).toEqual([[CALL, 'failed']])
  })
})

describe('the notes stop', () => {
  it("strict: a stop LiveKit didn't take throws, so Inngest tries again", async () => {
    const { step } = stepTools()
    expect(await runTeamCallNotesStop({ event: { data: { callId: CALL } }, step })).toEqual({ status: 'done', stopped: 1 })
    expect(h.stopArgs).toEqual([['notes', true]])
    h.stopFails = true
    await expect(runTeamCallNotesStop({ event: { data: { callId: CALL } }, step })).rejects.toThrow('not stopped')
  })
})
