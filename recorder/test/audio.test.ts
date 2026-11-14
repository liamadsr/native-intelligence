import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Mixer, DRIFT_MS } from '../src/mixer.ts'
import { AudioKeeper, diskAllows, encodeArgs, takeKey, type UploadPort } from '../src/audio.ts'
import { AppClient, AppError, type FeedSession } from '../src/app-client.ts'
import { loadConfig } from '../src/config.ts'

const SESSION = '99999999-9999-4999-8999-999999999999'
const RATE = 16_000
const sample = (ms: number) => Math.floor((ms * RATE) / 1000)

function mixer(fromSample = 0, originMs = 0) {
  const out = new Map<number, number>()
  const writes: Array<[number, number]> = []
  const m = new Mixer({
    sampleRate: RATE,
    originMs,
    fromSample,
    latencyMs: 1000,
    capacityMs: 4000,
    write: (at, pcm) => {
      writes.push([at, pcm.length])
      pcm.forEach((v, i) => {
        assert.equal(out.has(at + i), false, `sample ${at + i} written twice`)
        out.set(at + i, v)
      })
    },
  })
  return { m, out, writes }
}
const frame = (value: number, n = 160) => new Int16Array(n).fill(value)

test('mixer: a frame lands at the wall-clock time it was heard, frames that follow run on without gaps', () => {
  const { m, out } = mixer()
  // Three 10 ms frames, the second arriving 4 ms late, the third 3 ms early: still back to back.
  m.push('a', frame(100), 2010)
  m.push('a', frame(100), 2024)
  m.push('a', frame(100), 2027)
  m.finish(5000)
  const first = sample(2000)
  for (let i = 0; i < 480; i++) assert.equal(out.get(first + i), 100, `sample ${i}`)
  assert.equal(out.get(first - 1) ?? 0, 0)
  assert.equal(out.get(first + 480) ?? 0, 0)
})

test('mixer: a muted stretch moves the track’s clock on without sound; its next words land where they were said', () => {
  const { m, out } = mixer()
  m.push('a', frame(100), 1010)
  // Muted for 2 s: its frames still come, and add nothing.
  for (let t = 1020; t <= 3000; t += 10) m.skip('a', 160, t)
  m.push('a', frame(200), 3010)
  m.finish(6000)
  assert.equal(out.get(sample(1000)), 100)
  assert.equal(out.get(sample(2000)) ?? 0, 0)
  assert.equal(out.get(sample(3000)), 200)
})

test('mixer: frames that stopped coming for more than GAP_MS (a real gap) are placed again at their time; the gap is not drift', () => {
  const { m, out } = mixer()
  m.push('a', frame(100), 1010)
  m.push('a', frame(200), 3010)
  m.finish(6000)
  assert.equal(out.get(sample(1010)) ?? 0, 0, 'not run on from the first frame')
  assert.equal(out.get(sample(3000)), 200)
  assert.ok(m.maxDriftMs < 50, `furthest drift ${m.maxDriftMs}`)
})

test('mixer: a burst after a stall (the event loop busy) lands where it was heard, each frame once, nothing doubled', () => {
  const { m, out } = mixer()
  // 50 frames in real time, then 400 ms of stall: the next 40 frames all arrive at once.
  for (let k = 0; k < 50; k++) m.push('a', frame(k + 1), 1010 + k * 10)
  for (let k = 50; k < 90; k++) m.push('a', frame(k + 1), 1500 + 400)
  // Back in real time.
  for (let k = 90; k < 120; k++) m.push('a', frame(k + 1), 1010 + k * 10)
  m.finish(4000)
  for (const k of [0, 49, 50, 70, 89, 90, 119]) assert.equal(out.get(sample(1000 + k * 10) + 5), k + 1, `frame ${k}`)
  assert.equal(m.late, 0)
})

