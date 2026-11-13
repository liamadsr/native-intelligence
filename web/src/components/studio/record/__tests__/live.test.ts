// A take uploaded while it records (live.ts) against a made-up Studio: chunks gather into pieces of a few seconds,
// which go up in order, each signed then put; a dropped connection is waited out with the pieces kept; a refusal
// stops the take and keeps what reached the Studio; a Studio that cannot take the recording leaves it here for after
// Stop. And the POST /recordings body names how many pieces each track is.
import { describe, expect, it } from 'vitest'
import { recordingRequest } from '../finish'
import { GIVE_UP_AFTER_STOP_MS, LiveError, LiveTake, PIECE_MAX_BYTES, PIECE_SECONDS, backoffMs, piecesOf, type LiveApi } from '../live'
import type { FinishedTake, TakeRole } from '../types'

const TAKE = '5a5a5a5a-1111-4222-8333-999999999999'

/** A made-up Studio and storage: what was signed and what was put, in order; failures queued up by the test. */
function studio() {
  const calls: string[] = []
  const stored = new Map<string, number>()
  const failures: (LiveError | null)[] = []
  const pieces: Record<string, unknown>[] = []
  const api: LiveApi = {
    async get<T>() {
      return { takes: [] } as T
    },
    async post<T>(path: string, body: unknown) {
      calls.push(`POST ${path}`)
      const failure = failures.shift()
      if (failure) throw failure
      if (path.endsWith('/live-takes')) return { take: { id: TAKE, keys: { screen: `live/${TAKE}/screen`, microphone: `live/${TAKE}/microphone` } } } as T
      const piece = body as { role: string; index: number }
      pieces.push(body as Record<string, unknown>)
      return { url: `fake://${piece.role}/${piece.index}`, headers: { 'content-type': 'application/octet-stream' } } as T
    },
    async remove(path) {
      calls.push(`DELETE ${path}`)
    },
    async put(url, _headers, body) {
      calls.push(`PUT ${url}`)
      stored.set(url, body.size)
    },
  }
  return { api, calls, stored, failures, pieces }
}

/** A clock the test moves, and sleeps that move it. */
function clock() {
  let now = 0
  return { now: () => now, advance: (ms: number) => (now += ms), sleep: async (ms: number) => { now += ms } }
}

function take(api: LiveApi, time = clock(), roles: TakeRole[] = ['screen', 'microphone']) {
  const failed: string[] = []
  const live = new LiveTake(roles, { api, now: time.now, sleep: time.sleep, offset: (role) => (role === 'microphone' ? -0.1 : 0), onFailed: (m) => failed.push(m), onChange: () => undefined })
  return { live, failed, time }
}

const chunk = (bytes: number) => new Blob([new Uint8Array(bytes)])

describe('pieces', () => {
  it('joins chunks and cuts a run longer than the longest piece', () => {
    expect(piecesOf([chunk(3), chunk(4)]).map((b) => b.size)).toEqual([7])
    expect(piecesOf([chunk(10)], 4).map((b) => b.size)).toEqual([4, 4, 2])
    expect(piecesOf([]).length).toBe(0)
  })
  it('waits longer after each failure, up to 15 s', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000])
  })
})

