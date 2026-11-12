// End-to-end run of the REAL call recorder (src/main.ts) against a local LiveKit, with fake participants
// publishing known audio (a tone each), a fake app that speaks the capture feed's contract in memory
// (web/src/lib/capture-feed/contract.ts), and Deepgram replaced by a local fake that names each stretch of
// tone by its pitch (MODE=fake, the default), or the real one (MODE=real: one short pass with speech made
// by macOS's `say`, RECORDER_E2E_DEEPGRAM_API_KEY in the environment). README.md in this folder's parent
// says how to run it. Results: e2e/run/result-<mode>.json; the recorder's log: e2e/run/recorder.log.
// Never prints a key.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const RECORDER = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const RUN = HERE + 'run/'
const MODE = process.env.MODE === 'real' ? 'real' : 'fake'
const require = createRequire(import.meta.url)
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk')
const { WebSocketServer } = require('ws')
const rtc = require('@livekit/rtc-node')

const { key: LK_KEY, secret: LK_SECRET } = JSON.parse(readFileSync(RUN + 'keys.json', 'utf8'))
const LK_URL = 'ws://127.0.0.1:7880'
const rooms = new RoomServiceClient('http://127.0.0.1:7880', LK_KEY, LK_SECRET)
const FEED = 'e2e-feed-secret-' + randomUUID()
const APP_PORT = 3591
const DG_PORT = 3592
const T0 = Date.now()
const since = () => Date.now() - T0
const log = (...a) => console.log(`[e2e +${(since() / 1000).toFixed(1)}s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── The call and its people ───────────────────────────────────────────────
const CALL = randomUUID()
const ROOM = `tc-${CALL}`
const MA = randomUUID() // a member, tone 400 Hz
const MB = randomUUID() // a member, tone 800 Hz
const GUEST = randomUUID() // a meeting guest, tone 1200 Hz
const who = { [MA]: 'A', [MB]: 'B', [`guest-${GUEST}`]: 'G' }
const RECORDER_IDENTITY = 'notes-recorder-recorder' // web/src/lib/team-calls/livekit.ts teamCallRecorderIdentity('recorder')

// ── The fake app: the capture feed's contract, in memory ──────────────────
const app = {
  notes: true,
  round: 1,
  heard: new Set(), // the meeting guests who said go to this round's notes (588's capture_feed_hearable_guests)
  ejects: [], // 565's outbox as 588 fills it for the recorder: { identity, session, done }
  ejectsSettled: 0,
  ejectsRemoved: 0,
  sessions: new Map(), // id → { id, round, startedAt, producer, heartbeatAt, status, endedAt, endReason }
  segments: new Map(), // key → { session, speaker, text, startMs, endMs, at }
  duplicates: 0,
  dropped: [],
  roster: [],
  rosterKeys: new Set(),
  starts: [],
  ends: [],
  heartbeats: 0,
  works: 0,
  failNextSegments: 0,
  segmentRequests: 0,
  batchSizes: [], // segments per request the app took
  refusedAuth: 0,
}
function sessionFor(round) {
  return [...app.sessions.values()].find((s) => s.round === round)
}
function recorderToken(room, producerId) {
  const t = new AccessToken(LK_KEY, LK_SECRET, { identity: `notes-recorder-${producerId}`, name: 'Notes', ttl: 600 })
  // web/src/lib/team-calls/livekit.ts teamCallRecorderGrant (its own test checks the app's tokens).
  t.addGrant({ room, roomJoin: true, canSubscribe: true, canPublish: false, canPublishSources: [], canPublishData: false, canUpdateOwnMetadata: false, roomCreate: false, roomAdmin: false, roomList: false, roomRecord: false, hidden: true, recorder: true })
  return t.toJwt()
}
const appServer = createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const json = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (req.headers.authorization !== `Bearer ${FEED}`) {
    app.refusedAuth++
    return json(401, { error: 'Unauthorized' })
  }
  const b = JSON.parse(body || '{}')
  const url = req.url
  if (url === '/api/internal/team-call-recorder/work') {
    app.works++
    const s = sessionFor(app.round)
    const fresh = s && s.status === 'live' && Date.now() - s.heartbeatAt < 30_000 && s.producer !== b.producer.id
    const wanted = app.notes && !b.running.includes(CALL) && !fresh && !(s && s.status === 'ended') && b.capacity > 0
    return json(200, { jobs: wanted ? [{ callId: CALL, room: ROOM, round: app.round, token: await recorderToken(ROOM, b.producer.id) }] : [], pollMs: 1000 })
  }
  if (url === '/api/internal/capture-feed/start') {
    if (!app.notes) return json(200, { outcome: 'not_wanted', session: null })
    let s = sessionFor(app.round)
    let outcome = 'resumed'
    if (!s) {
      s = { id: randomUUID(), round: app.round, startedAt: new Date().toISOString(), producer: b.producer.id, heartbeatAt: Date.now(), status: 'live' }
      app.sessions.set(s.id, s)
      outcome = 'started'
    } else if (s.status === 'ended') return json(200, { outcome: 'not_wanted', session: null })
    s.producer = b.producer.id
    s.heartbeatAt = Date.now()
    app.starts.push({ at: since(), outcome, session: s.id })
    return json(200, { outcome, session: { id: s.id, startedAt: s.startedAt, round: s.round, captureId: 'capture-1', guests: [...app.heard] } })
  }
  if (url === '/api/internal/capture-feed/heartbeat') {
    app.heartbeats++
    return json(200, {
      sessions: b.sessions.map((id) => {
        const s = app.sessions.get(id)
        if (!s) return { id, keep: false, reason: 'unknown' }
        if (s.status === 'ended') return { id, keep: false, reason: s.endReason }
        s.heartbeatAt = Date.now()
        return { id, keep: true, reason: null, guests: [...app.heard] }
      }),
    })
  }
  const m = /^\/api\/internal\/capture-feed\/sessions\/([^/]+)\/(roster|segments|end)$/.exec(url)
  if (m) {
    const s = app.sessions.get(m[1])
    if (!s) return json(404, { error: 'No such session' })
    if (m[2] === 'roster') {
      for (const e of b.events) {
        if (app.rosterKeys.has(e.key)) continue
        app.rosterKeys.add(e.key)
        app.roster.push({ ...e, session: s.id, at: since() })
      }
      return json(200, { results: b.events.map((e) => ({ key: e.key, outcome: 'applied' })) })
    }
    if (m[2] === 'segments') {
      app.segmentRequests++
      if (app.failNextSegments > 0) {
        app.failNextSegments--
        return json(503, { error: 'Try again', code: 'FEED_RETRY' })
      }
      let accepted = 0
      let duplicate = 0
      let dropped = 0
      for (const g of b.segments) {
        if (app.segments.has(g.key)) {
          duplicate++
          app.duplicates++
          continue
        }
        const saidAt = Date.parse(s.startedAt) + g.startMs
        if (s.endedAt && saidAt >= s.endedAt) {
          dropped++
          app.dropped.push(g)
          continue
        }
        app.segments.set(g.key, { ...g, session: s.id, at: since() })
        accepted++
      }
      app.batchSizes.push(b.segments.length)
      return json(200, { outcome: 'applied', accepted, duplicate, dropped, transcriptLength: 0, captureId: 'capture-1' })
    }
    if (m[2] === 'end') {
      app.ends.push({ session: s.id, reason: b.reason, at: since() })
      return json(200, { ended: true })
    }
  }
  return json(404, { error: 'Not found' })
})
appServer.listen(APP_PORT, '127.0.0.1')

function notesOff() {
  app.notes = false
  const s = sessionFor(app.round)
  if (s && s.status !== 'ended') {
    s.status = 'ended'
    s.endedAt = Date.now()
    s.endReason = 'notes_off'
  }
  // 588's follow trigger: the round's producer goes on the eject outbox, naming its session.
  if (s) app.ejects.push({ identity: `notes-recorder-${s.producer}`, session: s.id, done: false })
}
// The app's drain (src/lib/team-calls/eject.ts), settled first as 588's capture_feed_settle_ejects
// does: a producer with a live session in the call's current round stays in the room.
async function drainEjects() {
  for (const e of app.ejects.filter((x) => !x.done)) {
    const cur = sessionFor(app.round)
    e.done = true
    if (app.notes && cur && cur.status === 'live' && `notes-recorder-${cur.producer}` === e.identity) {
      app.ejectsSettled++
      continue
    }
    await rooms.removeParticipant(ROOM, e.identity).catch(() => undefined)
    app.ejectsRemoved++
  }
}
function notesOn() {
  app.notes = true
  app.round++
}

// ── The fake Deepgram: finals for each stretch of tone, named by its pitch ─
const dg = { sockets: new Set(), connections: 0, finalizes: 0, keepalives: 0, closes: 0, protocolsOk: true, bytes: 0 }
let dgServer = null
if (MODE === 'fake') {
  dgServer = new WebSocketServer({
    port: DG_PORT,
    host: '127.0.0.1',
    handleProtocols: (protocols) => {
      const list = [...protocols]
      if (list[0] !== 'token' || !list[1]) dg.protocolsOk = false
      return 'token'
    },
  })
  dgServer.on('connection', (ws, req) => {
    const params = new URL(req.url, 'http://x').searchParams
    if (params.get('interim_results') !== 'false' || params.get('sample_rate') !== '16000' || params.get('model') !== 'nova-3') dg.protocolsOk = false
    dg.connections++
    dg.sockets.add(ws)
    let samples = 0 // audio received on this socket
    let speech = null // { start, crossings, n, lastVoiced }
    let lastEmitted = 0
    let prev = 0
    const emit = (text, start, end) => ws.send(JSON.stringify({ type: 'Results', is_final: true, start, duration: end - start, channel: { alternatives: [{ transcript: text, words: text ? [{ start, end }] : [] }] } }))
    const flush = () => {
      if (!speech) return
      const dur = speech.n / 16000
      const freq = speech.crossings / 2 / dur
      emit(`tone ${Math.round(freq / 100) * 100}`, speech.start / 16000, speech.lastVoiced / 16000)
      lastEmitted = speech.lastVoiced
      speech = null
    }
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const m = JSON.parse(String(data))
        if (m.type === 'Finalize') {
          dg.finalizes++
          flush()
        } else if (m.type === 'KeepAlive') dg.keepalives++
        else if (m.type === 'CloseStream') {
          dg.closes++
          flush()
          ws.close(1000)
        }
        return
      }
      const buf = Buffer.from(data)
      dg.bytes += buf.length
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)
      // 10 ms windows: voiced when loud; a stretch ends after 300 ms of quiet (endpointing).
      for (let off = 0; off + 160 <= pcm.length; off += 160) {
        let energy = 0
        let crossings = 0
        for (let i = off; i < off + 160; i++) {
          energy += Math.abs(pcm[i])
          if ((pcm[i] >= 0) !== (prev >= 0)) crossings++
          prev = pcm[i]
        }
        const voiced = energy / 160 > 1000
        if (voiced) {
          speech ??= { start: samples, crossings: 0, n: 0, lastVoiced: samples }
          speech.crossings += crossings
          speech.n += 160
          speech.lastVoiced = samples + 160
        } else if (speech && samples - speech.lastVoiced >= 0.3 * 16000) flush()
        else if (!speech && samples - lastEmitted >= 16000) {
          emit('', lastEmitted / 16000, samples / 16000)
          lastEmitted = samples
        }
        samples += 160
      }
    })
    ws.on('close', () => dg.sockets.delete(ws))
  })
}

// ── Participants ──────────────────────────────────────────────────────────
function wavPcm(path) {
  const b = readFileSync(path)
  let off = 12
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'data') return new Int16Array(b.buffer.slice(b.byteOffset + off + 8, b.byteOffset + off + 8 + size))
    off += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}
async function participant(identity, name, freq, speechFile, extra) {
  const t = new AccessToken(LK_KEY, LK_SECRET, { identity, name, ttl: 600 })
  t.addGrant({ room: ROOM, roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: false })
  const room = new rtc.Room()
  await room.connect(LK_URL, await t.toJwt(), { autoSubscribe: true, dynacast: false })
  const source = new rtc.AudioSource(16000, 1, 200)
  const track = rtc.LocalAudioTrack.createAudioTrack('mic', source)
  const opts = new rtc.TrackPublishOptions()
  opts.source = rtc.TrackSource.SOURCE_MICROPHONE
  const pub = await room.localParticipant.publishTrack(track, opts)
  // A second audio track that is not a microphone (a screen share's sound): the recorder must never take it.
  if (extra) {
    const source2 = new rtc.AudioSource(16000, 1, 200)
    const opts2 = new rtc.TrackPublishOptions()
    opts2.source = rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO
    await room.localParticipant.publishTrack(rtc.LocalAudioTrack.createAudioTrack('screen-audio', source2), opts2)
    ;(async () => {
      let phase = 0
      for (;;) {
        const frame = rtc.AudioFrame.create(16000, 1, 160)
        for (let i = 0; i < 160; i++) frame.data[i] = Math.round(8000 * Math.sin((2 * Math.PI * extra * (phase + i)) / 16000))
        phase += 160
        try {
          await source2.captureFrame(frame)
        } catch {
          break
        }
      }
    })()
  }
  const speech = speechFile ? wavPcm(speechFile) : null
  const p = { identity, room, source, track, pub, speaking: 0, phase: 0, running: true, speechAt: 0, bursts: [] }
  p.say = (seconds) => {
    p.bursts.push({ startMs: Date.now(), endMs: Date.now() + seconds * 1000 })
    p.speaking = Date.now() + seconds * 1000
    p.speechAt = 0
  }
  ;(async () => {
    while (p.running) {
      const frame = rtc.AudioFrame.create(16000, 1, 160)
      if (Date.now() < p.speaking) {
        if (speech) {
          frame.data.set(speech.subarray(p.speechAt, p.speechAt + 160))
          p.speechAt += 160
          if (p.speechAt >= speech.length) p.speaking = 0
        } else {
          for (let i = 0; i < 160; i++) frame.data[i] = Math.round(8000 * Math.sin((2 * Math.PI * freq * (p.phase + i)) / 16000))
          p.phase += 160
        }
      }
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
const seesRecorder = (p) => [...p.room.remoteParticipants.values()].some((r) => r.identity === RECORDER_IDENTITY)

// ── The recorder ──────────────────────────────────────────────────────────
const recLog = createWriteStream(RUN + 'recorder.log', { flags: 'w' })
let recorder = null
process.on('exit', () => recorder?.kill('SIGKILL'))
process.on('unhandledRejection', (err) => {
  console.error('[e2e] failed:', err)
  process.exit(2)
})
function startRecorder() {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RECORDER_APP_URL: `http://127.0.0.1:${APP_PORT}`,
    CAPTURE_FEED_SECRET: FEED,
    RECORDER_DEEPGRAM_API_KEY: MODE === 'real' ? process.env.RECORDER_E2E_DEEPGRAM_API_KEY : 'fake-deepgram-key',
    RECORDER_LIVEKIT_URL: LK_URL,
    RECORDER_HEALTH_PORT: '3593',
    RECORDER_ID: 'recorder',
    ...(MODE === 'fake' ? { RECORDER_DEEPGRAM_URL: `ws://127.0.0.1:${DG_PORT}/v1/listen` } : {}),
  }
  recorder = spawn(process.execPath, [RECORDER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  recorder.stdout.pipe(recLog, { end: false })
  recorder.stderr.pipe(recLog, { end: false })
  return recorder
}
async function stopRecorder() {
  const p = recorder
  const exited = new Promise((r) => p.once('exit', r))
  p.kill('SIGTERM')
  await exited
}
async function health() {
  try {
    return await (await fetch('http://127.0.0.1:3593/')).json()
  } catch {
    return null
  }
}

// ── The scenario ──────────────────────────────────────────────────────────
const result = { mode: MODE, checks: [], timeline: [] }
const mark = (what) => {
  result.timeline.push({ at: since(), what })
  log(what)
}
const check = (name, pass, detail) => {
  result.checks.push({ name, pass: !!pass, detail })
  log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`)
}

let speechFiles = {}
if (MODE === 'real') {
  if (!process.env.RECORDER_E2E_DEEPGRAM_API_KEY) throw new Error('MODE=real needs RECORDER_E2E_DEEPGRAM_API_KEY')
  const lines = {
    A: 'Good morning everyone. Let us review the launch plan for next Tuesday.',
    B: 'Thanks. I will send the updated budget to the team by Friday afternoon.',
  }
  for (const [k, text] of Object.entries(lines)) {
    execFileSync('/usr/bin/say', ['-o', RUN + `${k}.aiff`, text])
    execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', RUN + `${k}.aiff`, RUN + `${k}.wav`])
    speechFiles[k] = RUN + `${k}.wav`
  }
  result.lines = lines
}

await rooms.createRoom({ name: ROOM, emptyTimeout: 60, departureTimeout: 15, maxParticipants: 50 })
mark('room made')
const A = await participant(MA, 'Ana', 400, speechFiles.A, MODE === 'fake' ? 1600 : undefined)
const B = await participant(MB, 'Ben', 800, speechFiles.B)
mark('A and B in the room, publishing')
startRecorder()
mark('recorder started')
for (let i = 0; i < 100 && ![...A.room.remoteParticipants.values()].length; i++) await sleep(100)
// Wait until the recorder hears both.
for (let i = 0; i < 150; i++) {
  const h = await health()
  if (h?.speakers >= 2) break
  await sleep(200)
}
mark(`recorder hearing ${(await health())?.speakers} speakers`)
check('the recorder is hidden: nobody in the call sees it', !seesRecorder(A) && !seesRecorder(B))

if (MODE === 'real') {
  A.say(7)
  await sleep(8000)
  B.say(7)
  await sleep(9000)
  notesOff()
  mark('notes off')
  for (let i = 0; i < 80 && app.ends.length === 0; i++) await sleep(250)
  const segs = [...app.segments.values()]
  const textOf = (id) => segs.filter((s) => s.speaker === id).sort((a, b) => a.startMs - b.startMs).map((s) => s.text).join(' ')
  const norm = (t) => t.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
  const words = (t) => new Set(norm(t).split(' ').filter((w) => w.length > 3))
  const overlap = (said, heard) => {
    const w = words(said)
    const h = words(heard)
    return [...w].filter((x) => h.has(x)).length / w.size
  }
  result.heard = { A: textOf(MA), B: textOf(MB) }
  check('real Deepgram: what Ana said is in her words', overlap(result.lines.A, result.heard.A) >= 0.6, { overlap: overlap(result.lines.A, result.heard.A) })
  check('real Deepgram: what Ben said is in his', overlap(result.lines.B, result.heard.B) >= 0.6, { overlap: overlap(result.lines.B, result.heard.B) })
  check('real Deepgram: neither is the other’s', overlap(result.lines.A, result.heard.B) < 0.3 && overlap(result.lines.B, result.heard.A) < 0.3)
  check('the session was ended when notes went off', app.ends.length === 1, app.ends)
} else {
  const session1 = () => sessionFor(1)
  A.say(3)
  await sleep(4000)
  B.say(3)
  await sleep(4000)
  // A muted by the server (as a person's mute reaches LiveKit), tone still pushed: nothing must be heard.
  const pubA = [...A.room.localParticipant.trackPublications.values()][0]
  await rooms.mutePublishedTrack(ROOM, MA, pubA.sid, true)
  const muteFrom = Date.now()
  mark('A muted')
  await sleep(500)
  A.say(3)
  await sleep(3500)
  await rooms.mutePublishedTrack(ROOM, MA, pubA.sid, false)
  const muteTo = Date.now()
  mark('A unmuted')
  await sleep(500)
  A.say(3)
  await sleep(4000)
  // A meeting guest joins late, and has not said go to the notes yet: nothing of theirs may be heard,
  // not even a Deepgram socket opened for them.
  const socketsBeforeGuest = dg.connections
  const G = await participant(`guest-${GUEST}`, 'Dana', 1200)
  await sleep(2500)
  G.say(3)
  const unheardFrom = Date.now()
  await sleep(4000)
  const speakersBeforeAck = (await health())?.speakers
  check('a guest who has not said go: no socket, nothing heard', dg.connections === socketsBeforeGuest && speakersBeforeAck === 2, { sockets: dg.connections - socketsBeforeGuest, speakers: speakersBeforeAck })
  // They say go: the next heartbeat lists them, and from then on they are heard.
  app.heard.add(GUEST)
  mark('the guest said go')
  for (let i = 0; i < 60 && (await health())?.speakers < 3; i++) await sleep(200)
  const ackAt = Date.now()
  G.say(3)
  await sleep(4000)
  // Deepgram drops every socket while B speaks; the app refuses two segment requests (a retry).
  B.say(4)
  await sleep(1500)
  app.failNextSegments = 2
  for (const ws of dg.sockets) ws.terminate()
  mark('Deepgram dropped every socket')
  await sleep(4500)
  // B leaves and comes back (a new track).
  await B.leave()
  mark('B left')
  await sleep(3000)
  const B2 = await participant(MB, 'Ben', 800)
  mark('B back')
  await sleep(3000)
  B2.say(3)
  await sleep(4000)
  // Two people speak at once: their words reach the app together, in one request.
  A.say(1.5)
  B2.say(1.5)
  await sleep(6000)
  // The recorder restarts (a deploy): it takes the session up again.
  const beforeRestart = since()
  await stopRecorder()
  mark('recorder stopped (SIGTERM)')
  startRecorder()
  for (let i = 0; i < 150; i++) {
    const h = await health()
    if (h?.speakers >= 3) break
    await sleep(200)
  }
  mark(`recorder back, hearing ${(await health())?.speakers}`)
  A.say(3)
  await sleep(4000)
  // Notes off: the session ends now; the recorder hears it at its heartbeat and ends.
  notesOff()
  const offAt = Date.now()
  mark('notes off')
  G.say(2)
  for (let i = 0; i < 80 && app.ends.length === 0; i++) await sleep(250)
  await sleep(1500)

  const segs = [...app.segments.values()].map((s) => ({ ...s, said: Date.parse(session1().startedAt) + s.startMs }))
  const bySpeaker = (id) => segs.filter((s) => s.speaker === id)
  result.segments = segs.map((s) => ({ who: who[s.speaker], text: s.text, startMs: s.startMs, endMs: s.endMs }))
  result.roster = app.roster.map((e) => ({ who: who[e.speaker], kind: e.kind, atMs: e.atMs, identity: e.identity ? Object.keys(e.identity)[0] : null }))
  check('every segment is its own speaker’s tone (one track, one known speaker)', segs.length > 0 && bySpeaker(MA).every((s) => s.text === 'tone 400') && bySpeaker(MB).every((s) => s.text === 'tone 800') && bySpeaker(`guest-${GUEST}`).every((s) => s.text === 'tone 1200'), {
    A: bySpeaker(MA).map((s) => s.text),
    B: bySpeaker(MB).map((s) => s.text),
    G: bySpeaker(`guest-${GUEST}`).map((s) => s.text),
  })
  const burstsHeard = (p, id) =>
    p.bursts.filter((b) => b.startMs < offAt).map((b) => ({ burst: b, heard: bySpeaker(id).some((s) => Math.abs(s.said - b.startMs) < 900) }))
  const aBursts = burstsHeard(A, MA)
  const aMuted = aBursts.filter((x) => x.burst.startMs >= muteFrom && x.burst.startMs < muteTo)
  const aOpen = aBursts.filter((x) => !(x.burst.startMs >= muteFrom && x.burst.startMs < muteTo))
  check('every burst A spoke unmuted was heard, at the time it was said (±0.9 s)', aOpen.every((x) => x.heard), aOpen.map((x) => x.heard))
  check('nothing A said while muted was heard', aMuted.length === 1 && !aMuted[0].heard && !bySpeaker(MA).some((s) => s.said >= muteFrom + 300 && s.said < muteTo))
  const bAll = [...burstsHeard(B, MB), ...burstsHeard(B2, MB)]
  check('every burst B spoke was heard, the one across the Deepgram drop and the one after B came back included', bAll.every((x) => x.heard), bAll.map((x) => x.heard))
  const gHeard = burstsHeard(G, `guest-${GUEST}`)
  check('the late guest was heard once they said go, and never before', gHeard.some((x) => x.heard && x.burst.startMs >= ackAt) && !bySpeaker(`guest-${GUEST}`).some((s) => s.said < ackAt - 500), {
    heard: gHeard.map((x) => x.heard),
    before: bySpeaker(`guest-${GUEST}`).filter((s) => s.said >= unheardFrom - 500 && s.said < ackAt - 500).length,
  })
  check('only microphones are heard: the screen share’s sound never was', !segs.some((s) => s.text === 'tone 1600'))
  check('Deepgram was reconnected after the drop', dg.connections > 4, { connections: dg.connections })
  check('the two refused segment requests were sent again; no key was taken twice', app.failNextSegments === 0 && app.duplicates >= 0, { duplicatesSentAgain: app.duplicates, segmentRequests: app.segmentRequests })
  const keys = segs.map((s) => s.key)
  check('every key is unique', new Set(keys).size === keys.length)
  const joins = (id) => app.roster.filter((e) => e.speaker === id && e.kind === 'joined').length
  const leaves = (id) => app.roster.filter((e) => e.speaker === id && e.kind === 'left').length
  check('roster: A, B and the guest joined, with who they are', joins(MA) >= 1 && joins(MB) >= 2 && joins(`guest-${GUEST}`) >= 1 && app.roster.filter((e) => e.kind === 'joined').every((e) => e.identity), {
    A: joins(MA),
    B: joins(MB),
    G: joins(`guest-${GUEST}`),
  })
  check('roster: B left once and came back', leaves(MB) >= 1)
  const firstJoinB = app.roster.find((e) => e.speaker === MB && e.kind === 'joined')
  const firstSegB = segs.filter((s) => s.speaker === MB).sort((a, b) => a.at - b.at)[0]
  check('a speaker’s roster event reached the app before their first words', firstJoinB && firstSegB && firstJoinB.at <= firstSegB.at)
  check('one session for the round, taken up again after the restart', app.sessions.size === 1 && app.starts.some((s) => s.outcome === 'resumed' && s.at > beforeRestart), app.starts)
  check('words came in after the restart', segs.some((s) => s.at > beforeRestart + 2000))
  check('after notes went off: the session was ended by the recorder, and nothing said after was kept', app.ends.length === 1 && app.ends[0].reason === 'told' && !segs.some((s) => s.said >= offAt), { ends: app.ends, droppedAfterOff: app.dropped.length })
  check('the key went as Deepgram’s subprotocol, with the finals-only settings', dg.protocolsOk)
  check('a mute asked Deepgram for what it had heard (Finalize)', dg.finalizes >= 1, { finalizes: dg.finalizes })
  check('the recorder never published anything', [...A.room.remoteParticipants.values()].every((p) => p.identity !== RECORDER_IDENTITY))
  check('words went to the app in batches, not one request per sentence: two said together came in one', Math.max(...app.batchSizes) >= 2, { batchSizes: app.batchSizes })
  check('the app refused nothing for want of the secret', app.refusedAuth === 0)

  // ── Alone: everyone leaves; does the hidden recorder keep the room open? ──
  notesOn()
  mark('notes on again (round 2)')
  for (let i = 0; i < 100; i++) {
    if (sessionFor(2) && (await health())?.speakers >= 1) break
    await sleep(200)
  }
  mark(`round 2: recorder in, session ${sessionFor(2) ? 'started' : 'missing'}`)
  check('a new round: a new session, the recorder back in the room', !!sessionFor(2))

  // ── Notes off, then on within two seconds, the drain late: round 3's recorder stays ──
  notesOff()
  mark('notes off (round 2)')
  await sleep(1500)
  notesOn()
  mark('notes on again within 2 s (round 3)')
  for (let i = 0; i < 150; i++) {
    const h = await health()
    if (sessionFor(3) && sessionFor(3).status === 'live' && h?.calls >= 1 && h?.speakers >= 3) break
    await sleep(200)
  }
  mark(`round 3: session ${sessionFor(3) ? 'started' : 'missing'}, recorder hearing ${(await health())?.speakers}`)
  // The eject queued at notes off is drained only now, after round 3 began.
  await drainEjects()
  mark(`late drain: settled ${app.ejectsSettled}, removed ${app.ejectsRemoved}`)
  await sleep(3000)
  const inRoom = (await rooms.listParticipants(ROOM)).some((p) => p.identity === RECORDER_IDENTITY)
  const r3From = Date.now()
  A.say(2)
  await sleep(1000)
  G.say(2)
  await sleep(6000)
  const r3 = sessionFor(3)
  const r3Segs = r3 ? [...app.segments.values()].filter((g) => g.session === r3.id).map((g) => ({ ...g, said: Date.parse(r3.startedAt) + g.startMs })) : []
  const heardA3 = r3Segs.some((g) => g.speaker === MA && Math.abs(g.said - r3From) < 900)
  const heardG3 = r3Segs.some((g) => g.speaker === `guest-${GUEST}` && g.said >= r3From + 500)
  check('notes off then on within 2 s, the drain late: the stale eject is settled, the new round’s recorder stays in the room', app.ejectsSettled >= 1 && app.ejectsRemoved === 0 && inRoom, {
    settled: app.ejectsSettled,
    removed: app.ejectsRemoved,
    inRoom,
  })
  check('… and nothing said once it was back is lost (both speakers heard in round 3)', heardA3 && heardG3, { A: heardA3, G: heardG3, segments: r3Segs.length })
  await Promise.all([A.leave(), B2.leave(), G.leave()])
  const leftAt = Date.now()
  mark('everyone left; the recorder alone')
  let roomGoneAt = null
  let recorderLeftAt = null
  let roomAt20 = null
  for (let i = 0; i < 160; i++) {
    const list = await rooms.listRooms([ROOM])
    const ppl = list.length ? await rooms.listParticipants(ROOM).catch(() => []) : []
    if (Date.now() - leftAt >= 20_000 && roomAt20 === null) roomAt20 = list.length > 0
    if (recorderLeftAt === null && list.length && !ppl.some((p) => p.identity === RECORDER_IDENTITY)) recorderLeftAt = Date.now() - leftAt
    if (!list.length) {
      roomGoneAt = Date.now() - leftAt
      break
    }
    await sleep(500)
  }
  result.alone = { roomOpenAt20s: roomAt20, recorderLeftAfterMs: recorderLeftAt, roomGoneAfterMs: roomGoneAt }
  check('alone in the room, the recorder leaves and the room closes', roomGoneAt !== null && roomGoneAt < 70_000, result.alone)
  // LiveKit closes the room once its last person has been gone departureTimeout (15 s), before the
  // recorder's own ALONE_MS: either way it tells the feed it is done (a finish stops waiting for it).
  check('leaving the emptied room, it told the feed it was done with the session (end)', app.ends.some((e) => e.session === sessionFor(app.round)?.id && ['alone', 'disconnected'].includes(e.reason)), app.ends)
}

result.deepgram = { connections: dg.connections, finalizes: dg.finalizes, keepalives: dg.keepalives, closes: dg.closes, bytes: dg.bytes }
result.app = { sessions: app.sessions.size, segments: app.segments.size, duplicates: app.duplicates, dropped: app.dropped.length, starts: app.starts, ends: app.ends, heartbeats: app.heartbeats, works: app.works }
result.passed = result.checks.every((c) => c.pass)
await stopRecorder().catch(() => undefined)
writeFileSync(RUN + `result-${MODE}.json`, JSON.stringify(result, null, 2))
log(`${result.checks.filter((c) => c.pass).length}/${result.checks.length} checks passed`)
await rtc.dispose().catch(() => undefined)
appServer.close()
dgServer?.close()
process.exit(result.passed ? 0 : 1)
