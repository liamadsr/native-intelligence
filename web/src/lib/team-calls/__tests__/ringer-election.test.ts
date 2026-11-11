/**
 * One ringtone however many windows show the ring
 * (src/lib/team-calls/ringer-election.ts): with Web Locks the first window
 * rings and the rest wait; when the ringing window goes, the next rings on;
 * when the ring stops, every window lets go (nobody rings after). Without
 * locks, a BroadcastChannel claim.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdRinger, ringerLockName, type RingerLocks } from '../ringer-election'
import { __resetCrossWindowForTests, __setLockManagerForTests } from '@/lib/sounds/cross-window'

/** Exclusive locks with a queue, as navigator.locks behaves across windows of one origin. */
function fakeLocks(): RingerLocks {
  const held = new Map<string, boolean>()
  const queues = new Map<string, Array<() => void>>()
  const next = (name: string) => {
    const q = queues.get(name) ?? []
    const run = q.shift()
    if (run) run()
    else held.delete(name)
  }
  return {
    request(name, options, callback) {
      return new Promise((resolve) => {
        let aborted = false
        const start = () => {
          if (aborted) return next(name)
          held.set(name, true)
          Promise.resolve(callback({ name })).then(() => {
            resolve(undefined)
            next(name)
          })
        }
        options.signal?.addEventListener('abort', () => {
          aborted = true
          const q = queues.get(name) ?? []
          const i = q.indexOf(start)
          if (i >= 0) q.splice(i, 1)
          resolve(undefined)
        })
        if (!held.get(name)) start()
        else queues.set(name, [...(queues.get(name) ?? []), start])
      })
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => __resetCrossWindowForTests())

describe('holdRinger', () => {
  it('names one lock per ring', () => {
    expect(ringerLockName('r1')).toBe('ni-team-call-ring:r1')
  })

  it('three windows: exactly one rings', async () => {
    const locks = fakeLocks()
    const rang: string[] = []
    const releases = ['a', 'b', 'c'].map((w) => holdRinger('r1', () => (rang.push(w), () => {}), { locks }))
    await tick()
    expect(rang).toEqual(['a'])
    releases.forEach((r) => r())
  })

  it('the ringing window closes: the next one rings on', async () => {
    const locks = fakeLocks()
    const rang: string[] = []
    const stopped: string[] = []
    const a = holdRinger('r1', () => (rang.push('a'), () => stopped.push('a')), { locks })
    holdRinger('r1', () => (rang.push('b'), () => stopped.push('b')), { locks })
    await tick()
    a()
    await tick()
    await tick()
    expect(rang).toEqual(['a', 'b'])
    expect(stopped).toEqual(['a'])
  })

  it('the ring stops (answered anywhere): every window lets go, and nobody rings after', async () => {
    const locks = fakeLocks()
    const rang: string[] = []
    const stopped: string[] = []
    const all = ['a', 'b', 'c'].map((w) => holdRinger('r1', () => (rang.push(w), () => stopped.push(w)), { locks }))
    await tick()
    // The waiting ones let go first, then the ringing one (any order works).
    all[2]()
    all[1]()
    all[0]()
    await tick()
    await tick()
    expect(rang).toEqual(['a'])
    expect(stopped).toEqual(['a'])
  })

  it('two rings at once each have their own ringer', async () => {
    const locks = fakeLocks()
    const rang: string[] = []
    holdRinger('r1', () => (rang.push('r1'), () => {}), { locks })
    holdRinger('r2', () => (rang.push('r2'), () => {}), { locks })
    await tick()
    expect(rang.sort()).toEqual(['r1', 'r2'])
  })

  it('without Web Locks: the broadcast claim, one winner in this window', async () => {
    __setLockManagerForTests(null)
    vi.useFakeTimers()
    try {
      const rang: string[] = []
      holdRinger('r9', () => (rang.push('first'), () => {}), { locks: null })
      holdRinger('r9', () => (rang.push('second'), () => {}), { locks: null })
      await vi.advanceTimersByTimeAsync(200)
      expect(rang).toEqual(['first'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('released before its turn came: never rings', async () => {
    const locks = fakeLocks()
    const rang: string[] = []
    const a = holdRinger('r1', () => (rang.push('a'), () => {}), { locks })
    const b = holdRinger('r1', () => (rang.push('b'), () => {}), { locks })
    await tick()
    b()
    a()
    await tick()
    expect(rang).toEqual(['a'])
  })
})
