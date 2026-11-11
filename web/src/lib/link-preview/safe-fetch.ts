/**
 * Fetch a page from the public internet for a link preview, and nothing
 * else. The URL is a person's (a link they typed into a message or a doc), so
 * this is a server-side request forgery surface, and the rules are tight:
 *
 *   - http and https only, no user name or password in the URL, and no host
 *     that names this machine or a private network (localhost, *.local,
 *     *.internal, a cloud metadata name);
 *   - public addresses only, checked AT THE DIAL: the request's own DNS
 *     lookup (publicOnlyLookup, the MCP client-metadata fetch's) refuses any
 *     answer with a private, loopback, link-local, carrier-grade NAT or
 *     metadata address, and the socket connects to what that lookup
 *     returned, so a name can't resolve public at a check and private a
 *     moment later. A literal IP is checked as itself (it never reaches a
 *     lookup);
 *   - redirects followed by hand, at most PUBLIC_FETCH_MAX_REDIRECTS, every
 *     hop held to all of the above again;
 *   - PUBLIC_FETCH_TIMEOUT_MS for the whole of it, every hop included;
 *   - at most PUBLIC_FETCH_MAX_BYTES read (after decompression, so a small
 *     gzip can't unpack into a large one): the rest is never downloaded;
 *   - nothing of the person's goes with it: no cookies, no authorization, no
 *     referrer, a fresh connection every time (no pooled socket another
 *     lookup made).
 *
 * Server-only (node:http, node:https, node:dns). The request and the lookup
 * are injectable: tests answer from a table and never touch the network.
 */
import 'server-only'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import type { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { ipv6Groups, isPublicAddress } from '@/lib/mcp-client/url-guard'
import { publicOnlyLookup } from '@/lib/mcp/client-metadata-fetch'

export const PUBLIC_FETCH_TIMEOUT_MS = 5_000
export const PUBLIC_FETCH_MAX_BYTES = 512 * 1024
export const PUBLIC_FETCH_MAX_REDIRECTS = 3
const USER_AGENT = 'Mozilla/5.0 (compatible; NativeIntelligenceBot/1.0; link preview)'

/** A request the guard refused, or one that failed: `reason` says which, in plain words (for logs, never the person's URL). */
export class PublicFetchError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'PublicFetchError'
  }
}

export type Send = (url: string, options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest

export interface PublicFetchOptions {
  /** The request, per protocol (tests). */
  send?: { 'http:': Send; 'https:': Send }
  lookup?: LookupFunction
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  /** The Accept header (HTML by default). */
  accept?: string
}

export interface PublicPage {
  /** The URL the body came from (after any redirects). */
  url: string
  status: number
  /** The response's media type, lowercased, without parameters. */
  contentType: string
  /** The `charset` it named, lowercased, if any. */
  charset: string | null
  body: Uint8Array
  /** True when the body was longer than the cap (the rest was never read). */
  truncated: boolean
}

const BLOCKED_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback', 'metadata.google.internal', 'metadata.azure.com', 'metadata'])

/** The URL, parsed, when it is one this may fetch at all; throws a PublicFetchError saying why not. */
export function checkPublicUrl(raw: string | URL): URL {
  let url: URL
  try {
    url = typeof raw === 'string' ? new URL(raw) : new URL(raw.href)
  } catch {
    throw new PublicFetchError('not a URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PublicFetchError('only http and https')
  if (url.username || url.password) throw new PublicFetchError('credentials in the URL')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!host) throw new PublicFetchError('no host')
  if (BLOCKED_NAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    throw new PublicFetchError('not a public host')
  }
  const literal = ipv6Groups(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  if (literal && !isPublicAddress(host)) throw new PublicFetchError('not a public address')
  // A bare number or hex host ("2130706433", "0x7f.1") is an address in disguise: refused.
  if (!literal && /^[0-9x.]+$/i.test(host)) throw new PublicFetchError('not a public host')
  return url
}

function decoderFor(res: IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
  if (encoding === 'gzip' || encoding === 'x-gzip') return res.pipe(createGunzip())
  if (encoding === 'deflate') return res.pipe(createInflate())
  if (encoding === 'br') return res.pipe(createBrotliDecompress())
  return res
}

/**
 * GET a public page under the rules above: the final response (any status
 * but a redirect), its body read up to the cap. Rejects with a
 * PublicFetchError on a refusal, a timeout, too many redirects or a failed
 * request.
 */
export function fetchPublicPage(raw: string, opts: PublicFetchOptions = {}): Promise<PublicPage> {
  const send = opts.send ?? { 'http:': httpRequest as unknown as Send, 'https:': httpsRequest as unknown as Send }
  const lookup = opts.lookup ?? publicOnlyLookup()
  const maxBytes = opts.maxBytes ?? PUBLIC_FETCH_MAX_BYTES
  const maxRedirects = opts.maxRedirects ?? PUBLIC_FETCH_MAX_REDIRECTS
  const timeoutMs = opts.timeoutMs ?? PUBLIC_FETCH_TIMEOUT_MS

  return new Promise<PublicPage>((resolve, reject) => {
    let settled = false
    let current: ClientRequest | null = null
    let stream: Readable | null = null
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      fn()
    }
    const fail = (reason: string) =>
      finish(() => {
        current?.destroy()
        stream?.destroy()
        reject(new PublicFetchError(reason))
      })
    const deadline = setTimeout(() => fail('timed out'), timeoutMs)

    const hop = (target: string, redirects: number) => {
      let url: URL
      try {
        url = checkPublicUrl(target)
      } catch (err) {
        return fail(err instanceof PublicFetchError ? err.reason : 'refused')
      }
      const request = send[url.protocol as 'http:' | 'https:']
      current = request(
        url.href,
        {
          method: 'GET',
          // Built here, from nothing: no cookie, authorization or referrer ever rides along.
          headers: { accept: opts.accept ?? 'text/html,application/xhtml+xml', 'accept-encoding': 'gzip, deflate, br', 'user-agent': USER_AGENT },
          lookup,
          agent: false,
        },
        (res) => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume()
            if (redirects >= maxRedirects) return fail('too many redirects')
            let next: string
            try {
              next = new URL(res.headers.location, url).href
            } catch {
              return fail('a bad redirect')
            }
            return hop(next, redirects + 1)
          }
          const [type, ...params] = String(res.headers['content-type'] ?? '').split(';')
          const charset = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('charset='))?.slice(8).replace(/"/g, '') ?? null
          const body = decoderFor(res)
          stream = body
          const chunks: Uint8Array[] = []
          let size = 0
          const done = (truncated: boolean) =>
            finish(() => {
              if (truncated) {
                current?.destroy()
                body.destroy()
              }
              const all = Buffer.concat(chunks)
              resolve({ url: url.href, status, contentType: type.trim().toLowerCase(), charset, body: new Uint8Array(all.buffer, all.byteOffset, Math.min(all.byteLength, maxBytes)), truncated })
            })
          body.on('data', (chunk: Uint8Array) => {
            if (settled) return
            size += chunk.byteLength
            chunks.push(chunk)
            if (size > maxBytes) done(true)
          })
          body.on('end', () => done(false))
          body.on('error', (err) => fail(err.message || 'the response failed'))
        },
      )
      current.on('error', (err: NodeJS.ErrnoException) => fail(err.code === 'ENOTPUBLIC' ? 'resolves to an address that is not public' : err.message || 'the request failed'))
      current.end()
    }
    hop(raw, 0)
  })
}
