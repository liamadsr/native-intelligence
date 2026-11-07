// @vitest-environment jsdom
/**
 * The Interactive toggle in the top bar (../listen-mode-toggle; it was "Listen
 * mode" until Interactive mode), with the real section player, listen mode and
 * Interactive stores, the desktop bridge mocked, and metal-fx replaced by a
 * stub that shows its props (jsdom has no WebGL2):
 *  - it renders only where read-aloud can play (never in a browser), and goes
 *    when that stops (a capture, dictation); and only while the window the
 *    user works in has something to read (../listen-frame), or while listen
 *    mode is on, so it can always be turned off;
 *  - a labelled button, its icon what a click does (Play while off, Pause
 *    while on): a click turns listen mode on (pressed), a click again turns
 *    it off, pausing what plays;
 *  - on, the button wears a colourful border (LISTEN_ON_RING: the rainbow
 *    ring on its rim over a glow), click-through, shown by opacity so the
 *    button's box never changes; off, it is faded out; with or without the
 *    metal;
 *  - it sits in a liquid-metal pill (../listen-metal), on and off alike.
 *    metal-fx isn't fetched until a toggle first shows (a React.lazy chunk;
 *    once here it stays, so that test runs first), and the button is plain
 *    meanwhile and wherever metal-fx can't draw;
 *  - the metal: the chromatic pill behind the button, click-through, hiding
 *    with the toggle's ancestors, in the app's theme (the `dark` class), held
 *    still under prefers-reduced-motion;
 *  - metal-fx's shared WebGL2 context is kept for the page's life by one still
 *    pill of the module's own, made once, before any pill mounts; where the
 *    engine can't start (metal-fx throws), the button is plain;
 *  - the button stays the same element as listen mode turns on and off, so it
 *    keeps focus;
 *  - while listen mode is on and the window the user works in offers what
 *    comes next (../listen-frame: Mail's next thread), a round Next button
 *    just before the toggle (so the toggle doesn't move in the right-aligned
 *    top bar), outside the metal pill, labelled with the offer,
 *    a press of it not dragging the window: a click goes; none while off or
 *    with nothing offered, and the toggle stays the same element as it comes
 *    and goes;
 *  - while it is on and the desktop runs Interactive's voice (voice_status
 *    `interactive`, voice available and ready), a round mic button just before the
 *    toggle, outside the metal: Mic, labelled "Mute microphone"; a click mutes
 *    (MicOff, "Unmute microphone", pressed) and unmutes; it shows the phase
 *    (listening for the name, heard you, thinking, answering, follow-up);
 *    a press is not a drag; none while off, without that desktop support, or
 *    in a browser, and the toggle stays the same element as it comes and goes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { MetalFxProps, createInstance } from 'metal-fx'
import type { TtsStatePayload } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** metal-fx doesn't export createInstance's options type. */
type CreateInstanceOptions = Parameters<typeof createInstance>[0]

const bridge = vi.hoisted(() => ({ calls: [] as string[] }))
// The desktop app, and its voice_status (no Interactive unless a test says so).
const desktop = vi.hoisted(() => ({
  app: false,
  voice: { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready' } as Record<string, unknown>,
}))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => desktop.app }))
vi.mock('@/lib/voice/status-store', () => ({ useVoiceStatus: () => desktop.voice }))
vi.mock('@/lib/voice/assistant-name-store', () => ({
  useAssistantName: () => ({ name: 'Joseph', saved: false, loaded: true }),
}))
const metalModule = vi.hoisted(() => ({
  loads: 0,
  supported: true,
  /** createInstance throws, as metal-fx does when its engine can't start. */
  engineFails: false,
  /** What createInstance was asked to make: the module's own still pill. */
  kept: [] as CreateInstanceOptions[],
}))

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async () => void bridge.calls.push('speak'),
    ttsCancel: async () => void bridge.calls.push('cancel'),
    ttsPrepare: async () => void bridge.calls.push('prepare'),
    onTtsState: (_cb: (p: TtsStatePayload) => void) => () => {},
  },
}))

