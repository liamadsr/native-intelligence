// @vitest-environment jsdom
/**
 * The desktop main window's perf_snapshot event: every 30 minutes, numbers
 * only, from the main window and nowhere else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { takePerfSnapshot } from '../perf-snapshot'
import {
  PERF_SNAPSHOT_EVENT,
  PERF_SNAPSHOT_EVERY_MS,
  isDesktopMainWindow,
  perfSnapshotProperties,
  startPerfSnapshotEvents,
} from '../perf-snapshot-events'

function inWindow(label: string | null) {
  if (label === null) delete window.__TAURI_INTERNALS__
  else window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } }
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = `
    <div class="group/msg"><p>private words</p></div>
    <div aria-hidden inert data-card-parked="call_1"><div data-card-body-host><span></span></div></div>
    <div data-chat-card="call_2"><div data-card-dormant="" style="display:none"><div data-card-body-host></div></div></div>
    <section data-capture-id="0b6f7d1e-1111-4222-8333-944455556666"></section>`
})
afterEach(() => {
  vi.useRealTimers()
  inWindow(null)
  document.body.innerHTML = ''
})

describe('perfSnapshotProperties', () => {
  it('is the snapshot as flat numbers: no labels, ids or text', () => {
    const props = perfSnapshotProperties(takePerfSnapshot(document, { realtimeTopics: () => ['realtime:capture-stream:a:1'] }))
    expect(Object.values(props).every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true)
    expect(props).toMatchObject({ chat_messages: 1, parked_pages: 1, parked_elements: 3, inline_cards: 1, inline_asleep_pages: 1, inline_asleep_elements: 2, realtime_channels: 1 })
    const text = JSON.stringify(props)
    for (const leak of ['private', 'call_1', 'call_2', '0b6f7d1e', 'capture-stream', 'data-']) expect(text).not.toContain(leak)
  })
})

describe('startPerfSnapshotEvents', () => {
  it('sends one every 30 minutes from the desktop main window', () => {
    inWindow('main')
    expect(isDesktopMainWindow()).toBe(true)
    const capture = vi.fn()
    const stop = startPerfSnapshotEvents(capture, () => takePerfSnapshot(document))
    vi.advanceTimersByTime(PERF_SNAPSHOT_EVERY_MS - 1)
    expect(capture).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0][0]).toBe(PERF_SNAPSHOT_EVENT)
    expect(capture.mock.calls[0][1]).toMatchObject({ window: 'main', chat_messages: 1 })
    vi.advanceTimersByTime(PERF_SNAPSHOT_EVERY_MS)
    expect(capture).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(PERF_SNAPSHOT_EVERY_MS * 3)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['the browser', null],
    ['a workspace window', 'workspace-61db7809'],
    ['the HUD', 'agent-hud'],
  ])('sends nothing, and keeps no timer, in %s', (_where, label) => {
    inWindow(label)
    const capture = vi.fn()
    startPerfSnapshotEvents(capture, () => takePerfSnapshot(document))
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(PERF_SNAPSHOT_EVERY_MS * 4)
    expect(capture).not.toHaveBeenCalled()
  })

  it('skips a snapshot that throws, and keeps going', () => {
    inWindow('main')
    const capture = vi.fn()
    let n = 0
    startPerfSnapshotEvents(capture, () => {
      n += 1
      if (n === 1) throw new Error('boom')
      return takePerfSnapshot(document)
    })
    vi.advanceTimersByTime(PERF_SNAPSHOT_EVERY_MS * 2)
    expect(capture).toHaveBeenCalledTimes(1)
  })
})
