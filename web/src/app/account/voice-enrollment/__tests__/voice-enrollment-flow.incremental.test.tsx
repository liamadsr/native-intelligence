// @vitest-environment jsdom
/**
 * Enrollment flow — INCREMENTAL embedding during recording.
 *
 * The founder-reported bug: clicking Continue chunked the WHOLE passage and
 * serially embedded every chunk ON THE CLICK, freezing for 2–8s. The fix embeds
 * incrementally as audio accrues, so Continue only finalizes a tiny tail.
 *
 * These tests use the REAL chunker (so the real offset-aware
 * `chunkPassageAudioFrom` runs) and a recorder mock that hands back a GROWING
 * audio buffer as `passageSampleCount` ticks. The embedder mock records every
 * embed call with the phase it happened in (recording vs. finalize) so we can
 * assert:
 *   (a) chunks are embedded DURING accrual, and on Continue only the tail is;
 *   (b) offset correctness — no region is embedded twice across flushes;
 *   (c) Continue renders the pending ("Locking that in…") state;
 *   (d) a re-read discards the prior passage's incremental accumulation;
 *   (e) a background-embed failure falls back to finalize-time embedding.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { CHUNK_SAMPLE_RATE } from '../../../../lib/voice-profile/chunker'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('framer-motion', () => {
  const React = require('react')
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        function MotionStub(props: Record<string, unknown>) {
          const { initial, animate, exit, transition, ...rest } = props as Record<string, unknown>
          void initial
          void animate
          void exit
          void transition
          return React.createElement(tag, rest)
        },
    },
  )
  return {
    motion,
    AnimatePresence: ({ children }: { children: unknown }) =>
      React.createElement(React.Fragment, null, children),
  }
})

// ── Recorder mock: a growing loud-tone buffer. `snapshotPassageAudio` returns
//    the first `sampleCursor` samples of a long loud tone; the flow chunks the
//    NEW region past its consumed offset each time the sample count ticks. ──
const LOUD = (() => {
  // 60s of loud clean tone. A slow amplitude drift (well within loud/voiced)
  // makes each 3s window's content distinct so a chunk can be fingerprinted —
  // a pure periodic tone would make every chunk byte-identical.
  const n = 60 * CHUNK_SAMPLE_RATE
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const drift = 0.16 + 0.04 * Math.sin((2 * Math.PI * i) / n) // 0.12..0.20
    out[i] = drift * Math.sin((2 * Math.PI * 200 * i) / CHUNK_SAMPLE_RATE)
  }
  return out
})()

/** A stable fingerprint of a chunk's audio content — distinct per 3s window of
 *  the drifting tone, so duplicate embeds of the same region are detectable. */
function fingerprint(audio: Float32Array): number {
  let acc = 0
  const step = Math.max(1, Math.floor(audio.length / 64))
  for (let i = 0; i < audio.length; i += step) acc += Math.abs(audio[i])
  return Math.round(acc * 1e3)
}

const rec = vi.hoisted(() => ({
  level: 0,
  recording: false,
  error: null as string | null,
  speechDetected: false,
  passageVoicedSeconds: 0,
  passageSampleCount: 0,
  // How many samples of the loud tone are "captured so far".
  sampleCursor: 0,
  start: vi.fn(async () => true),
  stop: vi.fn(),
  measureNoiseFloor: vi.fn(() => 0.003),
  beginPassage: vi.fn(() => {
    rec.passageVoicedSeconds = 0
    rec.passageSampleCount = 0
    rec.sampleCursor = 0
  }),
  snapshotPassageAudio: vi.fn(() => new Float32Array(0)),
  endPassage: vi.fn(() => new Float32Array(0)),
  clearError: vi.fn(),
}))
// Snapshot / endPassage return the first `sampleCursor` samples of the tone.
rec.snapshotPassageAudio.mockImplementation(() => LOUD.subarray(0, rec.sampleCursor).slice())
rec.endPassage.mockImplementation(() => {
  const out = LOUD.subarray(0, rec.sampleCursor).slice()
  return out
})

vi.mock('@/components/voice-enrollment/use-voice-recorder', () => ({
  useVoiceRecorder: () => rec,
}))

// ── Embedder mock: records each embed with the current phase + the chunk's
//    identifying first sample so we can prove no region is embedded twice. Fails
//    on demand to exercise the finalize fallback. ──
const embed = vi.hoisted(() => ({
  phase: 'recording' as string,
  records: [] as { phase: string; firstSample: number }[],
  failNext: 0, // how many upcoming embeds should throw
  calls: 0,
  hold: null as Promise<void> | null, // when set, embeds await it (pending-state test)
}))
vi.mock('@/lib/voice-profile/enrollment-embedder', () => ({
  EnrollmentEmbedder: class {
    load() {
      return Promise.resolve()
    }
    async embed(audio: Float32Array) {
      embed.calls++
      // Fingerprint the chunk's content so a re-embedded region is detectable.
      const firstSample = fingerprint(audio)
      embed.records.push({ phase: embed.phase, firstSample })
      if (embed.failNext > 0) {
        embed.failNext--
        throw new Error('embed boom')
      }
      if (embed.hold) await embed.hold
      const v = new Array(512).fill(0.001)
      v[0] = 1
      return v
    }
    terminate() {}
  },
}))

