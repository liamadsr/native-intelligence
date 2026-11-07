// @vitest-environment jsdom
/**
 * Listen mode's pulse (../listen-frame): each content window is a ListenFrame
 * that its Listen targets register with. With the real section player, listen
 * mode and Listen targets, the desktop bridge mocked, and border-beam replaced
 * by a stub that shows its props (jsdom runs no CSS animations):
 *  - border-beam isn't fetched until a window first lights (it is a
 *    React.lazy chunk; once here it stays, so that test runs first);
 *  - a window holding a Listen target pulses when it is the focused window,
 *    or when one of its targets is reading (one that reads on after focus
 *    moved away), whether listen mode is on or off; an unfocused window whose
 *    target isn't reading, and a window with no target, stay still;
 *  - the next item loading in place of the last (its target gone for a
 *    moment) keeps the pulse steady; a window stills once it has held no
 *    target for LISTEN_TARGET_GAP_MS;
 *  - nothing pulses while read-aloud can't play, or in a window not drawn;
 *  - the window losing what lit it (focus moved away, nothing reading there):
 *    the beam goes inactive (it fades), then unmounts, when its fade ends or,
 *    when no fade runs, after LISTEN_PULSE_FADE_OUT_MS; lit again mid-fade,
 *    it stays;
 *  - something to read here, the top bar toggle's cue: the window the user works
 *    in (focused, drawn) holding a Listen target; held while the next item
 *    loads in place of the last, gone when the window closes;
 *  - what comes next here, the top bar's Next button: by the same rules, the
 *    offer of the window the user works in's target (Mail's next thread), one
 *    stable offer that calls the target's latest `go`; held while the next
 *    item loads, gone with the target, the focus or the window;
 *  - the window in front's target, for Interactive mode (getFrontListenTarget):
 *    the latest target in the window the user works in, with its controls:
 *    resume reads its item again from the paused sentence, describe is what
 *    it says about itself; none in an unfocused window or with none open;
 *  - the beam: pulse-inner in mono, brightened by theme, otherwise as border-beam's docs ship it (no strength of its own), at the window's own size, over a soft edge halo of our own (by theme), a click-through overlay over the
 *    content, in the app's theme (the `dark` class), not the system's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'
import type { TtsStatePayload } from '@/lib/tauri-bridge'
import type { BorderBeamProps } from 'border-beam'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({ calls: [] as string[] }))
const beamModule = vi.hoisted(() => ({ loads: 0 }))

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async () => void bridge.calls.push('speak'),
    ttsCancel: async () => void bridge.calls.push('cancel'),
    ttsPrepare: async () => void bridge.calls.push('prepare'),
    onTtsState: (_cb: (p: TtsStatePayload) => void) => () => {},
  },
}))

// The stub shows the props it got; its button stands in for the fade-out's end
// (border-beam calls onDeactivate from its animationend).
vi.mock('border-beam', async () => {
  beamModule.loads++
  const { createElement } = await import('react')
  return {
    BorderBeam: ({ active, size, colorVariant, theme, strength, brightness, className, onDeactivate, children }: BorderBeamProps) =>
      createElement(
        'div',
        {
          'data-beam': active ? 'active' : 'inactive',
          'data-size': size,
          'data-color-variant': colorVariant,
          'data-theme': theme,
          'data-strength': strength === undefined ? undefined : String(strength),
          'data-brightness': brightness === undefined ? undefined : String(brightness),
          className,
        },
        children,
        createElement('button', { type: 'button', 'data-beam-faded': '', onClick: () => onDeactivate?.() }),
      ),
  }
})

import {
  ListenFrame,
  LISTEN_PULSE_BRIGHTNESS,
  LISTEN_PULSE_FADE_OUT_MS,
  LISTEN_PULSE_HALO,
  LISTEN_TARGET_GAP_MS,
  getFrontListenTarget,
  useListenNextHere,
  useListenReadableHere,
  type ListenNext,
} from '../listen-frame'
import { ListenTarget } from '../listen-target'
import {
  __resetSectionPlayerForTests,
  getSectionPlayerSnapshot,
  pauseSection,
  playSection,
  setSectionPlayerSupported,
} from '@/lib/read-aloud/section-player'
import { __resetResumePointsForTests, getResumePoint, setResumePoint } from '@/lib/read-aloud/resume-points'
import { __resetListenModeForTests, isListenModeOn, setListenMode } from '@/lib/read-aloud/listen-mode'
import { WindowFocusProvider } from '@/components/views/unified-view-layout'

interface WindowSpec {
  id: string
  focused?: boolean
  drawn?: boolean
  /** Listen targets (an email thread, an action, a document). */
  targets?: string[]
  /** What the targets offer next (Mail's next thread). */
  next?: ListenNext
}

