// @vitest-environment jsdom
/**
 * Capture performance benchmark — empirical evidence for the re-render-storm
 * hypothesis BEFORE applying any fix.
 *
 * The user reports: starting/stopping/resuming a capture feels clunky, and after
 * 45–60 min of recording the whole app (incl. the audio waveform) goes
 * slow-motion. The investigation traced this to the RecordingContext value being
 * rebuilt unmemoized on every audio-level frame (~10 Hz), re-rendering ALL
 * context consumers for the entire recording, which starves the waveform's
 * requestAnimationFrame loop on the main thread.
 *
 * These tests measure the actual mechanism with hard numbers:
 *   1. The REAL TranscriptMerger's per-call + cumulative cost as N grows over an
 *      hour-long session (the "compounds over time" amplifier).
 *   2. The REAL derived-scan logic (finalSegmentCount / detectedSpeakers) cost
 *      per render over a growing transcript.
 *   3. A faithful React reproduction of the context-value churn: how many times
 *      consumers re-render per simulated second of 10 Hz audio with the CURRENT
 *      unmemoized pattern vs. a split/ref-routed pattern (the proposed fix).
 *
 * Run:  npx vitest run src/hooks/__tests__/recording-perf.bench.test.tsx
 *
 * This is a MECHANISM benchmark (deterministic, no hardware needed), not a full
 * desktop profiler trace — it isolates and quantifies the exact code paths the
 * static analysis flagged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import {
  createElement as h,
  createContext,
  useContext,
  useState,
  useRef,
  useMemo,
  useEffect,
  act,
  type ReactNode,
} from 'react'
import { TranscriptMerger, type TranscriptSegment } from '@/lib/deepgram-stream'
import {
  RecordingProvider,
  useRecordingStable,
  useRecordingContext,
  useAudioLevels,
  useTranscriptSegments,
  useFinalSegmentCount,
  useDetectedSpeakers,
  useAgentActivity,
  useLiveAgentStatus,
  useHasLiveTranscriptSegments,
  useLiveActiveSpeaker,
  useAutoAcceptCountdown,
} from '@/hooks/recording-context'
// The mock factory below spreads the ACTUAL module, so this import resolves to
// the real derived-signal logic (the exact code publishTranscriptSegments runs)
// — the growing-finals stores are driven through it for fidelity.
import {
  deriveTranscriptSignals,
  type AgentActivityEvent,
  type UseRecordingOptions,
} from '@/hooks/use-recording'

// ── Stateful mock of useRecording ────────────────────────────────
// The REAL RecordingProvider (mounted in the last describe) calls useRecording()
// and builds a memoized full context value + a memoized stable subset.
//
// levels/elapsed are now REF-BACKED EXTERNAL STORES: useRecording exposes
// getLevels/subscribeLevels + getElapsed/subscribeElapsed instead of returning
// the raw values. To faithfully reproduce production we:
//   - hold the level payload in a module ref + a listener set, and
//   - ALSO bump a piece of provider state on each push, so the provider still
//     re-renders on a level frame (exactly like production, where the hook
//     re-rendered ~10×/s). This is what lets us prove the memoized value/stable
//     subset insulate their consumers from that churn — while a useAudioLevels()
//     consumer, subscribed to the store, DOES observe the new level.
const levelStore = {
  current: { micLevel: 0, systemLevel: 0, timestamp: 0 } as { micLevel: number; systemLevel: number; timestamp: number },
  listeners: new Set<() => void>(),
}
const elapsedStore = { current: 0, listeners: new Set<() => void>() }
// Transcript segments are ALSO a ref-backed external store now (same as levels).
// Interim flushes (~150ms) re-publish the array but add no finals/speakers, so a
// push here must NOT re-render the memoized full/stable context — only a
// useTranscriptSegments() leaf consumer.
const transcriptStore = { current: [] as TranscriptSegment[], listeners: new Set<() => void>() }
// The per-utterance signals are ref-backed stores too (audit finding 7):
// finalSegmentCount + detectedSpeakers derive from the published transcript,
// agentActivity appends per live-agent tool call. Their deprecated context
// mirrors on the mock stay CONSTANT — that reproduces the Wave-2 end state
// (fields removed from the context value), which is exactly the contract the
// growing-finals render assertions below pin.
const finalCountStore = { current: 0, listeners: new Set<() => void>() }
const speakersStore = { current: [] as string[], listeners: new Set<() => void>() }
const activityStore = { current: [] as AgentActivityEvent[], listeners: new Set<() => void>() }
// Voice ID auto-accept countdown ticks — keyed by the suggestion entry, 1 Hz.
const autoAcceptTickStore = { current: new WeakMap<object, number>(), listeners: new Set<() => void>() }
// Options the provider passed to useRecording — the live-agent status test
// drives the provider's publishLiveAgentStatus via onLiveAgentStatusChange
// (the status store's one real change path).
let lastRecordingOptions: UseRecordingOptions | null = null
// Forces the mocked provider to re-render on a push (mirrors production's hook
// re-render on a level frame). Set by the mock's useRecording.
let bumpProviderRender: () => void = () => {}
function pushMockLevel(l: { micLevel: number; systemLevel: number; timestamp: number }) {
  levelStore.current = l
  levelStore.listeners.forEach((cb) => cb())
  bumpProviderRender()
}
function pushMockElapsed(seconds: number) {
  elapsedStore.current = seconds
  elapsedStore.listeners.forEach((cb) => cb())
  bumpProviderRender()
}
/** Publish a new transcript array (mirrors publishTranscriptSegments). Notifies
 *  store subscribers and bumps the provider render — but does NOT change
 *  finalSegmentCount/detectedSpeakers on the mock (an interim-flush tick), so the
 *  memoized context values must keep identity. */
