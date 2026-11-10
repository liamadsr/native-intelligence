/**
 * The forward from the app's old domain to its current one: dial8.ai (and its
 * www.) to nativeintelligence.dev. It moves people who open a page in a
 * browser, and nothing else.
 *
 * Off unless NI_FORWARD_OLD_DOMAIN is `307` (a temporary redirect, to start
 * with) or `308` (permanent). The value is read on every request, never
 * compiled in, so it is turned on and off without a code change: on the
 * server, the line in deploy/app/.env and `sudo ./deploy.sh --no-build`; on
 * the app's current host, the setting and a redeploy of the same commit.
 *
 * A request is forwarded only when every one of these holds (oldDomainForward):
 * - GET or HEAD. Nothing that posts: most callers do not follow a redirect on a
 *   POST, or drop their credentials when they do.
 * - Its Host is the old domain or its www. Never a browser-relay. host, the new
 *   domain, a preview or a local address.
 * - Its path belongs to a family people open in a browser (ROUTES: 'page').
 *   Every `api/` family, every sign-in, email-link and connect step, the files
 *   programs read, and the desktop's own windows are never forwarded; a path
 *   nobody classified is not forwarded either.
 * - It is a page load: not an open window's in-page navigation, a prefetch or
 *   a server action (those keep working where the window is, until it next
 *   loads a page), and not a script's fetch of a page.
 * - It does not come from an installed desktop build older than 0.2.107, whose
 *   window may show only dial8.ai (desktopWebViewOnOldDomain).
 * - The app's address (NEXT_PUBLIC_APP_URL) and the Google and ChatGPT sign-in
 *   callbacks, when set, are no longer on the old domain. Otherwise a sign-in
 *   would finish on the old domain and the forward would carry the person off
 *   their new session, so the forward stays off and says why, once.
 * Path and query are kept.
 *
 * Turn it on as `307`, and make it `308` once it has run for a while without a
 * surprise and nothing still needs the old domain's pages: browsers keep a 308
 * for good, so it cannot be taken back for people who saw it.
 */
import { APP_DOMAINS, appDomainOf, appUrl } from '@/lib/app-url'

/** The setting. */
export const OLD_DOMAIN_FORWARD_SETTING = 'NI_FORWARD_OLD_DOMAIN'

/** The domain people are forwarded to: the app's current one. */
export const FORWARD_TO_DOMAIN = APP_DOMAINS[0]

/** The domains people are forwarded from: every other one the app is served on. */
export const FORWARD_FROM_DOMAINS: readonly string[] = APP_DOMAINS.slice(1)

/**
 * What a path is, for the forward:
 * - page: people open it in a browser. Forwarded.
 * - flow: a step of a sign-in, an email link, a connect or another OAuth flow.
 *   It reads or sets something kept on the domain it was called on (a cookie,
 *   a PKCE verifier, a popup's opener), or hands a browser to the other domain
 *   itself. Forwarding it would break it or loop.
 * - program: called by a program (the desktop app, an agent, a webhook, an MCP
 *   client, a crawler). Never forwarded.
 * - held: a page kept on the old domain on purpose for now (see its reason).
 */
export type RouteKind = 'page' | 'flow' | 'program' | 'held'

export interface RouteRule {
  kind: RouteKind
  why: string
  /** Sub-paths (the second segment) that are something else than the family. */
  except?: Readonly<Record<string, RouteRule>>
}

const page = (why: string, except?: Record<string, RouteRule>): RouteRule => ({ kind: 'page', why, ...(except ? { except } : {}) })
const flow = (why: string): RouteRule => ({ kind: 'flow', why })
const program = (why: string): RouteRule => ({ kind: 'program', why })
const held = (why: string): RouteRule => ({ kind: 'held', why })

const SMS_CAMPAIGN =
  'Named in the carrier-reviewed SMS texts and the SMS campaign as a dial8.ai address. Stays until the campaign is updated for the new name.'

/**
 * Every top-level path, by its first segment ('' is the home page). A test
 * (src/__tests__/proxy.test.ts) fails when a folder or a metadata file in
 * src/app, or a family in src/app/api, is not listed here.
 */
