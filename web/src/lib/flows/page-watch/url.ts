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
import { ipv6Groups, isPublicAddress } from '@/lib/mcp-client/url-guard'

/** How often a watched page is read. */
export const PAGE_WATCH_INTERVAL_MINUTES = 15
/** How many page watches one person may keep switched on. */
export const PAGE_WATCH_MAX_PER_PERSON = 20
/** The longest "what to look for" a person may write. */
export const PAGE_WATCH_LOOK_FOR_MAX = 300
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