test('mixer: samples lost before they reached the recorder: the track sits early for LAG_HOLD_MS at most, then is moved on (silence for the loss, nothing dropped)', () => {
  const { m, out } = mixer()
  let k = 0
  // 1 s in real time, then 300 ms of frames never arrive, then on in real time for 3 s.
  for (; k < 100; k++) m.push('a', frame(k + 1), 1010 + k * 10)
  for (k = 130; k < 430; k++) m.push('a', frame(k + 1), 1010 + k * 10)
  m.finish(6000)
  // Early on, frame 130 sits where frame 100 would have (300 ms early); 1.5 s later it is back on the clock.
  assert.equal(out.get(sample(1000 + 100 * 10) + 5), 131)
  for (const late of [300, 350, 429]) assert.equal(out.get(sample(1000 + late * 10) + 5), late + 1, `frame ${late}`)
  assert.equal(m.late, 0, 'nothing dropped')
  assert.ok(m.maxDriftMs >= 290 && m.maxDriftMs < 400, `furthest drift ${m.maxDriftMs}`)
})

test('mixer: a track running ahead of the wall clock is held to DRIFT_MS ahead', () => {
  const { m, out } = mixer()
  // 40 frames (400 ms) arriving within the same instant: no frame lands more than DRIFT_MS after it was heard.
  for (let k = 0; k < 40; k++) m.push('a', frame(k + 1), 1010)
  m.finish(4000)
  let last = 0
  for (const [at, v] of out) if (v !== 0) last = Math.max(last, at)
  assert.ok(last <= sample(1010 + DRIFT_MS) + 160, `last sample at ${last}`)
})

test('mixer: two people at once are summed, clamped to 16 bits, never wrapped', () => {
  const { m, out } = mixer()
  m.push('a', frame(30000), 1010)
  m.push('b', frame(30000), 1010)
  m.push('c', frame(-1000), 1010)
  m.finish(3000)
  assert.equal(out.get(sample(1000)), 32767)
  const q = mixer()
  q.m.push('a', frame(-30000), 1010)
  q.m.push('b', frame(-30000), 1010)
  q.m.finish(3000)
  assert.equal(q.out.get(sample(1000)), -32768)
})

test('mixer: written a second behind, in order, each sample once; a frame later than that is dropped and counted', () => {
  const { m, out, writes } = mixer()
  m.push('a', frame(5), 1010)
  m.drain(1500)
  assert.equal(writes.length, 0, 'not yet: under a second old')
  m.drain(2100)
  assert.equal(out.get(sample(1000)), 5)
  // Heard at 1.05 s but arriving after its stretch went out.
  m.push('late', frame(9), 1060)
  assert.equal(m.late, 160)
  m.finish(4000)
  assert.equal(out.get(sample(1050)) ?? 0, 0, 'the late frame added nothing')
  for (let i = 1; i < writes.length; i++) assert.ok(writes[i][0] >= writes[i - 1][0] + writes[i - 1][1])
})

test('mixer: silence is never written, and its length is the take’s whole time', () => {
  const { m, writes } = mixer()
  assert.equal(m.finish(60_000), sample(60_000))
  assert.equal(writes.length, 0)
  assert.equal(m.voiced, false)
})

test('mixer: memory is the window: a frame far ahead pushes out what is held first, never more than the window at once', () => {
  const { m, out, writes } = mixer()
  m.push('a', frame(1), 1010)
  m.push('a', frame(2), 60_010)
  assert.equal(out.get(sample(1000)), 1)
  for (const [, n] of writes) assert.ok(n <= sample(4000))
  m.finish(61_000)
  assert.equal(out.get(sample(60_000)), 2)
})

test('mixer: a take taken up again never writes over what an earlier process wrote', () => {
  const { m, out } = mixer(sample(10_000))
  m.push('a', frame(7), 9_010) // before where the file ends: left as it is
  m.push('a', frame(8), 12_010)
  m.finish(14_000)
  assert.equal(out.get(sample(9_000)), undefined)
  assert.equal(out.get(sample(12_000)), 8)
  assert.equal(m.length, sample(14_000))
})

test('the encoder’s arguments: 16 kHz mono PCM in, AAC in MP4 out, the index first', () => {
  const a = encodeArgs('/x/in.pcm', '/x/out.m4a.part')
  assert.deepEqual(a.slice(a.indexOf('-f'), a.indexOf('-f') + 2), ['-f', 's16le'])
  assert.equal(a[a.indexOf('-ar') + 1], '16000')
  assert.equal(a[a.indexOf('-ac') + 1], '1')
  assert.equal(a[a.indexOf('-c:a') + 1], 'aac')
  assert.equal(a[a.indexOf('-movflags') + 1], '+faststart')
  assert.equal(a.at(-1), '/x/out.m4a.part')
})