export const ROUTES: Readonly<Record<string, RouteRule>> = {
  // People's pages.
  '': page('The home page.'),
  about: page('Marketing page.'),
  account: page('The app itself. Its API is under api/account, never forwarded.'),
  admin: page('The admin panel.', {
    auth: flow('admin/auth/callback: the admin sign-in returns here with a code its own domain\'s verifier cookie exchanges.'),
    'sign-out': flow('Clears the session cookie of the domain it is called on.'),
  }),
  'ai-work-environment': page('Marketing page.'),
  blog: page('The blog.', {
    'feed.xml': program('The RSS feed, read by feed readers.'),
  }),
  book: page('A business\'s public booking page; its form posts to the API of the domain it was loaded from.'),
  'company-brain': page('Marketing page.'),
  contact: page('Marketing page.'),
  dev: page('Development previews.'),
  docs: page('The documentation.'),
  'forgot-password': page('Asks for a reset; the reset then ends on the domain it was asked from.'),
  invite: page('A workspace invite link; sign-in from it happens on the domain it was opened on.'),
  l: page('A single-use link sent by text; its button posts to the API of the domain it was loaded from.'),
  link: page('An agent\'s connect link; sign-in from it happens on the domain it was opened on.'),
  login: page('Sign-in starts on the domain the page is on, and returns there.'),
  'meeting-notes': page('Marketing page.'),
  payments: page('A customer\'s payment and payment-setup pages, and where the payment provider returns; none of them reads a cookie.'),
  pricing: page('Marketing page.'),
  'release-notes': page('Marketing page.'),
  roadmap: page('Marketing page.'),
  s: page('A shared page; "create an account to comment" signs in on the domain it was opened on.'),
  sales: page('Marketing page.'),
  scribe: page('Marketing page.'),
  vs: page('Comparison pages.'),

  // Kept on the old domain while the SMS campaign names it.
  privacy: held(SMS_CAMPAIGN),
  sms: held(SMS_CAMPAIGN),
  terms: held(SMS_CAMPAIGN),

  // Steps of a flow, on the domain the flow is on.
  auth: flow('Sign-in and email-link callbacks (callback, confirm, desktop-callback, google, chatgpt): they read the verifier or transaction cookie of their own domain, and confirm hands a link to the domain its sign-in began on.'),
  mcp: flow('mcp/authorize: an MCP client\'s OAuth consent step, named after the host the client connected to.'),
  'mcp-oauth-popup-callback': flow('The end of an MCP connector\'s OAuth popup: talks to the window that opened it, on the same domain.'),
  'oauth-popup-callback': flow('The end of an integration\'s OAuth popup: talks to the window that opened it, on the same domain.'),
  'reset-password': flow('Where a password reset lands, with the session the reset link made on that domain.'),
  'sign-out': flow('Clears the session cookie of the domain it is called on.'),
  welcome: flow('Where a sign-in for the phone app returns before it opens the app; registered with the sign-in service per domain.'),

  // Programs.
  api: program('Every family in API_FAMILIES.'),
  hud: program('The desktop app\'s own windows (meeting, agent and dictation HUDs), loaded by the desktop app only.'),
  '.well-known': program('OAuth metadata for MCP clients, named after the host they connected to.'),
  'llms.txt': program('Read by AI crawlers.'),
  'robots.txt': program('Read by crawlers.'),
  'sitemap.xml': program('Read by crawlers.'),
  'manifest.webmanifest': program('Read by the browser for an installed web app.'),
  'opengraph-image': program('Fetched by link previews.'),
  'twitter-image': program('Fetched by link previews.'),
  'favicon.ico': program('Fetched by the browser for the tab.'),
  'icon.png': program('Fetched by the browser for the tab.'),
  // Not under src/app.
  _next: program('The scripts, styles and data of pages already open.'),
  eve: program('The eight agents, mounted at /eve/<name>/v1/* (next.config.mjs).'),
  ingest: program('Analytics, passed on to the analytics service (next.config.mjs rewrites).'),
}

/**
 * Every family under src/app/api, and who calls it. None is ever forwarded: a
 * program does not follow a redirect on a POST or drops its credentials doing
 * so, a webhook's signature covers the address it called, and an open window's
 * own fetches must stay on its domain. A test fails when a family is missing.
 */
