'use client'

/**
 * The ONE "Connect" flow for an integration, from any surface.
 *
 * Before this hook the same popup/deep-link dance was written out four times
 * (the integrations grid, the GitHub card, the integration detail view, the
 * MCP suggestions), and the copies had drifted: the detail view did a full-page
 * redirect on the web (reloading the whole shell), one copy never cleared its
 * spinner on a failed authorize request, and only one tore its listeners down
 * on unmount.
 *
 *   Web       GET the authorize URL, open it in a popup, and settle on the
 *             popup's `postMessage` (oauth-popup-callback / mcp-oauth-popup-
 *             callback) or on the popup closing without one. A blocked popup
 *             falls back to a full redirect.
 *   Desktop   Hand the URL to the system browser. Sign-in and OAuth connect
 *             ALWAYS stay in the user's default browser (passkeys, saved
 *             sign-ins, and the provider's redirect back to `dial8desktop://`
 *             live there): an authorize URL is exactly what
 *             `keepsSystemBrowser` (lib/open-external.ts) keeps out of the
 *             in-app browser, so this calls the opener plugin directly rather
 *             than going through the in-app link router. The return arrives as
 *             a deep link → `onOAuthCallback`. An MCP connect's return is its
 *             own deep link, claimed by the window that started it
 *             (`onMcpOAuthCallback`); one the person abandons ends when the
 *             window regains focus after losing it, past a short grace.
 *   local_exchange  macOS EventKit permission, no OAuth.
 *
 * A connect started with `origin: 'panel'` claims its desktop return
 * (oauth-return-claim.ts) so the settings overlay doesn't pop Settings over the
 * chat; the panel refreshes itself from `onReturn` instead.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktopApp } from '@/lib/platform'
import { onMcpOAuthCallback, onOAuthCallback } from '@/lib/navigation-events'
import { claimOAuthReturn, OAUTH_RETURN_TTL_MS } from './oauth-return-claim'
import { holdDesktopOAuthClaim } from './desktop-oauth-claims'

export type ConnectOrigin = 'settings' | 'panel'

export interface ConnectResult {
  /** The provider, or the `connectWithUrl` key for an MCP connect. */
  provider: string
  /** The capability, or 'mcp' for an MCP connect. */
  capability: string
  success: boolean
  error?: string | null
  /**
   * 'reported': the flow said how it went (popup message, deep link, the
   * EventKit answer, or a start failure). 'closed': it ended without saying
   * (popup closed, desktop window refocused after an MCP connect), so
   * `success` is false only because nothing reported it: re-read the status
   * to find out.
   */
  via: 'reported' | 'closed'
}

export interface UseConnectProviderOptions {
  /** Where the connect was started. 'panel' keeps the desktop return from opening Settings. */
  origin?: ConnectOrigin
  onReturn?: (result: ConnectResult) => void
}

export interface UseConnectProvider {
  connect: (provider: string, capability: string, opts?: { loginHint?: string }) => Promise<void>
  /** MCP: its own start endpoint gives the authorize URL; the popup / return handling is shared. */
  connectWithUrl: (key: string, getUrl: () => Promise<string | null>) => Promise<void>
  /** `${provider}-${capability}` or the MCP key while that connect is in flight. */
  connectingId: string | null
}

const POPUP_NAME = 'dial8-oauth'
const POPUP_FEATURES = 'width=600,height=700,popup=yes'
const OAUTH_POPUP_MESSAGE = 'dial8:oauth-popup-result'
const MCP_POPUP_MESSAGE = 'dial8:mcp-oauth-popup-result'
const POPUP_CLOSED_POLL_MS = 500
/**
 * Backstop for a desktop MCP connect that never refocuses the window (the user
 * finished elsewhere, or Cmd+Tab back didn't blur): drop the spinner so a
 * retry is possible.
 */
