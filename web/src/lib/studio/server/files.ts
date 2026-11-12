// Serving a stored file to the browser: GET /api/account/studio/file/<workspace>/<key>. The bytes always come
// through the app (same origin): the editor's preview fetches media with a Range header and the app's own headers,
// which a redirect to Storage would carry into a cross-origin preflight Storage refuses. A file kept as several
// parts is served as one, with byte ranges: only the parts (and the part ranges) a request needs are fetched.
import { blobPartUrls, type StoredBlob } from './blobs'
import type { StudioContext } from './context'
import { inlineTypeOf, OPAQUE } from './media-types'

/** A requested byte range, inclusive; null for the whole file; 'unsatisfiable' for a 416. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return 'unsatisfiable'
  let start: number
  let end = size - 1
  if (!match[1]) {
    // A suffix: the last N bytes.
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
  } else {
    start = Number(match[1])
    if (match[2]) end = Math.min(end, Number(match[2]))
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'unsatisfiable'
  return { start, end }
}

/** The parts a byte range touches, with the range inside each part (inclusive). */
export function partSpans(range: { start: number; end: number }, partBytes: number): { index: number; from: number; to: number }[] {
  const spans: { index: number; from: number; to: number }[] = []
  for (let index = Math.floor(range.start / partBytes); index <= Math.floor(range.end / partBytes); index++) {
    const base = index * partBytes
    spans.push({ index, from: Math.max(range.start, base) - base, to: Math.min(range.end, base + partBytes - 1) - base })
  }
  return spans
}

/**
 * The type a stored file is served with: an allowed media type (media-types.ts), from the stored type or, for files
 * stored as opaque bytes, the key's extension; anything else is opaque bytes (and served as a download).
 */
export function typeOfKey(key: string, stored: string): string {
  return inlineTypeOf(key, stored) ?? OPAQUE
}

/**
 * Every file answer's guard: a file is never a page. Were one opened as a document (a link followed, a tab), the
 * sandbox gives it no script, no origin and no requests; as a subresource (<video>, <img>, @font-face, a ranged
 * fetch) the policy does not apply and the media plays. nosniff keeps the browser to the stated type.
 */
export const FILE_CSP = "sandbox; default-src 'none'"

/** Content-addressed files never change under their key; everything else may. */
export const cacheControlFor = (key: string) => (/^assets\/[a-f0-9]{64}\./.test(key) ? 'private, max-age=3600, immutable' : 'private, no-cache')

/** Fetch bytes `from`..`to` (inclusive) of one part from its signed link, as a stream. */
export type PartFetch = (url: string, from: number, to: number, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>

/** The default part fetch: an HTTP Range request to Storage (a whole-part answer is trimmed to the range). */
export const fetchPart: PartFetch = async (url, from, to, signal) => {
  const response = await fetch(url, { headers: { range: `bytes=${from}-${to}` }, signal })
  if (!response.ok || !response.body) throw new Error(`Storage answered ${response.status}`)
  if (response.status === 206) return response.body
  return trimStream(response.body, from, to - from + 1)
}

/** Skip `skip` bytes of a stream, then pass `take` bytes. */
function trimStream(source: ReadableStream<Uint8Array>, skip: number, take: number): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let skipped = 0
  let sent = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (sent >= take) {
          await reader.cancel().catch(() => undefined)
          controller.close()
          return
        }
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        let chunk = value
        if (skipped < skip) {
          const drop = Math.min(skip - skipped, chunk.byteLength)
          skipped += drop
          chunk = chunk.subarray(drop)
        }
        if (!chunk.byteLength) continue
        const room = take - sent
        if (chunk.byteLength > room) chunk = chunk.subarray(0, room)
        sent += chunk.byteLength
        controller.enqueue(chunk)
        return
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

/** A Content-Disposition value that saves the file under `name`. */
export function attachment(name: string): string {
  const clean = name.replace(/[\r\n"\\]/g, '').slice(0, 200) || 'download'
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`
}

/**
 * Answer a request for a stored file: 200 with the whole file, 206 with a range, 416 for a range past its end;
 * HEAD answers the headers alone. Upstream reads stop when the browser goes away.
 */
export async function serveBlob(
  ctx: StudioContext,
  blob: StoredBlob,
  request: Request,
  options: { download?: string | null; fetchPart?: PartFetch } = {},
): Promise<Response> {
  const size = blob.bytes
  const inline = inlineTypeOf(blob.key, blob.contentType)
  const headers = new Headers({
    'content-type': inline ?? OPAQUE,
    'accept-ranges': 'bytes',
    'cache-control': cacheControlFor(blob.key),
    'x-content-type-options': 'nosniff',
    'content-security-policy': FILE_CSP,
  })
  // A type outside the allowed media is always a download, under its key's last segment when no name is asked.
  if (options.download) headers.set('content-disposition', attachment(options.download))
  else if (!inline) headers.set('content-disposition', attachment(blob.key.split('/').at(-1) || 'download'))
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    headers.set('content-range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  const whole = range ?? (size ? { start: 0, end: size - 1 } : null)
  headers.set('content-length', String(whole ? whole.end - whole.start + 1 : 0))
  if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`)
  const status = range ? 206 : 200
  if (request.method === 'HEAD' || !whole) return new Response(null, { status, headers })

  const spans = partSpans(whole, blob.partBytes)
  const urls = await blobPartUrls(ctx, blob)
  const get = options.fetchPart ?? fetchPart
  const upstream = new AbortController()
  const stop = () => upstream.abort()
  request.signal?.addEventListener('abort', stop, { once: true })
  let at = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (!reader) {
            const span = spans[at]
            if (!span) {
              request.signal?.removeEventListener('abort', stop)
              controller.close()
              return
            }
            reader = (await get(urls[span.index]!, span.from, span.to, upstream.signal)).getReader()
          }
          const { done, value } = await reader.read()
          if (done) {
            reader = null
            at++
            continue
          }
          controller.enqueue(value)
          return
        }
      } catch (error) {
        request.signal?.removeEventListener('abort', stop)
        controller.error(error)
      }
    },
    cancel() {
      upstream.abort()
      request.signal?.removeEventListener('abort', stop)
      return reader?.cancel().catch(() => undefined)
    },
  })
  return new Response(body, { status, headers })
}
