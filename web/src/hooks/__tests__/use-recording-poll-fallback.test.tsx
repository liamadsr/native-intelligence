// @vitest-environment jsdom
/**
 * Tests for useRecordingPollFallback — the capture-panel poll fallback that keeps
 * the flagship live-notes surface alive when live realtime delivery is dead.
 *
 * Contract:
 *   1. Actively recording => onTick fires on the interval.
 *   2. NOT recording => never polls.
 *   3. Unmount (or recording stops) clears the interval — no polls after.
 *   4. deliveryDown flag reflects the caller-supplied isDeliveryDown() getter at
 *      each tick (channel-aware: the hook itself knows nothing about sockets).
 *   5. A throwing getter is treated as delivery-down (fail safe: prefer a snap-in
 *      catch-up over stranding the notes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useRecordingPollFallback } from '../use-recording-poll-fallback'

let container: HTMLDivElement
let root: Root

function Host(props: {
  active: boolean
  onTick: (o: { deliveryDown: boolean }) => void
  isDeliveryDown: () => boolean
  intervalMs?: number
}) {
  useRecordingPollFallback(props.active, props.onTick, props.isDeliveryDown, props.intervalMs)
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('useRecordingPollFallback', () => {
  it('polls on the interval while actively recording', () => {
    const onTick = vi.fn()
    const isDeliveryDown = () => false
    act(() => root.render(h(Host, { active: true, onTick, isDeliveryDown, intervalMs: 25_000 })))

    expect(onTick).not.toHaveBeenCalled() // no immediate call
    act(() => vi.advanceTimersByTime(25_000))
    expect(onTick).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(25_000))
    expect(onTick).toHaveBeenCalledTimes(2)
  })

  it('never polls when not recording', () => {
    const onTick = vi.fn()
    const isDeliveryDown = () => false
    act(() => root.render(h(Host, { active: false, onTick, isDeliveryDown, intervalMs: 25_000 })))
    act(() => vi.advanceTimersByTime(120_000))
    expect(onTick).not.toHaveBeenCalled()
  })

  it('clears the interval on unmount (no polls after)', () => {
    const onTick = vi.fn()
    const isDeliveryDown = () => false
    act(() => root.render(h(Host, { active: true, onTick, isDeliveryDown, intervalMs: 25_000 })))
    act(() => vi.advanceTimersByTime(25_000))
    expect(onTick).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    act(() => vi.advanceTimersByTime(120_000))
    expect(onTick).toHaveBeenCalledTimes(1) // no further ticks
  })

  it('stops polling when recording flips to inactive', () => {
    const onTick = vi.fn()
    const isDeliveryDown = () => false
    act(() => root.render(h(Host, { active: true, onTick, isDeliveryDown, intervalMs: 25_000 })))
    act(() => vi.advanceTimersByTime(25_000))
    expect(onTick).toHaveBeenCalledTimes(1)

    act(() => root.render(h(Host, { active: false, onTick, isDeliveryDown, intervalMs: 25_000 })))
    act(() => vi.advanceTimersByTime(120_000))
    expect(onTick).toHaveBeenCalledTimes(1)
  })

  it('reports deliveryDown=true when the getter reports live delivery is down', () => {
    const onTick = vi.fn()
    const isDeliveryDown = () => true
    act(() => root.render(h(Host, { active: true, onTick, isDeliveryDown, intervalMs: 25_000 })))
    act(() => vi.advanceTimersByTime(25_000))
    expect(onTick).toHaveBeenLastCalledWith({ deliveryDown: true })
  })

  it('reports deliveryDown=false when the getter reports healthy delivery', () => {
    const onTick = vi.fn()
    const isDeliveryDown = () => false
    act(() => root.render(h(Host, { active: true, onTick, isDeliveryDown, intervalMs: 25_000 })))
    act(() => vi.advanceTimersByTime(25_000))
    expect(onTick).toHaveBeenLastCalledWith({ deliveryDown: false })
  })

  it('treats a THROWING getter as delivery-down (fail safe)', () => {
    const onTick = vi.fn()
    const isDeliveryDown = () => {
      throw new Error('cannot read liveness')
    }
    act(() => root.render(h(Host, { active: true, onTick, isDeliveryDown, intervalMs: 25_000 })))
    act(() => vi.advanceTimersByTime(25_000))
    expect(onTick).toHaveBeenLastCalledWith({ deliveryDown: true })
  })

  it('re-reads the getter each tick (channel-aware liveness can change mid-recording)', () => {
    const onTick = vi.fn()
    let down = false
    const isDeliveryDown = () => down
    act(() => root.render(h(Host, { active: true, onTick, isDeliveryDown, intervalMs: 25_000 })))
    act(() => vi.advanceTimersByTime(25_000))
    expect(onTick).toHaveBeenLastCalledWith({ deliveryDown: false })
    // Channel drops mid-recording — next tick must reflect it.
    down = true
    act(() => vi.advanceTimersByTime(25_000))
    expect(onTick).toHaveBeenLastCalledWith({ deliveryDown: true })
  })
})
