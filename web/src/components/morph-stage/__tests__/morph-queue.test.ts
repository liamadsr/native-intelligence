import { describe, it, expect } from 'vitest'
import { MorphQueue, easeInOut, type MorphClock, type MorphRenderer } from '../morph-queue'

/**
 * When a morph stage draws. The efficiency contract: frames run ONLY while a
 * morph is in flight, a burst of asks is one morph in flight and one waiting,
 * and a morph lands on time even when frames stop coming.
 */

function fakeClock() {
  let now = 0
  let nextId = 1
  const frames = new Map<number, () => void>()
  const timers = new Map<number, { at: number; cb: () => void }>()
  const clock: MorphClock = {
    now: () => now,
    frame: (cb) => { const id = nextId++; frames.set(id, cb); return id },
    cancelFrame: (id) => { frames.delete(id) },
    timeout: (cb, ms) => { const id = nextId++; timers.set(id, { at: now + ms, cb }); return id as unknown as ReturnType<typeof setTimeout> },
    clearTimeout: (id) => { timers.delete(id as unknown as number) },
  }
  return {
    clock,
    /** Advance to `ms` later, firing one frame per 16 ms (or none) and any due timers. */
    advance(ms: number, { withFrames = true } = {}) {
      const end = now + ms
      while (now < end) {
        now = Math.min(end, now + 16)
        if (withFrames) {
          const due = [...frames.values()]
          frames.clear()
          due.forEach((cb) => cb())
        }
        for (const [id, t] of [...timers]) {
          if (t.at <= now) { timers.delete(id); t.cb() }
        }
      }
    },
    pending: () => ({ frames: frames.size, timers: timers.size }),
  }
}

function recorder() {
  const log: string[] = []
  const renderer: MorphRenderer<string> = {
    still: (k) => log.push(`still:${k}`),
    morph: (from, to, p) => log.push(`morph:${from}>${to}@${p.toFixed(2)}`),
  }
  return { log, renderer, morphs: () => log.filter((l) => l.startsWith('morph')).length }
}

describe('MorphQueue', () => {
  it('draws the first picture at once, with nothing left running', () => {
    const t = fakeClock()
    const r = recorder()
    const q = new MorphQueue(r.renderer, 1000, t.clock)
    q.show('A')
    expect(r.log).toEqual(['still:A'])
    expect(t.pending()).toEqual({ frames: 0, timers: 0 })
  })

  it('morphs to a new picture, lands on it, and then runs nothing at all', () => {
    const t = fakeClock()
    const r = recorder()
    const q = new MorphQueue(r.renderer, 1000, t.clock)
    q.show('A')
    q.show('B')
    expect(q.animating).toBe(true)
    t.advance(1100)
    expect(r.log.at(-1)).toBe('still:B')
    expect(r.morphs()).toBeGreaterThan(30)
    expect(r.log.filter((l) => l.startsWith('morph')).every((l) => l.startsWith('morph:A>B'))).toBe(true)
    expect(q.animating).toBe(false)
    // Idle: no frame and no timer pending.
    expect(t.pending()).toEqual({ frames: 0, timers: 0 })
    const before = r.log.length
    t.advance(5000)
    expect(r.log.length).toBe(before)
  })

  it('a burst of asks mid-morph is one morph waiting: the newest', () => {
    const t = fakeClock()
    const r = recorder()
    const q = new MorphQueue(r.renderer, 1000, t.clock)
    q.show('A')
    q.show('B')
    t.advance(300)
    q.show('C')
    q.show('D')
    q.show('E')
    expect(q.target).toBe('E')
    t.advance(2500)
    const targets = [...new Set(r.log.filter((l) => l.startsWith('morph')).map((l) => l.slice(6, 9)))]
    expect(targets).toEqual(['A>B', 'B>E'])
    expect(r.log.at(-1)).toBe('still:E')
  })

  it('asking for what is already on its way, or on screen, starts nothing', () => {
    const t = fakeClock()
    const r = recorder()
    const q = new MorphQueue(r.renderer, 1000, t.clock)
    q.show('A')
    q.show('A')
    expect(q.animating).toBe(false)
    q.show('B')
    t.advance(200)
    q.show('C')
    q.show('B') // back to the one in flight: the waiting C is dropped
    t.advance(2000)
    expect(r.log.filter((l) => l.startsWith('still'))).toEqual(['still:A', 'still:B'])
  })

  it('lands on time with no frames at all (an occluded webview)', () => {
    const t = fakeClock()
    const r = recorder()
    const q = new MorphQueue(r.renderer, 1000, t.clock)
    q.show('A')
    q.show('B')
    t.advance(1200, { withFrames: false })
    expect(r.log.at(-1)).toBe('still:B')
    expect(q.animating).toBe(false)
  })

  it('redraws the still on demand, and stops everything when disposed', () => {
    const t = fakeClock()
    const r = recorder()
    const q = new MorphQueue(r.renderer, 1000, t.clock)
    q.show('A')
    q.redraw()
    expect(r.log).toEqual(['still:A', 'still:A'])
    q.show('B')
    q.dispose()
    expect(t.pending()).toEqual({ frames: 0, timers: 0 })
    const before = r.log.length
    t.advance(2000)
    q.show('C')
    expect(r.log.length).toBe(before)
  })

  it('eases in and out (power2)', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(0.5)).toBe(0.5)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.25)).toBeLessThan(0.25)
    expect(easeInOut(0.75)).toBeGreaterThan(0.75)
  })
})
