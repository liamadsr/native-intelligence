/**
 * Schemes an external link may use. Everything else is refused.
 *
 * The URLs reaching this helper are not all app-authored: `external_url` on a
 * link row and the compose panel's native-create deep link are both built from
 * the workspace's stored Jira `site_url`, which one admin writes and every other
 * member clicks. A `javascript:` URL in `window.open` executes in the app's own
 * origin (stored XSS, not self-XSS), and the desktop opener hands whatever it
 * gets to the OS, where `file:` and custom schemes are launchers.
 *
 * Validated HERE as well as at the settings PATCH boundary and in
 * parseJiraConfig, deliberately: this is the only layer that also covers
 * callers that never touch Jira and rows written before those checks existed.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** True when `url` is an absolute http(s) URL — the only kind we will open. */
export function isOpenableUrl(url: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url.trim()).protocol)
  } catch {
    // Not parseable as an absolute URL. A relative path is never an EXTERNAL
    // link, so there is nothing to salvage by resolving it against the origin.
    return false
  }
}

/**
 * Marks a link that must open in the user's own browser (a file download,
 * say), whatever else handles its clicks.
 */
export const SYSTEM_BROWSER_ATTR = 'data-system-browser'
/** Spread on an <a>: `<a href={url} {...SYSTEM_BROWSER_PROPS}>`. */
export const SYSTEM_BROWSER_PROPS = { [SYSTEM_BROWSER_ATTR]: '' } as const

/** Sign-in and account pages (an OAuth consent screen, an identity provider). */
const SIGN_IN_HOSTS = new Set([
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
  'appleid.apple.com',
  'auth.atlassian.com',
  'id.atlassian.com',
])
/** Payment pages: Stripe checkout, invoices, the billing portal, and Connect
 *  onboarding (connecting an account). */
const PAYMENT_HOSTS = new Set([
  'checkout.stripe.com',
  'billing.stripe.com',
  'buy.stripe.com',
  'invoice.stripe.com',
  'pay.stripe.com',
  'connect.stripe.com',
])

const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** Hosts whose every link joins a meeting. */
const MEETING_DOMAINS = [
  'meet.google.com',
  'zoom.us',
  'zoomgov.com',
  'webex.com',
  'gotomeeting.com',
  'meet.goto.com',
  'chime.aws',
  'whereby.com',
  'meet.jit.si',
  'bluejeans.com',
]

/** A link that joins a meeting. */
function isMeetingLink(host: string, path: string): boolean {
  if (MEETING_DOMAINS.some((d) => within(host, d))) return true
  // Teams and Slack themselves are fine in a tab; joining a call is not.
  if (host === 'teams.microsoft.com' || host === 'teams.live.com') {
    return path.startsWith('/l/meetup-join') || path.startsWith('/meet/')
  }
  return host === 'app.slack.com' && path.startsWith('/huddle/')
}

/**
 * The link inside a security scanner's or redirector's wrapper, if `u` is one:
 * Microsoft Defender Safe Links (Outlook mail synced from a Microsoft 365
 * tenant has every link rewritten), Proofpoint URL Defense, Google's /url
 * redirector. Null for anything else (an opaque click-tracker can't be seen
 * through).
 */
