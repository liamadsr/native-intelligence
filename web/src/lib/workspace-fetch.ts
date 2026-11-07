/**
 * Client-side workspace-aware fetch interceptor.
 *
 * In the desktop app, multiple windows can run different workspaces simultaneously.
 * Each window stores its active workspace ID here and `patchFetch()` injects an
 * `x-workspace-id` header on every `/api/` request so the server knows which
 * workspace the request belongs to — regardless of the shared httpOnly cookie.
 *
 * The ID is also persisted to localStorage so it survives page reloads. That
 * storage is SHARED by the desktop's windows on macOS (a workspace popout, the
 * HUD), so what a window reloads into is the last workspace any window set;
 * each window's own id lives in memory here, and a window that isn't a
 * workspace of its own (the live agent's HUD) sets it with `persist: false`.
 *
 * This file also watches every `/api/` response for a 429 "Usage limit exceeded"
 * body and triggers the global UsageLimitDialog via openUsageLimit(). Any AI
 * endpoint that returns the payload from lib/ai/auth.ts checkUsageLimits() will
 * automatically surface the upgrade prompt to the user — callers don't need to
 * opt in individually.
 *
 * The workspace header also goes to the same-origin `/eve/` agent mounts
 * (`/eve/<name>/v1/...`). Those channels resolve the workspace
 * themselves as header -> cookie -> first membership, and their
 * session-ownership ACL compares the result against the workspace the
 * conversation was minted under. A user who belongs to more than one workspace
 * and has no `workspace_id` cookie yet (fresh sign-in, never used the switcher)
 * would otherwise be resolved to a DIFFERENT workspace there than the `/api/`
 * route that created the session — and get 403'd out of their own session.
 * Only the workspace header is injected on `/eve/`: the eve client manages its
 * own Authorization, and its stream responses are long-lived NDJSON, so the
 * Bearer attach, the 401 refresh-and-retry and the 429 body read below stay
 * scoped to `/api/`.
 *
 * Auth resilience: the interceptor attaches the Supabase access token as an
 * `Authorization: Bearer` header (so requests authenticate even when the
 * httpOnly cookie session has gone stale — common in the multi-window desktop
 * app), and transparently refreshes-and-retries once on a 401. Without this, an
 * expired server-side cookie produces a silent "logged in in the UI but every
 * request 401s" split-brain that only a full re-login clears.
 */

import { openUsageLimit, parseUsageLimitResponse } from './usage-limit-store'
import { installDeployReload, noteResponseBuild } from './deploy-reload'

const STORAGE_KEY = 'dial8-workspace-id'

let _activeWorkspaceId: string | null = null

// Restore from localStorage on module load (survives reload)
if (typeof window !== 'undefined') {
  try {
    _activeWorkspaceId = localStorage.getItem(STORAGE_KEY)
  } catch { /* ignore */ }

  // If the URL has ?switch_to=<id>, validate it looks like a UUID before using it.
  // The server will still verify membership on every API call via getCurrentWorkspaceId().
  try {
    const switchTo = new URLSearchParams(window.location.search).get('switch_to')
    if (switchTo && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(switchTo)) {
      _activeWorkspaceId = switchTo
    }
  } catch { /* ignore */ }
}

/** Set the active workspace ID for this window. Called by WorkspaceCacheProvider.
 *  `persist: false` keeps it to this window's memory: a window that shares
 *  storage with the app but is not a workspace of its own (the live agent's
 *  HUD) must not rewrite the workspace the app's windows reload into. */
export function setClientWorkspaceId(id: string | null, { persist = true }: { persist?: boolean } = {}) {
  _activeWorkspaceId = id
  if (persist && typeof window !== 'undefined') {
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id)
      else localStorage.removeItem(STORAGE_KEY)
    } catch { /* ignore */ }
  }
}

/** Get the active workspace ID for this window. */
export function getClientWorkspaceId(): string | null {
  return _activeWorkspaceId
}

// ── Auth token helpers ──────────────────────────────────────────────────────
//
// The Supabase browser client keeps a fresh access token in memory/cookies and
// auto-refreshes it. We read it lazily (dynamic import, so this module stays
// usable in non-browser/SSR contexts) and attach it as a Bearer header. The
// server's auth (proxy.ts + requireWorkspace) accepts a Bearer access token as
// a fallback when the cookie session is stale.

/** Read the current Supabase access token, or null if signed out / unavailable. */
async function getAccessToken(): Promise<string | null> {
  try {
    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? null
  } catch {
    return null
  }
}

// Dedupe refreshes across a burst of 401s. A page load fires many requests at
// once; if the cookie/token is stale they ALL 401 within a few hundred ms. They
// must NOT each call refreshSession() — that races Supabase's refresh-token
// rotation and can invalidate the very token we just minted. Two layers:
//   1. An in-flight promise coalesces perfectly-overlapping refreshes.
//   2. A short TTL cache of the just-minted token coalesces near-simultaneous
//      ones (request B 401s on the old token a beat after A already refreshed).
let _refreshInFlight: Promise<string | null> | null = null
let _lastRefreshToken: string | null = null
let _lastRefreshAt = 0
/** Window during which a fresh token is reused instead of re-refreshing. */
const REFRESH_COALESCE_MS = 5_000

/** Force a single shared session refresh; returns the new access token or null. */
async function refreshAccessToken(nowMs: number): Promise<string | null> {
  // Reuse a very-recently-minted token rather than refreshing again.
  if (_lastRefreshToken && nowMs - _lastRefreshAt < REFRESH_COALESCE_MS) {
    return _lastRefreshToken
  }
  if (_refreshInFlight) return _refreshInFlight
  _refreshInFlight = (async () => {
    try {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data, error } = await supabase.auth.refreshSession()
      if (error) return null
      const token = data.session?.access_token ?? null
      if (token) {
        _lastRefreshToken = token
        _lastRefreshAt = nowMs
      }
      return token
    } catch {
      return null
    } finally {
      _refreshInFlight = null
    }
  })()
  return _refreshInFlight
}

