// @vitest-environment jsdom
/**
 * Enrollment flow — the processing / consistency / POST machinery.
 *
 * The existing flow test locks the intro + mic-check + thin-audio gating. This
 * file drives ALL THREE passages to completion with a mocked chunker + embedder,
 * then exercises the submit path's guards, which the review found broken:
 *
 *   • per-passage chunk cap + a defensive clamp to the route MAX (no volume 400);
 *   • the consistency outlier is deleted/re-read by passage KEY, not by a
 *     positional Map-values index (so a re-read can't delete the GOOD passage);
 *   • a consistency failure with NO identifiable outlier NEVER POSTs — it shows a
 *     hard failure state with Start over / Try again later;
 *   • consistency re-reads are capped (they count toward PASSAGE_MAX_RETRIES), so
 *     an unmatchable passage can't loop forever;
 *   • the bounce reason survives the passage-mount effect and renders on paint;
 *   • auto-advance does NOT fire on a passage mount carrying the prior passage's
 *     stale voiced-seconds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

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

// ── Controllable recorder mock (faithful reset semantics) ───────
const rec = vi.hoisted(() => ({
  level: 0,
  recording: false,
  error: null as string | null,
  speechDetected: false,
  passageVoicedSeconds: 0,
  passageSampleCount: 0,
  start: vi.fn(async () => true),
  stop: vi.fn(),
  measureNoiseFloor: vi.fn(() => 0.005),
  beginPassage: vi.fn(() => {
    rec.passageVoicedSeconds = 0
    rec.passageSampleCount = 0
  }),
  // Empty snapshot → the incremental effect no-ops (0 new chunks), so the whole
  // passage is finalized as the tail on Continue. This keeps the submit-path
  // assertions (chunk counts / sessionIds) identical while exercising the merge.
  snapshotPassageAudio: vi.fn(() => new Float32Array(0)),
  // Non-empty so the (mocked) chunker path is exercised at finalize.
  endPassage: vi.fn(() => new Float32Array(48000)),
  clearError: vi.fn(),
}))
vi.mock('@/components/voice-enrollment/use-voice-recorder', () => ({
  useVoiceRecorder: () => rec,
}))

// ── Chunker mock — controllable chunk count. `checkConsistency` defaults to the
//    REAL implementation (so the positional outlierIndex it returns is genuinely
//    tied to the prototypes it sees — the perfect test for the KEY-mapping fix),
//    but a test can override `consistencyOverride` to pin an exact result. ──
const chunker = vi.hoisted(() => ({
  chunksPerPassage: 10,
  consistencyOverride: null as
    | null
    | ((protos: number[][]) => { ok: boolean; minPairwise: number; outlierIndex: number | null }),
}))
vi.mock('@/lib/voice-profile/chunker', async () => {
  const actual = await vi.importActual<typeof import('@/lib/voice-profile/chunker')>(
    '@/lib/voice-profile/chunker',
  )
  return {
    ...actual,
    chunkPassageAudio: () =>
      Array.from({ length: chunker.chunksPerPassage }, (_v, i) => ({
        audio: new Float32Array(48000),
        quality: 0.7 + i * 0.001,
        durationScore: 1,
        levelScore: 1,
        snrScore: 1,
        startSample: i * 48000,
        endSample: (i + 1) * 48000,
      })),
    // Incremental path: the recorder's snapshot is empty in this suite, so no new
    // chunks are ever available mid-recording — the whole passage is finalized as
    // the tail on Continue. (The incremental accrual is covered by its own test.)
    chunkPassageAudioFrom: () => ({ chunks: [], nextOffset: 0 }),
    voicedSeconds: (chunks: unknown[]) => chunks.length * 3,
    checkConsistency: (protos: number[][]) =>
      chunker.consistencyOverride
        ? chunker.consistencyOverride(protos)
        : actual.checkConsistency(protos),
  }
})

// ── Embedder: per-passage embedding DIRECTION drives real consistency.
//    `dir` is the dominant dimension index for the current passage's vectors;
//    passages that share a direction are consistent, a different direction is an
//    outlier under the real cosine check. ──
const embed = vi.hoisted(() => ({ dir: 0 }))
vi.mock('@/lib/voice-profile/enrollment-embedder', () => ({
  EnrollmentEmbedder: class {
    load() {
      return Promise.resolve()
    }
    embed() {
      const v = new Array(512).fill(0.001)
      v[embed.dir] = 1 // dominant direction → near-orthogonal across directions
      return Promise.resolve(v)
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
  rec.start.mockClear()
  rec.beginPassage.mockClear()
  rec.snapshotPassageAudio.mockClear()
  rec.snapshotPassageAudio.mockReturnValue(new Float32Array(0))
  rec.endPassage.mockClear()
  rec.endPassage.mockReturnValue(new Float32Array(48000))
  chunker.chunksPerPassage = 10
  chunker.consistencyOverride = null
  embed.dir = 0
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

/** Drive intro → mic-check → passage-1. */
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

