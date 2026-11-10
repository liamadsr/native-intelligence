// @vitest-environment jsdom
/**
 * Tests for the delta-append transcript auto-save in RecordingProvider.
 *
 * The periodic + post-segment auto-save no longer re-PATCHes the whole
 * transcript; it POSTs only the NEW tail to /transcript-append with a
 * base_length optimistic-concurrency token, and advances its acked counters
 * ONLY on a confirmed 2xx. This is the product's most data-loss-sensitive path,
 * so these tests lock in:
 *   1. Normal incremental appends advance the acked refs only on success — a
 *      second batch of finals sends base_length = the first append's new_length.
 *   2. A failed append (fetch rejects) does NOT advance — the next tick re-sends
 *      the SAME delta (same base_length).
 *   3. A 409 base-length mismatch triggers a full-text PATCH fallback, then
 *      deltas resume from the server's true length.
 *   4. Resume-after-restart seeds base_length from the restored server text — the
 *      first append uses that length and a '\n'-prefixed chunk.
 *   5. Stop still sends the authoritative full-text PATCH with force_transcript.
 *
 * useRecording is mocked so we exercise ONLY the provider's save logic with a
 * controllable fake mic + fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { createElement as h, act, useEffect } from 'react'

// ── Controllable mock of useRecording ───────────────────────────
interface Seg { id: string; speaker: string; text: string; isFinal: boolean }

const finalCountListeners = new Set<() => void>()
const mockRecording: {
  isRecording: boolean
  startRecording: ReturnType<typeof vi.fn>
  stopRecording: ReturnType<typeof vi.fn>
  clearSessionAccumulators: ReturnType<typeof vi.fn>
  getLevels: () => { micLevel: number; systemLevel: number; timestamp: number }
  subscribeLevels: () => () => void
  getElapsed: () => number
  subscribeElapsed: () => () => void
  transcriptSegments: Seg[]
  getTranscriptSegmentsSnapshot: () => Seg[]
  subscribeTranscriptSegments: () => () => void
  finalSegmentCount: number
  // The provider's post-segment debounce subscribes to the final-count STORE
  // now (it no longer re-renders per utterance), so the mock must expose the
  // same accessor pair. Both are backed by `finalSegmentCount` above so the
  // existing `setFinals` driver keeps working; it calls notifyFinalSegmentCount
  // to wake the subscription.
  getFinalSegmentCount: () => number
  subscribeFinalSegmentCount: (cb: () => void) => () => void
  notifyFinalSegmentCount: () => void
  recordingError: null
  transcriptionStatus: string
  speakerContacts: Record<string, unknown>
  isAgentFinalizing: boolean
} = {
  isRecording: false,
  startRecording: vi.fn(async () => {}),
  stopRecording: vi.fn(async () => {}),
  // Called by stopRecordingWithCapture's tail (incident hotfix H3), strictly
  // AFTER the final force save — asserted in the stop test below.
  clearSessionAccumulators: vi.fn(),
  getLevels: () => ({ micLevel: 0, systemLevel: 0, timestamp: 0 }),
  subscribeLevels: () => () => {},
  getElapsed: () => 0,
  subscribeElapsed: () => () => {},
  transcriptSegments: [],
  // Transcript segments are now a ref-store on useRecording — the save logic
  // reads via the snapshot accessor. Back it by the same array `setFinals`
  // mutates so the existing test driver keeps working unchanged.
  getTranscriptSegmentsSnapshot: () => mockRecording.transcriptSegments,
  subscribeTranscriptSegments: () => () => {},
  finalSegmentCount: 0,
  getFinalSegmentCount: () => mockRecording.finalSegmentCount,
  subscribeFinalSegmentCount: (cb: () => void) => {
    finalCountListeners.add(cb)
    return () => { finalCountListeners.delete(cb) }
  },
  notifyFinalSegmentCount: () => { finalCountListeners.forEach((cb) => cb()) },
  recordingError: null,
  transcriptionStatus: 'connected',
  speakerContacts: {},
  isAgentFinalizing: false,
}

vi.mock('../use-recording', () => ({ useRecording: () => mockRecording }))
vi.mock('@/lib/capture-cache', () => ({
  seedCaptureCache: vi.fn(),
  captureDetailCache: new Map(),
  CAPTURE_CACHE_MAX: 20,
  writeCaptureCache: vi.fn(),
  registerPendingCaptureCreate: vi.fn(),
  captureRowReady: vi.fn(async () => true),
}))

// The stop path branches on whether a capture detail panel is mounted for this
// capture. That branch decides WHO owns the batch extraction — and, before the
// transcript-durability fix, whether `ni:capture-ended` was ever dispatched
// at all. Both legs are exercised below, so the registry is controllable here
// rather than reaching into module state.
const streamingPanels = new Set<string>()
const requestStreamingExtractionSpy = vi.fn()
vi.mock('@/lib/live-agent/streaming-extraction-bus', () => ({
  hasStreamingPanel: (id: string) => streamingPanels.has(id),
  requestStreamingExtraction: (detail: unknown) => requestStreamingExtractionSpy(detail),
  registerStreamingPanel: (id: string) => { streamingPanels.add(id) },
  unregisterStreamingPanel: (id: string) => { streamingPanels.delete(id) },
  STREAM_EXTRACTION_EVENT: 'ni:stream-extraction',
}))

import { RecordingProvider, useRecordingStable, useRecordingContext } from '../recording-context'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── fetch mock ──
interface Call { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[] = []
// Programmable per-URL responder. Returns a Response-like or throws.
let appendResponder: (call: Call) => Promise<Response> | Response
let patchResponder: (call: Call) => Promise<Response> | Response
let getCaptureResponder: (call: Call) => Promise<Response> | Response

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function installFetch() {
  calls = []
  appendResponder = () => jsonResponse(200, { new_length: 0 })
  patchResponder = () => jsonResponse(200, { capture: {} })
  getCaptureResponder = () => jsonResponse(200, { capture: {} })
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method || 'GET'
      let body: Record<string, unknown> | null = null
      if (typeof init?.body === 'string') {
        try { body = JSON.parse(init.body) } catch { body = null }
      }
      const call: Call = { url, method, body }
      calls.push(call)
      if (url.endsWith('/transcript-append') && method === 'POST') {
        return Promise.resolve(appendResponder(call))
      }
      if (/\/api\/account\/captures\/[^/]+$/.test(url) && method === 'PATCH') {
        return Promise.resolve(patchResponder(call))
      }
      if (/\/api\/account\/captures\/[^/]+$/.test(url) && method === 'GET') {
        return Promise.resolve(getCaptureResponder(call))
      }
      return Promise.resolve(jsonResponse(200, {}))
    }),
  )
}

// ── Harness: grabs the actions we drive the save with ──
const holder: {
  startForCapture: ((id: string) => Promise<void>) | null
  resume: ((id: string) => Promise<void>) | null
  stop: (() => Promise<void>) | null
  discard: (() => Promise<void>) | null
  flush: ((id: string) => Promise<void>) | null
  // The post-live batch hints live on the FULL context (they aren't part of the
  // stable subset), so the grabber reads both. Every capture is live; these make
  // Stop run the end-of-call batch, as an edition's batch persona does.
  setHints: ((hints: { liveAgentAssistOnly?: boolean; hasBatchDefault?: boolean }) => void) | null
} = { startForCapture: null, resume: null, stop: null, discard: null, flush: null, setHints: null }

function Grabber() {
  const stable = useRecordingStable()
  const full = useRecordingContext()
  useEffect(() => {
    holder.startForCapture = stable.startRecordingForCapture
    holder.resume = stable.resumeCapture
    holder.stop = stable.stopRecording
    holder.discard = stable.discardRecording
    holder.flush = stable.flushTranscriptForAgent
    holder.setHints = full.setPostLiveBatchHints
  })
  return null
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.useFakeTimers()
  // A prior test's recovery marker in localStorage triggers the on-mount
  // interrupted-capture probe; clear it so each mount starts clean.
  try { localStorage.clear() } catch { /* jsdom always has it */ }
  mockRecording.isRecording = false
  mockRecording.transcriptSegments = []
  mockRecording.finalSegmentCount = 0
  mockRecording.startRecording.mockClear()
  mockRecording.stopRecording.mockClear()
  mockRecording.clearSessionAccumulators.mockReset()
  streamingPanels.clear()
  requestStreamingExtractionSpy.mockClear()
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  holder.startForCapture = null
  holder.resume = null
  holder.stop = null
  holder.discard = null
  holder.flush = null
  holder.setHints = null
})

