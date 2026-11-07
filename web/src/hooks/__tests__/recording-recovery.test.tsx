// @vitest-environment jsdom
/**
 * The recovery prompt's decline (dismissRecovery in recording-context.tsx).
 *
 * When the app comes back within ten minutes of a recorder that died, it
 * offers to resume the capture. Declining it used to PATCH ended_at and run
 * nothing, so the meeting was never extracted or triaged. Pinned: the decline
 * POSTs /captures/[id]/decline-recovery (the server closes the capture and runs
 * the end-of-meeting pass), never the bare ended_at PATCH, and the recovery
 * marker is gone so the prompt is not offered again.
 *
 * The launch-time check that decides whether to offer it at all is pinned too:
 * a marker up to ten minutes old is offered (a frozen app plus a slow relaunch
 * outlasted the old two minutes), a failed check is retried and never drops the
 * marker, and only "gone" (404) or "ended" does. Each outcome is reported.
 *
 * useRecording is mocked (the same controllable fake as recording-start.test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { createElement as h, act, useEffect } from 'react'

const finalCountListeners = new Set<() => void>()
const mockRecording = {
  isRecording: false,
  startRecording: vi.fn(async () => {}),
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

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CAPTURE_ID = 'cap-recover-1'
let fetchCalls: { url: string; method: string; body: unknown }[] = []
/** Answers for the launch check's GETs, in order; the last one repeats.
 *  'network' rejects like a dropped connection. */
let captureGets: (Partial<Response> | 'network')[] = []
const OPEN_CAPTURE: Partial<Response> = {
  ok: true,
  status: 200,
  json: async () => ({ capture: { id: CAPTURE_ID, title: 'Sprint review', ended_at: null } }),
}

function installFetch() {
  fetchCalls = []
  captureGets = [OPEN_CAPTURE]
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    fetchCalls.push({ url, method, body: init?.body ?? null })
    if (url === `/api/account/captures/${CAPTURE_ID}` && method === 'GET') {
      const answer = captureGets.length > 1 ? captureGets.shift()! : captureGets[0]
      return answer === 'network'
        ? Promise.reject(new TypeError('Load failed'))
        : Promise.resolve(answer as Response)
    }
    if (url === `/api/account/captures/${CAPTURE_ID}/decline-recovery` && method === 'POST') {
      return Promise.resolve({ ok: true, json: async () => ({ status: 'ended', processing: true }) } as Response)
    }
    return Promise.resolve({ ok: false, json: async () => ({}) } as Response)
  }))
}

