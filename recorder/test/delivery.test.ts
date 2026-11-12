import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppClient, AppError, type RosterEvent, type Segment } from '../src/app-client.ts'
import { Delivery, nextBatch, type Item } from '../src/delivery.ts'
import { Keys, feedMs, identityOf, mayHear, rosterEvent, segmentOf } from '../src/speech.ts'
import { loadConfig } from '../src/config.ts'

const MEMBER = '33333333-3333-4333-8333-333333333333'
const GUEST = '44444444-4444-4444-8444-444444444444'

const roster = (key: string): Item => ({ kind: 'roster', event: { key, speaker: MEMBER, kind: 'joined', atMs: 0 } })
const seg = (key: string): Item => ({ kind: 'segment', segment: { key, speaker: MEMBER, text: 'hi', startMs: 0, endMs: 1 } })

test('a request takes the items of one kind at the head, in order', () => {
  assert.deepEqual(nextBatch([]), [])
  const q = [roster('r1'), seg('s1'), seg('s2'), roster('r2'), seg('s3')]
  assert.deepEqual(nextBatch(q).map((i) => (i.kind === 'roster' ? i.event.key : i.segment.key)), ['r1'])
  assert.deepEqual(nextBatch(q.slice(1)).map((i) => (i.kind === 'roster' ? i.event.key : i.segment.key)), ['s1', 's2'])
  assert.equal(nextBatch(Array.from({ length: 250 }, (_, i) => seg(`s${i}`))).length, 100)
})

test('a roster event always goes before words said after it, and a failed request is sent again as it was', async () => {
  const calls: string[] = []
  let failSegments = 2
  const d = new Delivery(
    {
      roster: async (events: readonly RosterEvent[]) => {
        calls.push(`roster:${events.map((e) => e.key).join(',')}`)
      },
      segments: async (segments: readonly Segment[]) => {
        calls.push(`segments:${segments.map((s) => s.key).join(',')}`)
        if (failSegments-- > 0) throw new AppError('down', 503, 'FEED_RETRY')
      },
    },
    { backoff: { baseMs: 1, maxMs: 2 } },
  )
  d.push(roster('r1'))
  d.push(seg('s1'))
  d.push(seg('s2'))
  assert.equal(await d.flush(2000), true)
  assert.deepEqual(calls, ['roster:r1', 'segments:s1,s2', 'segments:s1,s2', 'segments:s1,s2'])
  assert.equal(d.pending, 0)
})

test('a capture that is finished, or a session that is another producer’s, takes nothing more', async () => {
  let dead: string | null = null
  const d = new Delivery(
    {
      roster: async () => undefined,
      segments: async () => {
        throw new AppError('locked', 409, 'FEED_LOCKED')
      },
    },
    { onDead: (why) => (dead = why), backoff: { baseMs: 1, maxMs: 1 } },
  )
  d.push(seg('s1'))
  await d.flush(500)
  assert.equal(dead, 'FEED_LOCKED')
  d.push(seg('s2'))
  assert.equal(d.pending, 0)
})

test('a malformed batch is dropped, and the rest go on', async () => {
  const calls: string[] = []
  const d = new Delivery({
    roster: async (events: readonly RosterEvent[]) => {
      calls.push(`roster:${events[0].key}`)
    },
    segments: async () => {
      throw new AppError('bad', 400, null)
    },
  })
  d.push(seg('s1'))
  d.push(roster('r2'))
  assert.equal(await d.flush(500), true)
  assert.deepEqual(calls, ['roster:r2'])
})

test('batched: what is said within a few seconds goes in one request, and a flush sends at once', async () => {
  const calls: string[] = []
  const d = new Delivery(
    {
      roster: async (events: readonly RosterEvent[]) => {
        calls.push(`roster:${events.map((e) => e.key).join(',')}`)
      },
      segments: async (segments: readonly Segment[]) => {
        calls.push(`segments:${segments.map((s) => s.key).join(',')}`)
      },
    },
    { everyMs: 80 },
  )
  d.push(seg('s1'))
  d.push(seg('s2'))
  await new Promise((r) => setTimeout(r, 20))
  d.push(seg('s3'))
  assert.deepEqual(calls, [], 'nothing is sent before the window closes')
  await new Promise((r) => setTimeout(r, 120))
  assert.deepEqual(calls, ['segments:s1,s2,s3'])
  d.push(seg('s4'))
  d.push(roster('r1'))
  d.push(seg('s5'))
  assert.equal(await d.flush(1000), true)
  assert.deepEqual(calls, ['segments:s1,s2,s3', 'segments:s4', 'roster:r1', 'segments:s5'])
})

test('consent: every member is heard; a meeting guest only once the app lists them', () => {
  const none = new Set<string>()
  const listed = new Set([GUEST])
  assert.equal(mayHear(MEMBER, none), true)
  assert.equal(mayHear(`guest-${GUEST}`, none), false)
  assert.equal(mayHear(`guest-${GUEST}`, listed), true)
  assert.equal(mayHear(`guest-${GUEST.toUpperCase()}`, listed), true)
  assert.equal(mayHear('notes-recorder-recorder', listed), false)
  assert.equal(mayHear('EG_abc', listed), false)
})

