/**
 * The call's finish and the live agent's last turn (src/lib/inngest/
 * team-call-notes.ts, src/lib/team-calls/live-turns.ts): a turn still
 * running when the call ended is waited for before the end-of-meeting pass,
 * so its summary edit never lands on top of the pass's; with the live agent
 * off, its table is never read and nothing waits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const CALL = '77777777-7777-4777-8777-777777777777'
const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const h = vi.hoisted(() => ({ on: true, busy: [] as boolean[], calls: [] as string[] }))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: () => ({}) } }))
vi.mock('../capture-finalizer', () => ({
  runOwnerBatch: async () => (h.calls.push('batch'), 'completed'),
  postExtraction: async () => void h.calls.push('post'),
}))
vi.mock('@/lib/team-calls/egress', () => ({ teamCallEgressConfig: () => null, liveKitEgress: () => ({}) }))
vi.mock('@/lib/team-calls/fed-notes', () => ({
  FED_TAIL_CAP_MS: 120_000,
  markPassDone: async () => true,
  fedNotesStatus: async () => ({ fed: true, callStatus: 'ended', notesState: 'capturing', endedAt: null, undelivered: 0 }),
  writeFedNotes: async () => ({ outcome: 'ready', captureId: CAPTURE, ownerUserId: 'u-dana', workspaceId: 'ws', spoke: true }),
  finishClosedCapture: async () => ({ outcome: 'ready', captureId: CAPTURE, ownerUserId: 'u-dana', workspaceId: 'ws', spoke: true }),
  lockFedNotesAsTheyAre: async () => null,
}))
vi.mock('@/lib/team-calls/live-turns', () => ({
  teamCallLiveAgentOn: () => h.on,
  liveTurnBusy: async () => {
    h.calls.push('busy?')
    return h.busy.length ? h.busy.shift()! : false
  },
}))

const { runTeamCallNotesFinish } = await import('../team-call-notes')

function step() {
  return {
    run: async <T,>(_id: string, fn: () => Promise<T>) => fn(),
    sleep: async (id: string) => void h.calls.push(`sleep:${id.replace(/-\d+$/, '')}`),
  }
}

beforeEach(() => {
  h.on = true
  h.busy = []
  h.calls = []
})

describe('the finish and a live turn still running', () => {
  it('waits for it before the end-of-meeting pass', async () => {
    h.busy = [true, true, false]
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(h.calls).toEqual(['busy?', 'sleep:live-turn-wait', 'busy?', 'sleep:live-turn-wait', 'busy?', 'batch', 'post'])
  })

  it('a capture closed by hand mid-call waits the same way', async () => {
    h.busy = [true, false]
    await runTeamCallNotesFinish({ event: { data: { callId: CALL, captureId: CAPTURE } }, step: step() })
    expect(h.calls).toEqual(['busy?', 'sleep:live-turn-wait', 'busy?', 'batch', 'post'])
  })

  it('with the live agent off, nothing is read and nothing waits', async () => {
    h.on = false
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(h.calls).toEqual(['batch', 'post'])
  })
})
