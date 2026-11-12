/**
 * One request to a website the audit is crawling, and nothing else. The URL
 * is a person's (the site they asked to audit) or one that site's own pages
 * and sitemaps led to, so this is a server-side request forgery surface and
 * it keeps the link preview fetch's rules (src/lib/link-preview/safe-fetch.ts):
 *
 *   - http and https only, no credentials in the URL, no host that names
 *     this machine or a private network (checkPublicUrl);
 *   - public addresses only, checked AT THE DIAL: the request's own DNS
 *     lookup (publicOnlyLookup) refuses any private, loopback, link-local,
 *     carrier-grade NAT or metadata address, and the socket connects to what
 *     that lookup returned, so a name cannot resolve public at a check and
 *     private a moment later;
 *   - nothing of ours goes with it: no cookies, no authorization, no
 *     referrer, a fresh connection every time.
 *
 * Unlike the preview fetch this is ONE hop: a redirect comes back as the 3xx
 * it is, with its Location, because the crawl records each hop as its own
 * page (that is how redirect chains and loops are found) and sends the
 * target back through here, where it is checked again.
 *
 * Server-only (node:http, node:https, node:dns). The request and the lookup
 * are injectable: tests answer from a table and never touch the network.
 */
import {
  checkPublicUrl,
  PublicFetchError,
  type Send,
} from '@/lib/link-preview/safe-fetch'
import { publicOnlyLookup } from '@/lib/mcp/client-metadata-fetch'
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
} from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import type { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import 'server-only'
import { CRAWL_USER_AGENT, MAX_HTML_BYTES } from './limits'

export const CRAWL_FETCH_TIMEOUT_MS = 15_000

export interface CrawlFetchOptions {
  /** The request, per protocol (tests). */
  send?: { 'http:': Send; 'https:': Send }
  lookup?: LookupFunction
  /** For the whole request, body included. */
  timeoutMs?: number
  /** Most body bytes kept, after decompression. */
  maxBytes?: number
  /** The Accept header (HTML by default). */
  accept?: string
  /**
   * Whether to read the body of this response. Default: every response that
   * is not a redirect. A crawl reads only HTML; a body nobody reads is never
   * downloaded.
   */
  wantBody?: (status: number, contentType: string) => boolean
}

export interface CrawlResponse {
  /** The URL asked for. */
  url: string
  status: number
  /** One response header by its lowercase name; null when absent. */
  header(name: string): string | null
  /** The response's media type, lowercased, without parameters. */
  contentType: string
  /** The body as text, up to the cap ('' when it was not read). */
  body: string
  /** True when the body was longer than the cap (the rest was never read). */
  truncated: boolean
  /** From the request's start to its response headers: what a browser would call time to first byte. */
  responseTimeMs: number
}

function headerReader(
  headers: IncomingHttpHeaders,
): (name: string) => string | null {
  return (name) => {
    const value = headers[name.toLowerCase()]
    if (value === undefined) return null
    return Array.isArray(value) ? value.join(', ') : value
  }
}

function decoderFor(res: IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase()
  if (encoding === 'gzip' || encoding === 'x-gzip')
    return res.pipe(createGunzip())
  if (encoding === 'deflate') return res.pipe(createInflate())
  if (encoding === 'br') return res.pipe(createBrotliDecompress())
  return res
}

function decodeBody(bytes: Uint8Array, charset: string | null): string {
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try {
      return new TextDecoder(charset).decode(bytes)
    } catch {
      // An unknown label: read it as UTF-8 like everything else.
    }
  }
  return new TextDecoder().decode(bytes)
}

/**
 * GET one public URL under the rules above. Resolves with whatever the
 * server answered (any status, redirects included). Rejects with a
 * PublicFetchError on a refusal, a timeout or a failed request.
 */
export function crawlFetch(
  raw: string,
  opts: CrawlFetchOptions = {},
): Promise<CrawlResponse> {
  const send = opts.send ?? {
    'http:': httpRequest as unknown as Send,
    'https:': httpsRequest as unknown as Send,
  }
  const lookup = opts.lookup ?? publicOnlyLookup()
  const maxBytes = opts.maxBytes ?? MAX_HTML_BYTES
  const timeoutMs = opts.timeoutMs ?? CRAWL_FETCH_TIMEOUT_MS
  const wantBody =
    opts.wantBody ?? ((status: number) => status < 300 || status >= 400)

  return new Promise<CrawlResponse>((resolve, reject) => {
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

    let url: URL
    try {
      url = checkPublicUrl(raw)
    } catch (err) {
      return fail(err instanceof PublicFetchError ? err.reason : 'refused')
    }
    const startedAt = Date.now()
    const request = send[url.protocol as 'http:' | 'https:']
    current = request(
      url.href,
      {
        method: 'GET',
        // Built here, from nothing: no cookie, authorization or referrer ever rides along.
        headers: {
          accept: opts.accept ?? 'text/html,application/xhtml+xml',
          'accept-encoding': 'gzip, deflate, br',
          'user-agent': CRAWL_USER_AGENT,
        },
        lookup,
        agent: false,
      },
      (res) => {
        const responseTimeMs = Date.now() - startedAt
        const status = res.statusCode ?? 0
        const header = headerReader(res.headers)
        const [type, ...params] = String(
          res.headers['content-type'] ?? '',
        ).split(';')
        const contentType = type.trim().toLowerCase()
        const charset =
          params
            .map((p) => p.trim().toLowerCase())
            .find((p) => p.startsWith('charset='))
            ?.slice(8)
            .replace(/"/g, '') ?? null
        const done = (bytes: Uint8Array, truncated: boolean) =>
          finish(() =>
            resolve({
              url: url.href,
              status,
              header,
              contentType,
              body: decodeBody(bytes, charset),
              truncated,
              responseTimeMs,
            }),
          )

        if (!wantBody(status, contentType)) {
          // Not read: drop the connection instead of downloading it.
          res.destroy()
          return done(new Uint8Array(0), false)
        }

        const body = decoderFor(res)
        stream = body
        const chunks: Uint8Array[] = []
        let size = 0
        const end = (truncated: boolean) => {
          if (truncated) {
            current?.destroy()
            body.destroy()
          }
          const all = Buffer.concat(chunks)
          done(
            new Uint8Array(
              all.buffer,
              all.byteOffset,
              Math.min(all.byteLength, maxBytes),
            ),
            truncated,
          )
        }
        body.on('data', (chunk: Uint8Array) => {
          if (settled) return
          size += chunk.byteLength
          chunks.push(chunk)
          if (size > maxBytes) end(true)
        })
        body.on('end', () => end(false))
        body.on('error', (err) => fail(err.message || 'the response failed'))
      },
    )
    current.on('error', (err: NodeJS.ErrnoException) =>
      fail(
        err.code === 'ENOTPUBLIC'
          ? 'resolves to an address that is not public'
          : err.message || 'the request failed',
      ),
    )
    current.end()
  })
}

export type CrawlFetch = typeof crawlFetch
