// The Mac app's take uploaded while it records, end to end against the Studio's own live-takes code (its in-memory
// tables and bucket): the recorder writes segments, the page cuts them into pieces the app plans on its disk and
// sends, each signed by the Studio with its fences; at Stop only the tail is left; a take a crash cuts short is sent on
// from the disk at the next launch, then brought back from the Studio; a track the Studio refuses uploads whole after
// Stop. The made-up Mac keeps its files in memory and checks plans as the app does (studio_recorder.rs extend_plan).
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { blobObject } from '@/lib/studio/server/job-contract'
import { discardLiveTake, livePiece, liveTakeState, savedTakes, startLiveTake, QUIET_MS, TRACKS } from '@/lib/studio/server/live-takes'
import { startUpload } from '@/lib/studio/server/media'
import { getRecord } from '@/lib/studio/server/records'
import { advanceRecording, recoverTake, startRecording } from '@/lib/studio/server/recordings'
import { bindWholeUpload } from '@/lib/studio/server/live-takes'
import { StudioError } from '@/lib/studio/server/errors'
import { AVA, fakeContext, WS } from '@/lib/studio/server/__tests__/fake'
import { DesktopRecorder, type StudioRecorderBridge } from '../desktop'
import { recordingRequest } from '../finish'
import { hrefsFor, memoryDraftStore, provisionalRecord } from '../provisional'
import { LiveError, type LiveApi } from '../live'
import type { TakeFile, TakeRole } from '../types'

const uploads = vi.hoisted(() => ({ tickets: 0 }))
/** This browser's storage, in memory (the test runs in Node). */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() { return items.size },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, String(v)),
    removeItem: (k) => void items.delete(k),
    clear: () => items.clear(),
  }
}
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})
vi.mock('../../ui/client', () => ({
  request: async () => {
    uploads.tickets++
    return { uploadKey: `uploads/0e0e0e0e-1111-4222-8333-${String(uploads.tickets).padStart(12, '0')}`, partBytes: 1 << 20, parts: [] }
  },
}))

const SESSION = '0f0f0f0f-1111-4222-8333-444444444444'
const ROLES: TakeRole[] = ['screen', 'microphone']

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext({ member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'member' }] })
  uploads.tickets = 0
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

/** The Studio's routes, called straight (as the page's fetch would reach them), errors as the page reads them. */
function studioApi(): LiveApi {
  const call = async <T>(work: () => Promise<unknown>): Promise<T> => {
    try {
      return (await work()) as T
    } catch (error) {
      if (error instanceof StudioError) throw new LiveError(error.message, error.status, error.code)
      throw error
    }
  }
  const id = (path: string) => decodeURIComponent(/live-takes\/([^/]+)/.exec(path)![1]!)
  return {
    get: (path) => call(() => (path.includes('/recordings/') ? advanceRecording(env.ctx, decodeURIComponent(/recordings\/([^/?]+)/.exec(path)![1]!), 0) : liveTakeState(env.ctx, id(path)))),
    post: (path, body) => call(() => (path.endsWith('/uploads') ? startUpload(env.ctx, body as Record<string, unknown>) : path.endsWith('/live-takes') ? startLiveTake(env.ctx, body) : path.endsWith('/whole') ? bindWholeUpload(env.ctx, id(path), body) : livePiece(env.ctx, id(path), body))),
    remove: (path) => call(() => discardLiveTake(env.ctx, id(path))),
    put: async () => {
      throw new Error('the Mac app sends its own pieces')
    },
  }
}

type Planned = { index: number; offset: number; length: number; seconds: number; offsetSeconds?: number | null }

