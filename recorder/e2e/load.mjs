// What the call's sound costs the recorder: one call of PEOPLE members (default 10), each speaking a
// tone half the time, heard for SECONDS (default 60) by the REAL recorder (src/main.ts), with its audio
// on (AUDIO=on, the default) or off (AUDIO=off). Deepgram is a local sink that answers nothing; the app
// is a fake that speaks just enough of the feed's contract. Samples the recorder process's CPU and
// memory once a second (ps), then, with audio on, times the take's encode and upload after the call.
// Needs the local LiveKit of start-livekit.sh. Result: e2e/run/load-<on|off>.json. Never prints a key.
//
//   npm run e2e:load            (AUDIO=off npm run e2e:load for the comparison)
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const RECORDER = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const RUN = HERE + 'run/'
const AUDIO = process.env.AUDIO !== 'off'
const PEOPLE = Number(process.env.PEOPLE || 10)
const SECONDS = Number(process.env.SECONDS || 60)
const require = createRequire(import.meta.url)
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk')
const { WebSocketServer } = require('ws')
const rtc = require('@livekit/rtc-node')

const { key: LK_KEY, secret: LK_SECRET } = JSON.parse(readFileSync(RUN + 'keys.json', 'utf8'))
const LK_URL = 'ws://127.0.0.1:7880'
const rooms = new RoomServiceClient('http://127.0.0.1:7880', LK_KEY, LK_SECRET)
const FEED = 'e2e-feed-secret-' + randomUUID()
const APP_PORT = 3594
const DG_PORT = 3595
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CALL = randomUUID()
const ROOM = `tc-${CALL}`
const AUDIO_DIR = RUN + 'load-audio/'
rmSync(AUDIO_DIR, { recursive: true, force: true })
mkdirSync(AUDIO_DIR, { recursive: true })

const app = { session: null, notes: true, ended: false, uploads: [], stored: 0, grants: [] }
const appServer = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const json = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (req.method === 'PUT') {
    app.uploads.push({ at: Date.now(), bytes: Buffer.concat(chunks).length })
    return json(200, {})
  }
  if (req.headers.authorization !== `Bearer ${FEED}`) return json(401, {})
  const b = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  if (req.url === '/api/internal/team-call-recorder/work') {
    const t = new AccessToken(LK_KEY, LK_SECRET, { identity: `notes-recorder-${b.producer.id}`, name: 'Notes', ttl: 600 })
    t.addGrant({ room: ROOM, roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false, hidden: true, recorder: true })
    const wanted = app.notes && !app.session && !b.running.includes(CALL)
    return json(200, { jobs: wanted ? [{ callId: CALL, room: ROOM, round: 1, token: await t.toJwt() }] : [], pollMs: 1000 })
  }
  if (req.url === '/api/internal/capture-feed/start') {
    app.session ??= { id: randomUUID(), startedAt: new Date().toISOString(), round: 1, captureId: 'c', guests: [], audio: AUDIO }
    return json(200, { outcome: 'started', session: app.session })
  }
  if (req.url === '/api/internal/capture-feed/heartbeat') return json(200, { sessions: b.sessions.map((id) => ({ id, keep: app.notes, reason: app.notes ? null : 'notes_off', guests: [] })) })
  if (req.url.endsWith('/roster')) return json(200, { results: b.events.map((e) => ({ key: e.key, outcome: 'applied' })) })
  if (req.url.endsWith('/segments')) return json(200, { outcome: 'applied', accepted: b.segments.length, duplicate: 0, dropped: 0 })
  if (req.url.endsWith('/end')) {
    app.ended = Date.now()
    return json(200, { ended: true })
  }
  if (req.url.endsWith('/audio/stored')) {
    app.stored++
    return json(200, { outcome: 'stored', expiresAt: null })
  }
  if (req.url.endsWith('/audio')) {
    app.grants.push({ ...b, at: Date.now() })
    return json(200, { outcome: 'granted', upload: { url: `http://127.0.0.1:${APP_PORT}/upload`, method: 'PUT', headers: { 'content-type': b.contentType } } })
  }
  return json(404, {})
})
appServer.listen(APP_PORT, '127.0.0.1')

// Deepgram: takes the audio, answers nothing (the cost under test is the recorder's own).
const dg = new WebSocketServer({ port: DG_PORT, host: '127.0.0.1', handleProtocols: () => 'token' })
dg.on('connection', (ws) => ws.on('message', () => undefined))

