// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pendingSendCount, queueSend } from '../undo-send'

afterEach(() => vi.useRealTimers())

describe('queueSend', () => {
  it('sends when the time is up, unless undone first', async () => {
    vi.useFakeTimers()
    const a = vi.fn()
    const b = vi.fn()
    queueSend(a, 1000)
    const second = queueSend(b, 1000)
    expect(pendingSendCount()).toBe(2)
    expect(second.undo()).toBe(true)
    // Undone once is undone: a second Undo stops nothing.
    expect(second.undo()).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    expect(pendingSendCount()).toBe(0)
  })

  it('flush sends at once, once; too late to undo after', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const q = queueSend(send, 1000)
    q.flush()
    await vi.advanceTimersByTimeAsync(2000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(q.undo()).toBe(false)
  })

  it('while a send waits, leaving the page asks first', () => {
    vi.useFakeTimers()
    const q = queueSend(() => {}, 1000)
    const waiting = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(waiting)
    expect(waiting.defaultPrevented).toBe(true)
    q.undo()
    const idle = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(idle)
    expect(idle.defaultPrevented).toBe(false)
  })

  it('a send that throws is its own business', async () => {
    vi.useFakeTimers()
    queueSend(() => {
      throw new Error('boom')
    }, 10)
    await vi.advanceTimersByTimeAsync(10)
    expect(pendingSendCount()).toBe(0)
  })
})