test('a take’s key is the feed’s shape', () => {
  assert.match(takeKey(SESSION, Date.parse('2026-11-13T10:00:00Z')), /^[A-Za-z0-9._-]{1,80}$/)
})

test('settings: audio off unless RECORDER_AUDIO=on; its folder, encoder and free-space floor', () => {
  const base = { RECORDER_APP_URL: 'https://app.example.test', CAPTURE_FEED_SECRET: 's', RECORDER_DEEPGRAM_API_KEY: 'k' }
  const off = loadConfig(base)
  assert.ok(!('missing' in off) && off.audio === null)
  const on = loadConfig({ ...base, RECORDER_AUDIO: 'on' })
  assert.ok(!('missing' in on))
  assert.deepEqual(on.audio, { dir: '/var/lib/recorder/audio', ffmpeg: 'ffmpeg', minFreeBytes: 2048 * 1024 * 1024, maxHeldBytes: 4096 * 1024 * 1024 })
  const custom = loadConfig({ ...base, RECORDER_AUDIO: 'ON', RECORDER_AUDIO_DIR: '/data/a', RECORDER_AUDIO_MIN_FREE_MB: '10' })
  assert.ok(!('missing' in custom) && custom.audio?.dir === '/data/a' && custom.audio.minFreeBytes === 10 * 1024 * 1024)
})

// ── The keeper, with a stand-in encoder and app ───────────────────────────

/** A stand-in for ffmpeg: `-version` answers, an encode copies its input to its output. */
function fakeEncoder(dir: string, fail = false): string {
  const path = join(dir, 'fake-ffmpeg')
  writeFileSync(
    path,
    `#!/bin/sh
for a; do last="$a"; done
case " $* " in *" -version "*) exit 0;; esac
${fail ? 'echo broken >&2; exit 1' : ''}
in=""; prev=""
for a; do if [ "$prev" = "-i" ]; then in="$a"; fi; prev="$a"; done
cp "$in" "$last"
`,
  )
  chmodSync(path, 0o755)
  return path
}

interface FakeApp {
  grants: Array<Record<string, unknown>>
  stored: string[]
  answers: { grant?: string; stored?: string }
  failGrants: number
  uploads: Array<{ url: string; bytes: number; body: Buffer }>
  failUploads: number
}

function keeperWith(dir: string, app: FakeApp, opts: { ffmpeg?: string; minFreeBytes?: number; maxHeldBytes?: number; putStatus?: number } = {}) {
  const client = new AppClient({
    appUrl: 'http://app.test',
    secret: 's',
    producer: { kind: 'livekit_recorder', id: 'recorder' },
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body))
      if (url.endsWith('/audio')) {
        if (app.failGrants-- > 0) return new Response('{"code":"FEED_RETRY"}', { status: 503 })
        app.grants.push(body)
        const outcome = app.answers.grant ?? 'granted'
        return Response.json({ outcome, upload: outcome === 'granted' ? { url: 'http://storage.test/up', method: 'PUT', headers: { 'content-type': 'audio/mp4' } } : null, expiresAt: '2026-12-13T10:00:00.000Z' })
      }
      if (url.endsWith('/audio/stored')) {
        app.stored.push(body.take)
        return Response.json({ outcome: app.answers.stored ?? 'stored', expiresAt: '2026-12-13T10:00:00.000Z' })
      }
      return new Response('{}', { status: 404 })
    },
  })
  const uploads: UploadPort = {
    put: async (url, path, bytes) => {
      if (app.failUploads-- > 0) throw new Error('connection reset')
      app.uploads.push({ url, bytes, body: readFileSync(path) })
      return opts.putStatus ?? 200
    },
  }
  return new AudioKeeper({ dir, ffmpeg: opts.ffmpeg ?? fakeEncoder(dir), minFreeBytes: opts.minFreeBytes ?? 0, maxHeldBytes: opts.maxHeldBytes ?? 1024 ** 3 }, client, { uploads, retry: { baseMs: 5, maxMs: 10 }, leftoverGraceMs: 60_000 })
}
const newApp = (): FakeApp => ({ grants: [], stored: [], answers: {}, failGrants: 0, uploads: [], failUploads: 0 })
const session = (over: Partial<FeedSession> = {}): FeedSession => ({ id: SESSION, startedAt: new Date(Date.now() - 5000).toISOString(), round: 1, captureId: 'c', guests: [], audio: true, ...over })
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  assert.ok(cond(), 'timed out')
}
const files = (dir: string) => readdirSync(dir).filter((f) => !f.startsWith('fake-'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Someone speaks for `ms` ending now: 10 ms frames, each stamped when it was heard. Returns when it began. */
function talk(take: { push: (k: string, pcm: Int16Array, end: number) => void }, value: number, ms = 300, key = 'track-a'): number {
  const now = Date.now()
  for (let t = now - ms + 10; t <= now; t += 10) take.push(key, frame(value), t)
  return now - ms
}

test('keeper: a session the app wants no sound of opens no take', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const k = keeperWith(dir, newApp())
  assert.equal(await k.start(), true)
  assert.equal(await k.openTake(session({ audio: false })), null)
  await k.stop()
})

test('keeper: no encoder, no audio in this process (the calls go on)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const k = keeperWith(dir, newApp(), { ffmpeg: join(dir, 'no-such-ffmpeg') })
  assert.equal(await k.start(), false)
})

