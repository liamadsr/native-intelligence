/**
 * The desktop app's sign-in callback: `dial8desktop://auth/callback?code=…`
 * (or `?error=…`), produced by /auth/desktop-callback, or
 * `…?token_hash=…` from /auth/chatgpt/callback or /auth/google/callback
 * (ChatGPT sign-in, and Google sign-in on dial8.ai, run Native Intelligence's own OAuth
 * flow and hand over a one-time magic-link token instead of a Supabase PKCE
 * code).
 *
 * It reaches the app two ways, and both finish here so they behave the same:
 *  • as a deep link (DeepLinkHandler): an email link, or a build without the
 *    sign-in session that opened the sign-in page in the system browser;
 *  • as the result of the desktop's web authentication session
 *    (`tauriBridge.authWebSession`, the login page's Google and ChatGPT
 *    buttons).
 *
 * Only a `dial8desktop:` URL is a sign-in callback. An http(s) URL with a
 * `?code=` is somebody else's OAuth redirect and is never exchanged.
 */

export const DESKTOP_AUTH_SCHEME = 'dial8desktop:'

export type DesktopAuthCallback =
  | { kind: 'code'; code: string }
  | { kind: 'token_hash'; tokenHash: string; bind: string | null }
  | { kind: 'error'; error: string; description: string | null }

/**
 * A token_hash (ChatGPT or Google sign-in) is only redeemed when it carries
 * the `bind` this webview chose when it started that sign-in. A PKCE code is bound by
 * its verifier, but a magic-link token isn't bound to anything, so without
 * this a crafted dial8desktop:// link could sign the app into someone else's
 * account. The value lives in localStorage (the system-browser fallback
 * returns as an OS deep link, outside the starting page) for 15 minutes and
 * is used once.
 */
const BIND_KEY = 'ni.desktop-sign-in.bind'
const BIND_TTL_MS = 15 * 60 * 1000

/** Start a desktop sign-in that ends on a token_hash (ChatGPT, or Google on
 *  dial8.ai): the value to send as `?bind=`. */
export function beginDesktopTokenSignIn(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const bind = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  try {
    localStorage.setItem(BIND_KEY, JSON.stringify({ bind, at: Date.now() }))
  } catch {
    // No storage: the token_hash will be refused and the person can retry.
  }
  return bind
}

/** True once, for the bind this webview issued and still holds. */
function consumeBind(bind: string | null): boolean {
  try {
    const raw = localStorage.getItem(BIND_KEY)
    localStorage.removeItem(BIND_KEY)
    if (!raw || !bind) return false
    const stored = JSON.parse(raw) as { bind?: string; at?: number }
    return stored.bind === bind && typeof stored.at === 'number' && Date.now() - stored.at < BIND_TTL_MS
  } catch {
    return false
  }
}

/** Parse a sign-in callback, or null when `raw` isn't one. */
export function parseDesktopAuthCallback(raw: string): DesktopAuthCallback | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== DESKTOP_AUTH_SCHEME) return null
  // `dial8desktop://auth/callback`: WHATWG parses a non-special scheme's
  // authority as the host ("auth"); tolerate the path form too.
  const target = `${url.host}${url.pathname}`.replace(/^\/+/, '')
  if (target !== 'auth/callback' && target !== 'auth/callback/') return null
  const code = url.searchParams.get('code')
  if (code) return { kind: 'code', code }
  const tokenHash = url.searchParams.get('token_hash')
  if (tokenHash) return { kind: 'token_hash', tokenHash, bind: url.searchParams.get('bind') }
  return {
    kind: 'error',
    error: url.searchParams.get('error') || 'missing_code',
    description: url.searchParams.get('error_description'),
  }
}

/** What finishing a sign-in callback came to: signed in, or a `/login?error=`
 *  code (the login page's ERROR_MESSAGES keys; unknown codes read generically). */
export type DesktopSignInOutcome = { ok: true } | { ok: false; error: string; description: string | null }

interface AuthClient {
  auth: {
    exchangeCodeForSession(code: string): Promise<{ error: unknown }>
    verifyOtp(params: { token_hash: string; type: 'magiclink' }): Promise<{ error: unknown }>
  }
}

/** Exchange the callback's code for a session (PKCE: the verifier this
 *  webview stored when it started the sign-in; a code from anywhere else
 *  fails here), or redeem a ChatGPT or Google sign-in's one-time token. */
export async function completeDesktopSignIn(
  callback: DesktopAuthCallback,
  supabase: AuthClient,
): Promise<DesktopSignInOutcome> {
  if (callback.kind === 'error') {
    return { ok: false, error: callback.error, description: callback.description }
  }
  if (callback.kind === 'token_hash' && !consumeBind(callback.bind)) {
    console.error('[desktop-sign-in] sign-in token not bound to this app; refused')
    return { ok: false, error: 'auth_failed', description: null }
  }
  try {
    const { error } =
      callback.kind === 'code'
        ? await supabase.auth.exchangeCodeForSession(callback.code)
        : await supabase.auth.verifyOtp({ token_hash: callback.tokenHash, type: 'magiclink' })
    if (error) {
      console.error('[desktop-sign-in] session error:', error)
      return { ok: false, error: 'auth_failed', description: null }
    }
    return { ok: true }
  } catch (err) {
    console.error('[desktop-sign-in] error:', err)
    return { ok: false, error: 'auth_failed', description: null }
  }
}

/** `/login?error=` for a failed outcome. The code is reduced to a safe token. */
export function loginErrorPath(error: string): string {
  const code = /^[a-z0-9_]{1,64}$/i.test(error) ? error : 'auth_failed'
  return `/login?error=${encodeURIComponent(code)}`
}