// The stub shows the props it got.
vi.mock('metal-fx', async () => {
  metalModule.loads++
  const { createElement } = await import('react')
  return {
    isMetalFxSupported: () => metalModule.supported,
    createInstance: (opts: CreateInstanceOptions) => {
      if (metalModule.engineFails) throw new Error('metal-fx: WebGL2 not supported')
      metalModule.kept.push(opts)
      return {}
    },
    MetalFx: ({ children, preset, theme, paused, borderRadius, style, ...rest }: MetalFxProps) =>
      createElement(
        'div',
        {
          ...rest,
          'data-metal': '',
          'data-preset': preset,
          'data-theme': theme,
          'data-paused': String(paused),
          'data-radius': String(borderRadius),
          style,
        },
        children,
      ),
  }
})

import { LISTEN_ON_RING, ListenModeToggle } from '../listen-mode-toggle'
import { __setListenNextForTests, __setListenReadableForTests } from '../listen-frame'
import {
  __resetSectionPlayerForTests,
  getSectionPlayerSnapshot,
  playSection,
  setSectionPlayerSupported,
} from '@/lib/read-aloud/section-player'
import { __resetListenModeForTests, isListenModeOn } from '@/lib/read-aloud/listen-mode'
import { __resetResumePointsForTests, getResumePoint } from '@/lib/read-aloud/resume-points'
import {
  __resetInteractiveVoiceForTests,
  getInteractiveVoice,
  setInteractivePhase,
} from '@/lib/voice/interactive-store'

let container: HTMLDivElement
let root: Root

const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label="Interactive"]')
const micButton = () => container.querySelector<HTMLButtonElement>('button[data-interactive-mic]')
const metal = () => container.querySelector<HTMLElement>('[data-metal]')
const ring = () => container.querySelector<HTMLElement>('[data-listen-ring]')
const nextButton = () => container.querySelector<HTMLButtonElement>('button[data-listen-next]')

async function render(className?: string) {
  await act(async () => root.render(h(ListenModeToggle, { className })))
}

/** Waits (inside act) until `check` holds: the metal's first load is a
 *  React.lazy chunk, and React may hold back a Suspense reveal for a moment. */
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  expect(check()).toBe(true)
}

/** A few ticks for anything the lazy chunk would still render. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

/** jsdom has no matchMedia: a stand-in that answers prefers-reduced-motion. */
function stubReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}
const jsdomMatchMedia = window.matchMedia