const SENTENCES: Record<string, string[]> = {
  'email:m1': ['From Sarah, about Q3.', 'Tuesday works.'],
  'doc:2': ['Launch plan.', 'We ship on Friday.'],
  'doc:empty': [],
}
const sentencesOf = (key: string) => () => SENTENCES[key] ?? ['One.', 'Two.']

/** A content window: its frame, the focus signal TabContent gives the page,
 *  and the page's Listen targets. */
function contentWindow({ id, focused = false, drawn = true, targets = [], next }: WindowSpec) {
  const page: ReactNode[] = targets.map((key) =>
    h(ListenTarget, { key, listenKey: key, getSentences: sentencesOf(key), next }),
  )
  return h(
    'div',
    { key: id, 'data-window': id },
    h(ListenFrame, {
      focused,
      drawn,
      children: h(WindowFocusProvider, { isFocused: focused, children: page }),
    }),
  )
}

let container: HTMLDivElement
let root: Root

async function render(...windows: WindowSpec[]) {
  await renderNow(...windows)
  await settle()
}

/** What the top bar's toggle reads: can the window the user works in read
 *  something now. */
function ReadableProbe() {
  return h('span', { 'data-readable': String(useListenReadableHere()) })
}
const readableHere = () => container.querySelector<HTMLElement>('[data-readable]')?.dataset.readable === 'true'

/** What the top bar's Next button reads: what the window the user works in
 *  offers next, kept here to call and compare. */
let nextHere: ListenNext | null = null
function NextProbe() {
  nextHere = useListenNextHere()
  return null
}

/** Without waiting on timers: for fake-timer tests. */
async function renderNow(...windows: WindowSpec[]) {
  await act(async () =>
    root.render(
      h('div', null, [h(ReadableProbe, { key: '__readable' }), h(NextProbe, { key: '__next' }), ...windows.map(contentWindow)]),
    ),
  )
}

/** Effects and the store updates they cause, all flushed. */
async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Waits (inside act) until `check` holds: border-beam's first load is a
 *  React.lazy chunk, and React may hold back a Suspense reveal for a moment. */
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  expect(check()).toBe(true)
}

const pulse = (id: string) => container.querySelector<HTMLElement>(`[data-window="${id}"] [data-listen-pulse]`)
const beam = (id: string) => container.querySelector<HTMLElement>(`[data-window="${id}"] [data-beam]`)
const fadeEnds = async (id: string) => {
  await act(async () => container.querySelector<HTMLButtonElement>(`[data-window="${id}"] [data-beam-faded]`)!.click())
}
const playing = () => getSectionPlayerSnapshot().playingKey

beforeEach(() => {
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  __resetListenModeForTests()
  bridge.calls = []
  setSectionPlayerSupported(true)
  document.documentElement.classList.remove('dark')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => root.unmount())
  container.remove()
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  __resetListenModeForTests()
  document.documentElement.classList.remove('dark')
})

