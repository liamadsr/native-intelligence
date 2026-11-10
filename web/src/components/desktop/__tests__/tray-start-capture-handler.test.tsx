// @vitest-environment jsdom
/**
 * The tray's (and the HUD's) "Start Capture" on a calendar event (P5: every
 * way in opens a card): the capture is created or found and recorded live,
 * and the recording opens its card in a tab of its own; an event with no
 * title (an id-only fallback) opens the Captures card. Only the main window
 * acts on the broadcast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const env = vi.hoisted(() => ({
  fromEvent: null as null | ((e: Record<string, unknown>) => void),
  label: 'main' as string | null,
  startForCapture: vi.fn(async (_id: string, _opts?: { title?: string }) => {}),
  resume: vi.fn(async (_id: string, _opts?: { title?: string }) => {}),
}))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), loading: vi.fn(() => 't'), dismiss: vi.fn() }) }))
vi.mock('@/lib/tauri-bridge', () => ({
  getThisWebviewLabel: async () => env.label,
  tauriBridge: {
    onMeetingEnded: async () => () => {},
    onStartCaptureFromHud: async () => () => {},
    onHudLinkEvent: async () => () => {},
    onStartCaptureFromEvent: async (cb: (e: Record<string, unknown>) => void) => {
      env.fromEvent = cb
      return () => {}
    },
  },
}))
vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({
    startRecordingForCapture: env.startForCapture,
    resumeCapture: env.resume,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    isRecording: false,
    captureId: null,
  }),
}))

import { TrayStartCaptureHandler } from '../tray-start-capture-handler'

let container: HTMLDivElement
let root: Root
let opened: Array<Record<string, unknown>> = []
const onOpen = (e: Event) => opened.push((e as CustomEvent).detail)
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve() })

beforeEach(async () => {
  opened = []
  env.fromEvent = null
  env.label = 'main'
  env.startForCapture.mockClear()
  env.resume.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ capture_id: 'cap-42' }), { status: 200 })))
  window.addEventListener('ni:open-card', onOpen)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(h(TrayStartCaptureHandler)))
  await settle()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.removeEventListener('ni:open-card', onOpen)
  vi.unstubAllGlobals()
})

describe('TrayStartCaptureHandler', () => {
  it('an event: records the capture, which opens it in a tab of its own (no card into the chat on screen)', async () => {
    await act(async () => env.fromEvent!({ id: 'ev-1', title: 'Weekly sync', start: '2026-10-09T10:00:00Z', end: '2026-10-09T10:30:00Z' }))
    await settle()
    // The recording's navigate opens the card (in the meeting's own tab), so
    // nothing is opened into the chat the user is in.
    expect(opened).toEqual([])
    expect(env.startForCapture).toHaveBeenCalledWith('cap-42', { title: 'Weekly sync' })
  })

  it('a meeting whose capture closed moments ago (a mid-call restart) resumes that capture', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ capture_id: 'cap-41', created: false, resume: true }), { status: 200 })))
    await act(async () => env.fromEvent!({ id: 'ev-1', title: 'Weekly sync', start: '2026-10-09T10:00:00Z', end: '2026-10-09T10:30:00Z' }))
    await settle()
    expect(env.resume).toHaveBeenCalledWith('cap-41', { title: 'Weekly sync' })
    expect(env.startForCapture).not.toHaveBeenCalled()
  })

  it('an id-only event opens the Captures card', async () => {
    await act(async () => env.fromEvent!({ id: 'ev-1' }))
    await settle()
    expect(opened).toEqual([expect.objectContaining({ from: 'desktop', spec: expect.objectContaining({ kind: 'list', entity_type: 'capture' }) })])
    expect(env.startForCapture).not.toHaveBeenCalled()
  })
})