const MCP_DESKTOP_WAIT_MS = 15 * 60 * 1000 // a desktop MCP flow's whole life (desktop-oauth-claims.ts MCP_CLAIM_TTL_MS)
/**
 * After a desktop MCP connect's window regains focus, how long it waits for
 * the claim's answer before ending as `closed` (a claim usually lands in
 * under a second; the deep link that opens the app is what refocuses it).
 */
const MCP_DESKTOP_CLAIM_GRACE_MS = 15_000

/** The authorize request for an OAuth provider (exported for tests). */
export function authorizeRequestUrl(
  provider: string,
  capability: string,
  opts: { desktop: boolean; loginHint?: string },
): string {
  const params = new URLSearchParams({ capability, source: opts.desktop ? 'desktop' : 'web' })
  // Web: the callback lands on the popup page, which posts the result back.
  if (!opts.desktop) params.set('redirect', '/oauth-popup-callback')
  if (opts.loginHint) params.set('login_hint', opts.loginHint)
  return `/api/oauth/${encodeURIComponent(provider)}/authorize?${params.toString()}`
}

async function openInDefaultBrowser(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

interface PendingReturn {
  provider: string
  capability: string
  at: number
}

export function useConnectProvider(opts: UseConnectProviderOptions = {}): UseConnectProvider {
  const { origin = 'settings' } = opts
  const [connectingId, setConnectingId] = useState<string | null>(null)

  // Latest callback without re-subscribing the deep-link listener per render.
  const onReturnRef = useRef(opts.onReturn)
  useEffect(() => {
    onReturnRef.current = opts.onReturn
  }, [opts.onReturn])

  /** The flow in flight, read synchronously so a double click can't start two. */
  const connectingRef = useRef<string | null>(null)
  /** Tears down the in-flight popup watch / desktop focus wait. */
  const flowCleanupRef = useRef<(() => void) | null>(null)
  /** Desktop OAuth connects this hook started, awaiting their deep link. */
  const pendingDesktopRef = useRef<PendingReturn[]>([])
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      flowCleanupRef.current?.()
      flowCleanupRef.current = null
    }
  }, [])

  const clearConnecting = useCallback(() => {
    connectingRef.current = null
    if (mountedRef.current) setConnectingId(null)
  }, [])

  const settle = useCallback(
    (result: ConnectResult) => {
      clearConnecting()
      if (mountedRef.current) onReturnRef.current?.(result)
    },
    [clearConnecting],
  )

  // Desktop: the system-browser detour comes back as a deep link. Only a
  // return for a connect THIS hook started is reported; another surface's
  // connect is that surface's business.
  useEffect(() => {
    return onOAuthCallback((detail) => {
      const now = Date.now()
      const live = pendingDesktopRef.current.filter((p) => now - p.at <= OAUTH_RETURN_TTL_MS)
      const i = live.findIndex(
        (p) => p.provider === detail.provider && (!detail.capability || p.capability === detail.capability),
      )
      if (i === -1) {
        pendingDesktopRef.current = live
        return
      }
      const [match] = live.splice(i, 1)
      pendingDesktopRef.current = live
      onReturnRef.current?.({
        provider: detail.provider,
        capability: detail.capability || match.capability,
        success: detail.success,
        error: detail.error ?? null,
        via: 'reported',
      })
    })
  }, [])

  /** Web: settle on the popup's message, or on the popup closing without one. */
  const watchPopup = useCallback(
    (
      popup: Window,
      messageType: string,
      fromMessage: (data: { success?: unknown; error?: unknown; provider?: unknown; capability?: unknown }) => ConnectResult,
      onClosed: ConnectResult,
    ) => {
      let poll: ReturnType<typeof setInterval> | null = null
      const cleanup = () => {
        window.removeEventListener('message', onMessage)
        if (poll !== null) clearInterval(poll)
        poll = null
        if (flowCleanupRef.current === cleanup) flowCleanupRef.current = null
      }
      function onMessage(e: MessageEvent) {
        if (e.origin !== window.location.origin) return
        if (e.data?.type !== messageType) return
        cleanup()
        settle(fromMessage(e.data))
      }
      window.addEventListener('message', onMessage)
      poll = setInterval(() => {
        if (!popup.closed) return
        cleanup()
        settle(onClosed)
      }, POPUP_CLOSED_POLL_MS)
      flowCleanupRef.current = cleanup
    },
    [settle],
  )

  /** Start a flow: false when the same one is already in flight. */
  const begin = useCallback((id: string): boolean => {
    if (connectingRef.current === id) return false
    // A different connect replaces whatever was in flight (the popup window is
    // shared by name, so the new authorize URL loads into it).
    flowCleanupRef.current?.()
    flowCleanupRef.current = null
    connectingRef.current = id
    setConnectingId(id)
    return true
  }, [])

  const connect = useCallback(
    async (provider: string, capability: string, connectOpts?: { loginHint?: string }) => {
      const id = `${provider}-${capability}`
      if (!begin(id)) return
      const failed = (error: string | null): ConnectResult => ({
        provider,
        capability,
        success: false,
        error,
        via: 'reported',
      })

      // Local Exchange is an EventKit permission, not OAuth.
      if (provider === 'local_exchange') {
        try {
          const { tauriBridge } = await import('@/lib/tauri-bridge')
          const result = await tauriBridge.requestCalendarAccess()
          // No access yet means System Settings was opened: the caller
          // re-reads the status when the window regains focus.
          settle({ provider, capability, success: result.hasAccess, error: null, via: 'reported' })
        } catch (err) {
          console.error('[connect] calendar access request failed:', err)
          settle(failed(errorMessage(err, 'Calendar access request failed')))
        }
        return
      }

      const desktop = isDesktopApp()
      let url: string
      try {
        const res = await fetch(
          authorizeRequestUrl(provider, capability, { desktop, loginHint: connectOpts?.loginHint }),
        )
        if (!res.ok) {
          settle(failed(`Couldn't start the connection (HTTP ${res.status})`))
          return
        }
        const started = (await res.json()) as { url: string; state?: string; claimSecret?: string }
        url = started.url
        // Desktop: keep the claim secret in this window only; the deep link
        // brings the code back and the deep-link handler claims it with this
        // (desktop-oauth-claims.ts). Without it the connect can't finish.
        if (desktop) {
          if (!started.state || !started.claimSecret) {
            settle(failed("Couldn't start the connection"))
            return
          }
          holdDesktopOAuthClaim(started.state, started.claimSecret)
        }
      } catch (err) {
        settle(failed(errorMessage(err, "Couldn't start the connection")))
        return
      }
      if (connectingRef.current !== id) return // replaced while the request ran

      if (desktop) {
        try {
          await openInDefaultBrowser(url)
        } catch (err) {
          settle(failed(errorMessage(err, 'Failed to open the system browser')))
          return
        }
        pendingDesktopRef.current = [
          ...pendingDesktopRef.current.filter((p) => !(p.provider === provider && p.capability === capability)),
          { provider, capability, at: Date.now() },
        ]
        if (origin === 'panel') claimOAuthReturn(provider, capability)
        // The browser owns the flow now; the deep link reports the outcome.
        clearConnecting()
        return
      }

      const popup = window.open(url, POPUP_NAME, POPUP_FEATURES)
      if (!popup) {
        // Popup blocked: a full redirect still completes the flow, the user
        // just loses their place.
        window.location.href = url
        return
      }
      watchPopup(
        popup,
        OAUTH_POPUP_MESSAGE,
        (data) => ({
          provider: typeof data.provider === 'string' && data.provider ? data.provider : provider,
          capability: typeof data.capability === 'string' && data.capability ? data.capability : capability,
          success: data.success === true,
          error: typeof data.error === 'string' ? data.error : null,
          via: 'reported',
        }),
        { provider, capability, success: false, error: null, via: 'closed' },
      )
    },
    [begin, clearConnecting, origin, settle, watchPopup],
  )

  const connectWithUrl = useCallback(
    async (key: string, getUrl: () => Promise<string | null>) => {
      if (!begin(key)) return
      const result = (r: Omit<ConnectResult, 'provider' | 'capability'>): ConnectResult => ({
        provider: key,
        capability: 'mcp',
        ...r,
      })

      let url: string | null
      try {
        url = await getUrl()
      } catch (err) {
        settle(result({ success: false, error: errorMessage(err, 'Failed to start OAuth flow'), via: 'reported' }))
        return
      }
      if (connectingRef.current !== key) return // replaced while starting
      if (!url) {
        clearConnecting()
        return
      }

      if (isDesktopApp()) {
        try {
          await openInDefaultBrowser(url)
        } catch (err) {
          settle(result({ success: false, error: errorMessage(err, 'Failed to open the system browser'), via: 'reported' }))
          return
        }
        // The return: the claim's answer, once the deep link brings the code
        // back (dial8desktop://mcp-oauth/complete → the deep-link handler
        // claims it, desktop-oauth-claims.ts). If the person abandons the
        // browser instead, there is no deep link: the window regaining focus
        // after losing it ends the wait, after a grace for a claim the same
        // deep link is still finishing (opening the app is what refocuses it).
        // Focus without a preceding blur (macOS Cmd+Tab back to an
        // already-focused window) means nothing happened yet.
        // This flow's own claim only: another connect's (another card, a flow
        // this one replaced) never settles it. The state is the authorize URL's.
        let flowState: string | null = null
        try {
          flowState = new URL(url).searchParams.get('state')
        } catch {
          flowState = null
        }
        let blurred = false
        let claiming = false
        let grace: ReturnType<typeof setTimeout> | null = null
        const clearGrace = () => {
          if (grace !== null) clearTimeout(grace)
          grace = null
        }
        const onBlur = () => {
          blurred = true
          // Back to the browser to finish: the refocus wasn't the end after all.
          clearGrace()
        }
        const onFocus = () => {
          if (!blurred || claiming || grace !== null) return
          grace = setTimeout(() => {
            cleanup()
            settle(result({ success: false, error: null, via: 'closed' }))
          }, MCP_DESKTOP_CLAIM_GRACE_MS)
        }
        const stopClaim = onMcpOAuthCallback((detail) => {
          if (!flowState || detail.state !== flowState) return
          if (detail.phase === 'claiming') {
            // The deep link came back and the claim is running (exchange +
            // tools/list can be slow): wait for its answer, not a timer.
            claiming = true
            clearGrace()
            return
          }
          cleanup()
          settle(result({ success: detail.success, error: detail.error ?? null, via: 'reported' }))
        })
        const timeout = setTimeout(() => {
          cleanup()
          settle(result({ success: false, error: null, via: 'closed' }))
        }, MCP_DESKTOP_WAIT_MS)
        const cleanup = () => {
          window.removeEventListener('blur', onBlur)
          window.removeEventListener('focus', onFocus)
          stopClaim()
          clearTimeout(timeout)
          clearGrace()
          if (flowCleanupRef.current === cleanup) flowCleanupRef.current = null
        }
        window.addEventListener('blur', onBlur)
        window.addEventListener('focus', onFocus)
        flowCleanupRef.current = cleanup
        return
      }

      const popup = window.open(url, POPUP_NAME, POPUP_FEATURES)
      if (!popup) {
        window.location.href = url
        return
      }
      watchPopup(
        popup,
        MCP_POPUP_MESSAGE,
        (data) =>
          result({
            success: data.success === true,
            error: typeof data.error === 'string' ? data.error : null,
            via: 'reported',
          }),
        result({ success: false, error: null, via: 'closed' }),
      )
    },
    [begin, clearConnecting, settle, watchPopup],
  )

  return { connect, connectWithUrl, connectingId }
}
