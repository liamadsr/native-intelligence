/**
 * Worker lifecycle contract for VoiceIdService (src/lib/voice-id-service.ts).
 *
 * stop() used to hand its worker back to a static pool, so the ~100MB WavLM
 * model stayed resident for the life of the WebContent process after the first
 * recording. It now terminates. The trap this locks in: a terminated Worker
 * object silently no-ops every postMessage, so if any static (preloadedWorker /
 * preloadComplete / preloadPromise) were left pointing at the dead worker, the
 * NEXT initialize() would claim it and produce a service that never embeds
 * anything and never errors. These tests assert the second initialize()
 * constructs a genuinely NEW worker and never posts to the terminated one.
 *
 * The other half of the contract: stop() can land while initialize() is still
 * awaiting the preload (this.worker is null then, so stop() has nothing to
 * terminate). initialize() must notice the stop and terminate the worker it
 * was about to claim — otherwise the abort leaks exactly the ~100MB worker
 * this change exists to release.
 *
 * A fake Worker is required: jsdom/node implement none, and we must not load
 * @huggingface/transformers in a unit test. The fake answers a 'load' message
 * with a 'loaded' response, which is all preloadModel() waits on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { VoiceIdService } from '@/lib/voice-id-service'

/** Minimal stand-in for the real embedding worker. */
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  posted: unknown[] = []
  terminated = false
  /** Messages posted AFTER terminate() — must always be empty. */
  postedAfterTerminate: unknown[] = []

  /**
   * When true the worker does NOT auto-answer 'load'. The test fires the
   * 'loaded' reply by hand via finishLoad(), which is how the
   * stop()-during-an-in-flight-initialize() window is reproduced.
   */
  static manualLoad = false

  constructor(public url: unknown, public options?: unknown) {
    FakeWorker.instances.push(this)
  }

  postMessage(msg: unknown): void {
    if (this.terminated) {
      this.postedAfterTerminate.push(msg)
      return
    }
    this.posted.push(msg)
    // The real worker answers 'load' with 'loaded' once the model is ready.
    if ((msg as { type?: string })?.type === 'load' && !FakeWorker.manualLoad) {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'loaded' } }))
    }
  }

  /** Fire the deferred 'loaded' reply (manualLoad mode). */
  finishLoad(): void {
    this.onmessage?.({ data: { type: 'loaded' } })
  }

  terminate(): void {
    this.terminated = true
  }
}

/** Reach the private worker handle + the statics through a cast. */
interface Internals {
  worker: Worker | null
  modelLoaded: boolean
}
function internals(svc: VoiceIdService): Internals {
  return svc as unknown as Internals
}

interface Statics {
  preloadedWorker: Worker | null
  preloadComplete: boolean
  preloadPromise: Promise<void> | null
}
function statics(): Statics {
  return VoiceIdService as unknown as Statics
}

/** Reset the module-level preload latches between tests. */
function resetStatics() {
  const s = statics()
  s.preloadedWorker = null
  s.preloadComplete = false
  s.preloadPromise = null
}

