// @vitest-environment jsdom
/**
 * The resume points (../resume-points): where a paused reading picks up.
 *  - a pause keeps the sentence index, as the most recent pause; taking a
 *    key's point (a run starting) forgets it, and the last pause with it;
 *  - bounded: the MAX_RESUME_POINTS keys paused most recently, a pause moving
 *    its key to the newest;
 *  - the hooks follow one key's point and whether it is the last pause.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
  MAX_RESUME_POINTS,
  __resetResumePointsForTests,
  getLastPausedKey,
  getResumePoint,
  setResumePoint,
  subscribeResumePoints,
  takeResumePoint,
  useIsLastPaused,
  useResumePoint,
} from '../resume-points'

beforeEach(() => {
  __resetResumePointsForTests()
})

afterEach(() => {
  __resetResumePointsForTests()
})

describe('resume points', () => {
  it('a pause keeps the index as the last pause; taking the point forgets it', () => {
    expect(getResumePoint('doc:1')).toBeNull()
    setResumePoint('doc:1', 3)
    expect(getResumePoint('doc:1')).toBe(3)
    expect(getLastPausedKey()).toBe('doc:1')

    expect(takeResumePoint('doc:1')).toBe(3)
    expect(getResumePoint('doc:1')).toBeNull()
    expect(getLastPausedKey()).toBeNull()
    expect(takeResumePoint('doc:1')).toBeNull()
  })

  it('the last pause moves with each pause; taking an older point leaves it', () => {
    setResumePoint('doc:1', 1)
    setResumePoint('email:m2', 4)
    expect(getLastPausedKey()).toBe('email:m2')
    expect(takeResumePoint('doc:1')).toBe(1)
    expect(getLastPausedKey()).toBe('email:m2')
    // Pausing a key again moves it to the newest.
    setResumePoint('doc:1', 2)
    expect(getLastPausedKey()).toBe('doc:1')
  })

  it('indices are whole and never negative', () => {
    setResumePoint('a', -2)
    setResumePoint('b', 2.7)
    expect(getResumePoint('a')).toBe(0)
    expect(getResumePoint('b')).toBe(2)
  })

  it(`keeps the ${MAX_RESUME_POINTS} keys paused most recently`, () => {
    for (let i = 0; i <= MAX_RESUME_POINTS; i++) setResumePoint(`k${i}`, i)
    expect(getResumePoint('k0')).toBeNull()
    expect(getResumePoint('k1')).toBe(1)
    expect(getResumePoint(`k${MAX_RESUME_POINTS}`)).toBe(MAX_RESUME_POINTS)

    // Pausing k1 again makes it the newest: the next one out is k2.
    setResumePoint('k1', 7)
    setResumePoint('fresh', 0)
    expect(getResumePoint('k1')).toBe(7)
    expect(getResumePoint('k2')).toBeNull()
    expect(getLastPausedKey()).toBe('fresh')
  })

  it('tells listeners of every change, and of nothing else', () => {
    let calls = 0
    const unsubscribe = subscribeResumePoints(() => calls++)
    setResumePoint('a', 1)
    takeResumePoint('a')
    takeResumePoint('a') // nothing to take
    expect(calls).toBe(2)
    unsubscribe()
    setResumePoint('a', 1)
    expect(calls).toBe(2)
  })

  it('useResumePoint and useIsLastPaused follow one key', async () => {
    const seen: Array<[number | null, boolean]> = []
    function Probe() {
      seen.push([useResumePoint('doc:1'), useIsLastPaused('doc:1')])
      return null
    }
    const host = document.createElement('div')
    const root: Root = createRoot(host)
    await act(async () => root.render(h(Probe)))
    expect(seen.at(-1)).toEqual([null, false])

    await act(async () => setResumePoint('doc:1', 2))
    expect(seen.at(-1)).toEqual([2, true])
    // Another key paused: doc:1 keeps its point but is no longer the last pause.
    await act(async () => setResumePoint('doc:2', 0))
    expect(seen.at(-1)).toEqual([2, false])
    await act(async () => void takeResumePoint('doc:1'))
    expect(seen.at(-1)).toEqual([null, false])
    await act(async () => root.unmount())
  })
})