async function participant(i) {
  const identity = randomUUID()
  const t = new AccessToken(LK_KEY, LK_SECRET, { identity, name: `P${i}`, ttl: 600 })
  t.addGrant({ room: ROOM, roomJoin: true, canSubscribe: false, canPublish: true })
  const room = new rtc.Room()
  await room.connect(LK_URL, await t.toJwt(), { autoSubscribe: false, dynacast: false })
  const source = new rtc.AudioSource(16000, 1, 200)
  const opts = new rtc.TrackPublishOptions()
  opts.source = rtc.TrackSource.SOURCE_MICROPHONE
  await room.localParticipant.publishTrack(rtc.LocalAudioTrack.createAudioTrack('mic', source), opts)
  const freq = 200 + i * 90
  const p = { running: true, room }
  ;(async () => {
    let phase = 0
    let n = 0
    while (p.running) {
      const frame = rtc.AudioFrame.create(16000, 1, 160)
      // Each speaks in turns: two seconds on, two off, offset by person.
      if (Math.floor((n + i * 37) / 200) % 2 === 0) for (let k = 0; k < 160; k++) frame.data[k] = Math.round(4000 * Math.sin((2 * Math.PI * freq * (phase + k)) / 16000))
      phase += 160
      n++
      try {
        await source.captureFrame(frame)
      } catch {
        break
      }
    }
  })()
  p.leave = async () => {
    p.running = false
    await room.disconnect()
  }
  return p
}

// Its CPU as cumulative time (ps's TIME, "m:ss.cc"): the share of one core between two looks.
let last = null
const sample = (pid) => {
  try {
    const [time, rss] = execFileSync('ps', ['-o', 'time=,rss=', '-p', String(pid)]).toString().trim().split(/\s+/)
    const cpuS = time.split(':').map(Number).reduce((n, v) => n * 60 + v, 0)
    const now = Date.now()
    const cpu = last ? Math.round(((cpuS - last.cpuS) / ((now - last.at) / 1000)) * 1000) / 10 : 0
    last = { cpuS, at: now }
    return { cpu, rssMb: Math.round(Number(rss) / 1024) }
  } catch {
    return null
  }
}

await rooms.createRoom({ name: ROOM, emptyTimeout: 60, departureTimeout: 15, maxParticipants: 50 })
const people = []
for (let i = 0; i < PEOPLE; i++) people.push(await participant(i))
const rec = spawn(process.execPath, [RECORDER], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RECORDER_APP_URL: `http://127.0.0.1:${APP_PORT}`,
    CAPTURE_FEED_SECRET: FEED,
    RECORDER_DEEPGRAM_API_KEY: 'fake',
    RECORDER_DEEPGRAM_URL: `ws://127.0.0.1:${DG_PORT}/v1/listen`,
    RECORDER_LIVEKIT_URL: LK_URL,
    RECORDER_HEALTH_PORT: '3596',
    RECORDER_ID: 'loadrec',
    ...(AUDIO ? { RECORDER_AUDIO: 'on', RECORDER_AUDIO_DIR: AUDIO_DIR, RECORDER_AUDIO_MIN_FREE_MB: '0' } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
rec.stdout.on('data', (d) => (log += d))
rec.stderr.on('data', (d) => (log += d))
for (let i = 0; i < 100; i++) {
  const h = await fetch('http://127.0.0.1:3596/').then((r) => r.json()).catch(() => null)
  if (h?.speakers >= PEOPLE) break
  await sleep(300)
}
const samples = []
for (let s = 0; s < SECONDS; s++) {
  await sleep(1000)
  const x = sample(rec.pid)
  if (x) samples.push(x)
}
const heard = (await fetch('http://127.0.0.1:3596/').then((r) => r.json()).catch(() => null))?.speakers
app.notes = false
const offAt = Date.now()
for (let i = 0; i < 100 && !app.ended; i++) await sleep(200)
let handedOn = null
if (AUDIO) {
  // The encode and upload after the call, and what they cost.
  const after = []
  for (let i = 0; i < 300 && app.stored === 0; i++) {
    const x = sample(rec.pid)
    if (x) after.push(x)
    await sleep(100)
  }
  handedOn = { msAfterEnd: app.stored ? Date.now() - app.ended : null, upload: app.uploads[0] ?? null, grant: app.grants[0] ?? null, peakRssMb: Math.max(...after.map((x) => x.rssMb)) }
}
const steady = samples.slice(5)
const avg = (k) => Math.round((steady.reduce((n, x) => n + x[k], 0) / Math.max(1, steady.length)) * 10) / 10
const result = { audio: AUDIO, people: PEOPLE, seconds: SECONDS, speakersHeard: heard, cpuPercentAvg: avg('cpu'), cpuPercentMax: Math.max(...steady.map((x) => x.cpu)), rssMbAvg: avg('rssMb'), rssMbMax: Math.max(...steady.map((x) => x.rssMb)), endedAfterOffMs: app.ended ? app.ended - offAt : null, handedOn }
console.log(JSON.stringify(result, null, 2))
writeFileSync(RUN + `load-${AUDIO ? 'on' : 'off'}.json`, JSON.stringify({ ...result, samples }, null, 2))
writeFileSync(RUN + `load-${AUDIO ? 'on' : 'off'}.log`, log)
rec.kill('SIGTERM')
await Promise.all(people.map((p) => p.leave().catch(() => undefined)))
await rtc.dispose().catch(() => undefined)
appServer.close()
dg.close()
process.exit(0)