/** Complete the CURRENTLY-mounted passage by arming then crossing the gate. */
async function completePassage() {
  // Arm: a fresh sub-target reading for this step (mount reset it to 0).
  rec.passageVoicedSeconds = 2
  rerender()
  await flush()
  // Cross the gate → auto-advance runs the mocked chunk+embed and advances.
  rec.passageVoicedSeconds = 16
  rerender()
  await flush()
  await flush()
}

/** Drive all three passages to completion, landing on processing. `dirs` is the
 *  dominant embedding direction per passage (same direction ⇒ consistent). */
async function driveAllPassages(dirs: [number, number, number] = [0, 0, 0]) {
  await reachPassage1()
  embed.dir = dirs[0]
  await completePassage() // → passage-2
  expect(text()).toContain('mango smoothies')
  embed.dir = dirs[1]
  await completePassage() // → passage-3
  expect(text()).toContain('vote was unanimous')
  embed.dir = dirs[2]
  await completePassage() // → processing → submit
  await flush()
}

describe('VoiceEnrollmentFlow — consistent profile POST', () => {
  it('POSTs EVERY quality-accepted chunk (no per-passage downsample) and lands on done', async () => {
    await driveAllPassages()
    expect(text()).toMatch(/knows your voice|Native Intelligence knows/i)

    const postCall = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/account/voice-profile' && c[1]?.method === 'POST',
    )
    expect(postCall).toBeTruthy()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    // 3 passages × 10 chunks = 30 raw. Self-enrollment stores ALL of them (no
    // per-passage cap), and 30 is well under the shared max (60), so the whole
    // set survives to the body — accuracy over payload thrift.
    expect(body.chunks.length).toBe(30)
    // More than 8 chunks per passage survive intact — the old CRM-inherited
    // per-passage cap (8) is gone. Each of the 3 sessions carries all 10 chunks.
    const bySession = new Map<string, number>()
    for (const c of body.chunks as { sessionId: string }[]) {
      bySession.set(c.sessionId, (bySession.get(c.sessionId) ?? 0) + 1)
    }
    expect(bySession.size).toBe(3)
    for (const count of bySession.values()) {
      expect(count).toBe(10)
      expect(count).toBeGreaterThan(8)
    }
    // Every chunk carries its real per-chunk quality (not the 0.5 fallback) —
    // the 1:1 embedding↔chunk pairing flows quality straight through.
    expect(body.chunks.every((c: { quality: number }) => c.quality >= 0.7)).toBe(true)
    expect(refreshFn).toHaveBeenCalled()
  })

  it('defensively subsamples only a pathological over-long take down to the shared max (never 400)', async () => {
    // Huge per-passage chunk counts (3 × 40 = 120 raw) exceed the shared max
    // (60). The flow evenly subsamples ONLY then — down to exactly the cap — so
    // a good read can never 400 on volume, while a normal read is untouched.
    chunker.chunksPerPassage = 40
    await driveAllPassages()
    const postCall = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/account/voice-profile' && c[1]?.method === 'POST',
    )
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.chunks.length).toBe(60)
  })
})