beforeEach(() => {
  __resetSectionPlayerForTests()
  __resetListenModeForTests()
  __resetResumePointsForTests()
  __resetInteractiveVoiceForTests()
  desktop.app = false
  desktop.voice = { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready' }
  bridge.calls = []
  metalModule.supported = true
  // The window the user works in has something open to read, unless a test
  // says otherwise.
  __setListenReadableForTests(true)
  document.documentElement.classList.remove('dark')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  __resetSectionPlayerForTests()
  __resetListenModeForTests()
  __resetResumePointsForTests()
  __setListenReadableForTests(false)
  __setListenNextForTests(null)
  document.documentElement.classList.remove('dark')
  window.matchMedia = jsdomMatchMedia
})

describe('ListenModeToggle', () => {
  // First: metal-fx's module, once fetched, stays for the rest of the file.
  it('metal-fx is not fetched until a toggle first shows; then the metal comes, listen mode being off', async () => {
    await render()
    await settle()
    expect(metalModule.loads).toBe(0)

    await act(async () => setSectionPlayerSupported(true))
    expect(toggle()).not.toBeNull()
    await until(() => metal() !== null)
    expect(metalModule.loads).toBe(1)
    expect(isListenModeOn()).toBe(false)

    // On its first load, before any pill: one still pill of its own, drawn
    // nowhere, that keeps metal-fx's shared context for the page's life.
    expect(metalModule.kept).toHaveLength(1)
    const [kept] = metalModule.kept
    expect(kept.paused).toBe(true)
    expect(kept.hostCanvas.isConnected).toBe(false)
    expect([kept.cssWidth, kept.cssHeight]).toEqual([1, 1])
  })

  it('renders nothing where read-aloud cannot play', async () => {
    await render()
    expect(container.innerHTML).toBe('')
  })

  it('shows only while the window the user works in has something to read (an email, action or document open)', async () => {
    setSectionPlayerSupported(true)
    __setListenReadableForTests(false)
    await render()
    expect(container.innerHTML).toBe('')

    await act(async () => __setListenReadableForTests(true))
    expect(toggle()).not.toBeNull()

    await act(async () => __setListenReadableForTests(false))
    expect(container.innerHTML).toBe('')
  })

  it('stays while listen mode is on, with nothing to read here, so it can always be turned off', async () => {
    setSectionPlayerSupported(true)
    await render()
    await act(async () => toggle()!.click())
    expect(isListenModeOn()).toBe(true)

    await act(async () => __setListenReadableForTests(false))
    expect(toggle()).not.toBeNull()
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true')

    // Turned off there, it goes: nothing here to read.
    await act(async () => toggle()!.click())
    expect(isListenModeOn()).toBe(false)
    expect(container.innerHTML).toBe('')
  })

  it('a labelled button, "Interactive", off by default: a Play icon, in the metal pill', async () => {
    setSectionPlayerSupported(true)
    await render()
    const button = toggle()!
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.dataset.listenMode).toBe('off')
    expect(button.querySelector('svg')?.classList.contains('lucide-play')).toBe(true)
    expect(button.textContent).toBe('Interactive')
    await until(() => metal() !== null)
  })

  it('a click turns listen mode on (a Pause icon now), the metal staying; a click again turns it off (Play), pausing what plays', async () => {
    setSectionPlayerSupported(true)
    await render()
    await until(() => metal() !== null)
    const pill = metal()

    await act(async () => toggle()!.click())
    expect(isListenModeOn()).toBe(true)
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true')
    expect(toggle()!.dataset.listenMode).toBe('on')
    expect(toggle()!.querySelector('svg')?.classList.contains('lucide-pause')).toBe(true)
    // The same metal pill, still mounted.
    expect(metal()).toBe(pill)

    act(() => playSection('email:m2', ['One.', 'Two.']))
    await act(async () => toggle()!.click())
    expect(isListenModeOn()).toBe(false)
    expect(getSectionPlayerSnapshot().playingKey).toBeNull()
    expect(getResumePoint('email:m2')).toBe(0)
    expect(toggle()!.getAttribute('aria-pressed')).toBe('false')
    expect(toggle()!.querySelector('svg')?.classList.contains('lucide-play')).toBe(true)
    expect(metal()).toBe(pill)
  })

  it('the metal: the chromatic pill behind the button, over its box, click-through, hidden from assistive tech, hiding with its ancestors', async () => {
    setSectionPlayerSupported(true)
    await render()
    await until(() => metal() !== null)
    const pill = metal()!
    expect(pill.dataset.preset).toBe('chromatic')
    expect(pill.dataset.paused).toBe('false')
    expect(pill.dataset.listenMetal).toBe('moving')
    // metal-fx clamps the radius to half the height: a pill, whatever the height.
    expect(Number(pill.dataset.radius)).toBeGreaterThanOrEqual(14)
    expect(pill.getAttribute('aria-hidden')).toBe('true')
    expect(pill.style.position).toBe('absolute')
    expect(pill.style.pointerEvents).toBe('none')
    // metal-fx makes its root `visibility: visible` once painted; this keeps a
    // pill in a hidden list (under an open detail) hidden with it.
    expect(pill.classList.contains('[visibility:inherit]!')).toBe(true)
    // In the button's own box, and before it, so the (positioned) button paints above.
    const button = toggle()!
    expect(button.parentElement!.contains(pill)).toBe(true)
    expect(pill.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(button.classList.contains('relative')).toBe(true)
  })

  it("is in the app's theme (the `dark` class), not the system's", async () => {
    setSectionPlayerSupported(true)
    await render()
    await until(() => metal() !== null)
    expect(metal()!.dataset.theme).toBe('light')
    await act(async () => document.documentElement.classList.add('dark'))
    await until(() => metal()!.dataset.theme === 'dark')
  })

  it('holds still under prefers-reduced-motion', async () => {
    stubReducedMotion(true)
    setSectionPlayerSupported(true)
    await render()
    await until(() => metal() !== null)
    expect(metal()!.dataset.paused).toBe('true')
    expect(metal()!.dataset.listenMetal).toBe('still')
  })

  it('on, the button wears a colourful border: the rainbow ring on its rim over a glow, click-through, faded out while off', async () => {
    setSectionPlayerSupported(true)
    await render()
    await until(() => metal() !== null)
    const border = ring()!
    expect(toggle()!.contains(border)).toBe(true)
    expect(border.dataset.listenRing).toBe('off')
    expect(border.classList.contains('opacity-0')).toBe(true)
    expect(border.classList.contains('pointer-events-none')).toBe(true)
    expect(border.getAttribute('aria-hidden')).toBe('true')

    await act(async () => toggle()!.click())
    expect(ring()).toBe(border)
    expect(border.dataset.listenRing).toBe('on')
    expect(border.classList.contains('opacity-100')).toBe(true)
    expect(border.classList.contains('transition-opacity')).toBe(true)
    // The glow just outside the pill, then the ring on its rim: the rainbow
    // masked to the button's edge.
    const [glow, rim] = Array.from(border.children) as HTMLElement[]
    expect(glow.style.background).toBe(LISTEN_ON_RING.gradient)
    expect(glow.classList.contains('-inset-0.5')).toBe(true)
    expect(rim.style.background).toBe(LISTEN_ON_RING.gradient)
    expect(rim.style.padding).toBe(LISTEN_ON_RING.width)
    expect(rim.style.maskComposite).toBe('exclude')
    // The label is untouched.
    expect(toggle()!.textContent).toBe('Interactive')

    await act(async () => toggle()!.click())
    expect(border.dataset.listenRing).toBe('off')
    expect(border.classList.contains('opacity-0')).toBe(true)
  })

  it('where metal-fx cannot draw (no WebGL2), the button is plain, and still wears the colourful border when on', async () => {
    metalModule.supported = false
    setSectionPlayerSupported(true)
    await render()
    await settle()
    expect(metal()).toBeNull()
    expect(toggle()).not.toBeNull()
    expect(toggle()!.getAttribute('aria-pressed')).toBe('false')
    expect(ring()!.dataset.listenRing).toBe('off')

    await act(async () => toggle()!.click())
    expect(metal()).toBeNull()
    expect(ring()!.dataset.listenRing).toBe('on')
  })

  it('keeps that one pill of its own however often listen mode turns on and off', async () => {
    const kept = metalModule.kept.length
    setSectionPlayerSupported(true)
    await render()
    await until(() => metal() !== null)
    for (let i = 0; i < 3; i++) {
      await act(async () => toggle()!.click())
      await act(async () => toggle()!.click())
    }
    expect(metal()).not.toBeNull()
    expect(metalModule.kept).toHaveLength(kept)
  })

  it("where metal-fx's engine can't start (it throws: WebGL2, but not in an OffscreenCanvas), the button is plain", async () => {
    const { __restartListenMetalEngineForTests } = await import('../listen-metal')
    metalModule.engineFails = true
    __restartListenMetalEngineForTests()
    try {
      setSectionPlayerSupported(true)
      await render()
      await settle()
      expect(metal()).toBeNull()
      expect(toggle()!.getAttribute('aria-pressed')).toBe('false')
    } finally {
      metalModule.engineFails = false
      __restartListenMetalEngineForTests()
    }
  })

  it('the button stays the same element as listen mode turns on and off, so it keeps focus', async () => {
    setSectionPlayerSupported(true)
    await render()
    await until(() => metal() !== null)
    const button = toggle()!
    await act(async () => button.focus())
    await act(async () => button.click())
    expect(toggle()).toBe(button)
    expect(document.activeElement).toBe(button)
    await act(async () => button.click())
    expect(toggle()).toBe(button)
    expect(document.activeElement).toBe(button)
  })

  it("the header's className lands on its outer box, the metal's frame", async () => {
    setSectionPlayerSupported(true)
    await render('ml-1.5')
    const outer = container.firstElementChild as HTMLElement
    expect(outer.contains(toggle())).toBe(true)
    expect(outer.classList.contains('ml-1.5')).toBe(true)
    expect(toggle()!.classList.contains('ml-1.5')).toBe(false)
  })

  it('on, with what comes next offered here: a round Next button just before the toggle, outside the metal; a click goes', async () => {
    const go = vi.fn()
    setSectionPlayerSupported(true)
    __setListenNextForTests({ label: 'Next thread', go })
    await render()
    await until(() => metal() !== null)
    // Off: none.
    expect(nextButton()).toBeNull()

    await act(async () => toggle()!.click())
    const next = nextButton()!
    expect(next).not.toBeNull()
    expect(next.getAttribute('aria-label')).toBe('Next thread')
    expect(next.querySelector('svg')?.classList.contains('lucide-skip-forward')).toBe(true)
    // One of the bar's round pills: its 36px (the workspace pill's and the
    // toggle's height), white / black with a hairline border.
    for (const c of ['h-9', 'w-9', 'rounded-full', 'border', 'bg-white', 'dark:bg-black', 'shadow-sm']) {
      expect(next.classList.contains(c)).toBe(true)
    }
    expect(toggle()!.classList.contains('h-9')).toBe(true)
    // Before the toggle, in the same outer box, but not in the metal's.
    const outer = container.firstElementChild as HTMLElement
    expect(outer.contains(next)).toBe(true)
    expect(toggle()!.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(metal()!.parentElement!.contains(next)).toBe(false)

    await act(async () => next.click())
    expect(go).toHaveBeenCalledTimes(1)
    // Clicking it changes nothing about listen mode.
    expect(isListenModeOn()).toBe(true)
  })

  it('a press on the Next button is a click, not a drag of the window (the top bar is its drag strip)', async () => {
    setSectionPlayerSupported(true)
    __setListenNextForTests({ label: 'Next thread', go: () => {} })
    const dragStrip = vi.fn()
    await act(async () => root.render(h('div', { onMouseDown: dragStrip }, h(ListenModeToggle))))
    await act(async () => toggle()!.click())
    await act(async () => {
      nextButton()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(dragStrip).not.toHaveBeenCalled()
  })

  it('no Next button with nothing offered, nor once listen mode is off; the toggle stays the same element as it comes and goes', async () => {
    setSectionPlayerSupported(true)
    await render()
    const button = toggle()!
    await act(async () => button.click())
    expect(nextButton()).toBeNull()

    await act(async () => __setListenNextForTests({ label: 'Next thread', go: () => {} }))
    expect(nextButton()).not.toBeNull()
    expect(toggle()).toBe(button)

    await act(async () => __setListenNextForTests(null))
    expect(nextButton()).toBeNull()
    expect(toggle()).toBe(button)

    await act(async () => __setListenNextForTests({ label: 'Next thread', go: () => {} }))
    await act(async () => button.click())
    expect(isListenModeOn()).toBe(false)
    expect(nextButton()).toBeNull()
    expect(toggle()).toBe(button)
  })

  describe('the mic button (Interactive mode)', () => {
    function interactiveDesktop() {
      desktop.app = true
      desktop.voice = { ...desktop.voice, interactive: true }
    }

    it('on, on a desktop that runs Interactive: a round Mic button just before the toggle, outside the metal', async () => {
      interactiveDesktop()
      setSectionPlayerSupported(true)
      await render()
      await until(() => metal() !== null)
      // Off: none.
      expect(micButton()).toBeNull()

      await act(async () => toggle()!.click())
      const mic = micButton()!
      expect(mic).not.toBeNull()
      expect(mic.getAttribute('aria-label')).toBe('Mute microphone')
      expect(mic.getAttribute('aria-pressed')).toBe('false')
      expect(mic.querySelector('svg')?.classList.contains('lucide-mic')).toBe(true)
      for (const c of ['h-9', 'w-9', 'rounded-full', 'border', 'bg-white', 'dark:bg-black', 'shadow-sm']) {
        expect(mic.classList.contains(c)).toBe(true)
      }
      expect(toggle()!.classList.contains('h-9')).toBe(true)
      const outer = container.firstElementChild as HTMLElement
      expect(outer.contains(mic)).toBe(true)
      expect(toggle()!.compareDocumentPosition(mic) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
      expect(metal()!.parentElement!.contains(mic)).toBe(false)
    })

    it('a click mutes (MicOff, pressed) and a click again unmutes; Interactive stays on', async () => {
      interactiveDesktop()
      setSectionPlayerSupported(true)
      await render()
      await act(async () => toggle()!.click())
      await act(async () => micButton()!.click())
      expect(getInteractiveVoice().muted).toBe(true)
      expect(micButton()!.getAttribute('aria-label')).toBe('Unmute microphone')
      expect(micButton()!.getAttribute('aria-pressed')).toBe('true')
      expect(micButton()!.dataset.interactivePhase).toBe('muted')
      expect(micButton()!.querySelector('svg')?.classList.contains('lucide-mic-off')).toBe(true)
      expect(micButton()!.textContent).toContain('Muted')
      expect(isListenModeOn()).toBe(true)

      await act(async () => micButton()!.click())
      expect(getInteractiveVoice().muted).toBe(false)
      expect(micButton()!.getAttribute('aria-label')).toBe('Mute microphone')
    })

    it('shows where the conversation is: listening for the name, heard you, thinking, answering, follow-up', async () => {
      interactiveDesktop()
      setSectionPlayerSupported(true)
      await render()
      await act(async () => toggle()!.click())
      expect(micButton()!.dataset.interactivePhase).toBe('off')

      await act(async () => setInteractivePhase('listening'))
      expect(micButton()!.dataset.interactivePhase).toBe('listening')
      expect(micButton()!.textContent).toBe('Listening for “Joseph”')

      for (const [phase, words] of [
        ['heard', 'Heard you'],
        ['thinking', 'Thinking…'],
        ['answering', 'Answering'],
        ['follow-up', 'Go ahead, no name needed'],
      ] as const) {
        await act(async () => setInteractivePhase(phase))
        expect(micButton()!.dataset.interactivePhase).toBe(phase)
        expect(micButton()!.textContent).toBe(words)
      }
    })

    it('a press on it is a click, not a drag of the window', async () => {
      interactiveDesktop()
      setSectionPlayerSupported(true)
      const dragStrip = vi.fn()
      await act(async () => root.render(h('div', { onMouseDown: dragStrip }, h(ListenModeToggle))))
      await act(async () => toggle()!.click())
      await act(async () => {
        micButton()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      })
      expect(dragStrip).not.toHaveBeenCalled()
    })

    it('none without desktop support (an older desktop, voice unavailable or not ready, a browser): Interactive only reads', async () => {
      setSectionPlayerSupported(true)
      desktop.app = true
      await render()
      await act(async () => toggle()!.click())
      // voice_status without `interactive`.
      expect(micButton()).toBeNull()

      desktop.voice = { ...desktop.voice, interactive: true, available: false }
      await render()
      expect(micButton()).toBeNull()

      // The capability, but its modules not ready (local-stt, local-tts).
      desktop.voice = { ...desktop.voice, available: true, conversation: false }
      await render()
      expect(micButton()).toBeNull()
      desktop.voice = { ...desktop.voice, conversation: true }

      desktop.voice = { ...desktop.voice, available: true }
      desktop.app = false
      await render()
      expect(micButton()).toBeNull()
      expect(toggle()!.getAttribute('aria-pressed')).toBe('true')
    })

    it('the toggle stays the same element as the mic button comes and goes', async () => {
      interactiveDesktop()
      setSectionPlayerSupported(true)
      await render()
      const button = toggle()!
      await act(async () => button.click())
      expect(micButton()).not.toBeNull()
      expect(toggle()).toBe(button)
      await act(async () => button.click())
      expect(micButton()).toBeNull()
      expect(toggle()).toBe(button)
    })
  })

  it('goes when read-aloud stops being able to play (a capture, dictation)', async () => {
    setSectionPlayerSupported(true)
    await render()
    expect(toggle()).not.toBeNull()
    await act(async () => setSectionPlayerSupported(false))
    expect(container.innerHTML).toBe('')
  })
})
