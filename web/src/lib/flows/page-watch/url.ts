/**
 * The address of a page a loop watches, checked and tidied before it is
 * saved and again before every read. Pure and client-safe: the loop editor
 * runs it as the person types, the save route runs it before storing, and the
 * watch pass (./tick.ts) runs it before each fetch, so a row written some
 * other way can't point the fetcher anywhere this would refuse.
 *
 * This is only the first gate. The fetcher (src/lib/link-preview/safe-fetch.ts)
 * checks every address again at the dial, after DNS, on every redirect, so a
 * public name that resolves to a private address is still refused there.
 * Here the job is to say no early, in plain words, to what is plainly not a
 * public web page.
 */
import { looksLikeSignInUrl } from '@/lib/browser-agent/sign-in-page'
import { ipv6Groups, isPublicAddress } from '@/lib/mcp-client/url-guard'

/** How often a watched page is read. */
export const PAGE_WATCH_INTERVAL_MINUTES = 15
/** How many page watches one person may keep switched on. */
export const PAGE_WATCH_MAX_PER_PERSON = 20
/** The longest "what to look for" a person may write. */
export const PAGE_WATCH_LOOK_FOR_MAX = 300
/** Fewer lines of text than this and a read is a shell (a page a browser fills in, a robot check), not a page to watch. */
export const PAGE_WATCH_MIN_LINES = 5
/** The longest address this accepts. */
export const PAGE_WATCH_URL_MAX = 2048

/*
 * Names that point at this machine, a private network or a cloud's metadata
 * service, whatever they resolve to. The fetcher refuses the same set.
 */
const BLOCKED_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback', 'metadata', 'metadata.google.internal', 'metadata.azure.com'])
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp']

function refuse(message: string): Error {
  return new Error(message)
}

/**
 * The address, normalized (scheme added when missing, host lowercased, the
 * `#fragment` dropped), or an Error whose message can be shown to the person
 * as it is.
 */
export function normalizeWatchUrl(raw: unknown): string | Error {
  if (typeof raw !== 'string') return refuse('Give the address of the page to watch.')
  const trimmed = raw.trim()
  if (!trimmed) return refuse('Give the address of the page to watch.')
  if (trimmed.length > PAGE_WATCH_URL_MAX) return refuse('That address is too long.')
  if (/\s/.test(trimmed)) return refuse('That does not look like a web address.')

  // "example.com/pricing" is what people type: read it as https.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^/:]+:\d+(\/|$)/.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return refuse('That does not look like a web address.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return refuse('Only web pages (http or https) can be watched.')
  if (url.username || url.password) return refuse('Leave the user name and password out of the address: only public pages can be watched.')

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!host) return refuse('That does not look like a web address.')
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return refuse('That address is on a private network. Only public pages can be watched.')
  }
  const literal = ipv6Groups(host) !== null || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  if (literal && !isPublicAddress(host)) return refuse('That address is on a private network. Only public pages can be watched.')
  // A bare number or hex host ("2130706433", "0x7f.1") is an address in disguise.
  if (!literal && /^[0-9x.]+$/i.test(host)) return refuse('That does not look like a web address.')
  // A single word with no dot ("intranet", "router") is a name on someone's own network.
  if (!literal && !host.includes('.')) return refuse('That address is on a private network. Only public pages can be watched.')
  // Only a website's usual ports (80 for http, 443 for https, which the URL parser
  // leaves out): an explicit other port could reach a service on a server that
  // is not its website, the app's own server among them.
  if (url.port) return refuse(`That address names port ${url.port}. Only pages on a website's usual address (no port) can be watched.`)

  url.hash = ''
  const href = url.href
  if (href.length > PAGE_WATCH_URL_MAX) return refuse('That address is too long.')
  return href
}

/*
 * Reading in the person's browser (page watches, phase 2): a watch whose
 * trigger says `read_with: 'browser'` is read in the person's own cloud
 * browser, where they are signed in, instead of by a plain fetch. That costs
 * a browser's wake, so it is read less often and fewer may be kept.
 */

/** How often a page read in the person's browser is read. */
export const PAGE_WATCH_BROWSER_INTERVAL_MINUTES = 30
/** How many browser-read watches one person may keep switched on (within PAGE_WATCH_MAX_PER_PERSON). */
export const PAGE_WATCH_BROWSER_MAX_PER_PERSON = 5
/** A browser read that could not be made now (the browser is busy, taken over, or needs the Mac) is tried again this soon. */
export const PAGE_WATCH_BROWSER_RETRY_MINUTES = 10

/** Whether a page_changed trigger_config asks for the person's browser. */
export function watchReadsInBrowser(config: unknown): boolean {
  return !!config && typeof config === 'object' && (config as { read_with?: unknown }).read_with === 'browser'
}

/** How often a watch with this config is read, in minutes. */
export function watchIntervalMinutes(config: unknown): number {
  return watchReadsInBrowser(config) ? PAGE_WATCH_BROWSER_INTERVAL_MINUTES : PAGE_WATCH_INTERVAL_MINUTES
}

/*
 * Social networks whose terms forbid reading a signed-in account by
 * automation, and act on the account that does it (the person's own, not
 * ours). A watch never reads them in the person's browser. Their public
 * pages can still be watched the plain way.
 */
const NO_SIGNED_IN_WATCH_SITES = ['linkedin.com', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'threads.net', 'threads.com', 'tiktok.com']

/**
 * Why this address can't be watched in the person's browser, as a sentence
 * for them, or null when it can. `url` is an address normalizeWatchUrl passed.
 */
export function browserWatchRefusal(url: string): string | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return 'That does not look like a web address.'
  }
  const site = NO_SIGNED_IN_WATCH_SITES.find((s) => host === s || host.endsWith(`.${s}`))
  if (!site) return null
  return `${site} does not allow its signed-in pages to be read automatically, and it can restrict the account that does. It can't be watched in your browser.`
}

/**
 * Whether the browser, asked for `asked`, ended up on a sign-in page instead
 * (`landed`, the address the page itself reported): the person is not signed
 * in to the site in their browser, or their session ran out. True only when
 * the landing address looks like a sign-in page and the asked one did not, so
 * a watch ON a sign-in page is never taken for one. Pure.
 */
export function landedOnSignIn(asked: string, landed: string): boolean {
  let from: URL
  let to: URL
  try {
    from = new URL(asked)
    to = new URL(landed)
  } catch {
    return false
  }
  if (from.hostname === to.hostname && from.pathname === to.pathname) return false
  return looksLikeSignInUrl(to) && !looksLikeSignInUrl(from)
}