test('keeper: too little free disk, no take', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const k = keeperWith(dir, newApp(), { minFreeBytes: Number.MAX_SAFE_INTEGER })
  await k.start()
  assert.equal(await k.openTake(session()), null)
  await k.stop()
})

test('keeper: a finished take is encoded, granted, uploaded whole, said stored, then gone from the disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const app = newApp()
  const k = keeperWith(dir, app)
  await k.start()
  const s = session()
  const take = await k.openTake(s)
  assert.ok(take)
  await sleep(1100)
  talk(take, 1000, 500)
  await take.end('finish')
  await until(() => app.stored.length === 1)
  assert.equal(app.grants.length, 1)
  const g = app.grants[0]
  assert.equal(g.take, take.meta.take)
  assert.equal(g.contentType, 'audio/mp4')
  assert.ok(Math.abs(Number(g.offsetMs) - 5000) < 200, `offset ${g.offsetMs}`)
  // The file's length is the take's whole time, the fake encoder's output the raw PCM.
  assert.equal(app.uploads[0].bytes, app.uploads[0].body.length)
  assert.ok(Math.abs(Number(g.durationMs) - (app.uploads[0].bytes / 2 / 16)) <= 1)
  await until(() => files(dir).length === 0)
  await k.stop()
})

test('keeper: an upload that fails, and a grant the app could not write, are tried again; nothing is uploaded twice once stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const app = newApp()
  app.failGrants = 1
  app.failUploads = 2
  const k = keeperWith(dir, app)
  await k.start()
  const take = await k.openTake(session())
  await sleep(1100)
  talk(take!, 500)
  await take!.end('finish')
  await until(() => app.stored.length === 1)
  assert.equal(app.uploads.length, 1)
  assert.equal(app.grants.length, 3, 'one grant per upload attempt')
  assert.ok(k.counts.failed >= 3)
  await k.stop()
})

test('keeper: the app says not_wanted (the switch went off, the session too old): the file is dropped, never uploaded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const app = newApp()
  app.answers.grant = 'not_wanted'
  const k = keeperWith(dir, app)
  await k.start()
  const take = await k.openTake(session())
  await sleep(1100)
  talk(take!, 500)
  await take!.end('finish')
  await until(() => app.grants.length === 1 && files(dir).length === 0)
  assert.equal(app.uploads.length, 0)
  await k.stop()
})

test('keeper: a take with no sound in it is not kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const app = newApp()
  const k = keeperWith(dir, app)
  await k.start()
  const take = await k.openTake(session())
  await new Promise((r) => setTimeout(r, 1100))
  await take!.end('finish')
  await until(() => files(dir).length === 0)
  assert.equal(app.grants.length, 0)
  await k.stop()
})