async function mount() {
  await act(async () => {
    root.render(h(RecordingProvider, null, h(Grabber)))
  })
}

/** Set the in-memory finals + bump finalSegmentCount + re-render so the
 *  post-segment debounce effect (keyed on finalSegmentCount) fires. */
async function setFinals(segs: Array<{ speaker: string; text: string }>) {
  mockRecording.transcriptSegments = segs.map((s, i) => ({
    id: `seg-${i}`,
    speaker: s.speaker,
    text: s.text,
    isFinal: true,
  }))
  mockRecording.finalSegmentCount = segs.length
  // Wake the provider's store subscription so the debounce effect re-arms.
  // (It no longer keys on a render — that was the per-utterance re-render the
  // finding-7 migration removed.) The re-render is kept so any render-derived
  // state in the provider still settles.
  await act(async () => {
    mockRecording.notifyFinalSegmentCount()
    root.render(h(RecordingProvider, null, h(Grabber)))
  })
}

/** Fire the 2s post-segment debounce and flush the async save. */
async function fireDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_100)
  })
}

function appendCalls() {
  return calls.filter((c) => c.url.endsWith('/transcript-append') && c.method === 'POST')
}
function patchCalls() {
  // Transcript saves only: a start also marks the row live ({ live_mode: true }).
  return calls.filter(
    (c) => /\/api\/account\/captures\/[^/]+$/.test(c.url) && c.method === 'PATCH' && c.body?.live_mode === undefined,
  )
}