describe('a live take', () => {
  it('sends a piece every few seconds, in order, and at Stop only the last one', async () => {
    const s = studio()
    const { live, time } = take(s.api)
    await live.open('browser', { screen: 'Screen.webm', microphone: 'Mic.webm' })
    const screen = live.tracks.get('screen')!
    for (let second = 1; second <= 9; second++) {
      time.advance(1000)
      screen.push(chunk(100), second)
    }
    await new Promise((r) => setTimeout(r, 0))
    // A piece went up once four seconds had gathered after its first chunk; the last four seconds wait for Stop.
    expect(s.pieces.filter((p) => p.role === 'screen').map((p) => [p.index, p.bytes, p.seconds])).toEqual([[0, 500, 5]])
    expect(screen.status()).toMatchObject({ state: 'live', recordedBytes: 900, uploadedBytes: 500, unsavedSeconds: 4 })
    const done = await screen.finish()
    expect(done).toEqual({ key: `live/${TAKE}/screen`, pieces: 2, complete: true })
    expect([...s.stored.entries()]).toEqual([['fake://screen/0', 500], ['fake://screen/1', 400]])
    expect(screen.status().state).toBe('done')
  })

  it('cuts a piece early when it is large, and never past the longest piece', async () => {
    const s = studio()
    const { live } = take(s.api)
    await live.open('browser', { screen: 'Screen.webm', microphone: 'Mic.webm' })
    const screen = live.tracks.get('screen')!
    screen.push(chunk(PIECE_MAX_BYTES + 10), 1)
    await screen.finish()
    expect(s.pieces.map((p) => p.bytes)).toEqual([PIECE_MAX_BYTES, 10])
  })

  it('tells the Studio where the microphone sits on the screen’s clock', async () => {
    const s = studio()
    const { live } = take(s.api)
    await live.open('browser', { screen: 'Screen.webm', microphone: 'Mic.webm' })
    live.tracks.get('microphone')!.push(chunk(10), PIECE_SECONDS)
    await live.tracks.get('microphone')!.finish()
    expect(s.pieces[0]).toMatchObject({ role: 'microphone', index: 0, offsetSeconds: -0.1 })
  })

  it('keeps the pieces through a dropped connection and sends them when it is back', async () => {
    const s = studio()
    const { live } = take(s.api)
    await live.open('browser', { screen: 'Screen.webm', microphone: 'Mic.webm' })
    s.failures.push(new LiveError('The Studio could not be reached.', 0), new LiveError('Busy', 503), null)
    const screen = live.tracks.get('screen')!
    screen.push(chunk(50), 1)
    const done = await screen.finish()
    expect(done.pieces).toBe(1)
    expect(s.stored.get('fake://screen/0')).toBe(50)
  })

  it('gives up for now after Stop when nothing gets through for a while, and tries again when asked', async () => {
    const s = studio()
    const { live } = take(s.api)
    await live.open('browser', { screen: 'Screen.webm', microphone: 'Mic.webm' })
    for (let i = 0; i < 40; i++) s.failures.push(new LiveError('The Studio could not be reached.', 0))
    const screen = live.tracks.get('screen')!
    screen.push(chunk(50), 1)
    await expect(screen.finish()).rejects.toThrow('It is kept on this device: try again.')
    expect(screen.status().state).toBe('retrying')
    expect(GIVE_UP_AFTER_STOP_MS).toBeGreaterThan(0)
    s.failures.length = 0
    await expect(screen.finish()).resolves.toMatchObject({ pieces: 1, complete: true })
  })

  it('stops the take when the Studio refuses the rest, keeping what reached it', async () => {
    const s = studio()
    const { live, failed, time } = take(s.api)
    await live.open('browser', { screen: 'Screen.webm', microphone: 'Mic.webm' })
    const screen = live.tracks.get('screen')!
    screen.push(chunk(100), 1)
    time.advance(PIECE_SECONDS * 1000)
    screen.push(chunk(100), 1 + PIECE_SECONDS)
    await new Promise((r) => setTimeout(r, 0))
    s.failures.push(new LiveError('This workspace’s Studio is full.', 413, 'QUOTA'))
    time.advance(1000)
    screen.push(chunk(100), 2 + PIECE_SECONDS)
    time.advance(PIECE_SECONDS * 1000)
    screen.push(chunk(100), 2 + 2 * PIECE_SECONDS)
    await new Promise((r) => setTimeout(r, 0))
    expect(failed).toEqual(['This workspace’s Studio is full.'])
    expect(await screen.finish()).toEqual({ key: `live/${TAKE}/screen`, pieces: 1, complete: false })
  })

  it('records here when the Studio cannot take it while it records, to upload after Stop', async () => {
    const s = studio()
    const { live } = take(s.api)
    s.failures.push(new LiveError('Not found', 404))
    expect(await live.open('browser', { screen: 'Screen.webm', microphone: 'Mic.webm' })).toBe(false)
    const screen = live.tracks.get('screen')!
    screen.push(chunk(30), 1)
    screen.push(chunk(20), 2)
    expect(screen.status().state).toBe('local')
    expect(screen.localBlob('video/webm').size).toBe(50)
    await expect(screen.finish()).rejects.toThrow()
    // Nothing on the server to throw away.
    await live.discard()
    expect(s.calls.filter((c) => c.startsWith('DELETE'))).toEqual([])
  })

  it('throws the take away on the Studio when it is cancelled', async () => {
    const s = studio()
    const { live } = take(s.api)
    await live.open('browser', { screen: 'Screen.webm', microphone: 'Mic.webm' })
    await live.discard()
    expect(s.calls.at(-1)).toBe(`DELETE /api/account/studio/live-takes/${TAKE}`)
  })
})

describe('the recording request', () => {
  it('names how many pieces each live track is', () => {
    const finished: FinishedTake = {
      kind: 'browser', sessionId: TAKE, trace: null, sourceCursorHidden: false, transcript: null, durationSeconds: 9, liveTakeId: TAKE,
      files: [
        { role: 'screen', name: 'Screen.webm', contentType: 'video/webm', bytes: 900, offsetSeconds: 0, durationSeconds: 9, uploadKey: `live/${TAKE}/screen`, pieces: 3 },
        { role: 'microphone', name: 'Mic.webm', contentType: 'audio/webm', bytes: 90, offsetSeconds: -0.1, durationSeconds: 9, uploadKey: `live/${TAKE}/microphone`, pieces: 2 },
      ],
    }
    const body = recordingRequest(finished, { screen: `live/${TAKE}/screen`, microphone: `live/${TAKE}/microphone` }, { kind: 'new' })
    expect(body.screen).toEqual({ uploadKey: `live/${TAKE}/screen`, name: 'Screen.webm', pieces: 3 })
    expect(body.microphone).toEqual({ uploadKey: `live/${TAKE}/microphone`, name: 'Mic.webm', offsetSeconds: -0.1, pieces: 2 })
    // A track the Studio refused the end of says so.
    finished.files[0]!.partial = true
    expect(recordingRequest(finished, { screen: `live/${TAKE}/screen` }, { kind: 'new' }).screen).toEqual({ uploadKey: `live/${TAKE}/screen`, name: 'Screen.webm', pieces: 3, partial: true })
  })
})
