/**
 * The call recorder: one process for every call it is in (deploy/livekit's
 * `recorder` service; deploy/README.md step 23, "The call recorder").
 *
 *   - Every few seconds it asks the app for its work (the live calls with
 *     notes on that nobody feeds), starts each one's feed session and joins
 *     its room (./call.ts). It never listens on a port the app could call:
 *     LiveKit's stack is kept off the app's networks, and asking means a
 *     restarted recorder finds its calls again by itself.
 *     Joins run side by side, each given up after CONNECT_TIMEOUT_MS: one
 *     room that does not answer never holds up the others.
 *   - Every HEARTBEAT_MS it tells the feed which sessions it runs: that is how
 *     the app knows it is alive (the sweeper marks a quiet one lost), and the
 *     answer says which to stop (notes off, the call over, the bound, the
 *     capture closed, or the switch turned off in the app) and which meeting
 *     guests each call may hear now.
 *   - A call it left because it was alone, or because the feed refused its
 *     words, is not joined again for COOLDOWN_MS (the app may offer it again
 *     meanwhile: the work request names it as running).
 *   - SIGTERM (a deploy, a restart): every call's last words are delivered,
 *     and it leaves without ending any session, so the next process takes
 *     them up at once.
 *   - One recorder process per deployment today: its LiveKit identity is
 *     `notes-recorder-<RECORDER_ID>`, one per producer, so two processes with
 *     the same id would push each other out of a room.
 *   - The calls' sound (RECORDER_AUDIO=on, ./audio.ts): one take per call
 *     on disk while it is heard, encoded and handed to the app after, one at
 *     a time, in the background; what a shutdown leaves is picked up by the
 *     next process.
 *   - Health: GET http://127.0.0.1:<RECORDER_HEALTH_PORT>/ answers 200 while
 *     its loop runs (the compose health check), with counts and nothing else.
 */
import { createServer } from 'node:http'
import { dispose } from '@livekit/rtc-node'
import { AppClient, AppError, PRODUCER_KIND } from './app-client.ts'
import { AudioKeeper } from './audio.ts'
import { CallRecorder, type CallEnd } from './call.ts'
import { deepgramUrl, loadConfig, type RecorderConfig } from './config.ts'
import { sleep } from './backoff.ts'
import { Keys } from './speech.ts'

/** How often it tells the feed what it runs. */
export const HEARTBEAT_MS = 5_000
/** After leaving a call it was alone in, or whose feed refused its words, how long before it may join that call again. */
export const COOLDOWN_MS = 60_000

const loaded = loadConfig()
if ('missing' in loaded) {
  console.error(`[recorder] not started: set ${loaded.missing.join(', ')}`)
  process.exit(1)
}
const config: RecorderConfig = loaded

const client = new AppClient({ appUrl: config.appUrl, secret: config.feedSecret, producer: { kind: PRODUCER_KIND, id: config.producerId } })
const keys = new Keys(Date.now().toString(36))
const audio = config.audio ? new AudioKeeper(config.audio, client) : null
const audioOn = audio ? await audio.start() : false
const calls = new Map<string, CallRecorder>()
/** Joins under way (a call is in `calls` once its session started; this holds it until the room is joined). */
const joining = new Set<string>()
const cooldown = new Map<string, number>()
const shutdown = new AbortController()
let lastLoopAt = Date.now()
let lastAppOkAt = 0

function forget(callId: string, rec: CallRecorder, why: CallEnd): void {
  if (calls.get(callId) === rec) calls.delete(callId)
  if (why === 'alone' || why === 'refused') cooldown.set(callId, Date.now() + COOLDOWN_MS)
}

