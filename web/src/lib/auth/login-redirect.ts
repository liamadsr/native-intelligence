/**
 * Where `/login?redirect=` may send a person once they're signed in. The
 * value is anyone's to write (a link to /login can carry any `redirect`), so
 * every target is checked here, on the way in (the login form's cookie) and
 * on the way out (the OAuth callback, the password sign-in).
 */
import { APP_PAGE_ORIGINS, appDomainOf, appUrl } from '@/lib/app-url'

/**
 * The page's own origin, the app's configured one (NEXT_PUBLIC_APP_URL), which
 * the MCP authorize step links back from, and the domains the hosted app is
 * served on: a person who started on one of them resumes on the page's own
 * (the target is cut down to a path either way).
 */
function trustedOrigins(origin: string, appUrl: string | undefined): Set<string> {
  const origins = new Set<string>()
  for (const raw of [origin, appUrl, ...APP_PAGE_ORIGINS]) {
    if (!raw) continue
    try {
      origins.add(new URL(raw).origin)
    } catch {
      /* not a URL: not trusted */
    }
  }
  return origins
}

/**
 * The MCP OAuth step a redirect names, as a path and search, or null. The
 * authorize route (src/app/api/mcp/oauth/authorize) sends a signed-out person
 * to /login with its own full URL, so a full URL is fine, but only on this
 * origin or the app's: `https://evil.example/api/mcp/x`, `//evil.example/…`,
 * or a look-alike host would otherwise send a freshly signed-in person
 * off-site.
 */
export function mcpRedirectTarget(value: string, origin: string, appUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL): string | null {
  let url: URL
  try {
    url = new URL(value, origin)
  } catch {
    return null
  }
  if (!trustedOrigins(origin, appUrl).has(url.origin)) return null
  if (!url.pathname.startsWith('/api/mcp/') && !url.pathname.startsWith('/mcp/')) return null
  return `${url.pathname}${url.search}`
}

/**
 * A page an invite opens, which a person may need to sign in or up for first:
 * a workspace invite (/invite/<token>) or an agent link's connect link
 * (/link/<token>). Same-site paths only.
 */
export function isInviteRedirectPath(path: string): boolean {
  return (path.startsWith('/invite/') || path.startsWith('/link/')) && !path.includes('//')
}

/**
 * A page of the app itself: /account, its pages and their deep links (`/account?page=studio&video=<id>&export=<id>`,
 * the link the desktop app opens in the person's browser to download a large export there). Same-site paths only.
 */
export function isAccountRedirectPath(path: string): boolean {
  return /^\/account(?:[/?#]|$)/.test(path) && !path.includes('//') && !path.includes('\\')
}

/**
 * Where a password sign-in (or an instant sign-up) sends the person: the MCP
 * authorize step to resume, an invite (or connect link) or a shared page, or a page in the app;
 * anything else is /account.
 */
export function resolvePostAuthRedirect(redirectPath: string | null, origin: string): string {
  if (!redirectPath) return '/account'
  const mcp = mcpRedirectTarget(redirectPath, origin)
  if (mcp) return mcp
  if (redirectPath.includes('//')) return '/account'
  if (isInviteRedirectPath(redirectPath) || redirectPath.startsWith('/s/') || isAccountRedirectPath(redirectPath)) {
    return redirectPath
  }
  return '/account'
}

/**
 * Where Supabase sends a sign-in back to once the person has proved who they
 * are (its `redirectTo` / `emailRedirectTo`).
 *
 * In a browser: /auth/callback on the page's own origin, because that route
 * redeems the code with the verifier cookie this origin holds.
 *
 * In the desktop app: /auth/desktop-callback, which only hands the code to the
 * app (a dial8desktop:// link) for the app's own webview to redeem, so any of
 * the app's domains would do. It is the page's own origin, as it always was,
 * except for a window on the hosted app's OTHER domain (a build that loads
 * one domain while the app's address, NEXT_PUBLIC_APP_URL, is still on the
 * other): that one returns through the app's address, the entry Supabase's
 * redirect list is sure to hold. A redirect Supabase does not list falls back
 * to its Site URL, where a desktop sign-in ends nowhere.
 */
export function signInReturnUrl(where: 'desktop' | 'browser', pageOrigin: string, appAddress: string = appUrl()): string {
  if (where === 'browser') return `${pageOrigin}/auth/callback`
  return `${onTheAppsOtherDomain(pageOrigin, appAddress) ? appAddress : pageOrigin}/auth/desktop-callback`
}

/** Is `pageOrigin` a page origin of the hosted app, on a different one of its domains than `appAddress`? */
function onTheAppsOtherDomain(pageOrigin: string, appAddress: string): boolean {
  if (!APP_PAGE_ORIGINS.includes(pageOrigin)) return false
  try {
    const home = appDomainOf(new URL(appAddress).hostname)
    return home !== null && home !== appDomainOf(new URL(pageOrigin).hostname)
  } catch {
    return false
  }
}

/** Whether a sign-in target needs a full page load (an API route the client router can't open). */
export function isMcpTarget(target: string): boolean {
  return target.startsWith('/api/mcp/') || target.startsWith('/mcp/')
}