/** A made-up Mac: the recorder's files in memory, written in segments; the app's plan and send. */
function mac() {
  const disk: Record<string, Uint8Array> = { screen: new Uint8Array(0), microphone: new Uint8Array(0) }
  const segments: Record<string, { offset: number; length: number; endSeconds: number }[]> = { screen: [], microphone: [] }
  const plans: Record<string, Planned[]> = { screen: [], microphone: [] }
  const listeners: ((event: unknown) => void)[] = []
  const calls: string[] = []
  const state = { failPuts: 0, linked: null as string | null, finished: 'recording', discarded: [] as string[] }
  const startPts = { screen: 100, microphone: 99.956 }
  const fail = (code: string, message: string) => Object.assign(new Error(message), { code })
  const bridge: StudioRecorderBridge = {
    available: async () => true,
    permissions: async () => ({ screenRecording: 'granted', microphone: 'granted', camera: 'granted' }),
    requestPermissions: async () => ({}),
    targets: async () => ({}),
    start: async () => ({ sessionId: SESSION, files: ROLES.map((role) => ({ role, path: `/takes/${SESSION}/${role}` })) }),
    stop: async () => ({
      sessionId: SESSION,
      t0: 100,
      files: ROLES.map((role) => ({
        role, path: `/takes/${SESSION}/${role}.${role === 'screen' ? 'mp4' : 'm4a'}`, bytes: disk[role]!.length, firstPts: startPts[role as 'screen'], durationSeconds: 12,
        sha256: createHash('sha256').update(disk[role]!).digest('hex'), ...(role === 'screen' ? { width: 1280, height: 720, frames: 720, fps: 60 } : {}),
      })),
    }),
    takeMedia: async () => ({ tracks: ROLES.map((role) => ({ role, sha256: createHash('sha256').update(disk[role]!).digest('hex'), bytes: disk[role]!.length })), waveform: [0.2, 0.5] }),
    upload: async (_session, role, parts) => {
      calls.push(`whole ${role}`)
      // As the app does: each part of the file, from the disk, to its link.
      let at = 0
      for (const part of parts) {
        env.storage.put(part.url.replace('fake://upload/', ''), disk[role]!.slice(at, at + part.bytes))
        at += part.bytes
      }
      return { bytes: disk[role]!.length, sha256: 'x', parts: [] }
    },
    discard: async (session) => {
      state.discarded.push(session)
    },
    cancel: async () => ({ cancelled: true }),
    onSegment: (cb: (event: unknown) => void) => {
      listeners.push(cb)
      return () => listeners.splice(listeners.indexOf(cb), 1)
    },
    segments: async (_session, role) => ({ bytes: disk[role]!.length, startPts: segments[role]!.length ? startPts[role as 'screen'] : null, segments: segments[role]!.map((s, index) => ({ index, kind: index ? 'media' : 'init', ...s })) }),
    linkLive: async (_session, takeId) => {
      state.linked = takeId
    },
    planPieces: async (_session, role, pieces) => {
      const plan = plans[role]!
      for (const piece of pieces) {
        if (piece.index < plan.length) {
          if (JSON.stringify(plan[piece.index]) !== JSON.stringify(piece)) throw fail('conflict', 'planned otherwise')
          continue
        }
        const end = plan.length ? plan.at(-1)!.offset + plan.at(-1)!.length : 0
        if (piece.index !== plan.length || piece.offset !== end || piece.offset + piece.length > disk[role]!.length) throw fail('conflict', 'does not follow the plan')
        plan.push(piece)
      }
      return { planned: plan.length }
    },
    putPiece: async (_session, role, index, url, headers) => {
      const piece = plans[role]![index]
      if (!piece) throw fail('not-found', `piece ${index} was not planned`)
      if (state.failPuts > 0) {
        state.failPuts--
        throw fail('upload', 'the connection dropped')
      }
      calls.push(`put ${role} ${index}`)
      if (!env.storage.putLink({ url, headers }, disk[role]!.slice(piece.offset, piece.offset + piece.length))) throw fail('upload', 'answered 400')
      return { bytes: piece.length }
    },
    unfinishedTakes: async () => ({
      takes: state.linked
        ? [{ sessionId: SESSION, takeId: state.linked, state: state.finished, tracks: ROLES.map((role) => ({ role, bytes: disk[role]!.length, seconds: segments[role]!.at(-1)?.endSeconds ?? null, startPts: startPts[role as 'screen'], plan: plans[role] })) }]
        : [],
    }),
  }
  let filler = 1
  /** The recorder finished a segment of `bytes` bytes (the first opens as an MP4), and (`announce`) says so. */
  const write = (role: TakeRole, bytes: number, endSeconds: number, announce = true) => {
    const chunk = new Uint8Array(bytes).fill(filler++ % 250)
    if (!disk[role]!.length) chunk.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x35])
    const offset = disk[role]!.length
    const joined = new Uint8Array(offset + bytes)
    joined.set(disk[role]!)
    joined.set(chunk, offset)
    disk[role] = joined
    segments[role]!.push({ offset, length: bytes, endSeconds })
    const index = segments[role]!.length - 1
    if (announce) for (const listener of [...listeners]) listener({ sessionId: SESSION, role, index, kind: index ? 'media' : 'init', offset, length: bytes, endSeconds, startPts: startPts[role as 'screen'] })
  }
  return { bridge, disk, plans, calls, state, write }
}

