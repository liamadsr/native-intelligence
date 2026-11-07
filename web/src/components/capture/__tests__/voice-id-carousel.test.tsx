// @vitest-environment jsdom
/**
 * VoiceIdCarousel — Voice ID in the chat composer's slim row above the top
 * row: the detected speakers as a centred row of pills. When they fit, they sit
 * still. When they overflow, arrows appear either side and pan the row (never
 * past its ends — each arrow disables at its end), and otherwise it keeps
 * whoever is talking as near the middle as the ends allow. Renders nothing
 * until someone is heard, so the composer's row takes no room.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom lays nothing out: the stand-in lets a test fire the carousel's
// overflow measure once it has sized the boxes.
const resizeCallbacks = new Set<() => void>()
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  private cb: () => void
  constructor(cb: () => void) {
    this.cb = cb
    resizeCallbacks.add(cb)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallbacks.delete(this.cb)
  }
}

// The auto-accept countdown's tick store, as the provider keeps it: the latest
// tick per suggestion entry, notifying its subscribers on each.
const ticks = vi.hoisted(() => ({
  bySuggestion: new Map<object, number>(),
  listeners: new Set<() => void>(),
}))
vi.mock('@/hooks/recording-context', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useTranscriptSegments: () => [],
    useDetectedSpeakers: () => [],
    useFinalSegmentCount: () => 0,
    useAutoAcceptCountdown: (suggestion: { autoAcceptCountdown?: number }) =>
      useSyncExternalStore(
        (cb: () => void) => {
          ticks.listeners.add(cb)
          return () => {
            ticks.listeners.delete(cb)
          }
        },
        () => ticks.bySuggestion.get(suggestion) ?? suggestion.autoAcceptCountdown,
      ),
  }
})
// Every name a pill resolved — the unknown/identified pills resolve theirs on
// each render of the row, so it doubles as the row's render probe.
const displayNames = vi.hoisted(() => [] as string[])
vi.mock('@/hooks/use-recording', () => ({
  getSpeakerDisplayName: (speaker: string) => {
    displayNames.push(speaker)
    return speaker
  },
}))
vi.mock('@/components/desktop/speaker-contact-search', () => ({
  SpeakerContactSearch: ({ children }: { children?: ReactNode }) => children,
}))

import { VoiceIdCarousel } from '../live-capture-header'

let container: HTMLDivElement
let root: Root

const noop = () => {}
const speakers = (n: number) => Array.from({ length: n }, (_, i) => `local_${i}`)

function render(detectedSpeakers: string[], activeSpeaker: string | null = null) {
  act(() => {
    root.render(
      h(VoiceIdCarousel, {
        detectedSpeakers,
        activeSpeaker,
        speakerNames: {},
        speakerContacts: {},
        assignContact: noop,
        acceptSuggestion: noop,
        dismissSuggestion: noop,
        unlinkSpeaker: noop,
      }),
    )
  })
}

const row = () => container.querySelector<HTMLElement>('[data-voice-id-carousel]')!
const windowBox = () => row().querySelector<HTMLElement>(':scope > div')!
const track = () => windowBox().firstElementChild as HTMLElement
const arrow = (side: 'left' | 'right') =>
  row().querySelector<HTMLButtonElement>(`button[aria-label="Scroll speakers ${side}"]`)
const shift = () => track().style.transform

function size(el: HTMLElement, prop: 'offsetWidth' | 'clientWidth' | 'offsetLeft', value: number) {
  Object.defineProperty(el, prop, { configurable: true, get: () => value })
}

/** Lay the carousel out: a row with `room` px, the pills 90px wide 100px
 *  apart, and — overflowing — a 200px window between the arrows. */
function layOut(room: number, count: number) {
  size(row(), 'clientWidth', room)
  size(track(), 'offsetWidth', count * 100)
  size(windowBox(), 'offsetWidth', count * 100 > room ? 200 : count * 100)
  ;[...track().children].forEach((pill, i) => {
    size(pill as HTMLElement, 'offsetLeft', i * 100)
    size(pill as HTMLElement, 'offsetWidth', 90)
  })
  act(() => resizeCallbacks.forEach((cb) => cb()))
}

beforeEach(() => {
  ticks.bySuggestion.clear()
  ticks.listeners.clear()
  displayNames.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resizeCallbacks.clear()
})

