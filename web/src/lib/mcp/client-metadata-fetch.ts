/**
 * The fetch of a client metadata document (client-metadata.ts says what one
 * is). The URL is the app's to choose, so Native Intelligence fetching it is an SSRF
 * surface, and the draft's rules are kept tight:
 *
 *   - Public addresses only, checked AT THE DIAL: the request's own DNS
 *     lookup refuses any answer with a non-public address, and the socket
 *     connects to what that lookup returned. A name can't resolve public at
 *     a check and private a moment later (DNS rebinding), which the MCP
 *     client's guard (mcp-client/url-guard-dns.ts) can't promise.
 *   - 200 only. A redirect is never followed (the draft forbids it).
 *   - Served as JSON (application/json or application/…+json): a raw-text
 *     host where anyone can publish (a gist, raw.githubusercontent.com)
 *     can't stand in for an app's own.
 *   - At most METADATA_MAX_BYTES read, within FETCH_TIMEOUT_MS in all.
 *   - A fresh connection each time (no pooled socket another lookup made).
 *
 * Server-only (node:https, node:dns). The request and the lookup are
 * injectable: tests run a local server and never touch real DNS.
 */
import 'server-only'
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import type { IncomingMessage, RequestOptions, ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { ipv6Groups, isPublicAddress } from '@/lib/mcp-client/url-guard'
import { METADATA_MAX_BYTES, type FetchedDocument } from './client-metadata'

export const FETCH_TIMEOUT_MS = 5_000

type Resolve = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void

/**
 * A DNS lookup that only ever answers with public addresses: every address
 * the name has must be public, or the dial fails. The socket connects to
 * what this returns.
 */
export function publicOnlyLookup(resolve: Resolve = dnsLookup as unknown as Resolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, '')
      if (!addresses?.length || addresses.some((a) => !isPublicAddress(a.address))) {
        const refused: NodeJS.ErrnoException = new Error(`${hostname} does not resolve to public addresses only`)
        refused.code = 'ENOTPUBLIC'
        return callback(refused, '')
      }
      if (options.all) return callback(null, addresses)
      callback(null, addresses[0].address, addresses[0].family)
    })
  }
}

type Send = (url: string, options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest

export interface FetchOptions {
  send?: Send
  lookup?: LookupFunction
  timeoutMs?: number
}

/** GET a client metadata document under the rules above. Rejects with the reason on any failure. */
export function fetchMetadataDocument(url: string, opts: FetchOptions = {}): Promise<FetchedDocument> {
  const send = opts.send ?? (httpsRequest as Send)
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS
  // A literal address never reaches the lookup: it must be public itself.
  // (clientIdUrlProblem refuses them anyway; this holds without it.)
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  if ((ipv6Groups(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) && !isPublicAddress(host)) {
    return Promise.reject(new Error('not a public address'))
  }
  return new Promise<FetchedDocument>((resolve, reject) => {
    let settled = false
    let req: ClientRequest | null = null
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      fn()
    }
    const fail = (reason: string) =>
      finish(() => {
        req?.destroy()
        reject(new Error(reason))
      })
    const deadline = setTimeout(() => fail('timed out'), timeoutMs)

    req = send(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'NativeIntelligence-MCP-OAuth (+https://dial8.ai)' },
        lookup: opts.lookup ?? publicOnlyLookup(),
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return fail(`HTTP ${res.statusCode ?? 'error'}`)
        }
        const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (type !== 'application/json' && !/^application\/[\w.+-]+\+json$/.test(type)) {
          res.resume()
          return fail('not served as JSON')
        }
        const declared = Number(res.headers['content-length'] ?? '')
        if (Number.isFinite(declared) && declared > METADATA_MAX_BYTES) {
          res.resume()
          return fail('document too large')
        }
        const chunks: Uint8Array[] = []
        let size = 0
        res.on('data', (chunk: Uint8Array) => {
          size += chunk.byteLength
          if (size > METADATA_MAX_BYTES) return fail('document too large')
          chunks.push(chunk)
        })
        res.on('end', () => {
          let body: unknown
          try {
            body = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
          } catch {
            return fail('document is not JSON')
          }
          const cc = res.headers['cache-control']
          finish(() => resolve({ body, cacheControl: Array.isArray(cc) ? cc.join(', ') : (cc ?? null) }))
        })
        res.on('error', (err) => fail(err.message))
      },
    )
    req.on('error', (err) => fail(err.message))
    req.end()
  })
}