function unwrap(u: URL): string | null {
  const host = u.hostname.toLowerCase()
  if (host.endsWith('.safelinks.protection.outlook.com')) return u.searchParams.get('url')
  if ((host === 'www.google.com' || host === 'google.com') && u.pathname === '/url') {
    return u.searchParams.get('q') ?? u.searchParams.get('url')
  }
  if (host === 'urldefense.com' || host === 'urldefense.proofpoint.com') {
    // v3: /v3/__<url>__;<signature>
    const v3 = /\/v3\/__(.+?)__;/.exec(u.pathname + u.search)
    if (v3) return v3[1]
    // v2: ?u=<url, with - for % and _ for />
    const v2 = u.searchParams.get('u')
    if (v2) {
      try {
        return decodeURIComponent(v2.replace(/-/g, '%').replace(/_/g, '/'))
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * True for a URL that never opens in the in-app browser: signing in,
 * connecting an account (an OAuth authorize step, on any provider), paying,
 * joining a meeting, and Native Intelligence's own pages. The user's sign-ins, passkeys and
 * saved cards live in their browser, OAuth callbacks come back to the desktop
 * app through it, Apple Pay doesn't run in an in-app tab, and a meeting link
 * launches the meeting app from the browser — an in-app tab can't, and has no
 * camera or mic. Native Intelligence itself in a tab would share the app's cookies and sign
 * in through the web flow, in the tab. The connect and sign-in buttons already
 * hand their URLs to the system browser themselves; this keeps a plain LINK to
 * such a page out of the in-app browser too. A wrapped link (Safe Links, …) is
 * judged by the link inside.
 */
export function keepsSystemBrowser(url: string): boolean {
  return keeps(url, 0)
}

function keeps(url: string, depth: number): boolean {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return false
  }
  const host = u.hostname.toLowerCase()
  if (within(host, 'dial8.ai')) return true
  if (SIGN_IN_HOSTS.has(host) || PAYMENT_HOSTS.has(host)) return true
  const path = u.pathname.toLowerCase()
  if (isMeetingLink(host, path)) return true
  if (host === 'github.com' && (path.startsWith('/login') || path.startsWith('/session'))) return true
  if (/\/(oauth2?|authorize|sso|saml)(\/|$)/.test(path)) return true
  // An authorization request, wherever it's served from.
  const q = u.searchParams
  if (q.has('redirect_uri') || (q.has('client_id') && q.has('response_type'))) return true
  const inner = depth < 3 ? unwrap(u) : null
  return !!inner && keeps(inner, depth + 1)
}

/**
 * Open a URL in the user's browser, from either surface the app runs on.
 *
 * In the desktop (Tauri) WKWebView, `window.open` is silently swallowed —
 * external links must be handed to the OS via the opener plugin. The OAuth
 * connect and sign-in buttons inline that call ON PURPOSE (they must stay in
 * the user's browser); every other external link should use this helper.
 *
 * A URL that is not an absolute http(s) one is DROPPED with a warning rather
 * than opened. A dead click on a poisoned link beats running its payload, and
 * the surfaces that build these links (the Linked menu row, the compose panel's
 * native-create fallback) all degrade to "nothing happened" rather than break.
 */
export async function openExternalUrl(url: string, _opts: { background?: boolean } = {}): Promise<void> {
  if (!isOpenableUrl(url)) {
    console.warn('[open-external] refused to open a non-http(s) url')
    return
  }
  await openInSystemBrowser(url)
}

/**
 * Open a link a click on something that isn't an <a> asked for (a link
 * preview card): ⇧ or ⌥ goes straight to the user's browser, anything else
 * where openExternalUrl sends it.
 */
export function openUrlForClick(
  url: string,
  click: { shiftKey?: boolean; altKey?: boolean; metaKey?: boolean },
): Promise<void> {
  return click.shiftKey || click.altKey
    ? openInSystemBrowser(url).then(() => undefined)
    : openExternalUrl(url, { background: !!click.metaKey })
}

/**
 * True for a link to another site (an absolute http(s) URL, not the app's
 * own): one an <a> should open with target=_blank, so it leaves the app alone
 * on the web and opens in the user's browser on desktop. Relative paths, the
 * app's own URLs, mailto: and the rest are not.
 */
export function isExternalHref(href: string | null | undefined): boolean {
  return !!href && isOpenableUrl(href) && !isAppUrl(href)
}

/** Spread on an <a> to another site: `<a href={url} {...EXTERNAL_LINK_PROPS}>`. */
export const EXTERNAL_LINK_PROPS = { target: '_blank', rel: 'noopener noreferrer' } as const

/** The page's own origin (a dev server's, say): never a link out. */
function isAppUrl(url: string): boolean {
  try {
    return typeof window !== 'undefined' && new URL(url.trim()).origin === window.location.origin
  } catch {
    return false
  }
}

/**
 * Open an http(s) URL in the user's own browser (never the in-app one).
 * Resolves false when it could not be handed off (a refused URL, no window),
 * true otherwise (a browser that silently blocks a popup can't be detected).
 */
export async function openInSystemBrowser(url: string): Promise<boolean> {
  if (!isOpenableUrl(url)) {
    console.warn('[open-external] refused to open a non-http(s) url')
    return false
  }
  if (
    typeof window !== 'undefined' &&
    ((window as unknown as { __TAURI__?: unknown }).__TAURI__ ||
      (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  ) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
      return true
    } catch {
      // Fall through — a maybe-blocked popup beats a dead click.
    }
  }
  if (typeof window === 'undefined' || typeof window.open !== 'function') return false
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}

/**
 * Hide `a.target` from page scripts until the returned undo runs (the JS
 * property only: the DOM attribute is never touched). The desktop shell
 * plugin's script on <body> opens any target=_blank link whatever
 * preventDefault says, so a click handler that opens the link itself hides
 * the target first: a chat file whose link went stale (chat-file-part.tsx) and
 * the editor's links (url-link-decorations.ts). Null if it can't be
 * (the click is then left alone).
 */
export function hideTarget(a: HTMLAnchorElement): (() => void) | null {
  if (!a.target) return () => {}
  try {
    Object.defineProperty(a, 'target', {
      configurable: true,
      get: () => '',
      set: (v: string) => a.setAttribute('target', String(v)),
    })
  } catch {
    return null
  }
  let undone = false
  return () => {
    if (undone) return
    undone = true
    delete (a as { target?: string }).target
  }
}
