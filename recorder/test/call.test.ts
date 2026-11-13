import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Room } from '@livekit/rtc-node'
import { CallRecorder, TIMEOUT, within } from '../src/call.ts'
import type { AppClient, FeedSession, Job } from '../src/app-client.ts'
import type { AudioKeeper, CallAudio } from '../src/audio.ts'
import { Keys } from '../src/speech.ts'

// A call with its sound on, whose disk never answers: the call is heard all the same, it says
// `end` when it leaves, frees its slot, and a shutdown is not held up.

const job: Job = { callId: '77777777-7777-4777-8777-777777777777', room: 'tc-x', round: 1, token: 'jwt' }
const session: FeedSession = { id: '99999999-9999-4999-8999-999999999999', startedAt: new Date().toISOString(), round: 1, captureId: 'c', guests: [], audio: true }

/** A room that connects at once and has nobody in it. */
function fakeRoom(): Room {
  const room = {
    remoteParticipants: new Map(),
    on() {
      return room
    },
    connect: async () => undefined,
    disconnect: async () => undefined,
  }
  return room as unknown as Room
}

function fakeClient() {
  const ends: string[] = []
  const client = {
    roster: async () => [],
    segments: async () => ({ accepted: 0, duplicate: 0, dropped: 0 }),
    end: async (_id: string, why: string) => {
      ends.push(why)
      return true
    },
  }
  return { client: client as unknown as AppClient, ends }
}

const never = <T>() => new Promise<T>(() => undefined)

function recorder(audio: Pick<AudioKeeper, 'openTake'>) {
  const { client, ends } = fakeClient()
  const rec = new CallRecorder(job, session, {
    client,
    livekitUrl: 'ws://livekit.test',
    deepgramUrl: 'wss://deepgram.test',
    deepgramKey: 'k',
    maxCallMs: 60_000,
    keys: new Keys('t'),
    audio,
    audioOpenMs: 150,
    audioEndMs: 200,
    room: fakeRoom(),
  })
  return { rec, ends }
}

test('within: the value when it comes in time, else the timeout', async () => {
  assert.equal(await within(Promise.resolve(3), 50), 3)
  assert.equal(await within(never<number>(), 20), TIMEOUT)
})

test('a disk that never answers when the take opens: the call is joined and heard without its sound, in bounded time', async () => {
  let asked = 0
  const { rec, ends } = recorder({ openTake: () => (asked++, never<CallAudio | null>()) })
  const t0 = Date.now()
  await rec.start()
  assert.ok(Date.now() - t0 < 1000, `start took ${Date.now() - t0} ms`)
  assert.equal(asked, 1)
  await rec.stop('told', { flushMs: 50 })
  assert.deepEqual(ends, ['told'])
  assert.equal(await rec.done, 'told')
})

test('a disk that never answers when the take finishes: the call still says end, frees its slot, and leaves in bounded time', async () => {
  let ended = 0
  const take = { meta: { take: 't-1' }, end: () => (ended++, never<void>()), push() {}, skip() {}, forget() {} } as unknown as CallAudio
  const { rec, ends } = recorder({ openTake: async () => take })
  await rec.start()
  const t0 = Date.now()
  await rec.stop('told', { flushMs: 50 })
  assert.ok(Date.now() - t0 < 1500, `stop took ${Date.now() - t0} ms`)
  assert.equal(ended, 1)
  assert.deepEqual(ends, ['told'])
  assert.equal(await rec.done, 'told')
})

test('a shutdown with a hung disk: the take is paused (not finished), the call leaves in bounded time, and says no end', async () => {
  const hows: string[] = []
  const take = { meta: { take: 't-1' }, end: (how: string) => (hows.push(how), never<void>()), push() {}, skip() {}, forget() {} } as unknown as CallAudio
  const { rec, ends } = recorder({ openTake: async () => take })
  await rec.start()
  const t0 = Date.now()
  await rec.stop('shutdown', { flushMs: 50 })
  assert.ok(Date.now() - t0 < 1500)
  assert.deepEqual(hows, ['pause'])
  assert.deepEqual(ends, [])
})

test('a take that opens after its time is finished at once (it heard nothing), never left open', async () => {
  const hows: string[] = []
  let open: (t: CallAudio) => void = () => undefined
  const take = { meta: { take: 't-late' }, end: async (how: string) => void hows.push(how), push() {}, skip() {}, forget() {} } as unknown as CallAudio
  const { rec } = recorder({ openTake: () => new Promise<CallAudio | null>((r) => (open = r)) })
  await rec.start()
  open(take)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(hows, ['finish'])
  await rec.stop('told', { flushMs: 50 })
})