function pushMockTranscript(segments: TranscriptSegment[]) {
  transcriptStore.current = segments
  transcriptStore.listeners.forEach((cb) => cb())
  bumpProviderRender()
}
/** Publish a transcript where the FINAL count / speaker set may have GROWN —
 *  the store half of publishTranscriptSegments, driven through the REAL
 *  deriveTranscriptSignals (change-detection + identity-preservation included).
 *  Deliberately does NOT bump the deprecated finalSegmentCount/detectedSpeakers
 *  context mirrors on the mock: that reproduces Wave 2 (fields removed from the
 *  context), so the volatile consumer must stay at zero renders. */
function pushMockFinalsTranscript(segments: TranscriptSegment[]) {
  transcriptStore.current = segments
  transcriptStore.listeners.forEach((cb) => cb())
  const signals = deriveTranscriptSignals(segments, finalCountStore.current, speakersStore.current)
  if (signals.finalCountChanged) {
    finalCountStore.current = signals.finalCount
    finalCountStore.listeners.forEach((cb) => cb())
  }
  if (signals.speakersChanged) {
    speakersStore.current = signals.speakers
    speakersStore.listeners.forEach((cb) => cb())
  }
  bumpProviderRender()
}
/** Publish a grown live-agent activity feed (mirrors publishAgentActivity minus
 *  the deprecated state mirror — the Wave-2 shape). */
function pushMockActivity(events: AgentActivityEvent[]) {
  activityStore.current = events
  activityStore.listeners.forEach((cb) => cb())
  bumpProviderRender()
}
function resetMockStores() {
  levelStore.current = { micLevel: 0, systemLevel: 0, timestamp: 0 }
  levelStore.listeners.clear()
  elapsedStore.current = 0
  elapsedStore.listeners.clear()
  transcriptStore.current = []
  transcriptStore.listeners.clear()
  finalCountStore.current = 0
  finalCountStore.listeners.clear()
  speakersStore.current = []
  speakersStore.listeners.clear()
  activityStore.current = []
  activityStore.listeners.clear()
  autoAcceptTickStore.current = new WeakMap()
  autoAcceptTickStore.listeners.clear()
  lastRecordingOptions = null
}
const mockRecordingBase = {
  isRecording: false,
  startRecording: vi.fn(async () => {}),
  startRecordingForCapture: vi.fn(async () => {}),
  stopRecording: vi.fn(async () => {}),
  clearSessionAccumulators: vi.fn(),
  pauseRecording: vi.fn(),
  resumeRecording: vi.fn(),
  recordingError: null as string | null,
  transcriptionStatus: 'connected' as const,
  speakerContacts: {},
  isPaused: false,
  isAgentFinalizing: false,
  // DEPRECATED context mirrors — held CONSTANT (the Wave-2 shape: the real
  // values flow only through the stores below, so the memoized context value
  // must keep identity while they grow).
  finalSegmentCount: 0,
  detectedSpeakers: [] as string[],
  agentActivity: [] as AgentActivityEvent[],
  // External-store accessors — identity-stable module functions.
  getLevels: () => levelStore.current,
  subscribeLevels: (cb: () => void) => { levelStore.listeners.add(cb); return () => { levelStore.listeners.delete(cb) } },
  getElapsed: () => elapsedStore.current,
  subscribeElapsed: (cb: () => void) => { elapsedStore.listeners.add(cb); return () => { elapsedStore.listeners.delete(cb) } },
  getTranscriptSegmentsSnapshot: () => transcriptStore.current,
  subscribeTranscriptSegments: (cb: () => void) => { transcriptStore.listeners.add(cb); return () => { transcriptStore.listeners.delete(cb) } },
  getFinalSegmentCount: () => finalCountStore.current,
  subscribeFinalSegmentCount: (cb: () => void) => { finalCountStore.listeners.add(cb); return () => { finalCountStore.listeners.delete(cb) } },
  getDetectedSpeakers: () => speakersStore.current,
  subscribeDetectedSpeakers: (cb: () => void) => { speakersStore.listeners.add(cb); return () => { speakersStore.listeners.delete(cb) } },
  getAgentActivity: () => activityStore.current,
  subscribeAgentActivity: (cb: () => void) => { activityStore.listeners.add(cb); return () => { activityStore.listeners.delete(cb) } },
  getAutoAcceptTick: (suggestion: object) => autoAcceptTickStore.current.get(suggestion),
  subscribeAutoAcceptTicks: (cb: () => void) => { autoAcceptTickStore.listeners.add(cb); return () => { autoAcceptTickStore.listeners.delete(cb) } },
}
// Spread the ACTUAL module so pure exports (deriveTranscriptSignals,
// getSpeakerDisplayName, …) stay real — only the hook itself is replaced.
vi.mock('@/hooks/use-recording', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-recording')>()
  return {
    ...actual,
    useRecording: (options: UseRecordingOptions = {}) => {
      lastRecordingOptions = options
      // A render-bump counter so a level/elapsed push re-renders the provider
      // (production's hook re-rendered on every audio frame). The memoized context
      // values must still keep identity across these bumps.
      const [, setTick] = useState(0)
      bumpProviderRender = () => setTick((n) => n + 1)
      return mockRecordingBase
    },
  }
})
vi.mock('@/lib/capture-cache', () => ({
  seedCaptureCache: vi.fn(),
  captureDetailCache: new Map(),
  CAPTURE_CACHE_MAX: 20,
  writeCaptureCache: vi.fn(),
  registerPendingCaptureCreate: vi.fn(),
  captureRowReady: vi.fn(async () => true),
}))

