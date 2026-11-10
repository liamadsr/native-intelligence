'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { isDesktopApp } from '@/lib/platform'
import { createClient } from '@/lib/supabase/client'
import { tauriBridge, getThisWebviewLabel } from '@/lib/tauri-bridge'
import { listenScoped } from '@/lib/tauri-unlisten'
import { emitMcpOAuthCallback, emitOAuthCallback, emitSoftNavigate } from '@/lib/navigation-events'
import { claimDesktopMcp, claimDesktopOAuth } from '@/lib/integrations/desktop-oauth-claims'
import {
  DESKTOP_AUTH_SCHEME,
  completeDesktopSignIn,
  desktopSignInLanding,
  parseDesktopAuthCallback,
} from '@/lib/auth/desktop-sign-in'

/**
 * Global deep-link handler for the Tauri desktop app.
 * Mounted in the root layout so it catches auth deep links
 * and OAuth integration callbacks regardless of which page is active.
 * Also syncs Supabase auth tokens to the Rust backend for system tray API calls.
 *
 * MAIN-WINDOW ELECTION: `navigate` and `deep-link-auth` are Rust BROADCASTS and
 * this component mounts in every webview, so with a workspace pop-out open a
 * NON-idempotent intent would run once per window. The election is therefore
 * scoped to the payload class, not the listener:
 *  • auth login (`?code=`) — the code is SINGLE-USE, so the second
 *    exchangeCodeForSession fails and bounces that window to
 *    /login?error=auth_failed. Elected to the webview labelled 'main'.
 *  • `navigate` — a router push per window; elected for the same reason.
 *  • OAuth integration callbacks — a per-window UI notification (a toast plus
 *    opening THIS window's settings overlay) delivered over a same-webview
 *    CustomEvent that cannot cross windows. Run UNGATED: the pop-out that
 *    started the connect is the one that must update, and every other window
 *    reacting only touches its own UI.
 * Rust still broadcasts (old bundles have no election), so the filter lives
 * here. The main window always exists even when hidden to the tray
 * (close-to-tray hides, never destroys), so electing 'main' never drops a link.
 * Outside the desktop shell the label is null and behaviour is unchanged.
 *
 * ONLY dial8desktop:// IS A CALLBACK. An older desktop build broadcasts every
 * URL the OS handed it here, web links included. An https link carrying
 * `?code=` (someone else's OAuth redirect) must never be exchanged as a
 * Supabase code: that failed and bounced the window to
 * /login?error=auth_failed. So every branch below is gated on the protocol.
 */
/**
 * Per-effect gate for broadcast one-shots. Listeners are registered IMMEDIATELY
 * (resolving the label first would add an async hop before registration, and
 * Tauri never replays a broadcast that landed with nobody listening); work is
 * instead funnelled through `run`, which queues until the label settles. So an
 * event delivered during startup is held, not lost and not double-run.
 *
 * `dispose()` drops anything still queued so a late-resolving election can't
 * fire into an unmounted effect.
 */
function createMainWindowGate() {
  let label: string | null | undefined // undefined = not resolved yet
  let pending: Array<() => unknown> = []
  let disposed = false

  const ready = getThisWebviewLabel()
    .catch(() => null)
    .then((resolved) => {
      label = resolved
      const queued = pending
      pending = []
      // Only the elected window replays; a pop-out drops its queue.
      if (!disposed && (resolved === null || resolved === 'main')) {
        for (const run of queued) void run()
      }
    })

  return {
    run(fn: () => unknown) {
      if (disposed) return
      if (label === undefined) {
        pending.push(fn)
        void ready
        return
      }
      if (label !== null && label !== 'main') return
      void fn()
    },
    dispose() {
      disposed = true
      pending = []
    },
  }
}

/**
 * HUD windows (/hud/*: the live agent's /hud/agent, the meeting-detected
 * prompt) are overlays of the main window. They never sync auth, follow tray
 * navigation or take deep links, whatever the label election says: a
 * navigation there would put an app page in an overlay window.
 */
function onHudPage(): boolean {
  return window.location.pathname.startsWith('/hud/')
}

