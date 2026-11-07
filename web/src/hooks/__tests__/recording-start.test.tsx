// @vitest-environment jsdom
/**
 * Tests for startRecordingWithCapture's concurrency guarantees (the
 * "open a new capture instantly" change).
 *
 * The start is OPTIMISTIC: the capture id is CLIENT-minted, so the panel
 * navigation happens synchronously at click time while the create POST and mic
 * startup race in the background. These tests lock in the invariants that make
 * that safe:
 *   1. The create POST fires in parallel with mic startup (not after it).
 *   2. Navigation happens IMMEDIATELY — before either leg resolves — with the
 *      same client-minted id the POST body carries; the undo callback reverts
 *      it on mic failure.
 *   3. On mic failure, the capture the POST created is deleted (no orphan).
 *   4. A double-click fires exactly one create POST (re-entry guard).
 *
 * useRecording is mocked so we exercise ONLY the provider's wrapper logic with a
 * controllable fake mic + fetch — not the real Tauri/Deepgram/Supabase stack.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { createElement as h, act, useEffect } from 'react'

// ── Controllable mock of useRecording ───────────────────────────
// startRecording resolves/rejects on command so we can interleave it with the
// POST and assert ordering.
let micDeferred: { resolve: () => void; reject: (e: unknown) => void; promise: Promise<void> }
let startRecordingCalls = 0
function freshMicDeferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { resolve, reject, promise }
}

const finalCountListeners = new Set<() => void>()
const mockRecording = {
  isRecording: false,
  startRecording: vi.fn(async () => { startRecordingCalls++; return micDeferred.promise }),
  stopRecording: vi.fn(async () => {}),
  // Called by stopRecordingWithCapture's tail (incident hotfix H3) after the
  // final save — must exist on the mock or the stop tests throw.
  clearSessionAccumulators: vi.fn(),
  // Read by the stop path (final save + speaker snapshot). Reassigned by the
  // transcript-save tests to return final segments; reset in beforeEach.
  getTranscriptSegmentsSnapshot: (() => []) as () => { speaker: string; text: string; isFinal: boolean }[],
  subscribeTranscriptSegments: () => () => {},
  // Drives the provider's post-segment debounced save effect. Reassigned by
  // the transcript-save tests; reset in beforeEach. The provider reads it
  // through the STORE accessors now (it no longer re-renders per utterance),
  // so both are backed by this same field; notifyFinalSegmentCount wakes the
  // subscription for tests that bump the count mid-recording.
  finalSegmentCount: 0,
  getFinalSegmentCount: () => mockRecording.finalSegmentCount,
  subscribeFinalSegmentCount: (cb: () => void) => {
    finalCountListeners.add(cb)
    return () => { finalCountListeners.delete(cb) }
  },
  notifyFinalSegmentCount: () => { finalCountListeners.forEach((cb) => cb()) },
  // Minimal surface the provider spreads/reads; only what's touched on the start path.
  // levels/elapsed are external stores now — the provider reads elapsed via
  // getElapsed() (e.g. recovery marker / stop), so expose the accessors instead
  // of raw fields.
  getLevels: () => ({ micLevel: 0, systemLevel: 0, timestamp: 0 }),
  subscribeLevels: () => () => {},
  getElapsed: () => 0,
  subscribeElapsed: () => () => {},
  transcriptSegments: [],
  recordingError: null,
  transcriptionStatus: 'connected',
  speakerContacts: {},
  isAgentFinalizing: false,
}

vi.mock('../use-recording', () => ({
  useRecording: () => mockRecording,
}))
vi.mock('@/lib/capture-cache', () => ({
  seedCaptureCache: vi.fn(),
  captureDetailCache: new Map(),
  CAPTURE_CACHE_MAX: 20,
  writeCaptureCache: vi.fn(),
  registerPendingCaptureCreate: vi.fn(),
  captureRowReady: vi.fn(async () => true),
}))
// The stop path's headless batch fallback imports the supabase client for an
// auth token — stub it so exercising stop in jsdom can't touch real env/auth.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}))

import { RecordingProvider, useRecordingStable } from '../recording-context'
import { seedCaptureCache } from '@/lib/capture-cache'
import { wasRecentlyMutatedLocally } from '@/lib/entity-events'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── fetch mock: records calls (+ parsed JSON body), defers the POST ──
// `guardArmedAtRequest` snapshots wasRecentlyMutatedLocally('capture', id) AT
// REQUEST TIME for capture-row writes (null for URLs without a capture id).
// The load-bearing invariant is arm-BEFORE-write — the realtime fan-out of the
// committed UPDATE can reach the tab before the HTTP response resolves — so
// asserting guard state only after the awaited save resolves would still pass
// under a broken arm-after-write refactor.
let fetchCalls: {
  url: string
  method: string
  body: Record<string, unknown> | null
  guardArmedAtRequest: boolean | null
}[] = []
let postResolve: ((body: unknown) => void) | null = null
// When true, PATCH /api/account/captures/{id} (stop's ended_at write) is held
// open until patchResolve() — lets a test suspend the stop tail deterministically.
let deferPatch = false
let patchResolve: (() => void) | null = null
function installFetch() {
  fetchCalls = []
  postResolve = null
  deferPatch = false
  patchResolve = null
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    let body: Record<string, unknown> | null = null
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    } catch { /* non-JSON body — irrelevant here */ }
    const capId = /^\/api\/account\/captures\/([^/?]+)/.exec(url)?.[1] ?? null
    fetchCalls.push({
      url,
      method,
      body,
      guardArmedAtRequest: capId ? wasRecentlyMutatedLocally('capture', capId) : null,
    })
    if (url === '/api/account/captures' && method === 'POST') {
      // Resolve on command so we can assert it fired before the mic resolved.
      return new Promise((res) => {
        postResolve = (body: unknown) =>
          res({ ok: true, json: async () => body } as Response)
      })
    }
    if (deferPatch && url.startsWith('/api/account/captures/') && method === 'PATCH') {
      return new Promise((res) => {
        patchResolve = () => res({ ok: true, json: async () => ({}) } as Response)
      })
    }
    if (url.startsWith('/api/account/captures/') && method === 'PATCH') {
      // Capture-row PATCHes succeed — the stop path's local entity-updated
      // fan-out (and any res.ok-gated continuation) requires a 2xx.
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
    }
    if (url.startsWith('/api/account/captures/') && method === 'DELETE') {
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
    }
    if (url.endsWith('/transcript-append') && method === 'POST') {
      // Delta-append: echo the exact expected length back so the provider's
      // acked bookkeeping advances (a mismatch would take the full-PATCH
      // fallback and muddy the assertions).
      const newLength =
        ((body?.base_length as number) ?? 0) + String(body?.append_text ?? '').length
      return Promise.resolve({ ok: true, json: async () => ({ new_length: newLength }) } as Response)
    }
    // workspace default fetch on mount, etc.
    return Promise.resolve({ ok: false, json: async () => ({}) } as Response)
  }))
}