export const API_FAMILIES: Readonly<Record<string, string>> = {
  account: 'The app\'s pages (cookie), the desktop app and the phone app (Bearer): workspace data.',
  admin: 'The admin panel\'s pages.',
  ai: 'The app\'s pages and the phone app: chat and AI features, mostly streamed POSTs.',
  analytics: 'The app\'s pages and the desktop HUDs.',
  auth: 'The app\'s pages and the desktop app: session checks (check-session answers for the domain it is asked on).',
  billing: 'The app\'s pages: checkout and the billing portal.',
  'browser-exit': 'The desktop app natively: the cloud browser\'s exit switch.',
  'browser-relay': 'The cloud browser\'s relay, on the browser-relay. hosts, with its own token.',
  calendar: 'The app\'s pages and the desktop tray (Bearer).',
  calls: 'Phone calls: the voice service\'s signed webhooks.',
  contact: 'The contact forms on marketing pages (POST).',
  cron: 'The scheduler, with a Bearer secret.',
  'deepgram-token': 'Pages that transcribe (POST).',
  desktop: 'The desktop app natively: its update feed (api/desktop/update), asked by installed builds on their own domain.',
  device: 'Hardware devices (Bearer device tokens).',
  download: 'Download buttons and links: a redirect to the installer, with no state of its own domain; forwarding it would only add a hop.',
  'early-access': 'The early-access form (POST).',
  email: 'The app\'s pages, and unsubscribe links in mail already sent (signed, no cookie; the old domain keeps serving them).',
  feedback: 'The unsubscribe page\'s feedback (POST).',
  inngest: 'The background-job server: it calls and registers the app at a fixed address.',
  intake: 'Forms on businesses\' own sites (cross-origin POST with a preflight).',
  internal: 'The eight agents calling back into the app; they refuse any redirect.',
  links: 'The single-use links\' buttons (POST, same-origin check).',
  'local-agent': 'The agent on the person\'s Mac and the desktop app (tokens; redirects refused).',
  marketplace: 'The app\'s pages.',
  mcp: 'MCP clients: the MCP server, its OAuth authorize, token and registration steps, named after the host the client connected to.',
  'mcp-oauth': 'MCP connectors\' OAuth callbacks: a binding cookie on the domain the connect began on.',
  oauth: 'Integrations\' OAuth starts and callbacks: a nonce cookie on the domain the connect began on; the callback hands an answer to that domain itself.',
  payments: 'Customers\' payment pages (POST) and the payment provider\'s returns (a cookie of the domain the setup began on).',
  plans: 'Plan prices for public pages.',
  presence: 'The app\'s pages, the desktop app and the phone app (beacons).',
  public: 'Public pages: the booking page\'s form (POST).',
  'release-notes': 'Release notes as data.',
  search: 'The documentation\'s search box.',
  share: 'Shared pages\' comments (a session cookie of that domain).',
  sky: 'The marketing pages\' sky, from the caller\'s location headers.',
  slack: 'Slack\'s events and interactivity, passed on by the connector service.',
  twilio: 'The text-message service\'s webhooks, signed over the address it called.',
  version: 'Open windows and the desktop app, to notice a new deployment.',
  webhooks: 'Outside services\' webhooks (mail push, payments, issue trackers, code hosts), signed or registered per address.',
}

/** The first two segments of a path; null for a path that is not one of the app's (`//x`). */
function segments(pathname: string): [string, string] | null {
  if (pathname === '/' || pathname === '') return ['', '']
  const parts = pathname.split('/')
  if (parts[0] !== '' || parts[1] === '') return null
  return [parts[1], parts[2] ?? '']
}

/** What a path is (ROUTES), or null when nobody classified it. */
export function routeRule(pathname: string): RouteRule | null {
  const segs = segments(pathname)
  if (!segs) return null
  const family = Object.hasOwn(ROUTES, segs[0]) ? ROUTES[segs[0]] : undefined
  if (!family) return null
  const sub = family.except && Object.hasOwn(family.except, segs[1]) ? family.except[segs[1]] : undefined
  return sub ?? family
}

const lower = (host: string) => host.trim().toLowerCase().replace(/\.$/, '')

/** The old domain or its www., exactly. */
export function isForwardFromHost(host: string): boolean {
  const h = lower(host)
  return FORWARD_FROM_DOMAINS.some((domain) => h === domain || h === `www.${domain}`)
}

/** The setting's value as a status, or null when it is off. */
export function forwardStatus(env: Record<string, string | undefined> = process.env): 307 | 308 | null {
  const value = env[OLD_DOMAIN_FORWARD_SETTING]?.trim()
  return value === '307' ? 307 : value === '308' ? 308 : null
}

/**
 * An open window's in-page navigation, its prefetches and its server actions
 * (and a page's data request, which reaches the proxy under the page's own
 * path) are answered where the window is: a redirect to another origin fails
 * there (no CORS), and the window would fall back to a full load anyway. The
 * forward catches that window at its next page load.
 *
 * Next removes its own RSC and router headers before the proxy runs, so what
 * tells these requests apart here is the `_rsc` query Next adds to each of
 * them and the browser's `Sec-Fetch-Dest: empty` (below). The headers are
 * checked as well, should a version of Next pass them on.
 */
const IN_PAGE_HEADERS = ['rsc', 'next-action', 'next-router-prefetch', 'next-router-segment-prefetch', 'next-router-state-tree', 'x-nextjs-data']