describe('VoiceEnrollmentFlow — consistency outlier bounce', () => {
  it('re-reads the outlier passage by KEY (real check), shows the reason, then POSTs on a clean re-read', async () => {
    // Passages 0 and 2 share a direction; passage 1 (passage-2) is the outlier.
    // The REAL consistency check flags position 1, which must map to KEY 1 →
    // passage-2. (The pre-fix bug indexed the Map-values array by that position,
    // deleting a GOOD passage once insertion order diverged from key order.)
    await driveAllPassages([0, 5, 0])

    // Bounced to passage-2 with the reason carried across the transition (it
    // must survive the passage-mount effect that would otherwise wipe it).
    expect(text()).toContain('mango smoothies')
    expect(text()).toContain('didn’t match the others')
    // No POST on the inconsistent take.
    expect(
      fetchMock.mock.calls.some((c) => c[0] === '/api/account/voice-profile'),
    ).toBe(false)

    // Re-read passage-2 in the SAME direction as 0/2 → consistent → POST + done.
    embed.dir = 0
    await completePassage()
    await flush()
    expect(text()).toMatch(/knows your voice|Native Intelligence knows/i)
    const postCall = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/account/voice-profile' && c[1]?.method === 'POST',
    )
    expect(postCall).toBeTruthy()
    // Passage 0 and 2 (the GOOD passages) survived — 3 sessions in the body, not
    // 2 (which is what deleting the wrong passage would have produced).
    const body = JSON.parse((postCall![1] as { body: string }).body)
    const sessions = new Set(body.chunks.map((c: { sessionId: string }) => c.sessionId))
    expect(sessions.size).toBe(3)
  })
})

describe('VoiceEnrollmentFlow — consistency failure guard', () => {
  it('never POSTs when consistency fails with no identifiable outlier; offers Start over', async () => {
    // The failure has NO recoverable outlier (e.g. exactly 2 usable passages).
    chunker.consistencyOverride = () => ({ ok: false, minPairwise: 0.4, outlierIndex: null })
    await driveAllPassages()

    expect(text()).toContain('didn’t match up')
    expect(findCTA(/start over/i)).toBeTruthy()
    expect(findCTA(/try again later/i)).toBeTruthy()
    // The whole point of the guard: a two-voice profile is NEVER stored.
    expect(
      fetchMock.mock.calls.some((c) => c[0] === '/api/account/voice-profile'),
    ).toBe(false)

    // Start over resets cleanly back to passage 1.
    const startOver = findCTA(/start over/i)
    await act(async () => {
      startOver!.click()
      await Promise.resolve()
    })
    await flush()
    expect(text()).toContain('octopus named Pixel')
  })

  it('caps consistency re-reads and falls to the failure state instead of looping', async () => {
    // Pin the SAME passage KEY as the outlier on every check: index-0 in the
    // current entries order. Because the flow re-reads by KEY and re-inserts, the
    // Map order shifts — so "always position 0" keeps flagging whatever passage
    // sits first, and each bounce for a given passage counts toward
    // PASSAGE_MAX_RETRIES. After the cap it must STOP bouncing (no infinite loop).
    chunker.consistencyOverride = () => ({ ok: false, minPairwise: 0.4, outlierIndex: 0 })
    await driveAllPassages()

    // It keeps bouncing back to a passage; re-read each time. It must terminate
    // in a bounded number of steps rather than loop forever.
    let landedOnFailure = false
    for (let i = 0; i < 12; i++) {
      if (text().includes('didn’t match up')) {
        landedOnFailure = true
        break
      }
      // A passage is on screen — re-read it to send it back to processing.
      expect(text()).toMatch(/octopus named Pixel|mango smoothies|vote was unanimous/)
      await completePassage()
      await flush()
    }

    expect(landedOnFailure).toBe(true)
    // Never POSTed a known-inconsistent profile.
    expect(
      fetchMock.mock.calls.some((c) => c[0] === '/api/account/voice-profile'),
    ).toBe(false)
  })
})

describe('VoiceEnrollmentFlow — no spurious mount-time auto-advance', () => {
  it('does not consume a passage on mount from the prior passage’s stale voiced-seconds', async () => {
    await reachPassage1()
    // Complete passage-1 at a high voiced count so the prior total is stale-high.
    embed.dir = 0
    await completePassage() // → passage-2
    expect(text()).toContain('mango smoothies')

    // Passage-2 just mounted. beginPassage reset the tally, but simulate the
    // stale frame: force voicedSecs high WITHOUT ever arming a sub-target
    // reading for passage-2. The armed-step guard must refuse to auto-advance.
    rec.passageVoicedSeconds = 20
    rerender()
    await flush()
    await flush()
    // Still on passage-2 — no stale-driven auto-advance to passage-3.
    expect(text()).toContain('mango smoothies')
    expect(text()).not.toContain('vote was unanimous')
  })
})