export function DeepLinkHandler() {
  const router = useRouter()
  // The deep-link effect registers ONCE (re-registering would drop broadcasts
  // that land between teardown and the async re-listen), so it reads the router
  // through a ref rather than closing over a value its dep array excludes.
  const routerRef = useRef(router)
  routerRef.current = router
  // Sync Supabase auth token to Rust backend (for calendar tray, etc.)
  useEffect(() => {
    if (!isDesktopApp() || onHudPage()) return

    const supabase = createClient()
    let subscription: { unsubscribe: () => void } | undefined

    async function syncAuth() {
      // Send initial token if already logged in
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        tauriBridge.setAuthToken(session.access_token).catch(() => {})
      }

      // Listen for auth state changes (login, token refresh, logout)
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        tauriBridge.setAuthToken(session?.access_token ?? '').catch(() => {})
      })
      subscription = data.subscription
    }

    syncAuth()
    return () => subscription?.unsubscribe()
  }, [])

  // Handle tray navigation events (Settings, etc.)
  useEffect(() => {
    if (!isDesktopApp() || onHudPage()) return

    const gate = createMainWindowGate()

    const stop = listenScoped((scoped) =>
      import('@tauri-apps/api/event').then(({ listen }) =>
        listen<string>('navigate', scoped((event) => gate.run(() => {
          const path = event.payload
          if (path && typeof path === 'string') {
            console.log('[deep-link-handler] tray navigate:', path)
            // Use soft navigation to avoid destroying React state
            emitSoftNavigate({ path })
            router.push(path)
          }
        }))),
      ),
    )
    return () => {
      gate.dispose()
      stop()
    }
  }, [router])

  // Handle deep-link events (OAuth callbacks, auth login)
  useEffect(() => {
    if (!isDesktopApp() || onHudPage()) return

    const gate = createMainWindowGate()

    const stop = listenScoped((scoped) =>
      import('@tauri-apps/api/event').then(({ listen }) =>
        // Classify OUTSIDE the gate: the election is per payload class (see the
        // component doc), so the URL must be parsed before any window is elected
        // or the ungated OAuth branch would still be queued and dropped.
        listen<string>('deep-link-auth', scoped((event) => {
          let urlStr = event.payload
          if (typeof urlStr === 'string') {
            urlStr = urlStr.replace(/^"|"$/g, '')
          }

          let url: URL
          try {
            url = new URL(urlStr)
          } catch (err) {
            console.error('[deep-link-handler] error:', err)
            return
          }
          // Web links and anything else: not ours (see the component doc). Not
          // logged: a web link is the user's browsing.
          if (url.protocol !== DESKTOP_AUTH_SCHEME) {
            console.warn('[deep-link-handler] ignored a non-dial8desktop URL')
            return
          }
          console.log('[deep-link-handler] received:', `${url.protocol}//${url.host}${url.pathname}`)
          const host = url.host || url.pathname.split('/')[0]
          const path = url.pathname || ''

          // MCP connector connects (dial8desktop://mcp-oauth/complete or /error).
          // UNGATED like the integration branch below: only the window holding
          // the state's claim secret acts (desktop-oauth-claims.ts), so it
          // settles once, and a link for a flow it didn't start is ignored.
          if (host === 'mcp-oauth' || path.startsWith('/mcp-oauth')) {
            const state = url.searchParams.get('state')
            if (!state) return
            void claimDesktopMcp(
              { state, code: url.searchParams.get('code'), error: url.searchParams.get('error') },
              fetch,
              // The claim can take a while (exchange + tools/list): the connect
              // hook stops treating the refocus as an abandoned connect.
              () => emitMcpOAuthCallback({ state, phase: 'claiming' }),
            ).then((outcome) => {
              if (!outcome) return
              if (!outcome.success) console.error(`[deep-link-handler] MCP connect failed: ${outcome.error}`)
              emitMcpOAuthCallback({ ...outcome, phase: 'done' })
            })
            return
          }

          // OAuth integration callbacks (dial8desktop://oauth/complete, oauth/error).
          // UNGATED — per-window: only the window holding the claim secret
          // claims a code (desktop-oauth-claims.ts), so it settles once.
          // There is no success deep link: success is only what a claim
          // returns, so no other app opening a dial8desktop:// URL can fake it.
          if (host === 'oauth' || path.startsWith('/oauth')) {
            const error = url.searchParams.get('error')
            const provider = url.searchParams.get('provider') || ''
            const capability = url.searchParams.get('capability') || ''

            // The callback hands a desktop code back sealed and unexchanged; claim it.
            const isComplete = path === '/complete' || path === '/oauth/complete'
            const sealed = url.searchParams.get('sealed')
            const state = url.searchParams.get('state')
            if (isComplete && sealed && state) {
              void claimDesktopOAuth({ provider, capability, sealed, state }).then((outcome) => {
                if (!outcome) return // another window's connect, or nobody's
                if (outcome.success) {
                  console.log(`[deep-link-handler] OAuth connected: ${outcome.provider} ${outcome.capability}`)
                  emitOAuthCallback({ success: true, provider: outcome.provider, capability: outcome.capability })
                } else {
                  console.error(`[deep-link-handler] OAuth claim failed: ${outcome.error}`)
                  emitOAuthCallback({ success: false, provider, capability, error: outcome.error })
                }
              })
              return
            }

            if (error) {
              console.error(`[deep-link-handler] OAuth error: ${error}`)
              emitOAuthCallback({ success: false, provider, capability, error })
            }
            return
          }

          // Handle auth login callbacks (dial8desktop://auth/callback?code=...)
          // NOTE: Auth callbacks require a full page transition since the user
          // may be on the login page (outside the dashboard layout). This is
          // fine because there's no active capture during login. The `code` is
          // single-use, so exactly one window may exchange it. A password
          // reset asked for in the app returns here too and lands on the
          // reset page (src/lib/auth/password-reset.ts).
          const callback = parseDesktopAuthCallback(url.href)
          if (!callback) return
          // A bare callback (no code, no error) carries nothing to act on.
          if (callback.kind === 'error' && !url.searchParams.get('error')) return
          gate.run(async () => {
            const outcome = await completeDesktopSignIn(callback, createClient())
            if (outcome.ok) console.log('[deep-link-handler] session exchanged, redirecting')
            routerRef.current.push(desktopSignInLanding(outcome))
          })
        })),
      ),
    )
    return () => {
      gate.dispose()
      stop()
    }
  }, [])

  return null
}
