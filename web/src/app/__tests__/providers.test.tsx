// @vitest-environment jsdom
/**
 * POSTHOG SESSION REPLAY IS OFF INSIDE THE DESKTOP SHELL, ON FOR THE WEB.
 *
 * rrweb records the entire always-mounted dashboard DOM in the desktop
 * webview (every tab stays mounted display:none) and re-snapshots the whole
 * tree every 5 min — a measured 948 MB heap after 7 h versus ~90 MB in Chrome.
 * `disable_session_recording` is the config-level kill switch: it is one of the
 * ANDed terms in posthog-js's `_isRecordingEnabled`, so it forces recording off
 * regardless of the project's server-side replay toggle and the recorder
 * bundle is never fetched.
 *
 * What is pinned here: the desktop/web branch, and the localStorage escape
 * hatch. The web value must stay exactly `false` — a desktop-only fix that
 * silently killed replay on the marketing site and web dashboard would be a
 * regression, not a fix.
 *
 * `providers.tsx` calls `posthog.init` as a MODULE-LEVEL side effect, so each
 * case needs `vi.resetModules()` + a dynamic `import()` to re-run that block
 * under different window/localStorage state; a static top-level import would
 * only ever evaluate it once for the whole file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const initMock = vi.fn()
const registerMock = vi.fn()

vi.mock('posthog-js', () => ({
  default: { init: initMock, register: registerMock, capture: vi.fn() },
}))

vi.mock('posthog-js/react', () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
  usePostHog: () => ({ capture: vi.fn() }),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

let warnSpy: ReturnType<typeof vi.spyOn>

function forcedReplayWarnings(): string[] {
  return warnSpy.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes('ni:posthog-replay'))
}

function lastInitConfig(): Record<string, unknown> {
  expect(initMock).toHaveBeenCalledTimes(1)
  return initMock.mock.calls[0][1] as Record<string, unknown>
}

describe('PostHog init: desktop session-replay gate', () => {
  beforeEach(() => {
    vi.resetModules()
    initMock.mockClear()
    registerMock.mockClear()
    // src/test/setup.ts deletes NEXT_PUBLIC_POSTHOG_KEY globally (so no suite
    // emits fake events into the real project) — the init block is gated on it,
    // so it has to be set back for these cases to reach posthog.init at all.
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'test-key')
    delete window.__TAURI__
    delete window.__TAURI_INTERNALS__
    localStorage.clear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    delete window.__TAURI__
    delete window.__TAURI_INTERNALS__
    localStorage.clear()
    warnSpy.mockRestore()
  })

  it('disables session recording inside the Tauri desktop shell', async () => {
    // Tauri injects this at document start (WKUserScript .atDocumentStart),
    // before the page bundle runs — so reading it at module scope is safe.
    window.__TAURI_INTERNALS__ = {}

    await import('../providers')

    expect(lastInitConfig()).toMatchObject({ disable_session_recording: true })
  })

  it('also disables it for the legacy __TAURI__ global', async () => {
    window.__TAURI__ = {}

    await import('../providers')

    expect(lastInitConfig()).toMatchObject({ disable_session_recording: true })
  })

  it('leaves session recording on for the web app', async () => {
    await import('../providers')

    expect(lastInitConfig()).toMatchObject({ disable_session_recording: false })
  })

  it('keeps every other init option and the register call unchanged on web', async () => {
    await import('../providers')

    expect(lastInitConfig()).toMatchObject({
      person_profiles: 'identified_only',
      capture_pageview: false,
      capture_pageleave: true,
    })
    // platform stays 'web' deliberately: it is an analytics dimension existing
    // dashboards filter on, and correcting it is a separate decision. The
    // follow-up that changes the register call to
    // `platform: isDesktopApp() ? 'desktop' : 'web'` MUST update this
    // assertion (this case runs with no Tauri global, so it would then expect
    // 'web' here and need a matching desktop case expecting 'desktop').
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'web' }),
    )
  })

  it('re-enables replay on desktop when the localStorage debug flag is set, and warns once', async () => {
    window.__TAURI_INTERNALS__ = {}
    localStorage.setItem('ni:posthog-replay', 'on')

    await import('../providers')

    expect(lastInitConfig()).toMatchObject({ disable_session_recording: false })
    // A forgotten key would otherwise leave the desktop shell recording
    // indefinitely with no signal anywhere — the whole point of the warning.
    const warnings = forcedReplayWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(
      'PostHog session replay force-enabled via localStorage ni:posthog-replay',
    )
    expect(warnings[0]).toContain('remove the key to restore the default')
  })

  it('re-enables replay for the legacy __TAURI__ global too, and warns', async () => {
    // The override has to key off the same desktop detection as the gate: if
    // `isDesktopApp()` recognised the legacy global but the escape hatch only
    // ran for `__TAURI_INTERNALS__`, older shells would be stuck with replay
    // off and no way to turn it back on for a debugging session.
    window.__TAURI__ = {}
    localStorage.setItem('ni:posthog-replay', 'on')

    await import('../providers')

    expect(lastInitConfig()).toMatchObject({ disable_session_recording: false })
    const warnings = forcedReplayWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(
      'PostHog session replay force-enabled via localStorage ni:posthog-replay',
    )
  })

  it('ignores any localStorage value other than the exact "on" opt-in', async () => {
    window.__TAURI_INTERNALS__ = {}
    localStorage.setItem('ni:posthog-replay', 'true')

    await import('../providers')

    expect(lastInitConfig()).toMatchObject({ disable_session_recording: true })
    expect(forcedReplayWarnings()).toHaveLength(0)
  })

  it('does not warn on desktop with no override key', async () => {
    window.__TAURI_INTERNALS__ = {}

    await import('../providers')

    expect(forcedReplayWarnings()).toHaveLength(0)
  })

  it('does not warn on the web even when the override key is set', async () => {
    // The key is desktop-only: on web replay is already on, so there is
    // nothing forced and nothing to warn about.
    localStorage.setItem('ni:posthog-replay', 'on')

    await import('../providers')

    expect(lastInitConfig()).toMatchObject({ disable_session_recording: false })
    expect(forcedReplayWarnings()).toHaveLength(0)
  })

  it('stays disabled on desktop when localStorage itself throws', async () => {
    window.__TAURI_INTERNALS__ = {}
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('localStorage is blocked in this context')
      })

    try {
      await import('../providers')
      expect(lastInitConfig()).toMatchObject({ disable_session_recording: true })
      expect(forcedReplayWarnings()).toHaveLength(0)
    } finally {
      getItem.mockRestore()
    }
  })
})
