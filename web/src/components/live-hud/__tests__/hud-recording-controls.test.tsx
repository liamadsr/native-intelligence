// @vitest-environment jsdom
/**
 * HudElapsed, the HUD header's elapsed time: counted on from the reading it
 * was handed (`elapsedSec` at `at`), written straight into its own text once
 * a second. Pinned: one timeout at a time, chained to the next second; no
 * React render per second; none at all while paused or while the page is
 * hidden; a new reading (resume) starts from it. And the label/format match
 * the top bar pill's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Profiler } from 'react'
import { HudElapsed, formatElapsed } from '../hud-recording-controls'
import { formatTime } from '@/hooks/use-recording'
import { recordingStatusLabel } from '@/components/capture/recording-status'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let renders = 0
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  renders = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  delete (document as unknown as { hidden?: boolean }).hidden
})

const render = (props: { elapsedSec: number; at: number; paused: boolean }) =>
  act(() => root.render(h(Profiler, { id: 't', onRender: () => renders++ }, h(HudElapsed, props))))
const text = () => container.querySelector('[data-hud-elapsed]')!.textContent

describe('HudElapsed', () => {
  it('counts on by itself, one timeout at a time, without rendering', async () => {
    render({ elapsedSec: 336, at: Date.now(), paused: false })
    expect(text()).toBe('5:36')
    const rendered = renders
    expect(vi.getTimerCount()).toBe(1)
    // Just past the next whole second (it aims 10ms past, so a paint lands on a new one).
    await act(async () => { await vi.advanceTimersByTimeAsync(1010) })
    expect(text()).toBe('5:37')
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(63_000) })
    expect(text()).toBe('6:40')
    expect(vi.getTimerCount()).toBe(1)
    // Its text, not React: no render for any of those seconds.
    expect(renders).toBe(rendered)
  })

  it('holds while paused (no timer), and a resume counts on from its new reading', async () => {
    render({ elapsedSec: 336, at: Date.now() - 5000, paused: true })
    expect(text()).toBe('5:36')
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(text()).toBe('5:36')
    render({ elapsedSec: 336, at: Date.now(), paused: false })
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2010) })
    expect(text()).toBe('5:38')
  })

  it('no timer while the page is hidden; catches up when it shows', async () => {
    render({ elapsedSec: 0, at: Date.now(), paused: false })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(text()).toBe('1:30')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('reads like the top bar pill', () => {
    for (const s of [0, 9, 59, 60, 336, 3600, 4523]) expect(formatElapsed(s)).toBe(formatTime(s))
    expect(recordingStatusLabel('connected')).toBe('Recording')
    expect(recordingStatusLabel('reconnecting')).toBe('Reconnecting')
    expect(recordingStatusLabel('disconnected')).toBe('No Transcript')
  })
})