// Harness that grabs the stable context's startRecording and exposes it via a
// holder object (mutating a field, not reassigning a module binding, keeps the
// lint rule against outer-variable reassignment happy). Assigned in an effect so
// it's a commit-time side effect, not a render-time one.
const holder: {
  startFn: (() => Promise<void>) | null
  startForCaptureFn: ((id: string, opts?: { title?: string }) => Promise<void>) | null
  stopFn: (() => Promise<void>) | null
  navCalls: unknown[]
  navOptions: unknown[]
  backCalls: string[]
  captureId: string | null
  isStarting: boolean
} = { startFn: null, startForCaptureFn: null, stopFn: null, navCalls: [], navOptions: [], backCalls: [], captureId: null, isStarting: false }
function Grabber() {
  const { startRecording, startRecordingForCapture, stopRecording, registerNavigate, unregisterNavigate, captureId, isStarting } =
    useRecordingStable()
  useEffect(() => {
    holder.startFn = startRecording
    holder.startForCaptureFn = startRecordingForCapture
    holder.stopFn = stopRecording
  }, [startRecording, startRecordingForCapture, stopRecording])
  // Register a spy navigate + undo pair, mirroring the DashboardShell bridge.
  useEffect(() => {
    registerNavigate(
      (entry, options) => { holder.navCalls.push(entry); holder.navOptions.push(options) },
      (captureId) => { holder.backCalls.push(captureId) },
    )
    return () => unregisterNavigate()
  }, [registerNavigate, unregisterNavigate])
  // Commit-time mirrors (same rationale as startFn: no render-time mutation).
  useEffect(() => {
    holder.captureId = captureId
    holder.isStarting = isStarting
  })
  return null
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  startRecordingCalls = 0
  micDeferred = freshMicDeferred()
  mockRecording.isRecording = false
  mockRecording.getTranscriptSegmentsSnapshot = () => []
  mockRecording.finalSegmentCount = 0
  finalCountListeners.clear()
  mockRecording.startRecording.mockClear()
  mockRecording.clearSessionAccumulators.mockClear()
  vi.mocked(seedCaptureCache).mockClear()
  holder.navCalls = []
  holder.navOptions = []
  holder.backCalls = []
  localStorage.clear()
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
  holder.startFn = null
})

