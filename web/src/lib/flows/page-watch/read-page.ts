/**
 * One read of a watched page: the address checked (./url.ts), the page
 * fetched through the link preview's safe fetcher (public addresses only,
 * checked at the dial and on every redirect, a time and size cap, nothing of
 * the person's sent; every hop held to a website's usual ports, usualPortsOnly),
 * and its body turned into lines of visible text (./text.ts). A body cut at
 * the size cap loses its last, half-read line; data cut off part way is not
 * read at all. No model is involved.
 *
 * Both the save-time probe (./probe.ts) and the watch pass (./tick.ts) read
 * pages through here, so what a person is told when they save a watch is
 * what the pass will see. The reasons it gives are plain words for the
 * person (and for logs); the address itself is never logged.
 */
import 'server-only'
import { EventEmitter } from 'node:events'
import type { ClientRequest } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { decodeHtml } from '@/lib/link-preview/parse'
import { fetchPublicPage, PublicFetchError, type PublicFetchOptions, type PublicPage, type Send } from '@/lib/link-preview/safe-fetch'
import { pageToLines } from './text'
import { normalizeWatchUrl } from './url'

/* A watch reads a little more than a link preview (a long pricing page) and waits a little longer. */
export const PAGE_WATCH_FETCH_TIMEOUT_MS = 10_000
export const PAGE_WATCH_FETCH_MAX_BYTES = 2 * 1024 * 1024
const ACCEPT = 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1'

export type FetchPage = (url: string, opts: PublicFetchOptions) => Promise<PublicPage>

/** The fetcher's reason when a hop names a port other than its scheme's usual one. */
export const NOT_A_USUAL_PORT = 'not a usual port'

/*
 * A request that never leaves: it fails, a moment later, the way a refused
 * connection does, so the fetcher's own error path ends the read (a throw from
 * inside a redirect's callback would escape it).
 */
function refusedRequest(reason: string): ClientRequest {
  const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void }
  request.end = () => {
    setImmediate(() => request.emit('error', Object.assign(new Error(reason), { code: 'EPORT' })))
  }
  request.destroy = () => {}
  return request as unknown as ClientRequest
}

/**
 * The fetcher's request, held to a website's usual ports on every hop: the
 * address the person saved is checked by normalizeWatchUrl, and this holds a
 * redirect to the same rule, so a page can't send the read on to a service on
 * another port (the app's own server's among them). Everything else is the
 * fetcher's own rules, unchanged.
 */
export function usualPortsOnly(send: Send): Send {
  return (url, options, onResponse) => {
    let port = ''
    try {
      port = new URL(url).port
    } catch {
      return refusedRequest('not a URL')
    }
    if (port) return refusedRequest(NOT_A_USUAL_PORT)
    return send(url, options, onResponse)
  }
}

const watchSend = {
  'http:': usualPortsOnly(httpRequest as unknown as Send),
  'https:': usualPortsOnly(httpsRequest as unknown as Send),
}

const fetchWatched: FetchPage = (url, opts) => fetchPublicPage(url, { send: watchSend, ...opts })

export type WatchRead = { ok: true; lines: string[] } | { ok: false; reason: string }

/* The fetcher's own reasons, said the way a person would understand them. */
function plainReason(reason: string): string {
  if (reason === 'timed out') return 'The page took too long to answer.'
  if (reason === 'too many redirects') return 'The page sends visitors on to too many other addresses.'
  if (reason === NOT_A_USUAL_PORT) return 'The page sends visitors on to an address with a port. Only pages on a website\'s usual address can be watched.'
  if (reason.includes('not public') || reason === 'not a public host' || reason === 'not a public address') {
    return 'That address is on a private network. Only public pages can be watched.'
  }
  if (reason === 'only http and https' || reason === 'credentials in the URL' || reason === 'not a URL' || reason === 'no host') {
    return 'That does not look like a public web address.'
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(reason)) return 'No website answers at that address.'
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up/i.test(reason)) return 'The website did not let us connect.'
  if (/certificate|SSL|TLS/i.test(reason)) return 'The website\'s security certificate could not be checked.'
  return 'The page could not be read.'
}

function statusReason(status: number): string {
  if (status === 401 || status === 403) return `The page needs a sign-in or refuses visitors like us (it answered ${status}).`
  // 404 at save time is usually a mistyped address, so it does not claim the page ever existed.
  if (status === 404) return 'There is no page at that address (it answered 404).'
  if (status === 410) return 'The page is not there any more (it answered 410).'
  if (status === 429) return 'The website asked us to slow down (it answered 429).'
  if (status >= 500) return `The website had a problem answering (it answered ${status}).`
  return `The page did not answer normally (it answered ${status}).`
}

/** Read a page's lines once. Never throws. */
export async function readWatchPage(raw: string, deps: { fetchPage?: FetchPage } = {}): Promise<WatchRead> {
  const url = normalizeWatchUrl(raw)
  if (url instanceof Error) return { ok: false, reason: url.message }
  let page: PublicPage
  try {
    page = await (deps.fetchPage ?? fetchWatched)(url, {
      accept: ACCEPT,
      timeoutMs: PAGE_WATCH_FETCH_TIMEOUT_MS,
      maxBytes: PAGE_WATCH_FETCH_MAX_BYTES,
    })
  } catch (err) {
    return { ok: false, reason: plainReason(err instanceof PublicFetchError ? err.reason : err instanceof Error ? err.message : '') }
  }
  if (page.status < 200 || page.status >= 300) return { ok: false, reason: statusReason(page.status) }
  const type = page.contentType
  const textual = type === '' || type.startsWith('text/') || type === 'application/xhtml+xml' || type === 'application/json' || type.endsWith('+json')
  if (!textual) return { ok: false, reason: 'That address is a file, not a page of text.' }
  const json = type === 'application/json' || type.endsWith('+json')
  // Data cut off part way can't be read as data, and its last line would be a half.
  if (page.truncated && json) return { ok: false, reason: 'The page is data too large to read in full, so it cannot be watched.' }
  try {
    const lines = pageToLines(decodeHtml(page.body, page.charset), type)
    // A body cut at the size cap ends mid-line: that last line would read as new every time.
    if (page.truncated) lines.pop()
    return { ok: true, lines }
  } catch {
    return { ok: false, reason: 'The page could not be read.' }
  }
}