test('identities: a member id, a meeting guest, and nobody else', () => {
  assert.deepEqual(identityOf(MEMBER), { memberId: MEMBER })
  assert.deepEqual(identityOf(MEMBER.toUpperCase()), { memberId: MEMBER })
  assert.deepEqual(identityOf(`guest-${GUEST}`), { guestId: GUEST })
  assert.equal(identityOf('notes-recorder'), null)
  assert.equal(identityOf('EG_abc'), null)
  assert.equal(identityOf('guest-nope'), null)
  assert.equal(rosterEvent('notes-recorder', 'joined', 0, 0, 'k'), null)
  assert.deepEqual(rosterEvent(`guest-${GUEST}`, 'left', 2500, 1000, 'k1'), { key: 'k1', speaker: `guest-${GUEST}`, kind: 'left', atMs: 1500, identity: { guestId: GUEST } })
})

test('a segment: its words tidied, its times in the feed’s clock, never before its start; no words, no segment', () => {
  assert.equal(feedMs(500, 1000), 0)
  assert.deepEqual(segmentOf({ text: '  Hello\n there ', startWallMs: 2000, endWallMs: 2600 }, MEMBER, 1000, 'k'), { key: 'k', speaker: MEMBER, text: 'Hello there', startMs: 1000, endMs: 1600 })
  assert.equal(segmentOf({ text: '   ', startWallMs: 0, endWallMs: 1 }, MEMBER, 0, 'k'), null)
  assert.equal(segmentOf({ text: 'x'.repeat(5000), startWallMs: 0, endWallMs: 1 }, MEMBER, 0, 'k')!.text.length, 4000)
})

test('keys repeat only within a retry: per process, per track, in order', () => {
  const a = new Keys('p1')
  assert.equal(a.next('TR_1'), 'p1.TR_1.1')
  assert.equal(a.next('TR_1'), 'p1.TR_1.2')
  assert.notEqual(new Keys('p2').next('TR_1'), 'p1.TR_1.1')
})

test('settings: the three it cannot run without, and the defaults', () => {
  assert.deepEqual(loadConfig({}), { missing: ['RECORDER_APP_URL', 'CAPTURE_FEED_SECRET', 'RECORDER_DEEPGRAM_API_KEY'] })
  assert.deepEqual(loadConfig({ RECORDER_APP_URL: 'https://app.example.dev/path', CAPTURE_FEED_SECRET: 's', RECORDER_DEEPGRAM_API_KEY: 'k' }), { missing: ['RECORDER_APP_URL'] })
  const c = loadConfig({ RECORDER_APP_URL: 'https://app.example.dev/', CAPTURE_FEED_SECRET: 's', RECORDER_DEEPGRAM_API_KEY: 'k', RECORDER_MAX_CALLS: '99' })
  assert.ok(!('missing' in c))
  if ('missing' in c) return
  assert.equal(c.appUrl, 'https://app.example.dev')
  assert.equal(c.livekitUrl, 'ws://livekit:7880')
  assert.equal(c.producerId, 'recorder')
  assert.equal(c.maxCalls, 10)
})

test('the app client sends the secret and the producer, and says which answers are worth another try', async () => {
  const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = []
  const answers = [new Response(JSON.stringify({ jobs: [], pollMs: 2500 })), new Response('{"code":"FEED_LOCKED"}', { status: 409 }), new Response('', { status: 503 })]
  const client = new AppClient({
    appUrl: 'https://app.example.dev/',
    secret: 'feed-secret',
    producer: { kind: 'livekit_recorder', id: 'recorder' },
    fetch: async (url, init) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) })
      return answers.shift()!
    },
  })
  assert.deepEqual(await client.work([], 3), { jobs: [], pollMs: 2500 })
  assert.equal(seen[0].url, 'https://app.example.dev/api/internal/team-call-recorder/work')
  assert.equal(seen[0].auth, 'Bearer feed-secret')
  assert.deepEqual(seen[0].body, { producer: { kind: 'livekit_recorder', id: 'recorder' }, running: [], capacity: 3 })
  await assert.rejects(client.segments('s1', []), (e: AppError) => e.status === 409 && e.code === 'FEED_LOCKED' && !e.retry)
  await assert.rejects(client.end('s1', 'told'), (e: AppError) => e.status === 503 && e.retry)
})

test('the app client reads whom a session may hear: at its start, and at every heartbeat (only a kept one)', async () => {
  const answers = [
    new Response(JSON.stringify({ outcome: 'started', session: { id: 's1', startedAt: '2026-11-11T10:00:00.000Z', round: 1, captureId: 'c1', guests: [GUEST] } })),
    new Response(JSON.stringify({ outcome: 'started', session: { id: 's2', startedAt: '2026-11-11T10:00:00.000Z', round: 1, captureId: 'c2' } })),
    new Response(JSON.stringify({ sessions: [{ id: 's1', keep: true, reason: null, guests: [GUEST] }, { id: 's2', keep: false, reason: 'notes_off', guests: [GUEST] }, { keep: true }] })),
  ]
  const client = new AppClient({ appUrl: 'https://app.example.dev', secret: 'x', producer: { kind: 'livekit_recorder', id: 'recorder' }, fetch: async () => answers.shift()! })
  assert.deepEqual((await client.start('call-1')).session?.guests, [GUEST])
  assert.deepEqual((await client.start('call-2')).session?.guests, [])
  assert.deepEqual(await client.heartbeat(['s1', 's2']), [
    { id: 's1', keep: true, reason: null, guests: [GUEST] },
    { id: 's2', keep: false, reason: 'notes_off', guests: [] },
  ])
})