const CID = 'cap-delta-1'

async function startRecording() {
  // Flip isRecording AFTER the start, as the real mic does: a start-for-capture
  // while already recording is refused (it would reset the live session).
  await act(async () => { await holder.startForCapture!(CID) })
  mockRecording.isRecording = true
  // Re-render so the isRecording=true effects (periodic timer, debounce) arm.
  await act(async () => {
    root.render(h(RecordingProvider, null, h(Grabber)))
  })
}

describe('delta-append transcript auto-save', () => {
  it('falls back to a full-text PATCH when the acked new_length diverges', async () => {
    await mount()
    await startRecording()
    // Server returns 2xx but a WRONG new_length (not base + append.length). The
    // client must NOT trust the advance — it reconciles via a full PATCH.
    appendResponder = () => jsonResponse(200, { new_length: 999999 })

    await setFinals([{ speaker: 'remote_1', text: 'hello world' }])
    await fireDebounce()

    const ac = appendCalls()
    expect(ac.length).toBe(1)
    expect(ac[0].body).toMatchObject({ base_length: 0, append_text: '[remote_1] hello world' })
    // Divergence → full-text PATCH fallback (no force_transcript).
    const pc = patchCalls()
    expect(pc.length).toBe(1)
    expect(pc[0].body!.transcript).toBe('[remote_1] hello world')
    expect(pc[0].body!.force_transcript).toBeUndefined()
  })

  it('advances base_length across two successful appends', async () => {
    await mount()
    await startRecording()
    // Correct responder from the start: echo base + append length.
    appendResponder = (call) => {
      const b = call.body as { append_text: string; base_length: number }
      return jsonResponse(200, { new_length: b.base_length + b.append_text.length })
    }

    await setFinals([{ speaker: 'remote_1', text: 'aaa' }])
    await fireDebounce()
    const firstChunk = '[remote_1] aaa'
    let ac = appendCalls()
    expect(ac.length).toBe(1)
    expect(ac[0].body).toMatchObject({ base_length: 0, append_text: firstChunk })

    await setFinals([
      { speaker: 'remote_1', text: 'aaa' },
      { speaker: 'remote_1', text: 'bbb' },
    ])
    await fireDebounce()
    ac = appendCalls()
    expect(ac.length).toBe(2)
    // Second append: base_length = first chunk length, chunk prefixed with '\n'.
    expect(ac[1].body).toMatchObject({
      base_length: firstChunk.length,
      append_text: '\n[remote_1] bbb',
    })
    // No PATCH fallback on the clean success path.
    expect(patchCalls().length).toBe(0)
  })

  it('does NOT advance on a failed append — the next tick re-sends the same delta', async () => {
    await mount()
    await startRecording()
    // Append always rejects (network failure).
    appendResponder = () => { throw new Error('network down') }

    await setFinals([{ speaker: 'remote_1', text: 'ccc' }])
    await fireDebounce()
    let ac = appendCalls()
    expect(ac.length).toBe(1)
    expect(ac[0].body).toMatchObject({ base_length: 0, append_text: '[remote_1] ccc' })

    // A NEW final lands; because the previous append did not ack, the acked count
    // is still 0 → the retry sends BOTH finals from base_length 0 (no hole).
    await setFinals([
      { speaker: 'remote_1', text: 'ccc' },
      { speaker: 'remote_1', text: 'ddd' },
    ])
    await fireDebounce()
    ac = appendCalls()
    expect(ac.length).toBe(2)
    expect(ac[1].body).toMatchObject({ base_length: 0 })
    expect(ac[1].body!.append_text).toBe('[remote_1] ccc\n[remote_1] ddd')
  })

  it('rides out 1-2 transient 5xx appends (no PATCH), then falls back after the 3rd', async () => {
    await mount()
    await startRecording()
    // Every append 5xxs (the 2026-07-10 outage shape: the CAS-on-full-text URL
    // blew the proxy limit and 500'd forever).
    appendResponder = () => jsonResponse(500, { error: 'server error' })

    // Tick 1 — first 5xx. Below threshold → retry next tick, NO PATCH yet.
    await setFinals([{ speaker: 'remote_1', text: 'one' }])
    await fireDebounce()
    expect(appendCalls().length).toBe(1)
    expect(patchCalls().length).toBe(0)

    // Tick 2 — second 5xx. Still below threshold → still no PATCH.
    await setFinals([
      { speaker: 'remote_1', text: 'one' },
      { speaker: 'remote_1', text: 'two' },
    ])
    await fireDebounce()
    expect(appendCalls().length).toBe(2)
    expect(patchCalls().length).toBe(0)

    // Tick 3 — third consecutive 5xx crosses the threshold → full-text PATCH
    // fallback (a DIFFERENT route) so persistence self-heals instead of wedging.
    await setFinals([
      { speaker: 'remote_1', text: 'one' },
      { speaker: 'remote_1', text: 'two' },
      { speaker: 'remote_1', text: 'three' },
    ])
    await fireDebounce()
    expect(appendCalls().length).toBe(3)
    const pc = patchCalls()
    expect(pc.length).toBe(1)
    // The fallback carries the FULL transcript and NO force_transcript (no-shrink
    // guard still protects it).
    expect(pc[0].body!.transcript).toBe('[remote_1] one\n[remote_1] two\n[remote_1] three')
    expect(pc[0].body!.force_transcript).toBeUndefined()
  })

  it('falls back after 3 consecutive network failures (streak), like the 5xx path', async () => {
    await mount()
    await startRecording()
    appendResponder = () => { throw new Error('network down') }

    for (const finals of [
      [{ speaker: 'remote_1', text: 'a' }],
      [{ speaker: 'remote_1', text: 'a' }, { speaker: 'remote_1', text: 'b' }],
      [{ speaker: 'remote_1', text: 'a' }, { speaker: 'remote_1', text: 'b' }, { speaker: 'remote_1', text: 'c' }],
    ]) {
      await setFinals(finals)
      await fireDebounce()
    }

    // 3 network failures → the 3rd crosses the threshold → full PATCH fallback.
    expect(appendCalls().length).toBe(3)
    const pc = patchCalls()
    expect(pc.length).toBe(1)
    expect(pc[0].body!.transcript).toBe('[remote_1] a\n[remote_1] b\n[remote_1] c')
  })

  it('a success between failures RESETS the streak (no premature fallback)', async () => {
    await mount()
    await startRecording()
    // Two 5xx, then a success, then two more 5xx: the streak resets on the
    // success, so no PATCH fallback fires across the whole sequence (each side of
    // the success stays below the threshold of 3).
    let mode: 'fail' | 'ok' = 'fail'
    appendResponder = (call) => {
      if (mode === 'ok') {
        const b = call.body as { append_text: string; base_length: number }
        return jsonResponse(200, { new_length: b.base_length + b.append_text.length })
      }
      return jsonResponse(500, { error: 'server error' })
    }

    const build = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ speaker: 'remote_1', text: `s${i}` }))

    // Fail #1, Fail #2 (streak = 2, below threshold).
    await setFinals(build(1)); await fireDebounce()
    await setFinals(build(2)); await fireDebounce()
    expect(patchCalls().length).toBe(0)

    // Success → streak resets to 0.
    mode = 'ok'
    await setFinals(build(3)); await fireDebounce()
    expect(patchCalls().length).toBe(0)

    // Fail #1, Fail #2 again (streak = 2 again, still below threshold).
    mode = 'fail'
    await setFinals(build(4)); await fireDebounce()
    await setFinals(build(5)); await fireDebounce()

    // Never crossed 3-in-a-row thanks to the reset, so NO fallback PATCH fired.
    expect(patchCalls().length).toBe(0)
  })

  it('falls back to a full-text PATCH on a 409 base-length mismatch', async () => {
    await mount()
    await startRecording()
    appendResponder = () =>
      jsonResponse(409, { code: 'BASE_LENGTH_MISMATCH', server_length: 999 })

    await setFinals([{ speaker: 'remote_1', text: 'eee' }])
    await fireDebounce()

    expect(appendCalls().length).toBe(1)
    const pc = patchCalls()
    expect(pc.length).toBe(1)
    // The fallback PATCH sends the FULL transcript and NO force_transcript (the
    // no-shrink guard must still protect it).
    expect(pc[0].body!.transcript).toBe('[remote_1] eee')
    expect(pc[0].body!.force_transcript).toBeUndefined()
  })

  it('falls back to a full-text PATCH on a non-409 4xx, advancing refs only on its success', async () => {
    await mount()
    await startRecording()
    // The append route rejects with a 400 (e.g. an oversized delta after a long
    // offline gap). The delta path is unusable for this request, so the client
    // must fall back to the full-text PATCH rather than wedge by re-sending the
    // same rejected delta forever.
    appendResponder = () => jsonResponse(400, { error: 'append_text exceeds the maximum size' })
    // The fallback PATCH FAILS at first (500) so the acked refs must NOT advance.
    let patchOk = false
    patchResponder = () => (patchOk ? jsonResponse(200, { capture: {} }) : jsonResponse(500, {}))

    await setFinals([{ speaker: 'remote_1', text: 'fff' }])
    await fireDebounce()

    // The 400 append triggered a full-text PATCH fallback (no force_transcript).
    expect(appendCalls().length).toBe(1)
    const pc1 = patchCalls()
    expect(pc1.length).toBe(1)
    expect(pc1[0].body!.transcript).toBe('[remote_1] fff')
    expect(pc1[0].body!.force_transcript).toBeUndefined()

    // The fallback PATCH failed (500), so the acked refs did NOT advance: a new
    // final lands and the next append STILL sends base_length 0 with BOTH finals
    // (no hole, nothing falsely acked).
    await setFinals([
      { speaker: 'remote_1', text: 'fff' },
      { speaker: 'remote_1', text: 'ggg' },
    ])
    await fireDebounce()
    let ac = appendCalls()
    expect(ac.length).toBe(2)
    expect(ac[1].body).toMatchObject({ base_length: 0 })
    expect(ac[1].body!.append_text).toBe('[remote_1] fff\n[remote_1] ggg')

    // Now let the fallback PATCH succeed. A new final lands: the append still
    // 400s, but this time the PATCH lands and advances the acked refs to the full
    // three-final text (the ONLY point in this test where refs advance).
    patchOk = true
    await setFinals([
      { speaker: 'remote_1', text: 'fff' },
      { speaker: 'remote_1', text: 'ggg' },
      { speaker: 'remote_1', text: 'hhh' },
    ])
    await fireDebounce()
    ac = appendCalls()
    expect(ac.length).toBe(3)
    const fullThree = '[remote_1] fff\n[remote_1] ggg\n[remote_1] hhh'

    // The refs advanced only on the successful PATCH, so the NEXT append resumes
    // from the server's true length with a '\n'-prefixed chunk. Switch the append
    // route back to success to confirm the clean resume.
    appendResponder = (call) => {
      const b = call.body as { append_text: string; base_length: number }
      return jsonResponse(200, { new_length: b.base_length + b.append_text.length })
    }
    await setFinals([
      { speaker: 'remote_1', text: 'fff' },
      { speaker: 'remote_1', text: 'ggg' },
      { speaker: 'remote_1', text: 'hhh' },
      { speaker: 'remote_1', text: 'iii' },
    ])
    await fireDebounce()
    ac = appendCalls()
    expect(ac.length).toBe(4)
    expect(ac[3].body).toMatchObject({ base_length: fullThree.length })
    expect(ac[3].body!.append_text).toBe('\n[remote_1] iii')
  })

  it('seeds base_length from the restored server transcript on resume', async () => {
    const restored = '[remote_1] a previously recorded chunk of the meeting'
    getCaptureResponder = () =>
      jsonResponse(200, { capture: { transcript: restored, duration_seconds: 60 } })
    appendResponder = (call) => {
      const b = call.body as { append_text: string; base_length: number }
      return jsonResponse(200, { new_length: b.base_length + b.append_text.length })
    }

    await mount()
    await act(async () => { await holder.resume!(CID) })
    mockRecording.isRecording = true
    await act(async () => {
      root.render(h(RecordingProvider, null, h(Grabber)))
    })

    // New segment after resume → append with base_length = restored length and a
    // '\n'-prefixed chunk (restored + '\n' + new, matching the old full save).
    await setFinals([{ speaker: 'local_1', text: 'new words after resume' }])
    await fireDebounce()

    const ac = appendCalls()
    expect(ac.length).toBe(1)
    expect(ac[0].body).toMatchObject({ base_length: restored.length })
    expect(ac[0].body!.append_text).toBe('\n[local_1] new words after resume')
  })

  it('stop sends the authoritative full-text PATCH with force_transcript', async () => {
    await mount()
    await startRecording()
    appendResponder = (call) => {
      const b = call.body as { append_text: string; base_length: number }
      return jsonResponse(200, { new_length: b.base_length + b.append_text.length })
    }

    // Snapshot how many fetches had fired when the accumulator clear ran, so we
    // can assert the H3 ordering: the clear must come AFTER the force save (the
    // save reads the very segments the clear empties).
    let fetchCountAtClear = -1
    mockRecording.clearSessionAccumulators.mockImplementation(() => {
      fetchCountAtClear = calls.length
    })

    await setFinals([{ speaker: 'remote_1', text: 'final words' }])
    // Stop triggers the force save.
    await act(async () => { await holder.stop!() })

    const forcePatch = patchCalls().find((c) => c.body?.force_transcript === true)
    expect(forcePatch).toBeTruthy()
    expect(forcePatch!.body!.transcript).toBe('[remote_1] final words')

    // Incident hotfix H3: the session accumulators are cleared in stop's tail —
    // exactly once, and only after the authoritative force PATCH was issued.
    expect(mockRecording.clearSessionAccumulators).toHaveBeenCalledTimes(1)
    const forcePatchIndex = calls.findIndex((c) => c.body?.force_transcript === true)
    expect(fetchCountAtClear).toBeGreaterThan(forcePatchIndex)

    // …and it must NOT ask for the segments to be dropped. Dropping them makes
    // the header's transcript pane fall through to `capture.transcript`, which
    // the panel's one-shot loadTranscript() may have filled from BEFORE this
    // very force save — a permanently blank/truncated pane (recording-cache
    // review, critical). Stop releases only the per-word payloads + the merger.
    const clearArg = mockRecording.clearSessionAccumulators.mock.calls[0]?.[0] as
      | { dropSegments?: boolean }
      | undefined
    expect(clearArg?.dropSegments).not.toBe(true)
  })

  // The 2s post-segment debounce used to key on a `finalSegmentCount` STATE
  // mirror, so the provider re-rendered once per finalized utterance for the
  // whole meeting just to re-arm a timer. It now re-arms from the ref-backed
  // store's notification instead (finding 7). This pins that the notification
  // ALONE still drives the save — no re-render of the provider anywhere.
  it('re-arms the 2s debounce from the store notification alone (no re-render)', async () => {
    await mount()
    await startRecording()
    appendResponder = (call) => {
      const b = call.body as { append_text: string; base_length: number }
      return jsonResponse(200, { new_length: b.base_length + b.append_text.length })
    }

    // Mutate the store's backing values and fire ONLY the notification —
    // deliberately no root.render, unlike the shared setFinals() helper.
    mockRecording.transcriptSegments = [
      { id: 'seg-0', speaker: 'local_1', text: 'store-driven', isFinal: true },
    ]
    mockRecording.finalSegmentCount = 1
    await act(async () => { mockRecording.notifyFinalSegmentCount() })

    await fireDebounce()

    const ac = appendCalls()
    expect(ac.length).toBe(1)
    expect(ac[0].body).toMatchObject({ base_length: 0, append_text: '[local_1] store-driven' })
  })

  it('discard DOES drop the segments — the capture row is deleted, no reader survives', async () => {
    await mount()
    await startRecording()
    await setFinals([{ speaker: 'remote_1', text: 'throwaway words' }])

    await act(async () => { await holder.discard!() })

    expect(mockRecording.clearSessionAccumulators).toHaveBeenCalledTimes(1)
    expect(mockRecording.clearSessionAccumulators).toHaveBeenCalledWith({ dropSegments: true })
    // And discard never persists — no force PATCH on this path.
    expect(patchCalls().some((c) => c.body?.force_transcript === true)).toBe(false)
  })
})