test('keeper: a shutdown pauses the take; the next process taking the session up goes on in the same file, at the call’s time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const app = newApp()
  const s = session({ startedAt: new Date(Date.now() - 2000).toISOString() })
  const k1 = keeperWith(dir, app)
  await k1.start()
  const take1 = await k1.openTake(s)
  await sleep(400)
  const t0 = talk(take1!, 1111, 200)
  await take1!.end('pause')
  await k1.stop()
  const pcm = join(dir, `${take1!.meta.take}.pcm`)
  const pausedAt = statSync(pcm).size
  assert.ok(pausedAt > 0)
  assert.equal(app.grants.length, 0, 'nothing handed on at a shutdown')

  // The restart: 300 ms the call went on without anyone hearing it.
  await new Promise((r) => setTimeout(r, 300))
  const k2 = keeperWith(dir, app)
  await k2.start()
  const take2 = await k2.openTake(s)
  assert.equal(take2!.meta.take, take1!.meta.take, 'the same take')
  await sleep(700)
  const t1 = talk(take2!, 2222, 200)
  await take2!.end('finish')
  await until(() => app.stored.length === 1)
  const body = app.uploads[0].body
  const pcm16 = new Int16Array(body.buffer, body.byteOffset, body.length / 2)
  const origin = Date.parse(s.startedAt) + take1!.meta.offsetMs
  const at = (wall: number) => Math.floor(((wall - origin) * 16000) / 1000)
  assert.equal(pcm16[at(t0 + 100)], 1111, 'before the restart: where it was said')
  assert.equal(pcm16[at(t1 + 100)], 2222, 'after: where it was said')
  assert.equal(pcm16[at(t0 + 200 + 300)], 0, 'the stretch nobody heard is silence')
  assert.ok(Math.abs(pcm16.length - at(Date.now())) < 16 * 300, 'the file runs to the take’s end on the call’s clock')
  assert.equal(app.grants.length, 1, 'one take, one file')
  await k2.stop()
})

test('keeper: a take a restart left that no call takes up again is finished as it stands and handed on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const app = newApp()
  const k1 = keeperWith(dir, app)
  await k1.start()
  const take = await k1.openTake(session())
  await sleep(1100)
  talk(take!, 900)
  await take!.end('pause')
  await k1.stop()
  const k2 = keeperWith(dir, app)
  await k2.start()
  assert.equal(app.grants.length, 0)
  await k2.finishLeftovers()
  await until(() => app.stored.length === 1)
  assert.equal(app.grants[0].take, take!.meta.take)
  await k2.stop()
})

test('keeper: a finished take left on disk by a shutdown is handed on by the next process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const app = newApp()
  app.failGrants = 1000
  const k1 = keeperWith(dir, app)
  await k1.start()
  const take = await k1.openTake(session())
  await sleep(1100)
  talk(take!, 900)
  await take!.end('finish')
  await until(() => k1.counts.failed >= 1)
  await k1.stop()
  assert.ok(existsSync(join(dir, `${take!.meta.take}.json`)))
  app.failGrants = 0
  const k2 = keeperWith(dir, app)
  await k2.start()
  await until(() => app.stored.length === 1)
  await k2.stop()
})

test('keeper: an encoder that keeps failing gives the take up after three tries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const app = newApp()
  const k = keeperWith(dir, app, { ffmpeg: fakeEncoder(dir, true) })
  await k.start()
  const take = await k.openTake(session())
  await sleep(1100)
  talk(take!, 900)
  await take!.end('finish')
  await until(() => files(dir).length === 0)
  assert.equal(app.grants.length, 0)
  await k.stop()
})

test('the app client: the audio requests carry the feed’s producer, and a grant’s link must be http(s)', async () => {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = []
  const c = new AppClient({
    appUrl: 'https://app.example.test',
    secret: 'feed-secret',
    producer: { kind: 'livekit_recorder', id: 'recorder' },
    fetch: async (url, init) => {
      sent.push({ url, body: JSON.parse(String(init.body)) })
      if (url.endsWith('/audio')) return Response.json({ outcome: 'granted', upload: { url: 'javascript:alert(1)' } })
      return Response.json({ outcome: 'missing' })
    },
  })
  const g = await c.audioGrant(SESSION, { take: 't1', offsetMs: 10, durationMs: 20, bytes: 30, contentType: 'audio/mp4' })
  assert.equal(g.upload, null)
  assert.equal(sent[0].url, `https://app.example.test/api/internal/capture-feed/sessions/${SESSION}/audio`)
  assert.deepEqual(sent[0].body, { producer: { kind: 'livekit_recorder', id: 'recorder' }, take: 't1', offsetMs: 10, durationMs: 20, bytes: 30, contentType: 'audio/mp4' })
  assert.equal((await c.audioStored(SESSION, 't1')).outcome, 'missing')
  assert.equal(sent[1].url, `https://app.example.test/api/internal/capture-feed/sessions/${SESSION}/audio/stored`)
  void AppError
})