/** A clock the test moves: a wait ends once the test has moved it that far; `dead` ends none (the page is gone). */
function clock() {
  let now = 0
  let waits: { at: number; wake: () => void }[] = []
  const time = {
    dead: false,
    now: () => now,
    advance: (ms: number) => {
      now += ms
      const due = waits.filter((w) => w.at <= now)
      waits = waits.filter((w) => w.at > now)
      if (!time.dead) for (const w of due) w.wake()
    },
    sleep: (ms: number) => new Promise<void>((wake) => {
      waits.push({ at: now + ms, wake })
    }),
  }
  return time
}
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
}
const options = { screen: { kind: 'display' as const, displayId: 1 }, camera: null, microphone: { deviceId: null }, systemAudio: false, hideCursor: true }

/** Record `seconds` of a take, a 2 s segment of each track at a time (the screen's first is its init, 600 bytes). */
async function record(m: ReturnType<typeof mac>, time: ReturnType<typeof clock>, from: number, to: number, announce = true) {
  for (let s = from; s < to; s += 2) {
    time.advance(2000)
    if (!m.disk.screen!.length) m.write('screen', 600, 0, announce)
    if (!m.disk.microphone!.length) m.write('microphone', 600, 0, announce)
    m.write('screen', 150_000, s + 2, announce)
    m.write('microphone', 16_000, s + 2, announce)
    await settle()
  }
}