/**
 * `ni:capture-transcript-saved` — the extraction-INDEPENDENT signal that the
 * authoritative final transcript force-PATCH has landed.
 *
 * WHY IT EXISTS (audit: transcript tail loss / transcript-seam re-review). The
 * panel used to discover "the final save has landed" only via the EXTRACTION
 * lifecycle (`ni:capture-ended`). On the DEFAULT configuration — live mode
 * OFF with the detail panel mounted — the stop path hands the batch run to the
 * panel and deliberately does NOT dispatch capture-ended, waiting for the
 * panel's own dispatch from streaming onDone. A batch that errors (a 504 on a
 * very long transcript is the reported scenario) therefore produces NO
 * completion signal at all, so the post-stop transcript was never authoritatively
 * re-read and a pre-final-save row stayed cached as if it were complete.
 *
 * The contract these tests pin: the event fires on EVERY stop path that had a
 * bound capture, regardless of extraction, and carries the capture id.
 */
describe('ni:capture-transcript-saved (extraction-independent transcript signal)', () => {
  /** Record every transcript-saved event, with the fetch-call index at dispatch
   *  time so ordering against the force PATCH is assertable. */
  function listen() {
    const seen: Array<{ captureId: string; fetchIndex: number }> = []
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { captureId: string }
      seen.push({ captureId: d.captureId, fetchIndex: calls.length })
    }
    window.addEventListener('ni:capture-transcript-saved', handler)
    return {
      seen,
      dispose: () => window.removeEventListener('ni:capture-transcript-saved', handler),
    }
  }

  it('fires on a normal stop, with the right capture id, AFTER the force PATCH', async () => {
    const { seen, dispose } = listen()
    try {
      await mount()
      await startRecording()
      await setFinals([{ speaker: 'remote_1', text: 'the meeting tail' }])

      await act(async () => { await holder.stop!() })

      expect(seen.length).toBe(1)
      expect(seen[0].captureId).toBe(CID)
      // It must announce a transcript that is already durable: the authoritative
      // force PATCH has to have been issued (and awaited) before the dispatch.
      const forcePatchIndex = calls.findIndex((c) => c.body?.force_transcript === true)
      expect(forcePatchIndex).toBeGreaterThanOrEqual(0)
      expect(seen[0].fetchIndex).toBeGreaterThan(forcePatchIndex)
    } finally {
      dispose()
    }
  })

  // THE REGRESSION. A live call whose record a batch persona still writes (an
  // edition's batch default; an assist-only live agent) with its panel mounted:
  // the recording layer hands the run to the panel and never dispatches
  // capture-ended itself. If the panel's stream then errors, capture-ended is
  // never dispatched by anyone — so before this fix there was no signal at all
  // that the transcript was safe, and the panel's cached copy stayed truncated.
  it('fires even when the panel owns the batch and its extraction never completes', async () => {
    const { seen, dispose } = listen()
    const endedSeen: string[] = []
    const onEnded = (e: Event) => {
      endedSeen.push(((e as CustomEvent).detail as { captureId: string }).captureId)
    }
    window.addEventListener('ni:capture-ended', onEnded)
    try {
      // A detail panel is mounted for this capture → the stop path takes the
      // handoff branch (requestStreamingExtraction, no inline batch).
      streamingPanels.add(CID)

      await mount()
      await startRecording()
      await act(async () => { holder.setHints!({ hasBatchDefault: true }) })
      await setFinals([{ speaker: 'remote_1', text: 'a very long meeting tail' }])

      await act(async () => { await holder.stop!() })

      // Confirm we really are on the handoff branch and not the inline one.
      expect(requestStreamingExtractionSpy).toHaveBeenCalledTimes(1)
      expect(requestStreamingExtractionSpy.mock.calls[0][0]).toMatchObject({
        captureId: CID,
        mode: 'batch',
      })
      // The panel's stream errors (504 on a long transcript) → its onError path
      // dispatches NOTHING, so capture-ended never fires for this capture.
      expect(endedSeen).toEqual([])

      // …but the transcript signal fired anyway. This is the whole fix: the
      // transcript's durability no longer depends on extraction succeeding.
      expect(seen.length).toBe(1)
      expect(seen[0].captureId).toBe(CID)
    } finally {
      dispose()
      window.removeEventListener('ni:capture-ended', onEnded)
    }
  })

  // The headless leg of the same defect: with no panel mounted the recording
  // layer runs the batch itself, and its capture-ended dispatch is gated on
  // `extractionSucceeded`. A failing batch skips capture-ended entirely.
  it('fires when the inline batch extraction FAILS (capture-ended is skipped)', async () => {
    const { seen, dispose } = listen()
    const endedSeen: string[] = []
    const onEnded = (e: Event) => {
      endedSeen.push(((e as CustomEvent).detail as { captureId: string }).captureId)
    }
    window.addEventListener('ni:capture-ended', onEnded)
    try {
      // No panel registered → the recording layer runs the guaranteed batch, and
      // that POST fails (the 504-on-a-long-transcript shape).
      const realFetch = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
      vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/ai/live-agent') {
          calls.push({ url, method: init?.method || 'GET', body: null })
          return Promise.resolve(jsonResponse(504, { error: 'timeout' }))
        }
        return realFetch(url, init)
      }))

      await mount()
      await startRecording()
      await act(async () => { holder.setHints!({ hasBatchDefault: true }) })
      await setFinals([{ speaker: 'remote_1', text: 'headless meeting tail' }])

      await act(async () => { await holder.stop!() })

      // The batch ran here (not handed off) and failed, so capture-ended — which
      // is gated on extraction success — never fired.
      expect(requestStreamingExtractionSpy).not.toHaveBeenCalled()
      expect(calls.some((c) => c.url === '/api/ai/live-agent')).toBe(true)
      expect(endedSeen).toEqual([])

      // The transcript signal is independent of that failure.
      expect(seen.length).toBe(1)
      expect(seen[0].captureId).toBe(CID)
    } finally {
      dispose()
      window.removeEventListener('ni:capture-ended', onEnded)
    }
  })

  // A live call with a note-taking live agent (no batch hints): extraction is
  // never requested at stop at all (the summary was written incrementally during
  // the meeting). The signal must still fire.
  it('fires on a live-mode stop, where no batch extraction is ever requested', async () => {
    const { seen, dispose } = listen()
    try {
      await mount()
      await startRecording()
      await setFinals([{ speaker: 'local_1', text: 'live mode tail' }])

      await act(async () => { await holder.stop!() })

      // No batch extraction was requested on either leg.
      expect(requestStreamingExtractionSpy).not.toHaveBeenCalled()
      expect(calls.some((c) => c.url === '/api/ai/live-agent')).toBe(false)

      expect(seen.length).toBe(1)
      expect(seen[0].captureId).toBe(CID)
    } finally {
      dispose()
    }
  })

  it('does NOT fire on discard — the row is deleted and nothing was force-saved', async () => {
    const { seen, dispose } = listen()
    try {
      await mount()
      await startRecording()
      await setFinals([{ speaker: 'remote_1', text: 'throwaway words' }])

      await act(async () => { await holder.discard!() })

      expect(seen).toEqual([])
      // Sanity: discard genuinely never force-saved, so there is no durable
      // transcript for the event to have announced.
      expect(patchCalls().some((c) => c.body?.force_transcript === true)).toBe(false)
    } finally {
      dispose()
    }
  })

  it('fires exactly once for one stop, even when Stop is double-invoked', async () => {
    const { seen, dispose } = listen()
    try {
      await mount()
      await startRecording()
      await setFinals([{ speaker: 'remote_1', text: 'double clicked stop' }])

      // Two concurrent stops (a double-clicked Stop button). The re-entry guard
      // makes the second a no-op, so the signal must not duplicate.
      await act(async () => { await Promise.all([holder.stop!(), holder.stop!()]) })

      expect(seen.length).toBe(1)
      expect(seen[0].captureId).toBe(CID)
    } finally {
      dispose()
    }
  })
})