describe('VoiceIdCarousel', () => {
  it('renders nothing until someone is heard', () => {
    render([])
    expect(container.childElementCount).toBe(0)
  })

  it('sits still and centred while every speaker fits', () => {
    render(speakers(3), 'local_2')
    layOut(600, 3)
    expect(row().className).toMatch(/(^|\s)justify-center(\s|$)/)
    expect(arrow('left')).toBeNull()
    expect(arrow('right')).toBeNull()
    // Following the talker would slide the pills about; they fit, so it doesn't.
    expect(shift()).toBe('translateX(0px)')
    expect(container.textContent).toContain('local_0')
    expect(container.textContent).toContain('local_2')
  })

  it('becomes a carousel once they overflow: arrows pan it, and stop at its ends', () => {
    render(speakers(5))
    layOut(300, 5)
    // Room 300 against 500 of pills: arrows either side, a 200px window.
    expect(arrow('left')).not.toBeNull()
    expect(arrow('right')).not.toBeNull()
    expect(shift()).toBe('translateX(0px)')
    expect(arrow('left')!.disabled).toBe(true)
    expect(arrow('right')!.disabled).toBe(false)

    // Each press pans most of the window's width (0.6 × 200).
    act(() => arrow('right')!.click())
    expect(shift()).toBe('translateX(-120px)')
    expect(arrow('left')!.disabled).toBe(false)
    act(() => arrow('right')!.click())
    expect(shift()).toBe('translateX(-240px)')
    // Never past the end (200 - 500 = -300).
    act(() => arrow('right')!.click())
    expect(shift()).toBe('translateX(-300px)')
    expect(arrow('right')!.disabled).toBe(true)

    act(() => arrow('left')!.click())
    expect(shift()).toBe('translateX(-180px)')
  })

  it('keeps whoever is talking as near the middle as its ends allow', () => {
    render(speakers(5), 'local_2')
    layOut(300, 5)
    // local_2's centre (245) to the window's (100).
    expect(shift()).toBe('translateX(-145px)')

    render(speakers(5), 'local_4')
    // Centring local_4 (445) would run past the end; it stops there.
    expect(shift()).toBe('translateX(-300px)')
  })

  it('a suggestion counts down to auto-accept, and each tick repaints only its number', () => {
    const suggestion = {
      contactId: 'c-ada',
      contactName: 'Ada',
      confidence: 0.91,
      isAutoMatched: false,
      isSuggestion: true,
      trustTier: 'recognizing' as const,
      autoAcceptCountdown: 3,
    }
    act(() => {
      root.render(
        h(VoiceIdCarousel, {
          detectedSpeakers: ['local_0', 'remote_1'],
          activeSpeaker: 'remote_1',
          speakerNames: {},
          speakerContacts: { remote_1: suggestion },
          assignContact: noop,
          acceptSuggestion: noop,
          dismissSuggestion: noop,
          unlinkSpeaker: noop,
        }),
      )
    })
    const chip = () => track().querySelector<HTMLElement>('[data-speaker="remote_1"]')!
    expect(chip().textContent).toContain('Ada (91%)')
    // Before the first tick: the suggestion's own starting value.
    expect(chip().textContent).toContain('3s')
    const rowRenders = displayNames.length

    act(() => {
      ticks.bySuggestion.set(suggestion, 2)
      ticks.listeners.forEach((cb) => cb())
    })
    expect(chip().textContent).toContain('2s')
    expect(chip().textContent).not.toContain('3s')
    // The speakers row didn't re-render for it — only the number did.
    expect(displayNames.length).toBe(rowRenders)
  })

  it('a suggestion with no countdown shows no timer', () => {
    act(() => {
      root.render(
        h(VoiceIdCarousel, {
          detectedSpeakers: ['remote_1'],
          activeSpeaker: null,
          speakerNames: {},
          speakerContacts: {
            remote_1: { contactId: 'c-ada', contactName: 'Ada', confidence: 0.6, isAutoMatched: false, isSuggestion: true, isLearningMatch: true },
          },
          assignContact: noop,
          acceptSuggestion: noop,
          dismissSuggestion: noop,
          unlinkSpeaker: noop,
        }),
      )
    })
    expect(track().textContent).toContain('Possible: Ada?')
    expect(track().querySelector('.tabular-nums')).toBeNull()
  })
})
