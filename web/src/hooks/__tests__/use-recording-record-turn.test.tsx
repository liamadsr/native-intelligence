// @vitest-environment jsdom
/**
 * useRecording — the out-of-cycle record turn (live-agent messaging L3, plan
 * 3.6). A directive for the note-taker landed; `requestRecordTurn(captureId)`
 * gets it recorded within one turn instead of at the next transcript window.
 *
 * Drives the REAL hook (real TranscriptGate, real processChunk and pairing);
 * the edges are fakes: the Tauri bridge, a Deepgram fake whose onSegment feeds
 * the gate, and fetch, which answers /api/ai/live-agent (optionally held open
 * to keep a turn in flight).
 *
 * Pinned:
 *  - idle with transcript buffered → flushed now, under the size floor, as an
 *    ordinary window (no record_only);
 *  - idle with nothing buffered → one record_only turn over the windows
 *    already sent; before the first window, nothing;
 *  - paired (assist-only copilot) → the notes turn alone;
 *  - in flight → one record_only turn after the pass, however many requests;
 *  - another capture, live mode off, or after stop → nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'
import type { TranscriptSegment } from '@/lib/deepgram-stream'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const env = vi.hoisted(() => ({
  deepgram: [] as Array<{ onSegment: (s: TranscriptSegment) => void }>,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/lib/recording-telemetry', () => ({ trackRecordingEvent: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    modulesList: async () => [],
    onSttMessage: async () => () => {},
    onSttEngineChanged: async () => () => {},
    onSttFinished: async () => () => {},
    onAudioPcm: async () => () => {},
    getStatus: async () => 'idle',
    checkMicPermission: async () => 'granted',
    requestMicPermission: async () => 'granted',
    checkSystemAudioPermission: async () => 'granted',
    requestSystemAudioPermission: async () => 'granted',
    startRecording: (...args: unknown[]) => env.startRecording(...args),
    stopRecording: () => env.stopRecording(),
    recoverMic: async () => {},
    onAudioLevel: async () => () => {},
    onMicFault: async () => () => {},
  },
}))
vi.mock('@/lib/deepgram-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deepgram-stream')>()
  class FakeDeepgram {
    readonly engine = 'deepgram' as const
    onAudioData?: unknown
    onTranscriptionStatus?: (s: string) => void
    getUsageAuthHeader?: unknown
    refreshApiKey?: unknown
    start = vi.fn(async () => { this.onTranscriptionStatus?.('connected') })
    stop = vi.fn()
    constructor(public onSegment: (s: TranscriptSegment) => void) {
      env.deepgram.push(this)
    }
    getLastAudioAt() { return 1 }
    hasReceivedAudio() { return true }
    sendMicAudio() {}
  }
  return { ...actual, DeepgramStreamingService: FakeDeepgram }
})
vi.mock('@/lib/voice-id-service', () => ({
  VoiceIdService: class {
    autoAcceptDelaySec = 10
    initialize = async () => {}
    loadEnrollments = async () => {}
    loadSelfProfile = async () => {}
    hasSelfProfile = () => false
    feedAudio = () => {}
    onFinalSegment = () => {}
    getAssignments = () => []
    stop = () => {}
  },
}))
vi.mock('@/lib/web-audio-capture', () => ({ WebAudioCapture: class {}, WebAudioCaptureError: class extends Error {} }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'jwt' } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'jwt' } } }),
    },
  }),
}))

import { useRecording } from '../use-recording'

const CAPTURE = 'cap-1'
const holder: { api: ReturnType<typeof useRecording> | null } = { api: null }
let liveOn = true
function Host() {
  const api = useRecording({ liveAgentEnabled: liveOn, captureId: CAPTURE })
  useEffect(() => { holder.api = api })
  return null
}

type LiveBody = {
  capture_id: string
  recent_chunks: string[]
  live_role?: string
  record_only?: boolean
  window_age_ms?: number
  window_queued_age_ms?: number
}
let turns: LiveBody[] = []
/** What /api/ai/live-agent answers; a held turn resolves when `release()` runs. */
let answer: () => Record<string, unknown> = () => ({ ok: true, pair_notes: false })
let hold: Promise<void> | null = null

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/api/deepgram-token') {
    return { ok: true, status: 200, json: async () => ({ token: 'dg' }), text: async () => '{}' }
  }
  if (url === '/api/ai/live-agent') {
    turns.push(JSON.parse(String(init?.body)) as LiveBody)
    if (hold) await hold
    const body = answer()
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
})

let root: Root
let container: HTMLDivElement

async function settle(times = 30) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve()
  })
}

async function start() {
  await act(async () => { await holder.api!.startRecording() })
  await settle()
}

let segSeq = 0
/** A final segment into the gate (below the size floor: it stays buffered). */
async function say(text: string) {
  await act(async () => {
    const segment: TranscriptSegment = {
      id: `seg-${++segSeq}`,
      text,
      speaker: 'local_1',
      stream: 'mic',
      isFinal: true,
      startTime: segSeq,
      endTime: segSeq + 1,
      words: [],
    }
    env.deepgram[0].onSegment(segment)
  })
}

async function request(captureId = CAPTURE) {
  await act(async () => { holder.api!.requestRecordTurn(captureId) })
  await settle()
}

/** Run one ordinary window: say something, then flush it through a request. */
async function firstWindow(text: string) {
  await say(text)
  await request()
}