// Redirect-to-login guard: once we've given up (refresh failed) we bounce to
// /login exactly once, so a burst of dead requests can't loop-redirect.
let _redirectedToLogin = false

/** Session is unrecoverable (refresh failed). Send the user to sign in again. */
function handleSessionExpired() {
  if (typeof window === 'undefined' || _redirectedToLogin) return
  const path = window.location.pathname
  // Already on an auth page — nothing to do.
  if (path === '/login' || path.startsWith('/admin/login')) return
  _redirectedToLogin = true
  // Let any listener (e.g. a toast) react before we navigate.
  try { window.dispatchEvent(new CustomEvent('dial8:session-expired')) } catch { /* ignore */ }
  const next = encodeURIComponent(path + window.location.search)
  window.location.href = `/login?next=${next}`
}

let _patched = false

/**
 * Monkey-patch `window.fetch` to inject `x-workspace-id` on same-origin `/api/`
 * and `/eve/` requests.
 *
 * `/api/` requests additionally get the Bearer attach, the 401
 * refresh-and-retry and the 429 usage-limit watch. `/eve/` requests get ONLY
 * the workspace header — the eve client owns its Authorization, and its stream
 * responses are long-lived NDJSON that must not be read here. The header still
 * matters there: the eve channel resolves the workspace as header -> cookie ->
 * first membership and its session-ownership ACL compares that against the
 * conversation's workspace, so without it a multi-workspace user with no
 * `workspace_id` cookie is 403'd from the session `/api/` just minted for them.
 *
 * Safe to call multiple times — only patches once.
 */
export function patchFetch() {
  if (typeof window === 'undefined' || _patched) return
  _patched = true
  // New deploy → reload when idle (lib/deploy-reload.ts): every response below
  // reports the server's build, and a window back in view re-checks once.
  installDeployReload()

  const originalFetch = window.fetch.bind(window)
  const origin = window.location.origin

  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const isSameOriginApi = url.startsWith('/api/') ||
      (url.startsWith(origin) && url.includes('/api/'))
    // Anchored to the PATH (origin + '/eve/'), not a loose `includes`, so an
    // unrelated URL that merely contains "/eve/" somewhere is not matched.
    const isSameOriginEve = url.startsWith('/eve/') || url.startsWith(`${origin}/eve/`)

    // Non-API, non-eve or cross-origin requests pass straight through, untouched.
    if (!isSameOriginApi && !isSameOriginEve) {
      return originalFetch(input, init)
    }

    // Merge headers from both the Request object (if any) and init, with init
    // taking precedence — same precedence the platform applies.
    const baseHeaders = new Headers(input instanceof Request ? input.headers : init?.headers)
    if (input instanceof Request && init?.headers) {
      new Headers(init.headers).forEach((v, k) => baseHeaders.set(k, v))
    }

    const wsId = _activeWorkspaceId
    if (wsId && !baseHeaders.has('x-workspace-id')) {
      baseHeaders.set('x-workspace-id', wsId)
    }

    // The eve mounts get the workspace header and NOTHING else: the eve client
    // manages its own Authorization, and a stream response is long-lived NDJSON
    // that neither the 401 retry nor the 429 body read may touch.
    if (!isSameOriginApi) {
      const eveRes = await originalFetch(input, { ...init, headers: baseHeaders })
      noteResponseBuild(eveRes)
      return eveRes
    }

    // Attach the Supabase access token as a Bearer header so the request
    // authenticates even when the httpOnly cookie session is stale. Never
    // overwrite an Authorization header a caller set deliberately (e.g. a
    // device token, or a route that manages its own auth).
    const hadOwnAuth = baseHeaders.has('authorization')
    if (!hadOwnAuth) {
      const token = await getAccessToken()
      if (token) baseHeaders.set('Authorization', `Bearer ${token}`)
    }

    // A Request body can only be read once. Clone it up front so a retry has an
    // unconsumed copy (no-op for string/URL inputs, whose body lives in init).
    const send = (headers: Headers): Promise<Response> =>
      input instanceof Request
        ? originalFetch(input.clone(), { ...init, headers })
        : originalFetch(input, { ...init, headers })

    let res = await send(baseHeaders)
    noteResponseBuild(res)

    // Transparent refresh-and-retry on 401: the cookie/token went stale. Only
    // attempt when WE supplied the auth (a caller-managed Authorization header
    // owns its own retry semantics), and only once per request.
    if (res.status === 401 && !hadOwnAuth) {
      const newToken = await refreshAccessToken(Date.now())
      if (newToken) {
        const retryHeaders = new Headers(baseHeaders)
        retryHeaders.set('Authorization', `Bearer ${newToken}`)
        res = await send(retryHeaders)
      } else {
        // Refresh failed — the session is unrecoverable. Bounce to login once.
        handleSessionExpired()
      }
    }

    // Watch same-origin /api/ responses for AI usage-limit 429s.
    // Triggers the global UsageLimitDialog as a side effect — the response
    // is returned unchanged so the caller's normal error handling still runs.
    if (res.status === 429) {
      const info = await parseUsageLimitResponse(res)
      if (info) openUsageLimit(info)
    }

    return res
  } as typeof window.fetch
}

// Auto-patch on module load so the interceptor is ready before any component mounts
patchFetch()
