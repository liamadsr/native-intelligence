'use client'

/**
 * The live HUD's own telemetry (lib/hud-telemetry.ts; what each event carries:
 * ProductEvent in lib/posthog.ts), so "did the agent's nudge show?" is
 * answerable from PostHog. The window recording the call reports the other
 * half (hooks/use-agent-nudge-relay.ts: open, close, nudge received); this is
 * what the HUD itself saw, in either host (the desktop's window, the web's
 * panel):
 *   - `live_hud_loaded` once it mounts;
 *   - `live_hud_shown` / `live_hud_hidden` when it starts or stops showing:
 *     on the page's visibilitychange; LOAD_CHECK_MS after mounting (the
 *     desktop builds the window hidden and shows it after a delay; one still
 *     hidden then is reported as `not_shown_after_load`); and, where the host
 *     has a window of its own, every VISIBILITY_POLL_MS after that, since a
 *     hidden desktop window's page needn't hear a visibilitychange;
 *   - `live_hud_nudge_arrived` for each nudge new to its feed, with whether
 *     the call's chat is open yet (a nudge is drawn only in the chat);
 *   - `live_hud_nudge_displayed` for each heads-up its chat draws (the
 *     returned callback, for LiveChat's `onSayShown`).
 * Each carries the host, the capture, `window_visible` (the host's
 * `windowVisible`: the desktop window's own state, which is the one that
 * counts, since a hidden window's page still draws) and the page's
 * `document_visibility`.
 */
import { useCallback, useEffect, useRef } from 'react'
import { documentVisibility, trackHudEvent, type HudTelemetryEvent, type HudTelemetryProperties } from '@/lib/hud-telemetry'
import type { LiveChatSayShown } from '@/components/live-chat/live-chat'
import type { AgentHudNudge } from './hud-feed'

/** How long after mounting the HUD is checked for showing once more. */
export const LOAD_CHECK_MS = 5000
/** Then how often a host's own window is checked (one IPC call; reported only on a change). */
export const VISIBILITY_POLL_MS = 30_000

export interface HudTelemetryOptions {
  host: 'window' | 'page'
  /** The call's capture, once the HUD knows it (null before). */
  captureId: string | null
  /**
   * The call's workspace, for a host whose `x-workspace-id` can be another
   * window's (the desktop's HUD window: null until it knows). Left out, the
   * header says (the web's panel, in the app's own page).
   */
  workspaceId?: string | null
  /** The feed's nudges (lib: hud-feed `withNudge`, new ones appended). */
  nudges: readonly AgentHudNudge[]
  /** Whether the call's chat is open (the nudges are drawn in it). */
  hasConversation: boolean
  /** Whether the host's window is showing; none where there is no window of its own (the web's panel). */
  windowVisible?: () => Promise<boolean | null>
}

export function useHudTelemetry(options: HudTelemetryOptions): (say: LiveChatSayShown) => void {
  const { host, nudges } = options
  const latest = useRef(options)
  latest.current = options
  const polls = !!options.windowVisible

  const snapshot = useCallback(async (): Promise<HudTelemetryProperties> => {
    let visible: boolean | null = null
    try {
      visible = (await latest.current.windowVisible?.()) ?? null
    } catch {
      /* the window couldn't say */
    }
    return { host, capture_id: latest.current.captureId, window_visible: visible, document_visibility: documentVisibility() }
  }, [host])

  const send = useCallback((event: HudTelemetryEvent, properties: HudTelemetryProperties) => {
    const opts = 'workspaceId' in latest.current ? { workspaceId: latest.current.workspaceId ?? null } : {}
    trackHudEvent(event, properties, opts)
  }, [])

  const emit = useCallback(
    (event: HudTelemetryEvent, extra: HudTelemetryProperties = {}) => {
      void snapshot()
        .then((s) => send(event, { ...s, ...extra }))
        .catch(() => {})
    },
    [snapshot, send],
  )

  // Loaded, then shown / hidden as that changes.
  useEffect(() => {
    let alive = true
    let last: boolean | null = null
    let everShown = false
    const showing = (s: HudTelemetryProperties): boolean | null =>
      typeof s.window_visible === 'boolean' ? s.window_visible : s.document_visibility ? s.document_visibility === 'visible' : null
    const note = (now: boolean | null) => {
      last = now
      if (now) everShown = true
    }
    const report = (reason: string) =>
      snapshot()
        .then((s) => {
          if (!alive) return
          const now = showing(s)
          if (now === null) return
          // Still not showing at the check after load: said even though nothing changed.
          const neverShown = !now && !everShown && reason === 'after_load'
          if (now === last && !neverShown) return
          note(now)
          send(now ? 'live_hud_shown' : 'live_hud_hidden', { ...s, reason: neverShown ? 'not_shown_after_load' : reason })
        })
        .catch(() => {})

    void snapshot()
      .then((s) => {
        if (!alive) return
        note(showing(s))
        send('live_hud_loaded', s)
      })
      .catch(() => {})
    let poll: ReturnType<typeof setInterval> | null = null
    const check = setTimeout(() => {
      void report('after_load')
      if (polls && alive) poll = setInterval(() => void report('poll'), VISIBILITY_POLL_MS)
    }, LOAD_CHECK_MS)
    const onVisibility = () => void report('visibility_change')
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      clearTimeout(check)
      if (poll !== null) clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [snapshot, send, polls])

  // Each nudge new to the feed. Its own capture id, which the HUD may not
  // know yet (it learns the call from the recording window's events).
  const arrived = useRef(new Set<string>())
  useEffect(() => {
    for (const nudge of nudges) {
      if (!nudge?.id || arrived.current.has(nudge.id)) continue
      arrived.current.add(nudge.id)
      emit('live_hud_nudge_arrived', {
        nudge_id: nudge.id,
        nudge_kind: nudge.kind ?? null,
        has_conversation: latest.current.hasConversation,
        ...(nudge.captureId ? { capture_id: nudge.captureId } : {}),
      })
    }
  }, [nudges, emit])

  // Each heads-up the chat draws, once per HUD page (the chat tells each once
  // per mount; it remounts for another conversation).
  const displayed = useRef(new Set<string>())
  return useCallback(
    (say: LiveChatSayShown) => {
      if (displayed.current.has(say.id)) return
      displayed.current.add(say.id)
      emit('live_hud_nudge_displayed', { nudge_id: say.id, nudge_kind: say.kind, source: say.source })
    },
    [emit],
  )
}