const holder: {
  pending: { captureId: string; title: string } | null
  dismiss: (() => Promise<void>) | null
  confirm: (() => Promise<void>) | null
  startFor: ((id: string) => Promise<void>) | null
} = { pending: null, dismiss: null, confirm: null, startFor: null }
function Grabber() {
  const { pendingRecovery, dismissRecovery, confirmRecovery, startRecordingForCapture } = useRecordingStable()
  useEffect(() => {
    holder.pending = pendingRecovery
    holder.dismiss = dismissRecovery
    holder.confirm = confirmRecovery
    holder.startFor = startRecordingForCapture
  })
  return null
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  localStorage.clear()
  holder.pending = null
  holder.dismiss = null
  holder.confirm = null
  holder.startFor = null
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

/** Recording-telemetry events posted so far, with their properties. */
function telemetry() {
  return fetchCalls
    .filter((c) => c.url === '/api/analytics/recording-event')
    .map((c) => JSON.parse(c.body as string) as { event: string; properties: Record<string, unknown> })
}

function setMarker(ageMs: number) {
  localStorage.setItem('dial8-active-capture', JSON.stringify({ captureId: CAPTURE_ID, elapsed: 600, savedAt: Date.now() - ageMs }))
}

async function mount() {
  await act(async () => { root.render(h(RecordingProvider, null, h(Grabber))) })
}

const captureGetCount = () =>
  fetchCalls.filter((c) => c.url === `/api/account/captures/${CAPTURE_ID}` && c.method === 'GET').length

describe('the launch check for an interrupted capture', () => {
  it('offers a capture whose app took minutes to come back (marker under ten minutes old)', async () => {
    setMarker(6 * 60_000)
    await mount()
    await vi.waitFor(() => expect(holder.pending).toEqual({ captureId: CAPTURE_ID, title: 'Sprint review' }))
    expect(telemetry()).toContainEqual({ event: 'recovery_prompted', properties: { capture_id: CAPTURE_ID } })
  })

  it('drops a marker older than ten minutes without asking', async () => {
    setMarker(11 * 60_000)
    await mount()
    expect(holder.pending).toBeNull()
    expect(captureGetCount()).toBe(0)
    expect(localStorage.getItem('dial8-active-capture')).toBeNull()
    expect(telemetry()).toContainEqual({ event: 'recovery_skipped', properties: { capture_id: CAPTURE_ID, reason: 'stale' } })
  })

  it('retries a failed check and still offers the capture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      setMarker(30_000)
      captureGets = [{ ok: false, status: 502, json: async () => ({}) }, OPEN_CAPTURE]
      await mount()
      expect(holder.pending).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(holder.pending).toEqual({ captureId: CAPTURE_ID, title: 'Sprint review' })
      expect(captureGetCount()).toBe(2)
      expect(localStorage.getItem('dial8-active-capture')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the marker for the next launch when every check fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      setMarker(30_000)
      captureGets = ['network']
      await mount()
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(captureGetCount()).toBe(3)
      expect(holder.pending).toBeNull()
      expect(localStorage.getItem('dial8-active-capture')).not.toBeNull()
      expect(telemetry()).toContainEqual({ event: 'recovery_skipped', properties: { capture_id: CAPTURE_ID, reason: 'check_failed' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the marker when the capture is gone (404)', async () => {
    setMarker(30_000)
    captureGets = [{ ok: false, status: 404, json: async () => ({}) }]
    await mount()
    await vi.waitFor(() => expect(localStorage.getItem('dial8-active-capture')).toBeNull())
    expect(holder.pending).toBeNull()
    expect(captureGetCount()).toBe(1)
    expect(telemetry()).toContainEqual({ event: 'recovery_skipped', properties: { capture_id: CAPTURE_ID, reason: 'not_found' } })
  })

  it('drops the marker when the capture has already ended', async () => {
    setMarker(30_000)
    captureGets = [{
      ok: true,
      status: 200,
      json: async () => ({ capture: { id: CAPTURE_ID, title: 'Sprint review', ended_at: '2026-10-19T20:52:34.102581+00:00' } }),
    }]
    await mount()
    await vi.waitFor(() => expect(localStorage.getItem('dial8-active-capture')).toBeNull())
    expect(holder.pending).toBeNull()
    expect(telemetry()).toContainEqual({ event: 'recovery_skipped', properties: { capture_id: CAPTURE_ID, reason: 'ended' } })
  })
})

describe('a recording that starts meanwhile (the HUD or tray Start, in another window)', () => {
  it('is never met by a prompt: a check still retrying stands down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      setMarker(30_000)
      captureGets = [{ ok: false, status: 502, json: async () => ({}) }, OPEN_CAPTURE]
      await mount()
      // During the backoff the user starts the meeting from the HUD.
      await act(async () => { await holder.startFor!('cap-other') })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(holder.pending).toBeNull()
      expect(captureGetCount()).toBe(1)
      expect(telemetry()).toContainEqual({ event: 'recovery_skipped', properties: { capture_id: CAPTURE_ID, reason: 'recording' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a prompt already up: it goes, and End capture can no longer close anything', async () => {
    setMarker(30_000)
    await mount()
    await vi.waitFor(() => expect(holder.pending).not.toBeNull())
    const dismiss = holder.dismiss!
    await act(async () => { await holder.startFor!('cap-other') })
    expect(holder.pending).toBeNull()
    // A click that lands anyway (the stale handler) neither declines the old
    // capture nor drops the live session's marker.
    await act(async () => { await dismiss() })
    expect(fetchCalls.some((c) => c.url.endsWith('/decline-recovery'))).toBe(false)
    expect(JSON.parse(localStorage.getItem('dial8-active-capture')!).captureId).toBe('cap-other')
  })

  it('and Resume on it can no longer re-bind the live session', async () => {
    setMarker(30_000)
    await mount()
    await vi.waitFor(() => expect(holder.pending).not.toBeNull())
    const confirm = holder.confirm!
    await act(async () => { await holder.startFor!('cap-other') })
    await act(async () => { await confirm() })
    expect(fetchCalls.some((c) => c.url === `/api/account/captures/${CAPTURE_ID}/resume`)).toBe(false)
  })
})

describe('declining the recovery prompt', () => {
  it('asks the server to end the capture and write it up, never a bare ended_at PATCH', async () => {
    localStorage.setItem('dial8-active-capture', JSON.stringify({ captureId: CAPTURE_ID, elapsed: 600, savedAt: Date.now() - 30_000 }))
    await act(async () => { root.render(h(RecordingProvider, null, h(Grabber))) })
    // The on-mount recovery check found the interrupted capture and is asking.
    await vi.waitFor(() => expect(holder.pending).toEqual({ captureId: CAPTURE_ID, title: 'Sprint review' }))

    await act(async () => { await holder.dismiss!() })

    const declines = fetchCalls.filter((c) => c.url === `/api/account/captures/${CAPTURE_ID}/decline-recovery`)
    expect(declines).toEqual([{ url: `/api/account/captures/${CAPTURE_ID}/decline-recovery`, method: 'POST', body: null }])
    expect(fetchCalls.some((c) => c.method === 'PATCH' && c.url === `/api/account/captures/${CAPTURE_ID}`)).toBe(false)
    expect(localStorage.getItem('dial8-active-capture')).toBeNull()
    expect(holder.pending).toBeNull()
    expect(telemetry()).toContainEqual({ event: 'recovery_declined', properties: { capture_id: CAPTURE_ID } })
  })
})