/**
 * A window of an installed desktop build older than 0.2.107. Those load
 * https://dial8.ai, and their navigation guard (desktop/src-tauri/src/nav_guard.rs
 * before the address change) lets a window show only dial8.ai: a forward to the
 * new domain would be cancelled there and opened in the system browser, leaving
 * the app's window empty. Their update feed is asked natively, under api/, so
 * they still update; the build they update to loads the new domain itself.
 *
 * How their requests are told apart: the desktop's web views are WKWebViews
 * created by wry 0.54.3 with no user agent of their own, so they send WebKit's
 * bare default, which ends at `(KHTML, like Gecko)`, without the
 * `Version/… Safari/…` every Safari sends, and without any other browser's
 * token. Builds from 0.2.107 on send the same, but they load the new domain:
 * one of their windows that arrives here from it (its Referer) is forwarded.
 * Any other app that embeds a bare WKWebView on a Mac is left on the old
 * domain too, which keeps serving.
 */
export function desktopWebViewOnOldDomain(headers: Headers): boolean {
  const ua = headers.get('user-agent') ?? ''
  const bareMacWebKit =
    ua.includes('(Macintosh;') &&
    ua.includes('AppleWebKit/') &&
    !/\b(?:Safari|Chrome|Chromium|CriOS|Firefox|FxiOS|Edg|EdgiOS|OPR)\//.test(ua)
  if (!bareMacWebKit) return false
  const referer = headers.get('referer')
  if (referer) {
    try {
      if (appDomainOf(new URL(referer).host) === FORWARD_TO_DOMAIN) return false
    } catch {
      // Not a URL: decided by the user agent alone.
    }
  }
  return true
}

/**
 * Why the forward cannot run yet although the setting asks for it, or null.
 * It needs the app's address on the new domain, and the sign-in callbacks
 * that settings pin (Google's and ChatGPT's) off the old one: those sign-ins
 * move to their callback's domain before they start, and finish there.
 */
export function forwardBlockedBy(env: Record<string, string | undefined> = process.env): string | null {
  const address = appUrl()
  let addressDomain: string | null = null
  try {
    addressDomain = appDomainOf(new URL(address).host)
  } catch {
    // Not a URL: blocked below.
  }
  if (addressDomain !== FORWARD_TO_DOMAIN) {
    return `the app's address (NEXT_PUBLIC_APP_URL, compiled in) is ${address}, not on ${FORWARD_TO_DOMAIN}`
  }
  for (const name of ['GOOGLE_SIGN_IN_REDIRECT_URI', 'CHATGPT_REDIRECT_URI']) {
    const value = env[name]?.trim()
    if (!value) continue
    let host = ''
    try {
      host = new URL(value).host
    } catch {
      continue
    }
    if (FORWARD_FROM_DOMAINS.some((domain) => appDomainOf(host) === domain)) {
      return `${name} is on ${host}: that sign-in would finish there`
    }
  }
  return null
}

/** Enough of a request to decide: NextRequest has all of it. */
export interface ForwardRequest {
  method: string
  headers: Headers
  nextUrl: { pathname: string; search: string; searchParams: URLSearchParams; host: string }
}

export type ForwardDecision =
  | { forward: true; location: string; status: 307 | 308 }
  /** `blocked`: the setting asks for the forward, but forwardBlockedBy says no. */
  | { forward: false; reason: string; blocked?: true }

/** Whether this request is forwarded, and where. Pure but for the settings it reads. */
export function oldDomainForward(request: ForwardRequest, env: Record<string, string | undefined> = process.env): ForwardDecision {
  const status = forwardStatus(env)
  if (!status) return { forward: false, reason: 'off' }
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return { forward: false, reason: 'not GET or HEAD' }
  const host = request.headers.get('host') ?? request.nextUrl.host
  if (!isForwardFromHost(host)) return { forward: false, reason: 'not the old domain' }
  const rule = routeRule(request.nextUrl.pathname)
  if (!rule) return { forward: false, reason: 'path not classified' }
  if (rule.kind !== 'page') return { forward: false, reason: `path is ${rule.kind}` }
  if (IN_PAGE_HEADERS.some((name) => request.headers.has(name)) || request.nextUrl.searchParams.has('_rsc')) {
    return { forward: false, reason: 'in-page request' }
  }
  const dest = request.headers.get('sec-fetch-dest')
  if (dest && dest !== 'document') return { forward: false, reason: 'not a page load' }
  if (desktopWebViewOnOldDomain(request.headers)) return { forward: false, reason: 'desktop build older than 0.2.107' }
  const blockedBy = forwardBlockedBy(env)
  if (blockedBy) return { forward: false, reason: blockedBy, blocked: true }

  // The address's origin (forwardBlockedBy parsed it): a path in the setting never prefixes the target.
  const target = new URL(appUrl()).origin
  const location = new URL(`${target}${request.nextUrl.pathname}${request.nextUrl.search}`)
  // The path cannot change the origin (it starts with one slash), but say so.
  if (location.origin !== target) return { forward: false, reason: 'target off the app' }
  return { forward: true, location: location.toString(), status }
}