describe('VoiceIdService worker lifecycle (terminate, never pool)', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    FakeWorker.manualLoad = false
    resetStatics()
    vi.stubGlobal('Worker', FakeWorker)
    // preloadModel()/initialize() log progress; keep the run quiet.
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetStatics()
  })

  it('initialize() spawns exactly one worker and claims it off the static slot', async () => {
    const svc = new VoiceIdService()
    await svc.initialize()

    expect(FakeWorker.instances).toHaveLength(1)
    expect(internals(svc).worker).toBe(FakeWorker.instances[0])
    expect(internals(svc).modelLoaded).toBe(true)
    // The worker got a 'load' message and was handed off, not left in the slot.
    expect(FakeWorker.instances[0].posted).toEqual([{ type: 'load' }])
    expect(statics().preloadedWorker).toBeNull()
  })

  it('stop() terminates the worker and nulls the handle', async () => {
    const svc = new VoiceIdService()
    await svc.initialize()
    const worker = FakeWorker.instances[0]

    svc.stop()

    expect(worker.terminated).toBe(true)
    expect(internals(svc).worker).toBeNull()
    expect(internals(svc).modelLoaded).toBe(false)
    // No static may point at a terminated worker.
    expect(statics().preloadedWorker).toBeNull()
    expect(statics().preloadComplete).toBe(false)
    expect(statics().preloadPromise).toBeNull()
  })

  it('a second initialize() after stop() builds a NEW worker and never posts to the dead one', async () => {
    const first = new VoiceIdService()
    await first.initialize()
    const deadWorker = FakeWorker.instances[0]
    first.stop()

    const second = new VoiceIdService()
    await second.initialize()

    // Constructor call count 2 — the terminated handle was not reused.
    expect(FakeWorker.instances).toHaveLength(2)
    const liveWorker = FakeWorker.instances[1]
    expect(liveWorker).not.toBe(deadWorker)
    expect(internals(second).worker).toBe(liveWorker)
    expect(liveWorker.terminated).toBe(false)

    // Nothing was posted to the terminated worker after stop().
    expect(deadWorker.postedAfterTerminate).toEqual([])
    expect(deadWorker.posted).toEqual([{ type: 'load' }])

    second.stop()
    expect(liveWorker.terminated).toBe(true)
  })

  it('stop() is safe on a service that never initialized (failed-start path)', () => {
    const svc = new VoiceIdService()

    expect(() => svc.stop()).not.toThrow()
    expect(FakeWorker.instances).toHaveLength(0)
    expect(internals(svc).worker).toBeNull()
  })

  it('stop() leaves NO live worker parked in the static slot', async () => {
    // Nothing outside VoiceIdService parks a worker (preloadModel has zero
    // external callers now that the mount-time preload is gone), so the slot
    // is only ever the hand-off for a preload initialize() itself kicked off.
    // A worker still sitting there when stop() runs would be an orphan with no
    // handle: stop() must terminate it, not leave it resident.
    const first = new VoiceIdService()
    await first.initialize()

    // Simulate the only way a worker can end up parked: a preload that
    // resolved without an initialize() claiming it.
    await VoiceIdService.preloadModel()
    const parked = statics().preloadedWorker as unknown as FakeWorker | null
    expect(parked).not.toBeNull()

    first.stop()

    expect(parked!.terminated).toBe(true)
    expect(statics().preloadedWorker).toBeNull()
    expect(statics().preloadComplete).toBe(false)
    expect(statics().preloadPromise).toBeNull()
  })

  it('stop() during an IN-FLIGHT initialize() terminates the worker instead of orphaning it', async () => {
    // The leak: stop() runs while initialize() is still awaiting the preload,
    // so this.worker is still null and the old stop() was a complete no-op.
    // The late-resolving initialize() then claimed the freshly loaded worker
    // onto the already-stopped service — a live ~100MB worker with no handle.
    FakeWorker.manualLoad = true

    const svc = new VoiceIdService()
    const initPromise = svc.initialize()
    // Let initialize() reach its `await VoiceIdService.preloadPromise`.
    await Promise.resolve()

    const worker = FakeWorker.instances[0]
    expect(worker).toBeDefined()
    expect(worker.terminated).toBe(false)

    // User aborts before the model finishes loading.
    svc.stop()
    expect(internals(svc).worker).toBeNull()

    // The model finishes loading AFTER the stop.
    worker.finishLoad()
    await expect(initPromise).rejects.toThrow(/stopped/i)

    // The worker must be dead, and no static may point at it.
    expect(worker.terminated).toBe(true)
    expect(internals(svc).worker).toBeNull()
    expect(internals(svc).modelLoaded).toBe(false)
    expect(statics().preloadedWorker).toBeNull()
    expect(statics().preloadComplete).toBe(false)
    expect(statics().preloadPromise).toBeNull()

    // And a fresh service still gets a genuinely new worker afterwards.
    FakeWorker.manualLoad = false
    const next = new VoiceIdService()
    await next.initialize()
    expect(FakeWorker.instances).toHaveLength(2)
    expect(internals(next).worker).toBe(FakeWorker.instances[1])
    next.stop()
  })
})

describe('VoiceIdService mount-time preload is gone', () => {
  it('constructing a service does not create a worker', () => {
    FakeWorker.instances = []
    resetStatics()
    vi.stubGlobal('Worker', FakeWorker)
    try {
      new VoiceIdService()
      expect(FakeWorker.instances).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
      resetStatics()
    }
  })
})
