// @vitest-environment jsdom
/**
 * Capture in the composer (../composer-capture-button): the record icon when
 * idle ("Start capture", a click starts one), a pulsing dot while starting,
 * and while recording the way back, pause / resume and stop; nothing without
 * the recording (a composer that isn't the main chat's), or while the HUD
 * shows the recording's controls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rec = vi.hoisted(() => ({ value: null as Record<string, unknown> | null, inHud: false, desktop: false }))
vi.mock('@/components/desktop-titlebar', () => ({ useIsDesktop: () => rec.desktop }))
vi.mock('@/lib/live-agent/hud-recording', () => ({
  hudShowsRecordingControls: () => rec.inHud,
  subscribeHudRecordingControls: () => () => {},
}))
const opened = vi.hoisted(() => vi.fn())
vi.mock('@/components/read-aloud/listen-metal', () => ({ MetalRing: () => null }))
vi.mock('@/components/capture/recording-status', () => ({
  openActiveCapture: opened,
  recordingDotClass: () => 'bg-red-500',
}))

import { ComposerCaptureButton, type ComposerRecording } from '../composer-capture-button'

let container: HTMLDivElement
let root: Root
const actions = () => ({
  startRecording: vi.fn(),
  pauseRecording: vi.fn(),
  resumeRecording: vi.fn(),
  stopRecording: vi.fn(),
})
let fns: ReturnType<typeof actions>

function state(over: Record<string, unknown>) {
  fns = actions()
  rec.value = { isRecording: false, isStarting: false, captureId: null, transcriptionStatus: 'connected', isPaused: false, isAgentFinalizing: false, ...fns, ...over }
}
const render = () => act(() => root.render(h(TooltipProvider, null, h(ComposerCaptureButton, { recording: rec.value as unknown as ComposerRecording }))))
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

beforeEach(() => {
  rec.inHud = false
  rec.desktop = false
  opened.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Capture in the composer', () => {
  it('idle: the record icon alone, "Start capture"; a click starts one', () => {
    state({})
    render()
    const start = button('Start capture')!
    expect(start.getAttribute('data-composer-capture')).toBe('idle')
    expect(start.getAttribute('data-onboarding-target')).toBe('capture')
    expect(start.textContent).toBe('')
    expect(start.querySelector('svg.lucide-disc')).not.toBeNull()
    // Interactive's liquid metal rings it (over the button, fetched lazily), in
    // place of the old red ring; no fill at rest (the attach button's look).
    expect(start.parentElement?.hasAttribute('data-composer-capture-ring')).toBe(true)
    expect(start.className).not.toContain('ring-red')
    expect(start.className).not.toMatch(/(^|\s)bg-/)
    act(() => start.click())
    expect(fns.startRecording).toHaveBeenCalledTimes(1)
  })

  it('starting: a pulsing dot, and no second start', () => {
    state({ isStarting: true })
    render()
    const start = button('Start capture')!
    expect(start.getAttribute('data-composer-capture')).toBe('starting')
    expect(start.disabled).toBe(true)
    expect(start.querySelector('.animate-ping')).not.toBeNull()
  })

  it('recording: back to the live capture, pause / resume and stop', () => {
    state({ isRecording: true, captureId: 'cap-1' })
    render()
    expect(container.querySelector('[data-composer-capture="recording"]')).not.toBeNull()
    act(() => button('Return to active capture')!.click())
    expect(opened).toHaveBeenCalledWith('cap-1')
    act(() => button('Pause recording')!.click())
    expect(fns.pauseRecording).toHaveBeenCalledTimes(1)
    act(() => button('Stop recording')!.click())
    expect(fns.stopRecording).toHaveBeenCalledTimes(1)
    expect(button('Start capture')).toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    state({ isRecording: true, captureId: 'cap-1', isPaused: true })
    render()
    act(() => button('Resume recording')!.click())
    expect(fns.resumeRecording).toHaveBeenCalledTimes(1)
  })

  it('nothing while the HUD shows the recording’s controls', () => {
    state({ isRecording: true, captureId: 'cap-1' })
    rec.inHud = true
    render()
    expect(container.querySelector('button')).toBeNull()
  })
})