async function join(job: Awaited<ReturnType<AppClient['work']>>['jobs'][number]): Promise<void> {
  const started = await client.start(job.callId)
  if (!started.session) {
    console.info(`[recorder] call=${job.callId} not started: ${started.outcome}`)
    return
  }
  const rec = new CallRecorder(job, started.session, {
    client,
    livekitUrl: config.livekitUrl,
    deepgramUrl: deepgramUrl(config.deepgramUrl),
    deepgramKey: config.deepgramKey,
    maxCallMs: config.maxCallMs,
    keys,
    audio: audioOn ? audio : null,
  })
  calls.set(job.callId, rec)
  void rec.done.then((why) => forget(job.callId, rec, why))
  try {
    await rec.start()
  } catch (err) {
    console.warn(`[recorder] call=${job.callId} room not joined:`, err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    await rec.stop('failed', { flushMs: 0 })
  }
}

async function workLoop(): Promise<void> {
  let pollMs = 3000
  while (!shutdown.signal.aborted) {
    lastLoopAt = Date.now()
    for (const [id, until] of cooldown) if (until <= Date.now()) cooldown.delete(id)
    try {
      const running = [...new Set([...calls.keys(), ...joining, ...cooldown.keys()])]
      const busy = () => new Set([...calls.keys(), ...joining]).size
      const work = await client.work(running, Math.max(0, config.maxCalls - busy()))
      lastAppOkAt = Date.now()
      pollMs = Math.max(1000, Math.min(30_000, work.pollMs))
      for (const job of work.jobs) {
        if (shutdown.signal.aborted || calls.has(job.callId) || joining.has(job.callId) || cooldown.has(job.callId) || busy() >= config.maxCalls) continue
        joining.add(job.callId)
        void join(job)
          .catch((err) => console.warn(`[recorder] call=${job.callId} not joined:`, err instanceof Error ? err.message.slice(0, 160) : 'unknown'))
          .finally(() => joining.delete(job.callId))
      }
    } catch (err) {
      const status = err instanceof AppError ? err.status : 0
      console.warn(`[recorder] work not read (${status || 'unreachable'})${status === 404 ? ': the recorder is off in the app (TEAM_CALL_RECORDER), or the feed is (CAPTURE_FEED_SECRET)' : ''}`)
      pollMs = Math.min(30_000, Math.max(pollMs * 2, 5000))
    }
    await sleep(pollMs, shutdown.signal)
  }
}

async function heartbeatLoop(): Promise<void> {
  while (!shutdown.signal.aborted) {
    await sleep(HEARTBEAT_MS, shutdown.signal)
    if (shutdown.signal.aborted || calls.size === 0) continue
    const bySession = new Map([...calls.values()].map((r) => [r.session.id, r]))
    try {
      const answers = await client.heartbeat([...bySession.keys()])
      lastAppOkAt = Date.now()
      for (const a of answers) {
        const rec = bySession.get(a.id)
        if (!rec) continue
        if (a.keep) {
          rec.setGuests(a.guests)
          continue
        }
        console.info(`[recorder] call=${rec.job.callId} session=${a.id} stop: ${a.reason ?? 'told'}`)
        rec.setGuests([])
        void rec.stop('told')
      }
    } catch (err) {
      console.warn(`[recorder] heartbeat not sent (${err instanceof AppError ? err.status || 'unreachable' : 'unknown'})`)
    }
  }
}

const health = createServer((req, res) => {
  const alive = Date.now() - lastLoopAt < 60_000
  res.writeHead(alive ? 200 : 503, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      ok: alive,
      calls: calls.size,
      speakers: [...calls.values()].reduce((n, r) => n + r.speakers, 0),
      appOkSecondsAgo: lastAppOkAt ? Math.round((Date.now() - lastAppOkAt) / 1000) : null,
      audio: audioOn && audio ? { pending: audio.pending, ...audio.counts } : null,
    }),
  )
  void req
})
health.listen(config.healthPort, '127.0.0.1')

async function stopAll(signal: string): Promise<void> {
  if (shutdown.signal.aborted) return
  console.info(`[recorder] ${signal}: leaving ${calls.size} call(s), sessions kept for the next process`)
  shutdown.abort()
  await Promise.all([...calls.values()].map((r) => r.stop('shutdown', { flushMs: 15_000 })))
  await audio?.stop(5_000)
  health.close()
  await dispose().catch(() => undefined)
  process.exit(0)
}
process.on('SIGTERM', () => void stopAll('SIGTERM'))
process.on('SIGINT', () => void stopAll('SIGINT'))

console.info(`[recorder] started as ${config.producerId}: up to ${config.maxCalls} calls, LiveKit at ${config.livekitUrl}, audio ${audioOn ? 'on' : 'off'}`)
void workLoop()
void heartbeatLoop()