beforeEach(async () => {
  env.deepgram.length = 0
  env.startRecording.mockReset().mockResolvedValue({ sessionId: 's1', systemAudioStatus: 'capturing' })
  env.stopRecording.mockReset().mockResolvedValue({ sessionId: 's1', micFile: null, systemFile: null, durationSeconds: 60 })
  turns = []
  answer = () => ({ ok: true, pair_notes: false })
  hold = null
  liveOn = true
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(h(Host)) })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('requestRecordTurn — idle', () => {
  it('before any window and with nothing buffered, runs nothing', async () => {
    await start()
    await request()
    expect(turns).toEqual([])
  })

  it('flushes buffered transcript now, under the size floor, as an ordinary window', async () => {
    await start()
    await say('Dana owns the budget')
    expect(turns).toEqual([])
    await request()
    expect(turns).toHaveLength(1)
    expect(turns[0].record_only).toBeUndefined()
    expect(turns[0].live_role).toBeUndefined()
    expect(turns[0].recent_chunks).toEqual(['[local_1]: Dana owns the budget'])
  })

  it('with nothing buffered after a window, runs one record_only turn over the windows already sent', async () => {
    await start()
    await firstWindow('We ship on Friday')
    turns = []
    await request()
    expect(turns).toEqual([
      expect.objectContaining({ capture_id: CAPTURE, record_only: true, recent_chunks: ['[local_1]: We ship on Friday'] }),
    ])
    expect(turns[0].live_role).toBeUndefined()
  })

  it('paired (the copilot is assist-only): the notes turn alone', async () => {
    answer = () => ({ ok: true, pair_notes: true })
    await start()
    await firstWindow('We ship on Friday')
    // The window that learned the pairing ran the copilot, then its notes turn.
    expect(turns.map((t) => t.live_role ?? 'copilot')).toEqual(['copilot', 'notes'])
    turns = []
    await request()
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ live_role: 'notes', record_only: true })
  })
})

describe('requestRecordTurn — a turn in flight', () => {
  it('coalesces every request into ONE record_only turn after the pass', async () => {
    await start()
    let release!: () => void
    hold = new Promise<void>((r) => { release = r })
    await firstWindow('We ship on Friday')
    expect(turns).toHaveLength(1)

    // Three directives land while that window's turn is running.
    await request()
    await request()
    await request()
    expect(turns).toHaveLength(1)

    hold = null
    await act(async () => { release() })
    await settle(60)
    expect(turns).toHaveLength(2)
    expect(turns[1]).toMatchObject({ record_only: true, recent_chunks: ['[local_1]: We ship on Friday'] })
  })
})

describe('requestRecordTurn — ignored', () => {
  it('for another capture: nothing flushed, nothing sent', async () => {
    await start()
    await firstWindow('We ship on Friday')
    turns = []
    await request('cap-other')
    expect(turns).toEqual([])
    // Buffered transcript is not flushed on another capture's behalf either.
    await say('Dana owns the budget')
    await request('cap-other')
    expect(turns).toEqual([])
  })

  it('with live mode switched off mid-meeting', async () => {
    await start()
    await firstWindow('We ship on Friday')
    turns = []
    liveOn = false
    await act(async () => { root.render(h(Host)) })
    await settle()
    await request()
    expect(turns).toEqual([])
  })


  it('after stop', async () => {
    await start()
    await firstWindow('We ship on Friday')
    await act(async () => { await holder.api!.stopRecording() })
    await settle()
    turns = []
    await request()
    expect(turns).toEqual([])
  })
})

describe('window_age_ms — how long ago the gate flushed the window a turn answers for', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a window turn carries its age (never an absolute timestamp); a record_only turn carries none', async () => {
    await start()
    await firstWindow('We ship on Friday')
    expect(turns[0].window_age_ms).toBeGreaterThanOrEqual(0)
    expect(turns[0].window_age_ms).toBeLessThan(1_000)
    expect(turns[0]).not.toHaveProperty('window_flushed_at')
    expect(turns[0]).not.toHaveProperty('window_queued_age_ms')
    turns = []
    await request()
    expect(turns[0].record_only).toBe(true)
    expect(turns[0]).not.toHaveProperty('window_age_ms')
  })

  it('a device clock far off still reports the true age (only ages leave the device)', async () => {
    await start()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-18T11:59:10Z')) // 50 s slow against a 12:00:00 server
    await firstWindow('We ship on Friday')
    expect(turns[0].window_age_ms).toBe(0)
  })

  it('windows queued behind a turn in flight coalesce into one turn: window_age_ms is the NEWEST, window_queued_age_ms the OLDEST', async () => {
    await start()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const T0 = Date.parse('2026-10-18T12:00:00Z')
    vi.setSystemTime(T0)
    const long = (word: string) => `${word} `.repeat(400).trim() // past the gate's size floor
    /** Speak a window, then let 3 s of silence flush it. */
    const windowAt = async (word: string) => {
      await say(long(word))
      await act(async () => { vi.advanceTimersByTime(3_100) })
      await settle()
    }

    let release!: () => void
    hold = new Promise<void>((r) => { release = r })
    // Flushed at T0 + 3.05 s (the silence check); the body is built once the
    // timer advance has reached T0 + 3.1 s, so it reports 50 ms. Held in flight.
    await windowAt('alpha')
    expect(turns).toHaveLength(1)
    expect(turns[0].window_age_ms).toBe(50)
    expect(turns[0]).not.toHaveProperty('window_queued_age_ms')

    await windowAt('bravo') // queued, flushed at T0 + 6.15 s
    await windowAt('charlie') // queued, flushed at T0 + 9.25 s; the clock now reads T0 + 9.3 s
    expect(turns).toHaveLength(1)

    hold = null
    await act(async () => { release() })
    await settle(60)
    expect(turns).toHaveLength(2)
    expect(turns[1].recent_chunks.join('\n')).toContain('bravo')
    expect(turns[1].recent_chunks.join('\n')).toContain('charlie')
    expect(turns[1].window_age_ms).toBe(50)
    expect(turns[1].window_queued_age_ms).toBe(3_150)
  })
})