async function mount() {
  await act(async () => {
    root.render(h(RecordingProvider, null, h(Grabber)))
  })
}

describe('startRecordingWithCapture concurrency', () => {
  it('fires the create POST in parallel with mic startup (before the mic resolves)', async () => {
    await mount()
    expect(holder.startFn).toBeTruthy()

    // Kick off start but DON'T resolve the mic yet.
    let startDone: Promise<void>
    await act(async () => { startDone = holder.startFn!() })

    // The POST should already be in flight even though the mic hasn't resolved.
    const postCalls = fetchCalls.filter((c) => c.url === '/api/account/captures' && c.method === 'POST')
    expect(postCalls.length).toBe(1)
    expect(startRecordingCalls).toBe(1)
    expect(postResolve).toBeTruthy()

    // Now let both finish.
    await act(async () => {
      postResolve!({ capture: { id: 'cap-1', title: 'T' } })
      micDeferred.resolve()
      await startDone
    })
  })

  it('keeps the created capture (no DELETE) when both POST and mic succeed', async () => {
    await mount()

    let startDone: Promise<void>
    await act(async () => { startDone = holder.startFn!() })

    // POST resolves first, mic still pending — must NOT delete (it's not an orphan).
    await act(async () => { postResolve!({ capture: { id: 'cap-2', title: 'T' } }) })
    expect(fetchCalls.some((c) => c.method === 'DELETE')).toBe(false)

    // Mic confirms — success path completes with the capture kept (still no DELETE).
    await act(async () => { micDeferred.resolve(); await startDone })
    expect(fetchCalls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(fetchCalls.filter((c) => c.url === '/api/account/captures' && c.method === 'POST').length).toBe(1)
  })

  it('navigates optimistically at click time — before the mic or POST resolves', async () => {
    await mount()

    let startDone: Promise<void>
    await act(async () => { startDone = holder.startFn!() })

    // Neither leg has resolved, yet the panel navigation already happened, the
    // capture id is bound, and it's the SAME client-minted id the POST carries.
    const post = fetchCalls.find((c) => c.url === '/api/account/captures' && c.method === 'POST')!
    const mintedId = post.body?.id as string
    expect(mintedId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(holder.navCalls.length).toBe(1)
    expect(holder.navCalls[0]).toMatchObject({ captureId: mintedId })
    expect(holder.captureId).toBe(mintedId)
    expect(holder.isStarting).toBe(true)

    // Settle both legs; the starting window closes and nothing was undone.
    await act(async () => {
      postResolve!({ capture: { id: mintedId, title: 'T' } })
      micDeferred.resolve()
      await startDone
    })
    expect(holder.isStarting).toBe(false)
    expect(holder.backCalls.length).toBe(0)
  })

  it('deletes the created capture and undoes the navigation when the mic fails (no orphan)', async () => {
    await mount()

    let startDone: Promise<void>
    await act(async () => { startDone = holder.startFn!() })
    const post = fetchCalls.find((c) => c.url === '/api/account/captures' && c.method === 'POST')!
    const mintedId = post.body?.id as string

    // POST succeeds (capture row created), then the mic REJECTS.
    await act(async () => {
      postResolve!({ capture: { id: mintedId, title: 'T' } })
      micDeferred.reject(new Error('already active'))
      await startDone
    })

    // The orphan capture must be deleted, the binding cleared, and the
    // optimistic navigation reverted (shell-guarded goBack invoked).
    const deletes = fetchCalls.filter((c) => c.method === 'DELETE')
    expect(deletes.length).toBe(1)
    expect(deletes[0].url).toBe(`/api/account/captures/${mintedId}`)
    expect(holder.captureId).toBe(null)
    expect(holder.backCalls).toEqual([mintedId])
  })

  it('fires only ONE create POST on a double-click (re-entry guard)', async () => {
    await mount()

    let first: Promise<void>
    await act(async () => {
      first = holder.startFn!()
      // Second click before the first sequence finishes.
      holder.startFn!()
    })

    const postCalls = fetchCalls.filter((c) => c.url === '/api/account/captures' && c.method === 'POST')
    expect(postCalls.length).toBe(1)
    expect(startRecordingCalls).toBe(1)

    await act(async () => {
      postResolve!({ capture: { id: 'cap-3', title: 'T' } })
      micDeferred.resolve()
      await first
    })
  })

  it('a calendar / resume start double-fired during mic spin-up starts the mic once and keeps its binding', async () => {
    await mount()

    let first: Promise<void>
    let second: Promise<void>
    await act(async () => {
      first = holder.startForCaptureFn!('cap-ev')
      second = holder.startForCaptureFn!('cap-other')
    })
    expect(startRecordingCalls).toBe(1)
    expect(holder.captureId).toBe('cap-ev')

    await act(async () => {
      micDeferred.resolve()
      await first
      await second
    })
    expect(holder.captureId).toBe('cap-ev')
  })

  it('a start-for-capture while recording is refused without unbinding the live capture', async () => {
    await mount()
    let first: Promise<void>
    await act(async () => { first = holder.startForCaptureFn!('cap-live') })
    await act(async () => { micDeferred.resolve(); await first })
    mockRecording.isRecording = true

    await act(async () => {
      await expect(holder.startForCaptureFn!('cap-other')).rejects.toThrow('already active')
    })
    expect(startRecordingCalls).toBe(1)
    expect(holder.captureId).toBe('cap-live')
    expect(JSON.parse(localStorage.getItem('dial8-active-capture')!).captureId).toBe('cap-live')
  })

  it('serializes a new start behind an in-flight stop (no ref clobbering mid-stop)', async () => {
    await mount()

    // Run start A to completion.
    let startA: Promise<void>
    await act(async () => { startA = holder.startFn!() })
    const idA = fetchCalls.find((c) => c.url === '/api/account/captures' && c.method === 'POST')!
      .body?.id as string
    await act(async () => {
      postResolve!({ capture: { id: idA, title: 'T' } })
      micDeferred.resolve()
      await startA
    })
    mockRecording.isRecording = true

    // Stop A, suspended on the deferred ended_at PATCH (a real stop-tail window).
    deferPatch = true
    mockRecording.isRecording = false
    micDeferred = freshMicDeferred() // armed for start B
    let stopA: Promise<void>
    await act(async () => { stopA = holder.stopFn!() })

    // Click Capture while the stop tail is still in flight: the optimistic
    // section must NOT run yet — no second POST, no navigation, refs untouched.
    const navsBefore = holder.navCalls.length
    let startB: Promise<void>
    await act(async () => { startB = holder.startFn!() })
    expect(
      fetchCalls.filter((c) => c.url === '/api/account/captures' && c.method === 'POST').length,
    ).toBe(1)
    expect(holder.navCalls.length).toBe(navsBefore)

    // Release the stop; the queued start proceeds within a poll tick.
    deferPatch = false
    await act(async () => { patchResolve!(); await stopA })
    await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
    expect(
      fetchCalls.filter((c) => c.url === '/api/account/captures' && c.method === 'POST').length,
    ).toBe(2)
    expect(holder.navCalls.length).toBe(navsBefore + 1)

    // Settle start B cleanly.
    const idB = fetchCalls.filter((c) => c.url === '/api/account/captures' && c.method === 'POST')[1]
      .body?.id as string
    await act(async () => {
      postResolve!({ capture: { id: idB, title: 'T' } })
      micDeferred.resolve()
      await startB
    })
  })

  it('skips the post-create continuation (no re-seed) when a stop raced the create', async () => {
    await mount()

    let startDone: Promise<void>
    await act(async () => { startDone = holder.startFn!() })
    const mintedId = fetchCalls.find((c) => c.url === '/api/account/captures' && c.method === 'POST')!
      .body?.id as string
    expect(vi.mocked(seedCaptureCache).mock.calls.length).toBe(1) // optimistic seed

    // Mic confirms while the create POST is still in flight.
    await act(async () => { micDeferred.resolve() })
    mockRecording.isRecording = true

    // User stops in that window (stop nulls captureIdRef synchronously, then
    // parks its final save on the createSettled gate).
    mockRecording.isRecording = false
    let stopDone: Promise<void>
    await act(async () => { stopDone = holder.stopFn!() })

    // Create lands AFTER the stop: the continuation must bail — no stale
    // re-seed of an 'active' cache row for the dead capture.
    await act(async () => {
      postResolve!({ capture: { id: mintedId, title: 'T' } })
      await startDone
      await stopDone
    })
    expect(vi.mocked(seedCaptureCache).mock.calls.length).toBe(1)
  })

  it('preserves a foreign recovery marker on mic failure (undo clears only its own)', async () => {
    await mount()
    // Another window's live recording owns the shared marker. Written AFTER
    // mount — the on-mount recovery effect legitimately consumes markers it
    // can't validate; the two-window scenario has the other window writing
    // its marker while this one is already open.
    localStorage.setItem(
      'dial8-active-capture',
      JSON.stringify({ captureId: 'other-window-cap', elapsed: 5, savedAt: Date.now() }),
    )

    let startDone: Promise<void>
    await act(async () => { startDone = holder.startFn!() })
    const mintedId = fetchCalls.find((c) => c.url === '/api/account/captures' && c.method === 'POST')!
      .body?.id as string

    await act(async () => {
      postResolve!({ capture: { id: mintedId, title: 'T' } })
      micDeferred.reject(new Error('already active'))
      await startDone
    })

    // Undo ran (row deleted) but the other window's marker survived.
    expect(fetchCalls.some((c) => c.method === 'DELETE')).toBe(true)
    const marker = JSON.parse(localStorage.getItem('dial8-active-capture') ?? 'null')
    expect(marker?.captureId).toBe('other-window-cap')
  })
})

// Live is the only capture mode: no toggle, every start runs the live agent and
// opens in a tab of its own (the shell brings that tab to the front).
describe('every capture starts live, in a tab of its own', () => {
  const liveOpens = () =>
    fetchCalls.filter((c) => c.url === '/api/account/chat-history/live' && c.method === 'POST')

  it('the Capture button: a live row, its own tab, and the meeting chat — with no toggle touched', async () => {
    await mount()

    let startDone: Promise<void>
    await act(async () => { startDone = holder.startFn!() })
    const post = fetchCalls.find((c) => c.url === '/api/account/captures' && c.method === 'POST')!
    const mintedId = post.body?.id as string
    expect(post.body?.live_mode).toBe(true)
    expect(holder.navOptions).toEqual([undefined])

    await act(async () => {
      postResolve!({ capture: { id: mintedId, title: 'T' } })
      micDeferred.resolve()
      await startDone
    })
    expect(liveOpens().map((c) => c.body?.capture_id)).toEqual([mintedId])
  })

  it('a calendar / tray start opens its own tab before the mic, then marks the row live and opens the meeting chat', async () => {
    await mount()

    let startDone: Promise<void>
    await act(async () => { startDone = holder.startForCaptureFn!('cap-ev', { title: 'Weekly sync' }) })
    // Navigated at click time, like the Capture button — the mic hasn't confirmed.
    expect(holder.navCalls).toEqual([{ captureId: 'cap-ev', title: 'Weekly sync' }])
    expect(holder.navOptions).toEqual([undefined])
    expect(liveOpens()).toHaveLength(0)

    await act(async () => { micDeferred.resolve(); await startDone })
    // A from-event / calendar-sync row can say live_mode false: it is marked live.
    const mark = fetchCalls.find(
      (c) => c.url === '/api/account/captures/cap-ev' && c.method === 'PATCH' && c.body?.live_mode !== undefined,
    )
    expect(mark?.body).toEqual({ live_mode: true })
    expect(liveOpens().map((c) => c.body?.capture_id)).toEqual(['cap-ev'])
    expect(holder.backCalls).toEqual([])
  })

  it('a calendar / tray start whose mic fails closes the tab it opened, and opens no meeting chat', async () => {
    await mount()

    let startDone: Promise<void>
    await act(async () => { startDone = holder.startForCaptureFn!('cap-ev', { title: 'Weekly sync' }) })
    await act(async () => {
      micDeferred.reject(new Error('already active'))
      await startDone!.catch(() => {})
    })
    expect(holder.backCalls).toEqual(['cap-ev'])
    expect(holder.captureId).toBe(null)
    expect(liveOpens()).toHaveLength(0)
  })

  it('a start with no title (resume) navigates nowhere but still runs live', async () => {
    await mount()

    let startDone: Promise<void>
    await act(async () => { startDone = holder.startForCaptureFn!('cap-old') })
    await act(async () => { micDeferred.resolve(); await startDone })
    expect(holder.navCalls).toEqual([])
    expect(liveOpens().map((c) => c.body?.capture_id)).toEqual(['cap-old'])
  })
})

describe('transcript-save self-echo guard', () => {
  // Every transcript persistence path must arm wasRecentlyMutatedLocally for
  // ('capture', id) BEFORE its write — otherwise the recorder refetches its own
  // realtime echo (a full-transcript GET per append; perf finding 4a).

  /** Run a start to completion and return the minted capture id. */
  async function startAndSettle(): Promise<string> {
    let startDone: Promise<void>
    await act(async () => { startDone = holder.startFn!() })
    const mintedId = fetchCalls.find((c) => c.url === '/api/account/captures' && c.method === 'POST')!
      .body?.id as string
    await act(async () => {
      postResolve!({ capture: { id: mintedId, title: 'T' } })
      micDeferred.resolve()
      // Segments landed during the session: the stop-path force save and the
      // post-segment debounce both read these off the (re-)rendered mock.
      mockRecording.getTranscriptSegmentsSnapshot = () =>
        [{ speaker: 'S1', text: 'hello world', isFinal: true }]
      mockRecording.finalSegmentCount = 1
      mockRecording.isRecording = true
      await startDone
    })
    return mintedId
  }

  it('arms the guard on the stop path (authoritative force PATCH)', async () => {
    await mount()
    const mintedId = await startAndSettle()

    mockRecording.isRecording = false
    await act(async () => { await holder.stopFn!() })

    // The final save PATCHed the full transcript with force_transcript…
    const forcePatch = fetchCalls.find(
      (c) => c.url === `/api/account/captures/${mintedId}` && c.method === 'PATCH'
        && c.body?.force_transcript === true,
    )
    expect(forcePatch).toBeTruthy()
    expect(forcePatch!.body?.transcript).toBe('[S1] hello world')
    // …the guard was armed BEFORE the write left the tab (request-time
    // snapshot — the echo can beat the HTTP response, so arm-after-await
    // would reintroduce the race)…
    expect(forcePatch!.guardArmedAtRequest).toBe(true)
    // …and the self-echo window is still armed afterwards.
    expect(wasRecentlyMutatedLocally('capture', mintedId)).toBe(true)
  })

  it('arms the guard on the delta-append path (post-segment debounced save)', async () => {
    // Fake timers from the start so the 2s post-segment debounce is
    // controllable (the start path itself awaits no timers on success).
    vi.useFakeTimers()
    try {
      await mount()
      const mintedId = await startAndSettle()

      // Fire the 2s debounce → saveTranscript (force=false) → delta POST.
      await act(async () => { vi.advanceTimersByTime(2_100) })

      const append = fetchCalls.find(
        (c) => c.url === `/api/account/captures/${mintedId}/transcript-append` && c.method === 'POST',
      )
      expect(append).toBeTruthy()
      expect(append!.body?.append_text).toBe('[S1] hello world')
      // Armed BEFORE the write left the tab (request-time snapshot), not just
      // eventually — see the fetch-mock note on arm-after-write refactors.
      expect(append!.guardArmedAtRequest).toBe(true)
      expect(wasRecentlyMutatedLocally('capture', mintedId)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('arms the guard on the pagehide beacon path — BEFORE sendBeacon fires', async () => {
    await mount()
    const mintedId = await startAndSettle()

    // Snapshot the guard INSIDE the sendBeacon mock (call time), mirroring the
    // request-time discipline of the fetch-based sites.
    const beaconCalls: { url: string; guardArmedAtCall: boolean }[] = []
    const sendBeacon = vi.fn((url: string) => {
      beaconCalls.push({ url, guardArmedAtCall: wasRecentlyMutatedLocally('capture', mintedId) })
      return true
    })
    Object.defineProperty(navigator, 'sendBeacon', {
      value: sendBeacon,
      configurable: true,
      writable: true,
    })
    try {
      // Nothing else has armed the guard this session — the assertion below
      // must prove the beacon path itself arms it.
      expect(wasRecentlyMutatedLocally('capture', mintedId)).toBe(false)

      await act(async () => { window.dispatchEvent(new Event('pagehide')) })

      expect(beaconCalls.length).toBe(1)
      expect(beaconCalls[0].url).toBe('/api/account/captures/transcript-beacon')
      // The beacon's capture-row UPDATE echoes back over realtime if the tab
      // survives (canceled unload / bfcache restore) — the guard must already
      // be armed when the write leaves.
      expect(beaconCalls[0].guardArmedAtCall).toBe(true)
    } finally {
      delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon
    }
  })
})

describe('stop-path local fan-out', () => {
  /** Same start helper as the echo-guard suite (module scope keeps them
   *  separate describes; duplicating the 8-liner beats coupling them). */
  async function startAndSettle(): Promise<string> {
    let startDone: Promise<void>
    await act(async () => { startDone = holder.startFn!() })
    const mintedId = fetchCalls.find((c) => c.url === '/api/account/captures' && c.method === 'POST')!
      .body?.id as string
    await act(async () => {
      postResolve!({ capture: { id: mintedId, title: 'T' } })
      micDeferred.resolve()
      mockRecording.getTranscriptSegmentsSnapshot = () =>
        [{ speaker: 'S1', text: 'hello world', isFinal: true }]
      mockRecording.finalSegmentCount = 1
      mockRecording.isRecording = true
      await startDone
    })
    return mintedId
  }

  it('emits entity-updated with the ended_at/duration/ai_processed values the PATCH sent', async () => {
    await mount()
    const mintedId = await startAndSettle()

    // The stop PATCH's realtime echo is dropped client-wide (the final save
    // arms the self-echo guard), and later diffed realtime events never
    // re-carry these columns — so the stop path must fan the mutation out
    // locally or open lists show the capture as still-recording indefinitely.
    const emitted: { entityType: string; id: string; fields: Record<string, unknown> }[] = []
    const onUpdated = (e: Event) =>
      emitted.push((e as CustomEvent).detail as (typeof emitted)[number])
    window.addEventListener('dial8:entity-updated', onUpdated)
    try {
      mockRecording.isRecording = false
      await act(async () => { await holder.stopFn!() })

      const endPatch = fetchCalls.find(
        (c) => c.url === `/api/account/captures/${mintedId}` && c.method === 'PATCH'
          && c.body?.ai_processed === true,
      )
      expect(endPatch).toBeTruthy()
      const stopEmit = emitted.find(
        (d) => d.entityType === 'capture' && d.id === mintedId && d.fields.ai_processed === true,
      )
      expect(stopEmit).toBeTruthy()
      // The emit carries EXACTLY the values the PATCH sent — listeners patch
      // rows in place from these fields, so a drifted copy would render wrong.
      expect(stopEmit!.fields).toEqual({
        ended_at: endPatch!.body?.ended_at,
        duration_seconds: endPatch!.body?.duration_seconds,
        ai_processed: true,
      })
      expect(typeof stopEmit!.fields.ended_at).toBe('string')
      expect(typeof stopEmit!.fields.duration_seconds).toBe('number')
    } finally {
      window.removeEventListener('dial8:entity-updated', onUpdated)
    }
  })
})