// Silence React's "not configured to support act" warning; render counts are
// still accurate. We drive everything through act() explicitly.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── helpers ──────────────────────────────────────────────────────

let segCounter = 0
function makeFinal(startTime: number, stream: 'mic' | 'system' = 'mic'): TranscriptSegment {
  return {
    id: `${stream}-${segCounter++}`,
    stream,
    speaker: stream === 'mic' ? 'local_1' : 'remote_1',
    text: 'the quick brown fox jumped over the lazy dog and kept on talking for a while',
    startTime,
    endTime: startTime + 3,
    isFinal: true,
    words: [],
  } as TranscriptSegment
}

/** The REAL derived scans from use-recording.ts:858-867 (copied verbatim so we
 *  measure the exact logic). */
function deriveScans(transcriptSegments: TranscriptSegment[]) {
  const finalSegmentCount = transcriptSegments.filter((s) => s.isFinal).length
  const detectedSpeakers = Array.from(
    new Set(transcriptSegments.filter((s) => s.isFinal).map((s) => s.speaker)),
  ).sort((a, b) => {
    const aLocal = a.startsWith('local')
    const bLocal = b.startsWith('local')
    if (aLocal !== bLocal) return aLocal ? -1 : 1
    return a.localeCompare(b, undefined, { numeric: true })
  })
  return { finalSegmentCount, detectedSpeakers }
}

beforeEach(() => { segCounter = 0 })

// ─────────────────────────────────────────────────────────────────
describe('TranscriptMerger cost over a long session (real code)', () => {
  it('measures per-call + cumulative addSegment cost as N grows to an hour of finals', () => {
    // Realistic: ~1 final per ~3s of speech across 2 streams over 60 min.
    // Verifier corrected the inflated "20k" claim down to hundreds–low-thousands.
    const N = 1500
    const merger = new TranscriptMerger()
    let lastReturned: TranscriptSegment[] = []

    const t0 = performance.now()
    for (let i = 0; i < N; i++) {
      lastReturned = merger.addSegment(makeFinal(i * 3, i % 2 === 0 ? 'mic' : 'system'))
    }
    const total = performance.now() - t0

    // Sanity: every call returns a fresh full-length array (the clone the UI
    // hands to setTranscriptSegments each frame).
    expect(lastReturned).toHaveLength(N)
    expect(merger.getTranscript()).toHaveLength(N)

    // The cumulative cost of building an hour's transcript one segment at a time,
    // each call doing filter + push + full .sort() + spread clone.
    console.log(`[bench] TranscriptMerger: ${N} addSegment calls = ${total.toFixed(1)}ms total, ${(total / N).toFixed(3)}ms/call`)

    // Not an assertion on a wall-clock threshold (machine-dependent) — the point
    // is the printed number. Just assert it completed.
    expect(total).toBeGreaterThanOrEqual(0)
  })
})

