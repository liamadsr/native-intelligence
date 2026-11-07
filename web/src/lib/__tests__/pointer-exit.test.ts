// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { subscribePointerExit } from '../pointer-exit'

describe('subscribePointerExit', () => {
  it('fires on a mouseout to nowhere, window blur and the page hiding — not on moves within the page', () => {
    const listener = vi.fn()
    const stop = subscribePointerExit(listener)

    document.body.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.documentElement }))
    expect(listener).not.toHaveBeenCalled()

    document.body.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))
    expect(listener).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('blur'))
    expect(listener).toHaveBeenCalledTimes(2)

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(listener).toHaveBeenCalledTimes(3)
    delete (document as unknown as Record<string, unknown>).visibilityState

    stop()
    window.dispatchEvent(new Event('blur'))
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('keeps notifying the others when one listener unsubscribes itself mid-notify', () => {
    const second = vi.fn()
    const stopFirst = subscribePointerExit(() => stopFirst())
    const stopSecond = subscribePointerExit(second)
    window.dispatchEvent(new Event('blur'))
    expect(second).toHaveBeenCalledTimes(1)
    stopSecond()
  })
})
