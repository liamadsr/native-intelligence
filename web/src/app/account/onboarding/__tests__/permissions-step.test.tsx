// @vitest-environment jsdom
/**
 * Behavior tests for the desktop-only PERMISSIONS step — the wizard's opening
 * screen inside the Tauri shell (Circleback-style sequential cards).
 *
 * The load-bearing contracts:
 *   • Continue is GATED: enabled only once BOTH permissions are granted or
 *     declared unsupported. A denied microphone is invisible to the capture
 *     pipeline (macOS delivers zero-filled buffers), so this gate is the one
 *     reliable moment to secure the grants.
 *   • The mic card is LIVE: it polls the passive check every 1.5s, so a grant
 *     flipped directly in System Settings completes the card with no click —
 *     and a stale poll read must never downgrade a just-denied card back to
 *     not-determined (the flicker race pinned below).
 *   • The system-audio card NEVER requests on mount or on its timer — only
 *     the passive check runs there (it can never prompt). Requesting (or, on
 *     an old build, probing: creating a Core Audio tap IS the prompt trigger
 *     there) happens only on Allow, after the mic card settles (sequential
 *     unlock). On a current build the card is live like the mic card: seeded
 *     from the passive check and re-polled, so a Settings toggle completes it.
 *   • Old desktop builds reject the passive system-audio check; the card then
 *     keeps its old probe-only behaviour (no polling, "Check again").
 *   • Old desktop builds without the mic commands resolve to 'unsupported'
 *     and never block onboarding.
 *   • The skip link exists ONLY after a denial, and both exits funnel through
 *     a single onContinue call (double-fire guarded).
 *
 * framer-motion is stubbed to plain elements; both polls run on setInterval,
 * so fake timers drive them deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stub framer-motion: motion.<tag> → the plain tag; AnimatePresence → fragment.
vi.mock('framer-motion', () => {
  const React = require('react')
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        function MotionStub(props: Record<string, unknown>) {
          const { initial, animate, exit, transition, ...rest } = props as Record<
            string,
            unknown
          >
          void initial
          void animate
          void exit
          void transition
          return React.createElement(tag, rest)
        },
    },
  )
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  }
})

// The bridge is the component's only IO seam. Each test rewires these mocks.
const checkMicPermission = vi.fn<() => Promise<string>>()
const requestMicPermission = vi.fn<() => Promise<string>>()
const requestScreenCapturePermission = vi.fn<() => Promise<string>>()
const checkSystemAudioPermission = vi.fn<() => Promise<string>>()
const requestSystemAudioPermission = vi.fn<() => Promise<string>>()
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    checkMicPermission: () => checkMicPermission(),
    requestMicPermission: () => requestMicPermission(),
    requestScreenCapturePermission: () => requestScreenCapturePermission(),
    checkSystemAudioPermission: () => checkSystemAudioPermission(),
    requestSystemAudioPermission: () => requestSystemAudioPermission(),
  },
}))

// What Tauri rejects with for a command the running binary doesn't register.
const notFound = (cmd: string) => new Error(`command ${cmd} not found`)

import { PermissionsStep, type PermissionsOutcome } from '../permissions-step'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  checkMicPermission.mockReset()
  requestMicPermission.mockReset()
  requestScreenCapturePermission.mockReset()
  checkSystemAudioPermission.mockReset()
  requestSystemAudioPermission.mockReset()
  // Default: an OLD desktop build without the system-audio commands, so every
  // legacy scenario below keeps exercising the probe path exactly as before.
  // The current-build scenarios opt in explicitly.
  checkSystemAudioPermission.mockRejectedValue(notFound('check_system_audio_permission'))
  requestSystemAudioPermission.mockRejectedValue(notFound('request_system_audio_permission'))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
})

async function mount(
  onContinue: (o: PermissionsOutcome) => void = () => {},
  onResult?: (permission: 'microphone' | 'system_audio', result: string) => void,
) {
  await act(async () => {
    root.render(h(PermissionsStep, { onContinue, onResult, submitting: false }))
  })
}

/** Let the seed read (mount) or one poll tick settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

async function tickPoll() {
  await act(async () => {
    vi.advanceTimersByTime(1500)
    await Promise.resolve()
  })
}

const buttons = () => Array.from(host.querySelectorAll('button'))
const buttonByText = (text: string) =>
  buttons().find((b) => b.textContent?.includes(text))
const continueButton = () =>
  buttons().find((b) => b.textContent?.trim().startsWith('Continue'))!
const click = async (el: Element | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => {
    ;(el as HTMLButtonElement).click()
    await Promise.resolve()
  })
}

describe('PermissionsStep', () => {
  it('gates Continue until both permissions settle, unlocking system audio after mic', async () => {
    checkMicPermission.mockResolvedValue('not-determined')
    requestMicPermission.mockResolvedValue('granted')
    requestScreenCapturePermission.mockResolvedValue('granted')
    const onContinue = vi.fn()
    await mount(onContinue)
    await flush()

    // Mic pending: Continue disabled; system card locked (its Allow hidden
    // behind the collapsed card — only the mic Allow is rendered).
    expect(continueButton().disabled).toBe(true)
    expect(requestScreenCapturePermission).not.toHaveBeenCalled()

    await click(buttonByText('Allow'))
    // Mic granted → system card active, still gated.
    expect(continueButton().disabled).toBe(true)

    await click(buttonByText('Allow'))
    expect(requestScreenCapturePermission).toHaveBeenCalledTimes(1)
    expect(continueButton().disabled).toBe(false)

    await click(continueButton())
    expect(onContinue).toHaveBeenCalledExactlyOnceWith({
      microphone: 'granted',
      systemAudio: 'granted',
      skipped: false,
    })
  })

  it('never requests (or probes) system audio on mount or on the poll timer', async () => {
    // Current build: the passive check runs — seeded and re-polled — but the
    // request command never does without a click.
    checkMicPermission.mockResolvedValue('granted')
    checkSystemAudioPermission.mockResolvedValue('not-determined')
    await mount()
    await flush()
    await tickPoll()
    await tickPoll()
    expect(checkSystemAudioPermission.mock.calls.length).toBeGreaterThan(1)
    expect(requestSystemAudioPermission).not.toHaveBeenCalled()
    expect(requestScreenCapturePermission).not.toHaveBeenCalled()
  })

  it('never probes system audio on mount or on the poll timer on an old build either', async () => {
    checkMicPermission.mockResolvedValue('granted')
    await mount()
    await flush()
    await tickPoll()
    await tickPoll()
    expect(requestSystemAudioPermission).not.toHaveBeenCalled()
    expect(requestScreenCapturePermission).not.toHaveBeenCalled()
  })

  it('completes a denied mic card from the poll when the user grants in System Settings', async () => {
    checkMicPermission.mockResolvedValue('denied')
    await mount()
    await flush()

    expect(buttonByText('Open System Settings')).toBeTruthy()

    // User flips the toggle in System Settings → next poll sees granted.
    checkMicPermission.mockResolvedValue('granted')
    await tickPoll()
    expect(buttonByText('Open System Settings')).toBeUndefined()
    expect(host.textContent).toContain('Allow system audio access')
  })

  it('never downgrades a just-denied mic back to not-determined on a stale poll read', async () => {
    checkMicPermission.mockResolvedValue('not-determined')
    requestMicPermission.mockResolvedValue('denied')
    await mount()
    await flush()

    await click(buttonByText('Allow'))
    expect(buttonByText('Open System Settings')).toBeTruthy()

    // A stale read still reporting not-determined must not flip the card back.
    checkMicPermission.mockResolvedValue('not-determined')
    await tickPoll()
    expect(buttonByText('Open System Settings')).toBeTruthy()
  })

  it('treats missing mic commands (old desktop build) as unsupported and never blocks', async () => {
    checkMicPermission.mockRejectedValue(new Error('command check_mic_permission not found'))
    requestScreenCapturePermission.mockResolvedValue('granted')
    await mount()
    await flush()

    expect(host.textContent).toContain('unavailable on this build')
    // System audio still functional (the probe command predates the mic ones).
    await click(buttonByText('Allow'))
    expect(continueButton().disabled).toBe(false)
  })

  it('shows the skip link only after a denial, funnelling to a single onContinue', async () => {
    checkMicPermission.mockResolvedValue('not-determined')
    const onContinue = vi.fn()
    await mount(onContinue)
    await flush()

    expect(buttonByText('Skip for now')).toBeUndefined()

    checkMicPermission.mockResolvedValue('denied')
    await tickPoll()
    const skip = buttonByText('Skip for now')
    expect(skip).toBeTruthy()

    await click(skip)
    await click(buttonByText('Skip for now'))
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onContinue).toHaveBeenCalledWith({
      microphone: 'denied',
      systemAudio: 'idle',
      skipped: true,
    })
  })

  it('reports every user-visible outcome through onResult exactly once', async () => {
    checkMicPermission.mockResolvedValue('denied')
    requestScreenCapturePermission.mockResolvedValue('granted')
    const onResult = vi.fn()
    await mount(() => {}, onResult)
    await flush()

    // Poll-detected grant after a denial (the Settings-toggle conversion).
    checkMicPermission.mockResolvedValue('granted')
    await tickPoll()
    expect(onResult).toHaveBeenCalledWith('microphone', 'granted-via-settings')

    await click(buttonByText('Allow'))
    expect(onResult).toHaveBeenCalledWith('system_audio', 'granted')
    expect(onResult).toHaveBeenCalledTimes(2)
  })

  it('reports an already-granted mic at step entry', async () => {
    checkMicPermission.mockResolvedValue('granted')
    const onResult = vi.fn()
    await mount(() => {}, onResult)
    await flush()
    await tickPoll()
    expect(onResult).toHaveBeenCalledExactlyOnceWith('microphone', 'already-granted')
  })

  it('keeps Continue gated behind a denied system audio probe until Check again succeeds', async () => {
    checkMicPermission.mockResolvedValue('granted')
    requestScreenCapturePermission.mockResolvedValue('denied')
    await mount()
    await flush()

    await click(buttonByText('Allow'))
    expect(continueButton().disabled).toBe(true)
    expect(buttonByText('Check again')).toBeTruthy()

    requestScreenCapturePermission.mockResolvedValue('granted')
    await click(buttonByText('Check again'))
    expect(continueButton().disabled).toBe(false)
  })

  // ── Current desktop build: the passive system-audio check exists ──────

  it('completes the system audio card at entry when it is already granted', async () => {
    checkMicPermission.mockResolvedValue('granted')
    checkSystemAudioPermission.mockResolvedValue('granted')
    const onResult = vi.fn()
    await mount(() => {}, onResult)
    await flush()
    await flush()

    // Both cards done with no click at all.
    expect(continueButton().disabled).toBe(false)
    expect(buttonByText('Allow')).toBeUndefined()
    expect(onResult).toHaveBeenCalledWith('system_audio', 'already-granted')
    expect(onResult).toHaveBeenCalledWith('microphone', 'already-granted')
    expect(onResult).toHaveBeenCalledTimes(2)
    expect(requestSystemAudioPermission).not.toHaveBeenCalled()
    expect(requestScreenCapturePermission).not.toHaveBeenCalled()
  })

  it('denied → Open System Settings → the poll completes the card once it is granted there', async () => {
    checkMicPermission.mockResolvedValue('granted')
    checkSystemAudioPermission.mockResolvedValue('denied')
    requestSystemAudioPermission.mockResolvedValue('opened-settings')
    const onResult = vi.fn()
    await mount(() => {}, onResult)
    await flush()

    expect(host.textContent).toContain('we’ll detect it here automatically')
    expect(continueButton().disabled).toBe(true)
    expect(buttonByText('Check again')).toBeUndefined()

    // Already denied: the request can't prompt, so it opens the Settings pane.
    await click(buttonByText('Open System Settings'))
    expect(requestSystemAudioPermission).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith('system_audio', 'opened-settings')
    expect(buttonByText('Open System Settings')).toBeTruthy()
    expect(continueButton().disabled).toBe(true)

    // User flips the toggle in System Settings → the next poll sees granted.
    checkSystemAudioPermission.mockResolvedValue('granted')
    await tickPoll()
    expect(buttonByText('Open System Settings')).toBeUndefined()
    expect(continueButton().disabled).toBe(false)
    expect(onResult).toHaveBeenCalledWith('system_audio', 'granted-via-settings')
    expect(requestScreenCapturePermission).not.toHaveBeenCalled()
  })

  it('Allow on a current build runs the real request (not the legacy probe)', async () => {
    checkMicPermission.mockResolvedValue('granted')
    checkSystemAudioPermission.mockResolvedValue('not-determined')
    requestSystemAudioPermission.mockResolvedValue('granted')
    const onResult = vi.fn()
    await mount(() => {}, onResult)
    await flush()

    await click(buttonByText('Allow'))
    expect(requestSystemAudioPermission).toHaveBeenCalledTimes(1)
    expect(requestScreenCapturePermission).not.toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledWith('system_audio', 'granted')
    expect(continueButton().disabled).toBe(false)
  })

  it('never downgrades a just-denied system audio card back to Allow on a stale poll read', async () => {
    checkMicPermission.mockResolvedValue('granted')
    checkSystemAudioPermission.mockResolvedValue('not-determined')
    requestSystemAudioPermission.mockResolvedValue('denied')
    await mount()
    await flush()

    await click(buttonByText('Allow'))
    expect(buttonByText('Open System Settings')).toBeTruthy()

    // A read still reporting not-determined must not flip the card back.
    await tickPoll()
    expect(buttonByText('Open System Settings')).toBeTruthy()
    expect(buttonByText('Allow')).toBeUndefined()
  })

  it('skips the card on a macOS without Core Audio taps (unsupported at entry)', async () => {
    checkMicPermission.mockResolvedValue('granted')
    checkSystemAudioPermission.mockResolvedValue('unsupported')
    const onResult = vi.fn()
    await mount(() => {}, onResult)
    await flush()
    await flush()

    expect(host.textContent).toContain('unavailable on this build')
    expect(continueButton().disabled).toBe(false)
    expect(onResult).toHaveBeenCalledWith('system_audio', 'unsupported')
  })

  // ── Old desktop build: the passive check is missing ──────────────────

  it('old build: the check rejects once, polling stops, and Allow runs the legacy probe', async () => {
    checkMicPermission.mockResolvedValue('granted')
    requestScreenCapturePermission.mockResolvedValue('granted')
    await mount()
    await flush()
    await tickPoll()
    await tickPoll()

    // One passive read (rejected) and no polling after it.
    expect(checkSystemAudioPermission).toHaveBeenCalledTimes(1)

    await click(buttonByText('Allow'))
    expect(requestScreenCapturePermission).toHaveBeenCalledTimes(1)
    expect(requestSystemAudioPermission).not.toHaveBeenCalled()
    expect(continueButton().disabled).toBe(false)
  })

  // ── Windows app: no prompt for the mic, no system-audio permission ───

  describe('in the Windows app', () => {
    beforeEach(() => {
      window.__TAURI_INTERNALS__ = {}
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        configurable: true,
      })
      checkSystemAudioPermission.mockResolvedValue('not_applicable')
    })
    afterEach(() => {
      delete window.__TAURI_INTERNALS__
      delete (navigator as { userAgent?: string }).userAgent
    })

    it('shows no system-audio card, and a granted mic is enough to continue', async () => {
      checkMicPermission.mockResolvedValue('granted')
      await mount()
      await flush()

      expect(host.textContent).not.toContain('system audio')
      expect(host.textContent).toContain('Native Intelligence needs access to your microphone to record meetings.')
      expect(continueButton().disabled).toBe(false)
    })

    it('a denied mic points at Windows Settings', async () => {
      checkMicPermission.mockResolvedValue('denied')
      requestMicPermission.mockResolvedValue('opened-settings')
      await mount()
      await flush()

      expect(host.textContent).toContain('Settings → Privacy & security → Microphone')
      expect(host.textContent).not.toContain('System Settings')
      await click(buttonByText('Open Settings'))
      expect(requestMicPermission).toHaveBeenCalledTimes(1)
    })
  })
})