test('disk: a take is written only while the disk has its floor free and the recorder holds under its cap', () => {
  const settings = { minFreeBytes: 2048, maxHeldBytes: 4096 }
  assert.equal(diskAllows({ freeBytes: 2048, heldBytes: 0 }, settings), true)
  assert.equal(diskAllows({ freeBytes: 2047, heldBytes: 0 }, settings), false)
  assert.equal(diskAllows({ freeBytes: 1e12, heldBytes: 4096 }, settings), false)
})

test('keeper: no take opens once the recorder holds its cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const k = keeperWith(dir, newApp(), { maxHeldBytes: 1 })
  await k.start()
  // The stand-in encoder itself is a file in the folder: already over a 1-byte cap.
  assert.equal(await k.openTake(session()), null)
  await k.stop()
})

test('keeper: a take being written stops when the disk runs short, keeping (and handing on) what it has; the notes are not its to stop', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const app = newApp()
  const k = keeperWith(dir, app)
  await k.start()
  const take = await k.openTake(session())
  await sleep(1100)
  talk(take!, 700)
  // The disk fills up mid-call: the next look (sped up here) says so.
  ;(k as unknown as { diskOk: () => Promise<boolean> }).diskOk = async () => false
  ;(take as unknown as { lastDiskLook: number }).lastDiskLook = 0
  await until(() => take!.stoppedForDisk)
  talk(take!, 900) // after the stop: not written
  await until(() => app.stored.length === 1)
  const body = app.uploads[0].body
  const pcm16 = new Int16Array(body.buffer, body.byteOffset, body.length / 2)
  assert.ok(pcm16.includes(700), 'what was heard before is kept')
  assert.ok(!pcm16.includes(900), 'nothing after the stop')
  await take!.end('finish') // the call's own end later: the same, once
  assert.equal(app.grants.length, 1)
  await k.stop()
  void t
})

test('keeper: an upload Storage refuses because it has the file already (an answer lost) is settled by the app’s "stored"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const app = newApp()
  const k = keeperWith(dir, app, { putStatus: 409 })
  await k.start()
  const take = await k.openTake(session())
  await sleep(1100)
  talk(take!, 500)
  await take!.end('finish')
  await until(() => app.stored.length === 1 && files(dir).length === 0)
  assert.equal(app.grants.length, 1)
  await k.stop()
})

test('keeper: stray files an hour old are removed (temporary ones cut off, files whose state is gone); a take’s own files never are', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const k = keeperWith(dir, newApp())
  await k.start()
  const take = await k.openTake(session())
  const old = (Date.now() - 2 * 3600_000) / 1000
  const { utimesSync } = await import('node:fs')
  for (const name of ['t-x.json.tmp', 't-x.m4a.part', 't-orphan.pcm', 't-orphan.m4a', 't-new.m4a.part']) writeFileSync(join(dir, name), 'x')
  for (const name of ['t-x.json.tmp', 't-x.m4a.part', 't-orphan.pcm', 't-orphan.m4a']) utimesSync(join(dir, name), old, old)
  utimesSync(join(dir, `${take!.meta.take}.pcm`), old, old)
  assert.equal(await k.sweepStrays(), 4)
  const left = files(dir).sort()
  assert.deepEqual(left, [`${take!.meta.take}.json`, `${take!.meta.take}.pcm`, 't-new.m4a.part'].sort())
  await take!.end('finish')
  await k.stop()
})

test('keeper: a shutdown never waits past its bound on a worker that hangs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-audio-'))
  const k = keeperWith(dir, newApp())
  await k.start()
  ;(k as unknown as { worker: Promise<void> }).worker = new Promise(() => undefined)
  const t0 = Date.now()
  await k.stop(200)
  assert.ok(Date.now() - t0 < 1000)
})
