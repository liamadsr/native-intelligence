// @vitest-environment jsdom
/**
 * The recording pill's RETURN: clicking "Recording ←" brings the live capture
 * back as its card (P5: every way in opens a card): it opens in the main chat,
 * reusing the one already there (which docks it). There is one chat
 * (docs/plans/one-chat.md), so nothing switches.
 *
 * And where the recording's controls are: while a live agent's HUD shows them
 * for this capture (it claimed them: lib/live-agent/hud-recording.ts) the
 * pill steps aside; until a HUD does, or once it lets go, the pill is back
 * with pause and stop, so a recording can always be stopped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, forwardRef, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true


vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({
    isRecording: true,
    isStarting: false,
    captureId: 'cap-live',
    recordingError: null,
    transcriptionStatus: 'connected',
    startRecording: vi.fn(),
    isPaused: false,
    isAgentFinalizing: false,
    pauseRecording: () => {},
    resumeRecording: () => {},
    stopRecording: () => {},
  }),
  useRecordingElapsed: () => 91,
}))
vi.mock('@/hooks/use-recording', () => ({ formatTime: () => '1:31' }))
vi.mock('@/components/desktop-titlebar', () => ({
  useIsDesktop: () => true,
  subscribeMounted: () => () => {},
  getMountedSnapshot: () => true,
  getMountedServerSnapshot: () => false,
}))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}))
vi.mock('@/app/account/(dashboard)/top-bar/capture-calendar', () => ({ CaptureCalendar: () => null }))
vi.mock('liquid-gooey', () => {
  const Liquid = Object.assign(
    forwardRef<HTMLDivElement, Record<string, unknown>>(function Liquid(props, ref) {
      const { blur: _b, contrast: _c, fill: _f, shadow: _s, filterPadding: _p, children, ...rest } = props
      return h('div', { ...rest, ref }, children as ReactNode)
    }),
    {
      Item: ({ className, children }: { className?: string; children?: ReactNode }) =>
        h('div', { className, 'data-item': '' }, children),
    },
  )
  return { Liquid }
})

import { CaptureBarButton } from '../capture-bar-button'
import { OPEN_CARD_EVENT, type OpenCardRequest } from '@/lib/chat-cards/open-card'
import { __resetHudRecordingControlsForTests, claimHudRecordingControls } from '@/lib/live-agent/hud-recording'

let container: HTMLDivElement
let root: Root
let opened: OpenCardRequest[] = []
const onOpen = (e: Event) => opened.push((e as CustomEvent<OpenCardRequest>).detail)

function render() {
  act(() => {
    root.render(h(CaptureBarButton, { cardSide: 'top' }))
  })
}

const button = () => container.querySelector<HTMLButtonElement>('[data-onboarding-target="capture"]')!
const hasArrow = () => !!button().querySelector('svg.lucide-arrow-left')
const click = () => act(() => button().dispatchEvent(new MouseEvent('click', { bubbles: true })))

beforeEach(() => {
  opened = []
  window.addEventListener(OPEN_CARD_EVENT, onOpen)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  __resetHudRecordingControlsForTests()
  act(() => root.unmount())
  container.remove()
  window.removeEventListener(OPEN_CARD_EVENT, onOpen)
})

describe('the recording pill — return to the live capture', () => {
  it('shows the ← while recording', () => {
    render()
    expect(hasArrow()).toBe(true)
  })

  it('opens the capture card in the main chat, reusing the one there', () => {
    render()
    click()
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ from: 'capture', reuse: true, spec: { kind: 'record', record: { type: 'capture', id: 'cap-live' } } })
  })
})

describe('the recording controls moved to the HUD', () => {
  const stop = () => container.querySelector<HTMLButtonElement>('button[aria-label="Stop recording"]')
  const pause = () => container.querySelector<HTMLButtonElement>('button[aria-label="Pause recording"]')

  it('steps aside while a HUD shows them for this capture, and is back (stop and all) when it lets go', () => {
    render()
    expect(stop()).not.toBeNull()
    let release!: () => void
    act(() => {
      release = claimHudRecordingControls('cap-live')
    })
    expect(container.querySelector('[data-capture-liquid]')).toBeNull()
    expect(stop()).toBeNull()
    act(() => release())
    expect(stop()).not.toBeNull()
    expect(pause()).not.toBeNull()
  })

  it("stays while no HUD shows them, or one shows another capture's", () => {
    act(() => {
      claimHudRecordingControls('cap-other')
    })
    render()
    expect(stop()).not.toBeNull()
    expect(pause()).not.toBeNull()
    expect(hasArrow()).toBe(true)
  })
})