vi.mock('@/components/celebration/celebrate', () => ({ celebrate: vi.fn() }))
vi.mock('@/components/celebration/celebration-overlay', () => ({
  CelebrationOverlay: () => null,
}))
const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
const refreshFn = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-voice-profile', () => ({
  useVoiceProfile: () => ({ status: null, loading: false, refresh: refreshFn }),
}))

import { VoiceEnrollmentFlow } from '../voice-enrollment-flow'

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}
function text() {
  return container.textContent || ''
}
function rerender() {
  act(() => root.render(h(VoiceEnrollmentFlow)))
}
function findCTA(re: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => re.test(b.textContent || '')) as
    | HTMLButtonElement
    | undefined
}

beforeEach(() => {
  rec.level = 0
  rec.recording = false
  rec.error = null
  rec.speechDetected = false
  rec.passageVoicedSeconds = 0
  rec.passageSampleCount = 0
  rec.sampleCursor = 0
  rec.start.mockClear()
  rec.beginPassage.mockClear()
  rec.snapshotPassageAudio.mockClear()
  rec.endPassage.mockClear()
  embed.phase = 'recording'
  embed.records = []
  embed.failNext = 0
  embed.calls = 0
  embed.hold = null
  router.push.mockReset()
  router.back.mockReset()
  refreshFn.mockReset()
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function reachPassage1() {
  act(() => root.render(h(VoiceEnrollmentFlow)))
  await flush()
  const go = findCTA(/let’s do it|let's do it/i)
  await act(async () => {
    go!.click()
    await Promise.resolve()
  })
  await flush()
  rec.recording = true
  rec.speechDetected = true
  rerender()
  await flush()
  expect(text()).toContain('octopus named Pixel')
}

/** Simulate audio accruing: advance the cursor to `seconds`, publish the sample
 *  count, and let the incremental effect run a chunk+embed pass. */
async function accrueTo(seconds: number) {
  rec.sampleCursor = Math.floor(seconds * CHUNK_SAMPLE_RATE)
  rec.passageSampleCount = rec.sampleCursor
  rec.passageVoicedSeconds = Math.min(seconds, 20)
  rerender()
  await flush()
}

describe('VoiceEnrollmentFlow — incremental embedding during recording', () => {
  it('embeds chunks WHILE recording, and on Continue only embeds the tail', async () => {
    await reachPassage1()

    // Arm the auto-advance gate below target, then accrue audio in flushes. Each
    // flush past a new 3s window should embed the newly-stable chunks in the
    // background — BEFORE any Continue click.
    embed.phase = 'recording'
    rec.passageVoicedSeconds = 2 // arm the auto-advance step guard
    rerender()
    await flush()

    await accrueTo(3.5) // ~1 full chunk stable
    await accrueTo(7) //   ~2 full chunks stable total
    await accrueTo(10.5) // ~3 full chunks stable total

    const embeddedWhileRecording = embed.records.filter((r) => r.phase === 'recording').length
    // The incremental path embedded during accrual (not zero, and not the whole
    // passage — only the stable full windows so far).
    expect(embeddedWhileRecording).toBeGreaterThanOrEqual(2)

    // Now cross the auto-advance gate. Continue finalizes the TAIL only.
    embed.phase = 'finalize'
    const beforeFinalize = embed.records.length
    rec.passageVoicedSeconds = 16
    rec.sampleCursor = Math.floor(11 * CHUNK_SAMPLE_RATE) // a bit more audio for the tail
    rec.passageSampleCount = rec.sampleCursor
    rerender()
    await flush()
    await flush()

    // Advanced to passage 2 (or at least left passage 1).
    const finalizeEmbeds = embed.records.slice(beforeFinalize).filter((r) => r.phase === 'finalize')
    // The tail is SMALL — far fewer than the incremental chunks. The whole point:
    // Continue did not re-embed the entire passage.
    expect(finalizeEmbeds.length).toBeLessThan(embeddedWhileRecording)
  })

  it('never embeds the same region twice across incremental flushes (offset correctness)', async () => {
    await reachPassage1()
    embed.phase = 'recording'
    rec.passageVoicedSeconds = 2
    rerender()
    await flush()

    // Accrue in several overlapping snapshots — each snapshot INCLUDES all prior
    // audio, so a naive re-scan would re-embed earlier chunks. The offset guard
    // must ensure each region is embedded exactly once.
    await accrueTo(3.5)
    await accrueTo(6.5)
    await accrueTo(9.5)
    await accrueTo(12.5)

    const firstSamples = embed.records.map((r) => r.firstSample)
    const unique = new Set(firstSamples)
    // Every embed corresponds to a distinct chunk region — no duplicates.
    expect(unique.size).toBe(firstSamples.length)
  })

  it('renders the pending ("Locking that in…") state on Continue', async () => {
    await reachPassage1()
    embed.phase = 'recording'
    rec.passageVoicedSeconds = 2
    rerender()
    await flush()
    await accrueTo(9) // embed a few chunks incrementally

    // Hold the finalize (tail) embed open so the pending state is observable: the
    // gate handler `embed.hold` blocks the embed until we release it.
    let release: () => void = () => {}
    embed.hold = new Promise<void>((r) => {
      release = r
    })
    embed.phase = 'finalize'

    // Give the tail a chunk to embed so finalize actually awaits the held embed,
    // then cross the auto-advance gate. advancePassage runs, sets `advancing`
    // true, and parks on the held tail embed — so the pending state is visible.
    rec.sampleCursor = Math.floor(12 * CHUNK_SAMPLE_RATE)
    rec.passageSampleCount = rec.sampleCursor
    rec.passageVoicedSeconds = 16
    await act(async () => {
      rerender()
      await Promise.resolve()
    })

    // The Continue button shows the pending label and is disabled while the tail
    // embed is held open.
    const pending = findCTA(/locking that in/i)
    expect(pending).toBeTruthy()
    expect(pending!.disabled).toBe(true)

    // Release the embed → finalize completes → advances off passage 1.
    release()
    await flush()
    await flush()
    expect(text()).toContain('mango smoothies')
  })

  it('re-read discards the prior passage’s incremental accumulation', async () => {
    await reachPassage1()
    embed.phase = 'recording'
    rec.passageVoicedSeconds = 2
    rerender()
    await flush()
    await accrueTo(9) // embed a few chunks into passage 1's accumulator

    const beforeReRead = embed.records.filter((r) => r.phase === 'recording').length
    expect(beforeReRead).toBeGreaterThanOrEqual(1)

    // Force a thin-take failure: endPassage returns almost nothing so finalize
    // yields < PASSAGE_MIN_CHUNKS and the passage re-reads. Crossing the gate with
    // a tiny buffer triggers the failure → resetPassageAccumulation.
    rec.endPassage.mockReturnValueOnce(new Float32Array(0))
    // Also make the accumulator irrelevant by draining the snapshot for finalize:
    rec.sampleCursor = 0
    embed.phase = 'finalize'
    rec.passageVoicedSeconds = 16
    rerender()
    await flush()
    await flush()

    // Still on passage 1 (re-read), and a fresh accrual embeds again from scratch
    // — the accumulator was reset (new generation), so the region is re-chunked.
    expect(text()).toContain('octopus named Pixel')
    embed.phase = 'rescan'
    await accrueTo(9)
    const rescan = embed.records.filter((r) => r.phase === 'rescan').length
    expect(rescan).toBeGreaterThanOrEqual(1)
  })

  it('background-embed failure falls back to finalize-time embedding (offset not advanced)', async () => {
    await reachPassage1()
    // Every background embed FAILS during recording — so the offset never advances
    // and nothing is accumulated. Finalize must then re-chunk+embed the whole
    // passage (the old path), so the take still succeeds.
    embed.phase = 'recording'
    embed.failNext = 1000 // fail all background embeds
    rec.passageVoicedSeconds = 2
    rerender()
    await flush()
    await accrueTo(9)
    await accrueTo(18)

    // Background failures accumulated nothing (all threw).
    const recordingRecs = embed.records.filter((r) => r.phase === 'recording')
    expect(recordingRecs.length).toBeGreaterThan(0) // it tried

    // Now finalize succeeds: embeds work again, and the tail = the whole passage
    // (offset never advanced), so the take clears PASSAGE_MIN_CHUNKS and advances.
    embed.failNext = 0
    embed.phase = 'finalize'
    rec.sampleCursor = Math.floor(18 * CHUNK_SAMPLE_RATE)
    rec.passageSampleCount = rec.sampleCursor
    rec.passageVoicedSeconds = 16
    rerender()
    await flush()
    await flush()

    const finalizeRecs = embed.records.filter((r) => r.phase === 'finalize')
    // Finalize embedded the full passage (many chunks), proving the fallback.
    expect(finalizeRecs.length).toBeGreaterThanOrEqual(4)
    // Advanced off passage 1 — the take succeeded despite the background failures.
    expect(text()).toContain('mango smoothies')
  })
})
