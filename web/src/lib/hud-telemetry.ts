/**
 * Fire-and-forget client helper for the live HUD's telemetry: what the live
 * agent's HUD did during a call (opened, shown, hidden, and each nudge
 * received, arrived and drawn), so "did the nudge show?" is answerable from
 * PostHog instead of guessed at (the 2026-10-19 Owen call). The vocabulary and
 * what each event carries: ProductEvent in lib/posthog.ts.
 *
 * Posts to /api/analytics/hud-event, which authenticates the session and
 * forwards to PostHog via trackServerEvent (the browser PostHog instance isn't
 * reliably initialised inside the Tauri WebViews). The workspace rides on the
 * `x-workspace-id` header lib/workspace-fetch adds to every `/api/` request,
 * unless the caller names it (`workspaceId`, null included): the HUD window
 * does, since until it learns its call's workspace that header is whatever
 * workspace another window last stored. On the desktop each event also
 * carries `app_version`, read once per page.
 *
 * Strictly best-effort: it NEVER throws and NEVER blocks the HUD or the
 * recording — callers do not await it.
 */
import { isDesktopApp } from '@/lib/platform'

/** The HUD's events: the client's vocabulary and the sink's allowlist (api/analytics/hud-event). */
export const HUD_TELEMETRY_EVENTS = [
  'live_hud_open_requested',
  'live_hud_close_requested',
  'live_hud_nudge_received',
  'live_hud_loaded',
  'live_hud_shown',
  'live_hud_hidden',
  'live_hud_nudge_arrived',
  'live_hud_nudge_displayed',
  'live_hud_ensured',
] as const

export type HudTelemetryEvent = (typeof HUD_TELEMETRY_EVENTS)[number]

export type HudTelemetryProperties = Record<string, string | number | boolean | null>

let appVersion: Promise<string | null> | null = null

/** The desktop app's version, or null off the desktop (or when it can't say). Read once. */
function desktopAppVersion(): Promise<string | null> {
  appVersion ??= (async () => {
    if (!isDesktopApp()) return null
    try {
      const { getVersion } = await import('@tauri-apps/api/app')
      const version = await getVersion()
      return typeof version === 'string' ? version : null
    } catch {
      return null
    }
  })()
  return appVersion
}

export function trackHudEvent(
  event: HudTelemetryEvent,
  properties: HudTelemetryProperties = {},
  opts: { workspaceId?: string | null } = {},
): void {
  try {
    void desktopAppVersion()
      .then((version) =>
        fetch('/api/analytics/hud-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event,
            properties: version ? { ...properties, app_version: version } : properties,
            ...('workspaceId' in opts ? { workspaceId: opts.workspaceId ?? null } : {}),
          }),
          keepalive: true,
        }),
      )
      .catch(() => {})
  } catch {
    /* never let telemetry surface to the HUD */
  }
}

/** The page's visibility, for a HUD event ('visible' | 'hidden'; null without a document). */
export function documentVisibility(): string | null {
  try {
    return typeof document === 'undefined' ? null : document.visibilityState
  } catch {
    return null
  }
}

/** For tests: forget the cached app version. */
export function resetHudTelemetryForTests(): void {
  appVersion = null
}