/** The bytes of a track as the Studio holds them, its pieces joined in order. */
function stored(takeId: string, role: string, count: number): Uint8Array {
  const parts = Array.from({ length: count }, (_, i) => env.storage.objects.get(blobObject(WS, `live/${takeId}/${role}`, i))!.bytes)
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

describe('a Mac take uploaded while it records', () => {
  it('goes up in pieces as it records; at Stop only the tail is left; the Studio seals exactly the file on the computer', async () => {
    const m = mac()
    const time = clock()
    const recorder = new DesktopRecorder(m.bridge, studioApi(), time)
    await recorder.prepare(options)
    await recorder.start({ onStatus: () => undefined, onEnded: () => undefined })
    await settle()
    expect(m.state.linked).toBeTruthy()
    const takeId = m.state.linked!
    await record(m, time, 0, 20)
    const before = (await liveTakeState(env.ctx, takeId)).take.tracks.find((t) => t.role === 'screen')!
    // A piece a segment (two seconds; the first with the init) went up while it recorded.
    expect([before.declared, before.stored]).toEqual([10, 10])
    // The last segments are written at Stop, their events not (yet) here: Stop reads the take's index.
    m.write('screen', 90_000, 21, false)
    m.write('microphone', 9_000, 21, false)
    const take = await recorder.stop()
    expect(take.liveTakeId).toBe(takeId)
    const keys: Partial<Record<TakeRole, string>> = {}
    let tail = 0
    for (const file of take.files) {
      const before = m.calls.length
      keys[file.role] = await recorder.upload(take, file, () => undefined)
      tail += m.calls.length - before
      expect(file.uploadKey).toBe(`live/${takeId}/${file.role === 'microphone' ? 'microphone' : 'screen'}`)
    }
    // Only the tail was left: one piece a track.
    expect(tail).toBe(2)
    expect(m.calls.some((c) => c.startsWith('whole'))).toBe(false)
    const answer = await startRecording(env.ctx, recordingRequest(take, keys, { kind: 'new' }), 0)
    expect(answer.recording.status).toBe('processing')
    for (const file of take.files as TakeFile[]) {
      const role = file.role === 'microphone' ? 'microphone' : 'screen'
      const state = (await liveTakeState(env.ctx, takeId)).take.tracks.find((t) => t.role === role)!
      expect(state.sealed).toBe(true)
      expect(file.pieces).toBe(state.stored)
      // Joined in order, the pieces are byte for byte the recorder's file.
      expect(stored(takeId, role, state.stored)).toEqual(m.disk[file.role])
    }
    const jobs = env.tables.studio_job!.map((j) => j.input as { uploadKey: string; conform?: unknown; partial?: boolean })
    expect(jobs.map((j) => j.uploadKey).sort()).toEqual([`live/${takeId}/microphone`, `live/${takeId}/screen`])
    expect(jobs.every((j) => !j.partial)).toBe(true)

    // The next time the Studio opens, the take is handed over but not made yet: the copy on the computer stays until
    // the Studio holds every byte of it (filing.test.ts: it goes once it does, never before).
    const next = new DesktopRecorder(m.bridge, studioApi(), clock())
    expect(await next.sendUnfinished()).toBe(0)
    expect(m.state.discarded).toEqual([])
  }, 30_000)

  it('cut short by a crash: the next launch sends what the disk holds, and the take is brought back whole', async () => {
    const m = mac()
    const time = clock()
    const recorder = new DesktopRecorder(m.bridge, studioApi(), time)
    await recorder.prepare(options)
    await recorder.start({ onStatus: () => undefined, onEnded: () => undefined })
    await settle()
    const takeId = m.state.linked!
    await record(m, time, 0, 12)
    // The connection drops; a piece is declared but never stored. Then the app crashes: the page is gone mid-retry.
    m.state.failPuts = 1_000
    await record(m, time, 12, 18)
    time.dead = true
    recorder.dispose()
    // The recorder finished its files as the app quit (no events: nobody listens).
    await record(m, time, 18, 22, false)
    const left = (await liveTakeState(env.ctx, takeId)).take.tracks.find((t) => t.role === 'screen')!
    expect(left.declared).toBeGreaterThan(left.stored)
    expect(m.plans.screen!.length).toBeGreaterThanOrEqual(left.declared)

    // Next launch: what did not go up is sent from the disk, the pieces the Studio heard of exactly as declared.
    m.state.failPuts = 0
    const next = new DesktopRecorder(m.bridge, studioApi(), clock())
    expect(await next.sendUnfinished()).toBe(1)
    for (const role of ROLES) {
      const state = (await liveTakeState(env.ctx, takeId)).take.tracks.find((t) => t.role === role)!
      expect(state.stored).toBe(state.declared)
      expect(stored(takeId, role, state.stored)).toEqual(m.disk[role])
    }
    // Offered back once quiet, then made a video from all of it.
    const later = Date.now() + QUIET_MS + 1000
    const saved = (await savedTakes(env.ctx, later)).takes
    expect(saved.map((t) => t.id)).toEqual([takeId])
    expect(saved[0]!.bytes).toBe(m.disk.screen!.length + m.disk.microphone!.length)
    await recoverTake(env.ctx, takeId, 0, later)
    const screen = (await liveTakeState(env.ctx, takeId)).take.tracks.find((t) => t.role === 'screen')!
    expect(screen.sealed).toBe(true)
    expect(screen.bytes).toBe(m.disk.screen!.length)
    // Sent once: a second launch finds nothing more to send.
    expect(await new DesktopRecorder(m.bridge, studioApi(), clock()).sendUnfinished()).toBe(0)
  }, 30_000)

  it('a track the Studio refuses keeps recording and uploads whole after Stop', async () => {
    const m = mac()
    const time = clock()
    const recorder = new DesktopRecorder(m.bridge, studioApi(), time)
    await recorder.prepare(options)
    await recorder.start({ onStatus: () => undefined, onEnded: () => undefined })
    await settle()
    await record(m, time, 0, 8)
    // Thrown away on the Studio (another window): every further piece is refused.
    await discardLiveTake(env.ctx, m.state.linked!)
    await record(m, time, 8, 16)
    const take = await recorder.stop()
    for (const file of take.files) {
      expect(file.uploadKey).toBeUndefined()
      await recorder.upload(take, file, () => undefined)
    }
    expect(m.calls.filter((c) => c.startsWith('whole')).sort()).toEqual(['whole microphone', 'whole screen'])
  }, 30_000)

  it('keeps every track on the screen’s clock when the page missed every segment event: live and after a crash', async () => {
    const m = mac()
    const time = clock()
    const recorder = new DesktopRecorder(m.bridge, studioApi(), time)
    await recorder.prepare(options)
    await recorder.start({ onStatus: () => undefined, onEnded: () => undefined })
    await settle()
    const takeId = m.state.linked!
    await record(m, time, 0, 8, false)
    const take = await recorder.stop()
    const mic = take.files.find((f) => f.role === 'microphone')!
    await recorder.upload(take, mic, () => undefined)
    expect(mic.uploadKey).toBeTruthy()
    const track = await getRecord<{ offsetSeconds: number | null }>(env.ctx, TRACKS, `${takeId}:microphone`)
    expect(track!.offsetSeconds).toBeCloseTo(-0.044, 6)

    // A second take, its page gone mid-take with every event missed: sent on from the disk with its offset.
    const m2 = mac()
    const time2 = clock()
    const recorder2 = new DesktopRecorder(m2.bridge, studioApi(), time2)
    await recorder2.prepare(options)
    await recorder2.start({ onStatus: () => undefined, onEnded: () => undefined })
    await settle()
    await record(m2, time2, 0, 8, false)
    time2.dead = true
    recorder2.dispose()
    expect(await new DesktopRecorder(m2.bridge, studioApi(), clock()).sendUnfinished()).toBe(1)
    const track2 = await getRecord<{ offsetSeconds: number | null; bytes: number }>(env.ctx, TRACKS, `${m2.state.linked}:microphone`)
    expect(track2!.offsetSeconds).toBeCloseTo(-0.044, 6)
    expect(track2!.bytes).toBe(m2.disk.microphone!.length)
  }, 30_000)

  it('a track the Studio stopped taking is sent whole after a restart, its folder kept until then, and the take brought back with it', async () => {
    const m = mac()
    const time = clock()
    const recorder = new DesktopRecorder(m.bridge, studioApi(), time)
    await recorder.prepare(options)
    await recorder.start({ onStatus: () => undefined, onEnded: () => undefined })
    await settle()
    const takeId = m.state.linked!
    await record(m, time, 0, 8)
    // A microphone piece is in storage at another length: the Studio stops taking that track at the next piece.
    const key = `live/${takeId}/microphone`
    const state = (await liveTakeState(env.ctx, takeId)).take.tracks.find((t) => t.role === 'microphone')!
    env.storage.put(blobObject(WS, key, state.stored - 1), new Uint8Array(10))
    await record(m, time, 8, 12)
    expect((await liveTakeState(env.ctx, takeId)).take.tracks.find((t) => t.role === 'microphone')!.stopped).toBe(true)
    // The app quits before Stop: the page is gone, the recorder finishes its files.
    time.dead = true
    recorder.dispose()
    await record(m, time, 12, 16, false)

    const next = new DesktopRecorder(m.bridge, studioApi(), clock())
    expect(await next.sendUnfinished()).toBe(1)
    expect(m.calls).toContain('whole microphone')
    const later = Date.now() + QUIET_MS + 1000
    // Bound to the take on the Studio itself (POST /live-takes/:id/whole): whoever brings it back gets the whole track.
    expect((await liveTakeState(env.ctx, takeId)).take.whole).toEqual(['microphone'])
    await recoverTake(env.ctx, takeId, 0, later)
    const job = env.tables.studio_job!.map((j) => j.input as { uploadKey: string; provenance: { role: string } }).find((j) => j.provenance.role === 'microphone')!
    expect(job.uploadKey).toMatch(/^uploads\//)
    const blob = env.tables.studio_blob!.find((b) => b.key === job.uploadKey)!
    expect(blob.bytes).toBe(m.disk.microphone!.length)
    // Handed over with the whole track, not made yet: the folder stays (it goes once the Studio holds every byte).
    await new DesktopRecorder(m.bridge, studioApi(), clock()).sendUnfinished()
    expect(m.state.discarded).toEqual([])
  }, 30_000)

  it('opens in the editor at Stop without waiting for the Studio, even one that never answers', async () => {
    const m = mac()
    const time = clock()
    // A Studio that never answers: the take could not even be opened there.
    const silent: LiveApi = { ...studioApi(), post: () => new Promise<never>(() => undefined) }
    const recorder = new DesktopRecorder(m.bridge, silent, time)
    await recorder.prepare(options)
    await recorder.start({ onStatus: () => undefined, onEnded: () => undefined })
    await record(m, time, 0, 12)
    // Everything the page does from Stop to handing the edit to the editor (useManualRecording finish, App openDraft):
    // the take, its draft, the record kept beside it and read back, the addresses its files play from. React drawing
    // the editor is not in it (only the real app can show that).
    const store = memoryDraftStore()
    const started = performance.now()
    const take = await recorder.stop()
    const draft = await recorder.provisional(take, '7e7e7e7e-1111-4222-8333-444444444444', 'Recording · 14 Nov')
    await store.put(provisionalRecord(draft!, { sessionId: take.sessionId, takeId: take.liveTakeId ?? null, title: 'Recording · 14 Nov', files: take.files, take }))
    const kept = (await store.get('7e7e7e7e-1111-4222-8333-444444444444'))!
    const hrefs = hrefsFor(kept.assets, kept.sessionId, 'k'.repeat(64))
    const ms = performance.now() - started
    console.info(`STOP_TO_EDITOR ${ms.toFixed(1)} ms (made-up Mac, no Studio; up to the editor's load, not its drawing)`)
    expect(Object.keys(hrefs)).toHaveLength(2)
    expect(draft).not.toBeNull()
    expect(draft!.project.clips[0]).toMatchObject({ trimEndSourceFrame: 720 })
    expect(draft!.project.audioTracks).toHaveLength(1)
    expect(ms).toBeLessThan(1000)
  }, 30_000)
})
