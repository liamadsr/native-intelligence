import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALM_MS, MAX_CALM_RUN_MS, createSkyActivity } from '../sky-activity'

const make = () => createSkyActivity({ now: () => Date.now() })

describe('sky activity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('becomes calm after a quiet spell, and any input freezes it at once', () => {
    const a = make()
    const heard = vi.fn()
    a.subscribe(heard)
    a.markActive()
    expect(a.canMove()).toBe(false)
    vi.advanceTimersByTime(CALM_MS - 1)
    expect(a.canMove()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(a.canMove()).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
    a.markActive()
    expect(a.canMove()).toBe(false)
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('waits a full calm spell after the LAST input of a burst, with one timer', () => {
    const a = make()
    a.markActive()
    const timers = vi.getTimerCount()
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(100)
      a.markActive()
    }
    expect(vi.getTimerCount()).toBe(timers)
    vi.advanceTimersByTime(CALM_MS - 1)
    expect(a.isCalm()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(a.isCalm()).toBe(true)
    // Calm holds one timer: the run's cap, not a calm-spell timer.
    expect(vi.getTimerCount()).toBe(1)
  })

  it('holds freeze it however calm it is, and releasing one restarts the calm spell', () => {
    const a = make()
    a.markActive()
    vi.advanceTimersByTime(CALM_MS)
    expect(a.canMove()).toBe(true)
    a.setHold('stream', true)
    expect(a.canMove()).toBe(false)
    expect(a.holds()).toEqual(['stream'])
    vi.advanceTimersByTime(CALM_MS * 3)
    expect(a.canMove()).toBe(false)
    a.setHold('stream', false)
    expect(a.canMove()).toBe(false)
    vi.advanceTimersByTime(CALM_MS)
    expect(a.canMove()).toBe(true)
  })

  it('comes to rest after MAX_CALM_RUN_MS of motion, with no timer left, until the next input', () => {
    const a = make()
    const heard = vi.fn()
    a.subscribe(heard)
    a.markActive()
    vi.advanceTimersByTime(CALM_MS)
    expect(a.canMove()).toBe(true)
    vi.advanceTimersByTime(MAX_CALM_RUN_MS - 1)
    expect(a.canMove()).toBe(true)
    expect(a.isResting()).toBe(false)
    heard.mockClear()
    vi.advanceTimersByTime(1)
    expect(a.isResting()).toBe(true)
    expect(a.canMove()).toBe(false)
    expect(heard).toHaveBeenCalledTimes(1)
    // Resting ticks nothing, however long it lasts.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(MAX_CALM_RUN_MS * 5)
    expect(a.canMove()).toBe(false)

    // Input, then a calm spell: a fresh run of the full length.
    a.markActive()
    expect(a.isResting()).toBe(false)
    expect(a.canMove()).toBe(false)
    vi.advanceTimersByTime(CALM_MS)
    expect(a.canMove()).toBe(true)
    vi.advanceTimersByTime(MAX_CALM_RUN_MS - 1)
    expect(a.canMove()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(a.isResting()).toBe(true)
  })

  it('counts a run as continuous motion: a freeze in between starts the cap over', () => {
    const a = make()
    a.markActive()
    vi.advanceTimersByTime(CALM_MS)
    vi.advanceTimersByTime(MAX_CALM_RUN_MS - 1_000)
    a.setHold('stream', true)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10_000)
    a.setHold('stream', false)
    vi.advanceTimersByTime(CALM_MS)
    expect(a.canMove()).toBe(true)
    vi.advanceTimersByTime(MAX_CALM_RUN_MS - 1)
    expect(a.isResting()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(a.isResting()).toBe(true)
  })

  it('releasing a hold while resting starts a fresh calm spell', () => {
    const a = make()
    a.markActive()
    vi.advanceTimersByTime(CALM_MS + MAX_CALM_RUN_MS)
    expect(a.isResting()).toBe(true)
    a.setHold('full', true)
    a.setHold('full', false)
    expect(a.isResting()).toBe(false)
    expect(a.canMove()).toBe(false)
    vi.advanceTimersByTime(CALM_MS)
    expect(a.canMove()).toBe(true)
  })

  it('ignores a hold set twice', () => {
    const a = make()
    const heard = vi.fn()
    a.subscribe(heard)
    a.setHold('full', true)
    a.setHold('full', true)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('reports an empty chat only when every active chat is empty', () => {
    const a = make()
    expect(a.isChatEmpty()).toBe(false)
    a.setChatEmpty('one', true)
    expect(a.isChatEmpty()).toBe(true)
    a.setChatEmpty('two', false)
    expect(a.isChatEmpty()).toBe(false)
    a.setChatEmpty('two', null)
    expect(a.isChatEmpty()).toBe(true)
  })

  it('moving the mouse never freezes it, and wakes a sky at rest; a click still freezes it', () => {
    const listeners = new Map<string, () => void>()
    const win = { addEventListener: (t: string, fn: () => void) => listeners.set(t, fn), removeEventListener: vi.fn(), matchMedia: undefined }
    const doc = { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible' }
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    try {
      const a = make()
      const detach = a.attach()
      vi.advanceTimersByTime(CALM_MS)
      expect(a.canMove()).toBe(true)
      listeners.get('pointermove')!()
      expect(a.canMove()).toBe(true)
      // At rest after the run's cap: the mouse wakes it for a fresh run.
      vi.advanceTimersByTime(MAX_CALM_RUN_MS)
      expect(a.isResting()).toBe(true)
      listeners.get('pointermove')!()
      expect(a.isResting()).toBe(false)
      expect(a.canMove()).toBe(true)
      // Clicking is using the app: frozen at once.
      listeners.get('pointerdown')!()
      expect(a.canMove()).toBe(false)
      detach()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('attaches window listeners once, and detaching stops its timer', () => {
    const add = vi.fn()
    const remove = vi.fn()
    const win = { addEventListener: add, removeEventListener: remove, matchMedia: undefined }
    const doc = { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible' }
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    try {
      const a = make()
      const d1 = a.attach()
      const d2 = a.attach()
      const wired = add.mock.calls.length
      expect(wired).toBe(6)
      expect(add.mock.calls.find(([t]) => t === 'scroll')?.[2]).toMatchObject({ capture: true, passive: true })
      d1()
      expect(remove).not.toHaveBeenCalled()
      d2()
      expect(remove).toHaveBeenCalledTimes(6)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
