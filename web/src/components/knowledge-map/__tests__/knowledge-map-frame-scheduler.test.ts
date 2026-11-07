import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FpsMeter, FrameScheduler, IDLE_GAP_MS, SettleTimer } from '../frame-scheduler'

/**
 * A fake rAF whose frames only run when the test says so — the only way to
 * assert "nothing was scheduled", which is the property the whole
 * render-on-demand design rests on.
 */
function makeFakeRaf() {
  let next = 1
  const pending = new Map<number, (now: number) => void>()
  return {
    raf: (cb: (now: number) => void) => {
      const handle = next++
      pending.set(handle, cb)
      return handle
    },
    caf: (handle: number) => {
      pending.delete(handle)
    },
    get pendingCount() {
      return pending.size
    },
    /** Run every currently pending callback once. */
    flush(now = 0) {
      const callbacks = [...pending.entries()]
      pending.clear()
      for (const [, cb] of callbacks) cb(now)
    },
  }
}

describe('FrameScheduler', () => {
  it('schedules nothing until markDirty is called', () => {
    const fake = makeFakeRaf()
    const onFrame = vi.fn(() => false)
    const s = new FrameScheduler({ onFrame, raf: fake.raf, caf: fake.caf })

    expect(s.isScheduled).toBe(false)
    expect(fake.pendingCount).toBe(0)
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('runs exactly one frame per markDirty burst', () => {
    const fake = makeFakeRaf()
    const onFrame = vi.fn(() => false)
    const s = new FrameScheduler({ onFrame, raf: fake.raf, caf: fake.caf })

    // A pointer burst marks dirty many times before the next frame runs.
    s.markDirty()
    s.markDirty()
    s.markDirty()
    expect(fake.pendingCount).toBe(1)

    fake.flush()
    expect(onFrame).toHaveBeenCalledTimes(1)
    // Nothing else was requested, so the loop stops dead.
    expect(s.isScheduled).toBe(false)
    expect(fake.pendingCount).toBe(0)
  })

  it('goes idle after a frame and stays idle (no perpetual rAF)', () => {
    const fake = makeFakeRaf()
    const s = new FrameScheduler({ onFrame: () => false, raf: fake.raf, caf: fake.caf })
    s.markDirty()
    for (let i = 0; i < 10; i++) fake.flush()
    expect(s.isScheduled).toBe(false)
    expect(s.frameCount).toBe(1)
  })

  it('keeps running while onFrame asks for another frame', () => {
    const fake = makeFakeRaf()
    let remaining = 3
    const s = new FrameScheduler({
      onFrame: () => remaining-- > 0,
      raf: fake.raf,
      caf: fake.caf,
    })
    s.markDirty()
    fake.flush() // remaining 3 -> true
    expect(s.isScheduled).toBe(true)
    fake.flush() // 2 -> true
    fake.flush() // 1 -> true
    expect(s.isScheduled).toBe(true)
    fake.flush() // 0 -> false
    expect(s.isScheduled).toBe(false)
    expect(s.frameCount).toBe(4)
  })

  it('re-arms when markDirty happens DURING a frame', () => {
    const fake = makeFakeRaf()
    let scheduler: FrameScheduler | null = null
    let armedDuringFrame = false
    scheduler = new FrameScheduler({
      onFrame: () => {
        if (!armedDuringFrame) {
          armedDuringFrame = true
          // A tile arriving mid-render marks dirty from inside the frame.
          scheduler!.markDirty()
        }
        return false
      },
      raf: fake.raf,
      caf: fake.caf,
    })
    scheduler.markDirty()
    fake.flush()
    expect(scheduler.isScheduled).toBe(true)
    fake.flush()
    expect(scheduler.isScheduled).toBe(false)
    expect(scheduler.frameCount).toBe(2)
  })

  it('pause cancels the armed frame and resume replays the pending dirt', () => {
    const fake = makeFakeRaf()
    const onFrame = vi.fn(() => false)
    const s = new FrameScheduler({ onFrame, raf: fake.raf, caf: fake.caf })

    s.markDirty()
    expect(fake.pendingCount).toBe(1)
    s.pause()
    expect(fake.pendingCount).toBe(0)
    expect(s.isPaused).toBe(true)

    // markDirty while paused must not schedule anything.
    s.markDirty()
    expect(fake.pendingCount).toBe(0)

    s.resume()
    expect(fake.pendingCount).toBe(1)
    fake.flush()
    expect(onFrame).toHaveBeenCalledTimes(1)
  })

  it('resume without pending dirt schedules nothing', () => {
    const fake = makeFakeRaf()
    const s = new FrameScheduler({ onFrame: () => false, raf: fake.raf, caf: fake.caf })
    s.markDirty()
    fake.flush()
    s.pause()
    s.resume()
    expect(s.isScheduled).toBe(false)
  })

  it('a flushed frame while paused does nothing', () => {
    const fake = makeFakeRaf()
    const onFrame = vi.fn(() => false)
    const s = new FrameScheduler({ onFrame, raf: fake.raf, caf: fake.caf })
    s.markDirty()
    // Simulate the rAF firing after pause() cancelled — a real browser can
    // deliver a callback that was already queued.
    s.pause()
    fake.flush()
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('dispose stops everything and ignores later markDirty', () => {
    const fake = makeFakeRaf()
    const onFrame = vi.fn(() => false)
    const s = new FrameScheduler({ onFrame, raf: fake.raf, caf: fake.caf })
    s.markDirty()
    s.dispose()
    expect(fake.pendingCount).toBe(0)
    s.markDirty()
    expect(fake.pendingCount).toBe(0)
    fake.flush()
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('counts a frame even when onFrame throws, and does not swallow the error', () => {
    const fake = makeFakeRaf()
    const s = new FrameScheduler({
      onFrame: () => {
        throw new Error('render blew up')
      },
      raf: fake.raf,
      caf: fake.caf,
    })
    s.markDirty()
    expect(() => fake.flush()).toThrow('render blew up')
    expect(s.frameCount).toBe(1)
  })
})

describe('SettleTimer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires once after the quiet period', () => {
    const onSettle = vi.fn()
    const t = new SettleTimer(120, onSettle)
    t.bump()
    vi.advanceTimersByTime(119)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('collapses a burst into ONE trailing fire', () => {
    const onSettle = vi.fn()
    const t = new SettleTimer(120, onSettle)
    // A pan delivers a camera change every frame for a second.
    for (let i = 0; i < 60; i++) {
      t.bump()
      vi.advanceTimersByTime(16)
    }
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(120)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('always fires on the trailing edge — the final bump is never lost', () => {
    const onSettle = vi.fn()
    const t = new SettleTimer(180, onSettle)
    t.bump()
    vi.advanceTimersByTime(170)
    t.bump()
    vi.advanceTimersByTime(170)
    expect(onSettle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('flush runs the pending callback immediately and disarms', () => {
    const onSettle = vi.fn()
    const t = new SettleTimer(180, onSettle)
    t.bump()
    expect(t.isPending).toBe(true)
    t.flush()
    expect(onSettle).toHaveBeenCalledTimes(1)
    expect(t.isPending).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('flush with nothing armed does nothing', () => {
    const onSettle = vi.fn()
    new SettleTimer(180, onSettle).flush()
    expect(onSettle).not.toHaveBeenCalled()
  })

  it('cancel drops the pending fire', () => {
    const onSettle = vi.fn()
    const t = new SettleTimer(120, onSettle)
    t.bump()
    t.cancel()
    vi.advanceTimersByTime(1000)
    expect(onSettle).not.toHaveBeenCalled()
  })

  it('dispose prevents any later fire, including from an in-flight timer', () => {
    const onSettle = vi.fn()
    const t = new SettleTimer(120, onSettle)
    t.bump()
    t.dispose()
    vi.advanceTimersByTime(1000)
    expect(onSettle).not.toHaveBeenCalled()
    t.bump()
    vi.advanceTimersByTime(1000)
    expect(onSettle).not.toHaveBeenCalled()
  })
})

describe('FpsMeter', () => {
  it('reports 0 before there are two frames', () => {
    const m = new FpsMeter()
    expect(m.fps()).toBe(0)
    m.sample(0)
    expect(m.fps()).toBe(0)
  })

  it('averages steady 60 Hz frames to ~60 fps', () => {
    const m = new FpsMeter()
    for (let i = 0; i <= 30; i++) m.sample(i * 16.667)
    expect(m.fps()).toBeCloseTo(60, 0)
  })

  it('reflects a slow stretch rather than hiding it', () => {
    const m = new FpsMeter()
    for (let i = 0; i <= 20; i++) m.sample(i * 50) // 20 fps
    expect(m.fps()).toBeCloseTo(20, 0)
  })

  it('discards the window across an idle gap instead of averaging it in', () => {
    const m = new FpsMeter()
    for (let i = 0; i <= 10; i++) m.sample(i * 16)
    // The map went idle for two seconds — a render-on-demand map's normal
    // state. Averaging that in would report ~1 fps on a healthy map.
    m.sample(10 * 16 + 2000)
    expect(m.fps()).toBe(0)
    for (let i = 1; i <= 10; i++) m.sample(10 * 16 + 2000 + i * 16)
    expect(m.fps()).toBeCloseTo(62.5, 0)
  })

  it('treats a gap just under IDLE_GAP_MS as a real (slow) frame', () => {
    const m = new FpsMeter()
    m.sample(0)
    m.sample(IDLE_GAP_MS - 1)
    expect(m.fps()).toBeGreaterThan(0)
    expect(m.fps()).toBeLessThan(5)
  })

  it('keeps only the last `window` intervals', () => {
    const m = new FpsMeter(5)
    // Ten slow frames then five fast ones: only the fast ones should count.
    for (let i = 0; i <= 10; i++) m.sample(i * 100)
    let t = 10 * 100
    for (let i = 0; i < 5; i++) {
      t += 10
      m.sample(t)
    }
    expect(m.fps()).toBeCloseTo(100, 0)
  })

  it('reset clears the window', () => {
    const m = new FpsMeter()
    for (let i = 0; i <= 10; i++) m.sample(i * 16)
    m.reset()
    expect(m.fps()).toBe(0)
  })

  it('counts the first interval even when the first frame lands at t=0', () => {
    // rAF timestamps start at 0 on some engines; a `last > 0` sentinel would
    // silently throw away the first real interval.
    const m = new FpsMeter()
    m.sample(0)
    m.sample(16)
    expect(m.fps()).toBeCloseTo(62.5, 0)
  })

  it('ignores a zero or negative interval', () => {
    const m = new FpsMeter()
    m.sample(100)
    m.sample(100)
    m.sample(50)
    expect(m.fps()).toBe(0)
  })
})