describe('ListenFrame — the pulse', () => {
  // First: border-beam's module, once fetched, stays for the rest of the file.
  it('border-beam is not fetched, and nothing is drawn, until a window first lights: the focused one holding a Listen target', async () => {
    await render({ id: 'a', focused: true })
    expect(pulse('a')).toBeNull()
    expect(beamModule.loads).toBe(0)

    await render({ id: 'a', focused: true, targets: ['email:m1'] })
    await until(() => beam('a') !== null)
    expect(beamModule.loads).toBe(1)
    expect(beam('a')?.dataset.beam).toBe('active')
  })

  it('lights whether listen mode is on or off: the hue marks the window listen mode reads, the toggle says whether it is on', async () => {
    expect(isListenModeOn()).toBe(false)
    await render({ id: 'a', focused: true, targets: ['email:m1'] }, { id: 'b', targets: ['doc:2'] })
    // Off: nothing reads, and the focused window is lit all the same.
    expect(playing()).toBeNull()
    expect(beam('a')?.dataset.beam).toBe('active')
    expect(pulse('a')?.dataset.listenPulse).toBe('on')
    expect(pulse('b')).toBeNull()

    await act(async () => setListenMode(true))
    await settle()
    expect(playing()).toBe('email:m1')
    expect(beam('a')?.dataset.beam).toBe('active')
    expect(pulse('b')).toBeNull()

    // Off again: what played pauses; the window stays lit, nothing fades.
    await act(async () => setListenMode(false))
    expect(playing()).toBeNull()
    expect(beam('a')?.dataset.beam).toBe('active')
    expect(pulse('a')?.dataset.listenPulse).toBe('on')
  })

  it('the focused window holding a Listen target pulses; an unfocused one whose target is not reading, and one with no target, stay still', async () => {
    setListenMode(true)
    await render(
      { id: 'a', focused: true, targets: ['email:m1'] },
      { id: 'b', targets: ['doc:2'] },
      { id: 'c' },
    )
    expect(playing()).toBe('email:m1')
    expect(beam('a')?.dataset.beam).toBe('active')
    expect(pulse('a')?.dataset.listenPulse).toBe('on')
    expect(pulse('b')).toBeNull()
    expect(pulse('c')).toBeNull()
  })

  it('the focused window pulses though its target has nothing to read', async () => {
    setListenMode(true)
    await render({ id: 'a', focused: true, targets: ['doc:empty'] })
    expect(playing()).toBeNull()
    expect(beam('a')?.dataset.beam).toBe('active')
  })

  it('a focused window with no Listen target stays still', async () => {
    setListenMode(true)
    await render({ id: 'a', focused: true }, { id: 'b', targets: ['doc:2'] })
    expect(pulse('a')).toBeNull()
    expect(pulse('b')).toBeNull()
  })

  it('an unfocused window pulses while one of its targets reads: it read on after focus moved away', async () => {
    setListenMode(true)
    await render({ id: 'a', focused: true, targets: ['email:m1'] }, { id: 'b', targets: ['doc:2'] })
    expect(pulse('b')).toBeNull()

    // b's document reads on (it was the focused window when it started).
    await act(async () => playSection('doc:2', SENTENCES['doc:2']))
    await settle()
    expect(playing()).toBe('doc:2')
    expect(beam('b')?.dataset.beam).toBe('active')
    // The focused window still holds a target: it stays lit.
    expect(beam('a')?.dataset.beam).toBe('active')

    // Reading moves on to a key no window here holds: b stills.
    await act(async () => playSection('md:elsewhere', ['Elsewhere.']))
    expect(beam('b')?.dataset.beam).toBe('inactive')
    expect(beam('a')?.dataset.beam).toBe('active')
  })

  it('a window losing what lit it (focus moved away, its reading over): the beams go inactive and fade, then unmount once faded', async () => {
    await render({ id: 'a', focused: true, targets: ['email:m1'] }, { id: 'b', targets: ['doc:2'] })
    await act(async () => playSection('doc:2', SENTENCES['doc:2']))
    expect(beam('a')?.dataset.beam).toBe('active')
    expect(beam('b')?.dataset.beam).toBe('active')

    // Focus leaves a (for a window with nothing to read), and b's reading
    // moves on to a key no window here holds.
    await render({ id: 'a', focused: false, targets: ['email:m1'] }, { id: 'b', targets: ['doc:2'] }, { id: 'c', focused: true })
    await act(async () => playSection('md:elsewhere', ['Elsewhere.']))
    expect(beam('a')?.dataset.beam).toBe('inactive')
    expect(beam('b')?.dataset.beam).toBe('inactive')
    expect(pulse('a')?.dataset.listenPulse).toBe('fading')
    // The halo fades with the beam.
    const halo = pulse('a')!.querySelector<HTMLElement>('[data-listen-pulse-halo]')!
    expect(halo.dataset.listenPulseHalo).toBe('off')
    expect(halo.style.opacity).toBe('0')

    await fadeEnds('a')
    await fadeEnds('b')
    expect(pulse('a')).toBeNull()
    expect(pulse('b')).toBeNull()
  })

  it('a fade that never reports its end (reduced motion, a hidden window) unmounts after LISTEN_PULSE_FADE_OUT_MS', async () => {
    await render({ id: 'a', focused: true, targets: ['email:m1'] })
    expect(beam('a')?.dataset.beam).toBe('active')

    vi.useFakeTimers()
    await renderNow({ id: 'a', focused: false, targets: ['email:m1'] })
    expect(beam('a')?.dataset.beam).toBe('inactive')
    act(() => vi.advanceTimersByTime(LISTEN_PULSE_FADE_OUT_MS - 1))
    expect(pulse('a')).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(pulse('a')).toBeNull()
  })

  it('lit again mid-fade (focus back), it stays', async () => {
    await render({ id: 'a', focused: true, targets: ['email:m1'] })
    await render({ id: 'a', focused: false, targets: ['email:m1'] })
    expect(beam('a')?.dataset.beam).toBe('inactive')
    await render({ id: 'a', focused: true, targets: ['email:m1'] })
    expect(beam('a')?.dataset.beam).toBe('active')
    // The old fade's end arriving now takes nothing down.
    await fadeEnds('a')
    expect(beam('a')?.dataset.beam).toBe('active')
  })

  it('the next item loading in place of the last keeps the pulse steady; the item closed, the window stills after LISTEN_TARGET_GAP_MS', async () => {
    setListenMode(true)
    await render({ id: 'a', focused: true, targets: ['email:m1'] })
    expect(beam('a')?.dataset.beam).toBe('active')

    vi.useFakeTimers()
    // The skeleton while the next email loads: no target for a moment…
    await renderNow({ id: 'a', focused: true })
    act(() => vi.advanceTimersByTime(LISTEN_TARGET_GAP_MS - 100))
    expect(beam('a')?.dataset.beam).toBe('active')
    // …then the next email: the pulse never dipped.
    await renderNow({ id: 'a', focused: true, targets: ['email:m2'] })
    act(() => vi.advanceTimersByTime(LISTEN_TARGET_GAP_MS))
    expect(beam('a')?.dataset.beam).toBe('active')

    // Closed for good: it stills once the gap has lasted.
    await renderNow({ id: 'a', focused: true })
    act(() => vi.advanceTimersByTime(LISTEN_TARGET_GAP_MS - 1))
    expect(beam('a')?.dataset.beam).toBe('active')
    act(() => vi.advanceTimersByTime(1))
    expect(beam('a')?.dataset.beam).toBe('inactive')
  })

  it('stays still while read-aloud cannot play (a capture recording), and in a window not drawn (a background tab, tucked)', async () => {
    setListenMode(true)
    await render({ id: 'a', focused: true, targets: ['email:m1'] }, { id: 'b', drawn: false, focused: false, targets: ['doc:2'] })
    await act(async () => playSection('doc:2', SENTENCES['doc:2']))
    expect(beam('a')?.dataset.beam).toBe('active')
    expect(pulse('b')).toBeNull()

    await act(async () => setSectionPlayerSupported(false))
    expect(beam('a')?.dataset.beam).toBe('inactive')

    await act(async () => setSectionPlayerSupported(true))
    await render({ id: 'a', focused: true, drawn: false, targets: ['email:m1'] })
    expect(beam('a')?.dataset.beam).toBe('inactive')
  })

  it("pulse-inner in mono, brightened, with border-beam's own defaults otherwise, as a click-through overlay over the content", async () => {
    setListenMode(true)
    await render({ id: 'a', focused: true, targets: ['email:m1'] })
    const b = beam('a')!
    expect(b.dataset.size).toBe('pulse-inner')
    // Mono (grey and white), brightened for the theme (light here: no `dark`
    // class); the docs' strength (1), not overridden.
    expect(b.dataset.colorVariant).toBe('mono')
    expect(b.dataset.strength).toBeUndefined()
    expect(b.dataset.brightness).toBe(String(LISTEN_PULSE_BRIGHTNESS.light))

    const overlay = pulse('a')!
    expect(overlay.getAttribute('aria-hidden')).toBe('true')
    for (const cls of ['pointer-events-none', 'absolute', 'inset-0', 'z-20']) {
      expect(overlay.classList.contains(cls), cls).toBe(true)
    }
    // The beam wraps an empty div carrying the window's inner radius, at the
    // window's own size: nothing scales it.
    const shape = b.firstElementChild as HTMLElement
    expect(shape.tagName).toBe('DIV')
    expect(shape.childElementCount).toBe(0)
    expect(shape.style.borderRadius).toBe('23px')
    expect(overlay.querySelector('[style*="scale"]')).toBeNull()
    expect(overlay.classList.contains('overflow-hidden')).toBe(true)

    // Under the beam, our own soft edge halo (light theme here), in the same
    // click-through overlay, shown once mounted.
    const halo = overlay.querySelector<HTMLElement>('[data-listen-pulse-halo]')!
    expect(halo.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect((halo.firstElementChild as HTMLElement).style.boxShadow).toBe(LISTEN_PULSE_HALO.light)
    await until(() => halo.dataset.listenPulseHalo === 'on')
    expect(halo.style.opacity).toBe('1')
  })

  it('follows the app theme (the dark class on <html>), not the system one', async () => {
    const matchMedia = vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }))
    vi.stubGlobal('matchMedia', matchMedia)
    try {
      setListenMode(true)
      await render({ id: 'a', focused: true, targets: ['email:m1'] })
      expect(beam('a')?.dataset.theme).toBe('light')

      await act(async () => {
        document.documentElement.classList.add('dark')
        await Promise.resolve()
      })
      expect(beam('a')?.dataset.theme).toBe('dark')
      // And its brightness with it: toward white on dark; and the halo.
      expect(beam('a')?.dataset.brightness).toBe(String(LISTEN_PULSE_BRIGHTNESS.dark))
      const halo = pulse('a')!.querySelector<HTMLElement>('[data-listen-pulse-halo]')!
      expect((halo.firstElementChild as HTMLElement).style.boxShadow).toBe(LISTEN_PULSE_HALO.dark)

      await act(async () => {
        document.documentElement.classList.remove('dark')
        await Promise.resolve()
      })
      expect(beam('a')?.dataset.theme).toBe('light')
      expect(matchMedia).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('ListenFrame — something to read here (the Listen mode toggle shows on it)', () => {
  it('the window the user works in, holding an email, action or document, can read', async () => {
    await render({ id: 'a', focused: true, targets: ['email:m1'] })
    expect(readableHere()).toBe(true)
  })

  it('nothing to read: no target open there, or the window holding one unfocused or not drawn', async () => {
    await render(
      { id: 'a', focused: true },
      { id: 'b', focused: false, targets: ['doc:2'] },
      { id: 'c', focused: true, drawn: false, targets: ['email:m1'] },
    )
    expect(readableHere()).toBe(false)
  })

  it('whether listen mode is on or not', async () => {
    setListenMode(false)
    await render({ id: 'a', focused: true, targets: ['doc:2'] })
    expect(readableHere()).toBe(true)
  })

  it('held while the next item loads in place of the last; closed, it goes after LISTEN_TARGET_GAP_MS', async () => {
    await render({ id: 'a', focused: true, targets: ['email:m1'] })
    expect(readableHere()).toBe(true)

    vi.useFakeTimers()
    await renderNow({ id: 'a', focused: true })
    act(() => vi.advanceTimersByTime(LISTEN_TARGET_GAP_MS - 100))
    expect(readableHere()).toBe(true)
    await renderNow({ id: 'a', focused: true, targets: ['email:m2'] })
    act(() => vi.advanceTimersByTime(LISTEN_TARGET_GAP_MS))
    expect(readableHere()).toBe(true)

    await renderNow({ id: 'a', focused: true })
    act(() => vi.advanceTimersByTime(LISTEN_TARGET_GAP_MS))
    expect(readableHere()).toBe(false)
  })

  it('focus moving to a window with nothing open takes it away, and back brings it', async () => {
    await render({ id: 'a', focused: true, targets: ['email:m1'] }, { id: 'b' })
    expect(readableHere()).toBe(true)
    await render({ id: 'a', targets: ['email:m1'] }, { id: 'b', focused: true })
    expect(readableHere()).toBe(false)
    await render({ id: 'a', focused: true, targets: ['email:m1'] }, { id: 'b' })
    expect(readableHere()).toBe(true)
  })

  it('the window closing takes its report with it', async () => {
    await render({ id: 'a', focused: true, targets: ['email:m1'] })
    expect(readableHere()).toBe(true)
    await render()
    expect(readableHere()).toBe(false)
  })
})

describe('ListenFrame — what comes next here (the Next button beside the toggle)', () => {
  it("the window the user works in offers its target's next; one stable offer, calling the target's latest go", async () => {
    const first = vi.fn()
    await render({ id: 'a', focused: true, targets: ['email:m1'], next: { label: 'Next thread', go: first } })
    expect(nextHere?.label).toBe('Next thread')
    const offer = nextHere
    act(() => nextHere!.go())
    expect(first).toHaveBeenCalledTimes(1)

    // The page re-renders with a new go: the same offer, calling the new one.
    const second = vi.fn()
    await render({ id: 'a', focused: true, targets: ['email:m1'], next: { label: 'Next thread', go: second } })
    expect(nextHere).toBe(offer)
    act(() => nextHere!.go())
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('none: a target that offers none, or the window holding one unfocused or not drawn', async () => {
    const next = { label: 'Next thread', go: () => {} }
    await render({ id: 'a', focused: true, targets: ['email:m1'] })
    expect(readableHere()).toBe(true)
    expect(nextHere).toBeNull()

    await render({ id: 'a', targets: ['email:m1'], next }, { id: 'b', focused: true })
    expect(nextHere).toBeNull()
    await render({ id: 'a', focused: true, drawn: false, targets: ['email:m1'], next })
    expect(nextHere).toBeNull()
    // Focus back: it comes back.
    await render({ id: 'a', focused: true, targets: ['email:m1'], next })
    expect(nextHere?.label).toBe('Next thread')
  })

  it('held while the next item loads in place of the last; the item closed, it goes after LISTEN_TARGET_GAP_MS', async () => {
    const go = vi.fn()
    await render({ id: 'a', focused: true, targets: ['email:m1'], next: { label: 'Next thread', go } })
    expect(nextHere?.label).toBe('Next thread')

    vi.useFakeTimers()
    // Loading the next thread: no target for a moment, the offer holds, and
    // still goes where the last one said.
    await renderNow({ id: 'a', focused: true })
    act(() => vi.advanceTimersByTime(LISTEN_TARGET_GAP_MS - 100))
    expect(nextHere?.label).toBe('Next thread')
    act(() => nextHere!.go())
    expect(go).toHaveBeenCalledTimes(1)
    await renderNow({ id: 'a', focused: true, targets: ['email:m2'], next: { label: 'Next thread', go } })
    act(() => vi.advanceTimersByTime(LISTEN_TARGET_GAP_MS))
    expect(nextHere?.label).toBe('Next thread')

    // The last thread: its target offers none.
    await renderNow({ id: 'a', focused: true, targets: ['email:m3'] })
    expect(nextHere).toBeNull()

    // Closed: gone once the gap has passed.
    await renderNow({ id: 'a', focused: true, targets: ['email:m2'], next: { label: 'Next thread', go } })
    expect(nextHere?.label).toBe('Next thread')
    await renderNow({ id: 'a', focused: true })
    act(() => vi.advanceTimersByTime(LISTEN_TARGET_GAP_MS))
    expect(nextHere).toBeNull()
  })

  it('the window closing takes its offer with it', async () => {
    await render({ id: 'a', focused: true, targets: ['email:m1'], next: { label: 'Next thread', go: () => {} } })
    expect(nextHere?.label).toBe('Next thread')
    await render()
    expect(nextHere).toBeNull()
  })
})

describe('ListenFrame — the window in front’s target (Interactive mode)', () => {
  it('the latest target in the window the user works in, with its controls; none elsewhere', async () => {
    await render({ id: 'a', focused: false, targets: ['email:m1'] }, { id: 'b', focused: true, targets: ['doc:2'] })
    expect(getFrontListenTarget()?.key).toBe('doc:2')
    expect(getFrontListenTarget()?.describe?.()).toBeNull()

    await render({ id: 'a', focused: true, targets: ['email:m1'] }, { id: 'b', focused: false, targets: ['doc:2'] })
    expect(getFrontListenTarget()?.key).toBe('email:m1')

    await render({ id: 'a', focused: false, targets: ['email:m1'] })
    expect(getFrontListenTarget()).toBeNull()
    await render()
    expect(getFrontListenTarget()).toBeNull()
  })

  it('resume reads its item again from the sentence it was paused in (while listen mode is on)', async () => {
    await render({ id: 'a', focused: true, targets: ['doc:2'] })
    // Listen mode off: nothing.
    act(() => getFrontListenTarget()!.resume())
    expect(playing()).toBeNull()

    // On (which reads it, by the target's own rule), then paused in its
    // second sentence, as Interactive mode pauses it on the name.
    act(() => setListenMode(true))
    await settle()
    act(() => pauseSection('doc:2'))
    act(() => setResumePoint('doc:2', 1))
    expect(playing()).toBeNull()
    bridge.calls = []
    act(() => getFrontListenTarget()!.resume())
    expect(playing()).toBe('doc:2')
    // It took its place: it plays from the second sentence.
    expect(getResumePoint('doc:2')).toBeNull()
    await settle()
    expect(bridge.calls.filter((c) => c === 'speak')).toHaveLength(1)
  })

  it('a target that describes itself (a browser page) hands that over', async () => {
    const describe = () => ({ title: 'Inbox', site: 'outlook' })
    await act(async () =>
      root.render(
        h(
          'div',
          { 'data-window': 'w' },
          h(ListenFrame, {
            focused: true,
            drawn: true,
            children: h(WindowFocusProvider, {
              isFocused: true,
              children: h(ListenTarget, { listenKey: 'browser-highlight:w:none', getSentences: () => [], describe }),
            }),
          }),
        ),
      ),
    )
    await settle()
    expect(getFrontListenTarget()?.describe?.()).toEqual({ title: 'Inbox', site: 'outlook' })
  })
})
