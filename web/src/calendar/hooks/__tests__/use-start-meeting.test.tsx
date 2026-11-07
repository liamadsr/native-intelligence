// @vitest-environment jsdom
/**
 * useStartMeetingFromEvent — the calendar's Start on an event.
 *
 * Pinned: a capture the route finds or creates is recorded with
 * startRecordingForCapture; one it hands back as `resume` (this meeting's
 * capture closed moments ago, e.g. by a mid-call restart) is resumed with
 * resumeCapture, which unlocks it only once the client can record, and opens
 * it the same way (the event title).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'
import type { IEvent } from '@/calendar/interfaces'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const recording = {
  isRecording: false,
  startRecordingForCapture: vi.fn(async (_id: string, _opts?: { title?: string }) => {}),
  resumeCapture: vi.fn(async (_id: string, _opts?: { title?: string }) => {}),
}
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => recording }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), loading: vi.fn(() => 't'), dismiss: vi.fn() }) }))

import { useStartMeetingFromEvent } from '../use-start-meeting'

const EVENT = {
  id: 'evt-1',
  title: 'Owen & Liam',
  startDate: '2026-10-19T20:30:00.000Z',
  endDate: '2026-10-19T21:00:00.000Z',
} as IEvent

let start: ((e: IEvent) => Promise<void>) | null = null
function Grabber() {
  const { startMeeting } = useStartMeetingFromEvent()
  useEffect(() => { start = startMeeting })
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  recording.startRecordingForCapture.mockClear()
  recording.resumeCapture.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(h(Grabber)) })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function answer(body: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
}

describe('useStartMeetingFromEvent', () => {
  it('records the capture the route finds or creates', async () => {
    answer({ capture_id: 'cap-new', created: true })
    await act(async () => { await start!(EVENT) })
    expect(recording.startRecordingForCapture).toHaveBeenCalledWith('cap-new', { title: 'Owen & Liam' })
    expect(recording.resumeCapture).not.toHaveBeenCalled()
  })

  it('resumes the capture the route hands back as the same sitting', async () => {
    answer({ capture_id: 'cap-interrupted', created: false, resume: true })
    await act(async () => { await start!(EVENT) })
    expect(recording.resumeCapture).toHaveBeenCalledWith('cap-interrupted', { title: 'Owen & Liam' })
    expect(recording.startRecordingForCapture).not.toHaveBeenCalled()
  })

  it('sends an all-day event\'s exclusive end, not the last day\'s 00:00', async () => {
    answer({ capture_id: 'cap-new', created: true })
    const allDay = { ...EVENT, isAllDay: true, startDate: '2026-10-21', endDate: '2026-10-21' } as IEvent
    await act(async () => { await start!(allDay) })
    const init = (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0][1]
    expect(JSON.parse(String(init.body)).end).toBe('2026-10-22')
  })
})