describe('Derived-scan cost per render over a growing transcript (real logic)', () => {
  it('measures filter+Set+map+sort cost at small vs large N, run at ~10Hz render rate', () => {
    const build = (n: number) => Array.from({ length: n }, (_, i) => makeFinal(i * 3))
    const RENDERS_PER_SEC = 11 // 10Hz levels + 1Hz elapsed (verified cadence)

    for (const n of [100, 500, 1500]) {
      const segs = build(n)
      const t0 = performance.now()
      for (let r = 0; r < RENDERS_PER_SEC; r++) deriveScans(segs)
      const perSecond = performance.now() - t0
      console.log(`[bench] derived scans @ N=${n}: ${(perSecond / RENDERS_PER_SEC).toFixed(4)}ms/render, ${perSecond.toFixed(3)}ms/sec of renders`)
    }
    expect(true).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────
// React reproduction of the CONTEXT-VALUE CHURN.
//
// CURRENT pattern (the bug): provider rebuilds `value = {...state}` every render
// with no memo; every useContext consumer re-renders whenever ANY field changes
// — including the 10Hz `levels`. We count consumer renders per simulated second.
//
// FIXED pattern (proposed): split into a stable context (functions/flags) and
// route high-frequency `levels` to ONLY the waveform via a ref, not context.
// Stable consumers should then NOT re-render on level frames.
// ─────────────────────────────────────────────────────────────────

interface FakeLevels { mic: number; sys: number }

describe('Context-value churn: current (unmemoized) vs fixed (split + ref)', () => {
  let container: HTMLElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  const FRAMES = 30 // simulate 3 seconds of 10Hz audio levels

  it('CURRENT: a level-only consumer AND an unrelated consumer both re-render on every level frame', async () => {
    // Mirrors recording-context.tsx:714 — value rebuilt every render, no memo.
    const Ctx = createContext<{ levels: FakeLevels; isRecording: boolean; stop: () => void } | null>(null)

    let pushLevel: (l: FakeLevels) => void = () => {}
    function Provider({ children }: { children: ReactNode }) {
      const [levels, setLevels] = useState<FakeLevels>({ mic: 0, sys: 0 })
      const [isRecording] = useState(true)
      pushLevel = setLevels
      const stop = () => {}
      // THE DEFECT: new object literal every render (spread of changing state).
      const value = { levels, isRecording, stop }
      return h(Ctx.Provider, { value }, children)
    }

    let waveformRenders = 0
    let unrelatedRenders = 0
    // Waveform legitimately consumes levels.
    function Waveform() { useContext(Ctx); waveformRenders++; return null }
    // An UNRELATED consumer that only needs isRecording/stop (e.g. tab-bar,
    // capture-bar-button, chat-panel). It should NOT care about levels — but with
    // the unmemoized value it re-renders on every frame anyway.
    function UnrelatedConsumer() { useContext(Ctx); unrelatedRenders++; return null }

    await act(async () => {
      root.render(h(Provider, null, h(Waveform), h(UnrelatedConsumer)))
    })
    const baseWave = waveformRenders
    const baseUnrelated = unrelatedRenders

    for (let i = 0; i < FRAMES; i++) {
      await act(async () => { pushLevel({ mic: i % 10, sys: (i * 2) % 10 }) })
    }

    const waveDelta = waveformRenders - baseWave
    const unrelatedDelta = unrelatedRenders - baseUnrelated
    console.log(`[bench] CURRENT over ${FRAMES} level frames: waveform=${waveDelta} renders, UNRELATED consumer=${unrelatedDelta} renders`)

    // The bug: the unrelated consumer re-renders once per frame — wasted work
    // multiplied across all 9 real consumers, every frame, for the whole meeting.
    expect(unrelatedDelta).toBe(FRAMES)
    expect(waveDelta).toBe(FRAMES)
  })

  it('FIXED: levels via ref + split context — unrelated consumers do NOT re-render on level frames', async () => {
    // Stable context: only functions + low-frequency flags. Built with useMemo
    // over stable members so its identity never changes on a level frame.
    const StableCtx = createContext<{ isRecording: boolean; stop: () => void } | null>(null)
    // Levels delivered via a ref + subscription — never through React state/context.
    type LevelSub = { ref: { current: FakeLevels }; subscribe: (cb: () => void) => void }
    const LevelCtx = createContext<LevelSub | null>(null)

    let pushLevel: (l: FakeLevels) => void = () => {}
    function Provider({ children }: { children: ReactNode }) {
      const [isRecording] = useState(true)
      const levelRef = useRef<FakeLevels>({ mic: 0, sys: 0 })
      const subsRef = useRef<Set<() => void>>(new Set())
      const stop = useMemo(() => () => {}, [])
      // Stable: identity changes only when isRecording/stop change, never per frame.
      const stableValue = useMemo(() => ({ isRecording, stop }), [isRecording, stop])
      const levelSub = useMemo<LevelSub>(() => ({
        ref: levelRef,
        subscribe: (cb: () => void) => { subsRef.current.add(cb) },
      }), [])
      pushLevel = (l: FakeLevels) => {
        // Mutate ref + notify only level subscribers — NO provider re-render.
        levelRef.current = l
        subsRef.current.forEach((cb) => cb())
      }
      return h(StableCtx.Provider, { value: stableValue },
        h(LevelCtx.Provider, { value: levelSub }, children))
    }

    let waveformRenders = 0
    let unrelatedRenders = 0
    function Waveform() {
      const sub = useContext(LevelCtx)!
      const [, force] = useState(0)
      // Subscribe once; on each level tick, force a local re-render (mirrors a
      // component that paints from the level ref). In the REAL app the canvas
      // reads the ref in its own rAF loop and wouldn't even need this.
      const subscribed = useRef(false)
      if (!subscribed.current) { subscribed.current = true; sub.subscribe(() => force((n) => n + 1)) }
      waveformRenders++
      return null
    }
    function UnrelatedConsumer() { useContext(StableCtx); unrelatedRenders++; return null }

    await act(async () => {
      root.render(h(Provider, null, h(Waveform), h(UnrelatedConsumer)))
    })
    const baseUnrelated = unrelatedRenders

    for (let i = 0; i < FRAMES; i++) {
      await act(async () => { pushLevel({ mic: i % 10, sys: (i * 2) % 10 }) })
    }

    const unrelatedDelta = unrelatedRenders - baseUnrelated
    console.log(`[bench] FIXED over ${FRAMES} level frames: UNRELATED consumer=${unrelatedDelta} renders (target: 0)`)

    // The win: unrelated consumers are completely insulated from level frames.
    expect(unrelatedDelta).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────
// The REAL split, end-to-end: mount the actual RecordingProvider (useRecording
// mocked to a stateful level source) and read the STABLE context the way the chat
// panel now does. This locks in the two guarantees the chat-panel isolation
// depends on:
//   1. useRecordingStable() exposes flushTranscriptForAgent (moved into the stable
//      subset) — the chat panel awaits it before a live talk-back turn WITHOUT
//      subscribing to the volatile full context.
//   2. A useRecordingStable() consumer does NOT re-render when levels tick at
//      audio-frame rate — the whole point of moving the chat panel off the full
//      RecordingContext.
// ─────────────────────────────────────────────────────────────────
describe('RecordingProvider split: stable consumer is insulated from level ticks', () => {
  let container: HTMLElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    resetMockStores()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  const FRAMES = 30 // 3 seconds of 10Hz audio levels

  it('exposes flushTranscriptForAgent and does NOT re-render on level updates', async () => {
    // A stable-context consumer mirroring how the chat panel now reads recording:
    // it grabs flushTranscriptForAgent (+ getTranscriptSegments) and counts its
    // own renders. In the real app this component is the 1600-line chat panel; the
    // fix is that a level tick no longer touches it.
    let stableConsumerRenders = 0
    const seen: {
      flush: unknown
      getSegments: unknown
    } = { flush: null, getSegments: null }

    function StableConsumer() {
      const ctx = useRecordingStable()
      stableConsumerRenders++
      // Capture the fields the chat panel depends on (via an effect so it's a
      // commit-time read, not a render-time side effect).
      useEffect(() => {
        seen.flush = ctx.flushTranscriptForAgent
        seen.getSegments = ctx.getTranscriptSegments
      })
      return null
    }

    await act(async () => {
      root.render(h(RecordingProvider, null, h(StableConsumer)))
    })

    // (1) The stable context carries the transcript-flush action + the freshest-
    // segments getter — both moved into the stable subset for the chat panel.
    expect(typeof seen.flush).toBe('function')
    expect(typeof seen.getSegments).toBe('function')

    const baseRenders = stableConsumerRenders

    // (2) Drive level frames through the REAL provider. Each tick re-renders the
    // provider (the full, unmemoized value rebuilds) — but the memoized stableValue
    // keeps its identity, so this consumer must not re-render.
    for (let i = 0; i < FRAMES; i++) {
      await act(async () => {
        pushMockLevel({ micLevel: i % 10, systemLevel: (i * 2) % 10, timestamp: i })
      })
    }

    const renderDelta = stableConsumerRenders - baseRenders
    console.log(`[bench] REAL provider over ${FRAMES} level frames: stable consumer=${renderDelta} renders (target: 0)`)
    expect(renderDelta).toBe(0)
  })

  it('a VOLATILE-context consumer is insulated from level + elapsed + TRANSCRIPT ticks', async () => {
    // The capture detail panel reads the full RecordingContext (isRecording,
    // agentActivity, …). The value is memoized over explicit deps, and the three
    // high-frequency signals — levels, elapsed, AND the ~150ms transcript array —
    // are external stores, NOT context fields. So even this volatile consumer no
    // longer re-renders on any of them. Prove it across 30 level frames, several
    // elapsed ticks, and a burst of interim transcript flushes.
    let volatileConsumerRenders = 0
    function VolatileConsumer() {
      const ctx = useRecordingContext()
      // Touch fields the panel actually reads, so a naive [recording] dep (which
      // would churn every render) would be caught here. (finalSegmentCount is
      // no longer a context field at all — it is a leaf store; see the
      // per-utterance suite below.)
      void ctx.isRecording
      void ctx.isPaused
      volatileConsumerRenders++
      return null
    }

    await act(async () => {
      root.render(h(RecordingProvider, null, h(VolatileConsumer)))
    })
    const base = volatileConsumerRenders

    for (let i = 0; i < FRAMES; i++) {
      await act(async () => {
        pushMockLevel({ micLevel: i % 10, systemLevel: (i * 2) % 10, timestamp: i })
      })
    }
    // A handful of 1Hz elapsed ticks too — they must not touch the volatile value.
    for (let s = 1; s <= 5; s++) {
      await act(async () => { pushMockElapsed(s) })
    }
    // A burst of interim transcript flushes — the dominant lag source we just
    // moved to a leaf store. These must NOT re-render the volatile consumer.
    for (let i = 0; i < FRAMES; i++) {
      await act(async () => {
        pushMockTranscript([makeFinal(i), { ...makeFinal(i), isFinal: false }])
      })
    }

    const delta = volatileConsumerRenders - base
    console.log(`[bench] REAL provider: VOLATILE consumer=${delta} renders across ${FRAMES} level + 5 elapsed + ${FRAMES} transcript ticks (target: 0)`)
    expect(delta).toBe(0)
  })

  it('a useTranscriptSegments() consumer observes the latest segments and re-renders on publishes', async () => {
    // The live-transcript leaf calls useTranscriptSegments() (useSyncExternalStore
    // over the transcript store). It SHOULD re-render on each publish AND read the
    // freshest array — that's the one place the ~150ms flushes are allowed to land.
    let leafRenders = 0
    let observedLen = -1
    function TranscriptLeaf() {
      const segs = useTranscriptSegments()
      leafRenders++
      observedLen = segs.length
      return null
    }

    await act(async () => {
      root.render(h(RecordingProvider, null, h(TranscriptLeaf)))
    })
    const base = leafRenders

    for (let i = 1; i <= FRAMES; i++) {
      await act(async () => {
        // i distinct final segments → a growing array, one publish per tick.
        pushMockTranscript(Array.from({ length: i }, (_, k) => makeFinal(k)))
      })
    }

    const delta = leafRenders - base
    console.log(`[bench] useTranscriptSegments consumer: ${delta} renders across ${FRAMES} publishes; latest len=${observedLen}`)
    expect(observedLen).toBe(FRAMES) // saw the last published array
    expect(delta).toBe(FRAMES) // re-rendered once per distinct publish
  })

  it('a useAudioLevels() consumer observes the latest published level and re-renders on publishes', async () => {
    // The waveform leaf calls useAudioLevels() (useSyncExternalStore over the
    // level store). It SHOULD re-render on each publish AND always read the freshest
    // payload — that's the one place level frames are allowed to land.
    let waveformRenders = 0
    const observed: { mic: number; sys: number } = { mic: -1, sys: -1 }
    function WaveformLeaf() {
      const { micLevel, systemLevel } = useAudioLevels()
      waveformRenders++
      observed.mic = micLevel
      observed.sys = systemLevel
      return null
    }

    await act(async () => {
      root.render(h(RecordingProvider, null, h(WaveformLeaf)))
    })
    const base = waveformRenders

    for (let i = 0; i < FRAMES; i++) {
      await act(async () => {
        pushMockLevel({ micLevel: i, systemLevel: i * 2, timestamp: i })
      })
    }

    const delta = waveformRenders - base
    console.log(`[bench] useAudioLevels consumer: ${delta} renders across ${FRAMES} publishes; latest=(${observed.mic}, ${observed.sys})`)
    // Observed the LAST published payload…
    expect(observed.mic).toBe(FRAMES - 1)
    expect(observed.sys).toBe((FRAMES - 1) * 2)
    // …and re-rendered on the publishes (one per distinct level frame).
    expect(delta).toBe(FRAMES)
  })
})

// ─────────────────────────────────────────────────────────────────
// GROWING FINALS (audit finding 7). The prior tests only ever pushed a CONSTANT
// final count; the in-meeting reality is a count that grows per finalized
// utterance, plus a speaker set that grows early then stabilizes, plus an
// activity feed that appends per live-agent tool call, plus a status that
// cycles per turn. This block pins the Wave-2 contract, written against the
// leaf hooks NOW: the growing signals flow ONLY through the ref-backed stores
// (the mock's deprecated context mirrors stay constant, exactly as Wave 2
// leaves them by deleting the fields), so a volatile-context consumer's render
// delta must stay 0 while the leaf consumers track every change.
// ─────────────────────────────────────────────────────────────────
describe('Growing finals / activity / status land on leaf stores, not the context', () => {
  let container: HTMLElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    resetMockStores()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  const FINALS = 30 // a growing per-utterance stream (vs the constant-count tests above)

  it('a growing final count re-renders ONLY the finals/speakers leaves; volatile consumer delta stays 0', async () => {
    let volatileRenders = 0
    function VolatileConsumer() {
      const ctx = useRecordingContext()
      // Touch context fields the capture panel reads. finalSegmentCount /
      // detectedSpeakers are NOT among them any more — they were removed from
      // the context value and live only in the leaf stores the two leaves
      // below subscribe to, which is exactly what this test proves.
      void ctx.isRecording
      void ctx.isPaused
      volatileRenders++
      return null
    }
    let countRenders = 0
    let observedCount = -1
    function FinalCountLeaf() {
      observedCount = useFinalSegmentCount()
      countRenders++
      return null
    }
    let speakersRenders = 0
    let observedSpeakers: string[] = []
    function SpeakersLeaf() {
      observedSpeakers = useDetectedSpeakers()
      speakersRenders++
      return null
    }

    await act(async () => {
      root.render(h(RecordingProvider, null, h(VolatileConsumer), h(FinalCountLeaf), h(SpeakersLeaf)))
    })
    const baseVolatile = volatileRenders
    const baseCount = countRenders
    const baseSpeakers = speakersRenders

    // One publish per new final, alternating mic/system so the speaker set
    // grows to [local_1, remote_1] after two finals and then stays stable.
    const finals: TranscriptSegment[] = []
    for (let i = 1; i <= FINALS; i++) {
      finals.push(makeFinal(i * 3, i % 2 === 1 ? 'mic' : 'system'))
      await act(async () => {
        pushMockFinalsTranscript([...finals])
      })
    }

    const volatileDelta = volatileRenders - baseVolatile
    const countDelta = countRenders - baseCount
    const speakersDelta = speakersRenders - baseSpeakers
    console.log(
      `[bench] growing finals ×${FINALS}: volatile consumer=${volatileDelta} renders (target 0), ` +
        `finals leaf=${countDelta}, speakers leaf=${speakersDelta}`,
    )

    // Leaf hooks tracked every change…
    expect(observedCount).toBe(FINALS)
    expect(countDelta).toBe(FINALS) // one render per new final
    expect(observedSpeakers).toEqual(['local_1', 'remote_1'])
    expect(speakersDelta).toBe(2) // local_1 appears, then remote_1 — then stable
    // …and the volatile context value kept identity throughout (the Wave-2
    // contract this bench pins: growing finals never re-render the panel).
    expect(volatileDelta).toBe(0)

    // Interim-flush republishes (same finals + a trailing interim, fresh array
    // identity each time — the ~150ms hot path) must wake NEITHER leaf, and the
    // speakers snapshot must keep its identity (getSnapshot-caching rule).
    const speakersIdentityBefore = observedSpeakers
    const countRendersBefore = countRenders
    const speakersRendersBefore = speakersRenders
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        pushMockFinalsTranscript([...finals, { ...makeFinal(999 + i), isFinal: false }])
      })
    }
    expect(countRenders).toBe(countRendersBefore)
    expect(speakersRenders).toBe(speakersRendersBefore)
    expect(observedSpeakers).toBe(speakersIdentityBefore)
    expect(volatileRenders - baseVolatile).toBe(0)
  })

  it('live-agent activity appends re-render ONLY the useAgentActivity leaf; volatile consumer delta stays 0', async () => {
    let volatileRenders = 0
    function VolatileConsumer() {
      const ctx = useRecordingContext()
      void ctx.isRecording
      // agentActivity is no longer a context field — only useAgentActivity()
      // sees the appends.
      void ctx.isPaused
      volatileRenders++
      return null
    }
    let leafRenders = 0
    let observedLen = -1
    function ActivityLeaf() {
      observedLen = useAgentActivity().length
      leafRenders++
      return null
    }

    await act(async () => {
      root.render(h(RecordingProvider, null, h(VolatileConsumer), h(ActivityLeaf)))
    })
    const baseVolatile = volatileRenders
    const baseLeaf = leafRenders

    const APPENDS = 10
    const events: AgentActivityEvent[] = []
    for (let i = 1; i <= APPENDS; i++) {
      events.push({
        id: `activity-${i}`,
        toolName: 'propose_change',
        args: { display_text: `item ${i}` },
        state: 'result',
        timestamp: i,
      })
      await act(async () => {
        pushMockActivity([...events])
      })
    }

    const volatileDelta = volatileRenders - baseVolatile
    const leafDelta = leafRenders - baseLeaf
    console.log(
      `[bench] activity appends ×${APPENDS}: volatile consumer=${volatileDelta} renders (target 0), leaf=${leafDelta}`,
    )
    expect(observedLen).toBe(APPENDS)
    expect(leafDelta).toBe(APPENDS)
    expect(volatileDelta).toBe(0)
  })

  it('useLiveAgentStatus observes the provider status path and skips duplicate publishes', async () => {
    // The status store lives in the PROVIDER (publishLiveAgentStatus), fed by
    // the exact change path production uses: the onLiveAgentStatusChange
    // callback the provider hands to useRecording. Drive it through the
    // captured options. The status is store-ONLY now — no state mirror and no
    // context field — so a transition re-renders neither the provider nor any
    // volatile consumer, only the subscribing leaf.
    let leafRenders = 0
    let observedStatus = ''
    function StatusLeaf() {
      observedStatus = useLiveAgentStatus()
      leafRenders++
      return null
    }

    await act(async () => {
      root.render(h(RecordingProvider, null, h(StatusLeaf)))
    })
    expect(observedStatus).toBe('idle')
    expect(lastRecordingOptions?.onLiveAgentStatusChange).toBeTypeOf('function')

    await act(async () => {
      lastRecordingOptions!.onLiveAgentStatusChange!('listening')
    })
    expect(observedStatus).toBe('listening')

    await act(async () => {
      lastRecordingOptions!.onLiveAgentStatusChange!('processing')
    })
    expect(observedStatus).toBe('processing')

    // Duplicate publish — the store notifies only on an actual change, so the
    // leaf must not re-render again.
    const rendersBeforeDuplicate = leafRenders
    await act(async () => {
      lastRecordingOptions!.onLiveAgentStatusChange!('processing')
    })
    expect(leafRenders).toBe(rendersBeforeDuplicate)
  })

  // The derived transcript leaves subscribe to the ~150ms segment store but
  // select a PRIMITIVE (who's talking; whether there's any transcript), so they
  // re-render only when that answer changes — Voice ID's speaker pills (each a
  // popover) and the shut Transcripts pill stop riding every interim flush.
  it('useLiveActiveSpeaker / useHasLiveTranscriptSegments re-render only when their answer changes', async () => {
    let speakerRenders = 0
    const speakerSeen: (string | null)[] = []
    function ActiveSpeakerLeaf() {
      speakerSeen.push(useLiveActiveSpeaker())
      speakerRenders++
      return null
    }
    let hasRenders = 0
    let observedHas: boolean | null = null
    function HasSegmentsLeaf() {
      observedHas = useHasLiveTranscriptSegments()
      hasRenders++
      return null
    }

    await act(async () => {
      root.render(h(RecordingProvider, null, h(ActiveSpeakerLeaf), h(HasSegmentsLeaf)))
    })
    expect(speakerSeen.at(-1)).toBeNull()
    expect(observedHas).toBe(false)
    const baseSpeaker = speakerRenders
    const baseHas = hasRenders

    const interim = (id: string, stream: 'mic' | 'system', text: string): TranscriptSegment => ({
      ...makeFinal(0, stream),
      id,
      text,
      isFinal: false,
    })
    const settledMic = makeFinal(0, 'mic') // local_1
    const settledSystem = makeFinal(3, 'system') // remote_1

    // local_1 starts talking: five flushes grow one forming line.
    for (let i = 1; i <= 5; i++) {
      await act(async () => { pushMockTranscript([interim('i-mic', 'mic', 'so'.repeat(i))]) })
    }
    expect(speakerSeen.at(-1)).toBe('local_1')
    expect(speakerRenders - baseSpeaker).toBe(1) // null → local_1, once
    expect(observedHas).toBe(true)
    expect(hasRenders - baseHas).toBe(1) // false → true, once

    // The line settles, still local_1's: nothing changes for either leaf.
    await act(async () => { pushMockTranscript([settledMic]) })
    expect(speakerRenders - baseSpeaker).toBe(1)

    // remote_1 cuts in (an interim, behind local_1's final) — the talker changes;
    // three more flushes of the same forming line change nothing.
    for (let i = 1; i <= 4; i++) {
      await act(async () => { pushMockTranscript([settledMic, interim('i-sys', 'system', 'ok'.repeat(i))]) })
    }
    expect(speakerSeen.at(-1)).toBe('remote_1')
    expect(speakerRenders - baseSpeaker).toBe(2)

    // remote_1's line settles (the latest final is theirs): no change.
    await act(async () => { pushMockTranscript([settledMic, settledSystem]) })
    expect(speakerRenders - baseSpeaker).toBe(2)

    // local_1 again, forming a new line.
    await act(async () => { pushMockTranscript([settledMic, settledSystem, interim('i-mic-2', 'mic', 'and')]) })
    expect(speakerSeen.at(-1)).toBe('local_1')
    expect(speakerRenders - baseSpeaker).toBe(3)

    // A new session clears the transcript: no talker, no transcript.
    await act(async () => { pushMockTranscript([]) })
    expect(speakerSeen.at(-1)).toBeNull()
    expect(observedHas).toBe(false)
    expect(speakerRenders - baseSpeaker).toBe(4)
    expect(hasRenders - baseHas).toBe(2)
  })

  it('auto-accept countdown ticks re-render ONLY the countdown leaf; volatile consumer delta stays 0', async () => {
    let volatileRenders = 0
    function VolatileConsumer() {
      const ctx = useRecordingContext()
      void ctx.speakerContacts
      volatileRenders++
      return null
    }
    const suggestion = {
      contactId: 'c-ada', contactName: 'Ada', confidence: 0.91, isAutoMatched: false,
      isSuggestion: true, trustTier: 'recognizing' as const, autoAcceptCountdown: 10,
    }
    const other = { ...suggestion, contactId: 'c-bo', contactName: 'Bo' }
    let leafRenders = 0
    let observed: number | undefined
    function CountdownLeaf() {
      observed = useAutoAcceptCountdown(suggestion)
      leafRenders++
      return null
    }

    await act(async () => {
      root.render(h(RecordingProvider, null, h(VolatileConsumer), h(CountdownLeaf)))
    })
    // No tick yet: the suggestion's own starting value.
    expect(observed).toBe(10)
    const baseVolatile = volatileRenders
    const baseLeaf = leafRenders

    const publishTick = (entry: object, remaining: number) => {
      autoAcceptTickStore.current.set(entry, remaining)
      autoAcceptTickStore.listeners.forEach((cb) => cb())
    }
    for (let remaining = 9; remaining >= 7; remaining--) {
      await act(async () => { publishTick(suggestion, remaining) })
    }
    expect(observed).toBe(7)
    expect(leafRenders - baseLeaf).toBe(3)
    // Another suggestion's tick doesn't move this chip's number.
    await act(async () => { publishTick(other, 4) })
    expect(observed).toBe(7)
    expect(leafRenders - baseLeaf).toBe(3)
    expect(volatileRenders - baseVolatile).toBe(0)
  })

  // Every leaf hook must return a STABLE reference for its empty/absent case.
  // useSyncExternalStore re-invokes getSnapshot during render and compares by
  // identity: a fresh {}/[] per call is an infinite render loop ("The result of
  // getSnapshot should be cached"), which React surfaces only under the exact
  // conditions this test creates — mounted OUTSIDE RecordingProvider, where the
  // `?? (() => FALLBACK)` arm is the getSnapshot. Rendering repeatedly proves
  // the loop settles rather than diverging.
  it('every leaf hook returns a stable empty snapshot outside the provider', async () => {
    const seen = {
      levels: [] as unknown[],
      segments: [] as unknown[],
      speakers: [] as unknown[],
      activity: [] as unknown[],
      counts: [] as number[],
      statuses: [] as string[],
      activeSpeakers: [] as (string | null)[],
      hasSegments: [] as boolean[],
    }
    let renders = 0
    function AllLeaves() {
      seen.levels.push(useAudioLevels())
      seen.segments.push(useTranscriptSegments())
      seen.speakers.push(useDetectedSpeakers())
      seen.activity.push(useAgentActivity())
      seen.counts.push(useFinalSegmentCount())
      seen.statuses.push(useLiveAgentStatus())
      seen.activeSpeakers.push(useLiveActiveSpeaker())
      seen.hasSegments.push(useHasLiveTranscriptSegments())
      renders++
      return null
    }

    // No RecordingProvider anywhere above — the fallback arms are live.
    await act(async () => { root.render(h(AllLeaves)) })
    await act(async () => { root.render(h('div', null, h(AllLeaves))) })
    await act(async () => { root.render(h(AllLeaves)) })

    // A diverging snapshot would blow the render budget long before this.
    expect(renders).toBeLessThan(20)
    // Every object-valued snapshot came back as the SAME module constant.
    expect(new Set(seen.levels).size).toBe(1)
    expect(new Set(seen.segments).size).toBe(1)
    expect(new Set(seen.speakers).size).toBe(1)
    expect(new Set(seen.activity).size).toBe(1)
    // …and the primitive ones are the documented zero values.
    expect(new Set(seen.counts)).toEqual(new Set([0]))
    expect(new Set(seen.statuses)).toEqual(new Set(['idle']))
    expect(new Set(seen.activeSpeakers)).toEqual(new Set([null]))
    expect(new Set(seen.hasSegments)).toEqual(new Set([false]))
  })
})
