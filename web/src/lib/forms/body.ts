/**
 * A form submission's body, read for the forms intake alone (./submit.ts).
 * The quote intake keeps its own reader (src/lib/customers/intake.ts
 * readFormBody, 32 KB): this one differs only where a form takes files.
 *
 *   JSON, form encoding   at most FORM_TEXT_BODY_MAX bytes, as the quote
 *                         intake takes.
 *   multipart             a form without a files field: the same cap, and any
 *                         file part ignored (as before). A form with one: at
 *                         most FORM_UPLOAD_BODY_MAX bytes in all (every file
 *                         at its largest, and the fields), its text parts
 *                         together at most FORM_TEXT_BODY_MAX, at most
 *                         MULTIPART_PARTS_MAX parts, and each file part kept
 *                         with its name, declared type and bytes (./files.ts
 *                         checks them; one over a file's limit is kept by its
 *                         size alone). Such an upload must declare its length
 *                         (./submit.ts answers 411 without one), and takes
 *                         room among the uploads in flight by it first
 *                         (./upload-room.ts).
 *
 * The cap is checked on the declared Content-Length before anything is read,
 * and again on the bytes as they stream in: the read stops, and the body is
 * refused, the moment it passes the cap (or its declared length), so no more
 * than the cap is ever held. With a declared length the bytes go straight
 * into one buffer of that length as they arrive (nothing is held twice);
 * without one (a small text body) the pieces are joined once and let go.
 *
 * A multipart body is parsed here, over that one buffer: each part's bytes
 * are a view into it, never a copy, and a file's view is the very bytes
 * ./files.ts checks and ./file-store.ts stores. A streaming parse would not
 * hold less: every file must be checked whole before the row is written, and
 * is stored only after, so the files are held either way. So an upload is
 * held once, its declared length (./upload-room.ts has the arithmetic).
 *
 * A name posted more than once (a multi-select's boxes) is read as a list.
 */
import { QUOTE_BODY_MAX_BYTES } from '@/lib/customers/intake'
import type { UploadedPart } from './files'
import { FORM_FILE_LIMITS } from './types'

/** The most a submission's text may be: the quote intake's cap. */
export const FORM_TEXT_BODY_MAX = QUOTE_BODY_MAX_BYTES
/** The most a submission with files may be: every file at its largest, the text, and the encoding's own bytes. */
export const FORM_UPLOAD_BODY_MAX = FORM_FILE_LIMITS.maxFiles * FORM_FILE_LIMITS.maxBytes + FORM_TEXT_BODY_MAX + 64 * 1024
/** Parts one multipart body may hold: every field of the largest form, a multi-select's boxes, the files, and the form's own. */
export const MULTIPART_PARTS_MAX = 2000

export const BODY_TOO_LARGE_TEXT = "That's more than this form takes."
export const BODY_TOO_LARGE_FILES = `That's more than this form takes: at most ${FORM_FILE_LIMITS.maxFiles} files of ${FORM_FILE_LIMITS.maxBytes / (1024 * 1024)} MB each.`
export const BODY_UNREADABLE = 'Send the form as JSON or form fields.'

export type FormBody =
  | { ok: true; fields: Record<string, unknown>; files: UploadedPart[]; fileBytes: number }
  | { ok: false; status: 400 | 413; error: string }

/** The request's declared Content-Length, or null when it declares none (or nonsense). Pure. */
export function declaredLength(request: Request): number | null {
  const raw = request.headers.get('content-length')
  if (raw === null || !/^\d+$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return Number.isSafeInteger(n) ? n : null
}

/** Whether the request says its body is multipart form data. Pure. */
export function isMultipart(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data')
}

/** The body's bytes, or 'too_large' the moment they pass `max` or the length declared (the read is stopped there). */
async function readCapped(request: Request, max: number): Promise<Uint8Array | 'too_large'> {
  const declared = declaredLength(request)
  if (declared !== null && declared > max) return 'too_large'
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const stop = async () => {
    await reader.cancel().catch(() => {})
    return 'too_large' as const
  }
  if (declared !== null) {
    // One buffer of the declared length, filled as the bytes arrive: each piece is let go once copied in.
    const out = new Uint8Array(declared)
    let at = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (at + value.byteLength > declared) return stop()
      out.set(value, at)
      at += value.byteLength
    }
    return at === declared ? out : out.subarray(0, at)
  }
  let chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) return stop()
    chunks.push(value)
  }
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  chunks = []
  return out
}

/** Add a posted value; a name posted again becomes a list. */
function put(out: Record<string, unknown>, name: string, value: string) {
  if (!(name in out)) out[name] = value
  else if (Array.isArray(out[name])) (out[name] as unknown[]).push(value)
  else out[name] = [out[name], value]
}

/** One part of a multipart body: `body` is a view into the body's buffer. */
export interface MultipartPart {
  name: string
  /** Set (maybe empty) on a file part, null on a text one. */
  filename: string | null
  /** The part's declared Content-Type, '' when it gave none. */
  type: string
  body: Uint8Array
}

/** A multipart content type's boundary, or null. Pure. */
export function boundaryOf(contentType: string): string | null {
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType)
  const boundary = m?.[1] ?? m?.[2] ?? null
  return boundary && /^[ -~]+$/.test(boundary) ? boundary : null
}

const CR = 0x0d
const LF = 0x0a
const HEADERS_MAX = 8 * 1024
/** A header's parameter: `; name="value"`, `; name=value` or `; name*=utf-8''value`. */
const PARAM = /;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+?)(\*?)\s*=\s*(?:"([^"]*)"|([^;\s]*))/g

/** What a browser escapes in a part's name and filename (the HTML standard's), read back. */
const unescapeName = (s: string) => s.replace(/%0A/gi, '\n').replace(/%0D/gi, '\r').replace(/%22/g, '"')

/** A part's headers: its name and filename (Content-Disposition) and type, or null when they aren't a form-data part's. */
function partHeaders(text: string): { name: string; filename: string | null; type: string } | null {
  let name: string | null = null
  let filename: string | null = null
  let extended: string | null = null
  let type = ''
  for (const line of text.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) return null
    const header = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (header === 'content-type') {
      type = value
      continue
    }
    if (header !== 'content-disposition') continue
    if (!/^form-data\s*(;|$)/i.test(value)) return null
    for (const m of value.matchAll(PARAM)) {
      const key = m[1].toLowerCase()
      const raw = m[3] ?? m[4] ?? ''
      if (m[2] === '*') {
        if (key !== 'filename') continue
        const at = raw.indexOf("''")
        if (at < 0 || raw.slice(0, at).toLowerCase() !== 'utf-8') return null
        try {
          extended = decodeURIComponent(raw.slice(at + 2))
        } catch {
          return null
        }
      } else if (key === 'name') name = unescapeName(raw)
      else if (key === 'filename') filename = unescapeName(raw)
    }
  }
  if (name === null) return null
  return { name, filename: extended ?? filename, type }
}

/**
 * The parts of a multipart body (RFC 7578, as browsers send it), each body a
 * view into `input`: nothing copied. Null when it isn't one this can read, or
 * holds more than `maxParts` parts. Pure.
 */
export function parseMultipart(input: Uint8Array, boundary: string, maxParts = MULTIPART_PARTS_MAX): MultipartPart[] | null {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  // A boundary is printable ASCII (boundaryOf), so its UTF-8 bytes are its own.
  const ascii = new TextEncoder()
  const delimiter = ascii.encode(`--${boundary}`)
  const between = ascii.encode(`\r\n--${boundary}`)
  const headersEnd = ascii.encode('\r\n\r\n')
  // The first delimiter starts the body, or ends a preamble.
  let pos = buf.subarray(0, delimiter.length).equals(delimiter) ? 0 : buf.indexOf(between)
  if (pos < 0) return null
  if (pos > 0) pos += 2
  const parts: MultipartPart[] = []
  for (;;) {
    pos += delimiter.length
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) return parts
    while (buf[pos] === 0x20 || buf[pos] === 0x09) pos++
    if (buf[pos] !== CR || buf[pos + 1] !== LF) return null
    pos += 2
    if (parts.length >= maxParts) return null
    const end = buf.indexOf(headersEnd, pos)
    if (end < 0 || end - pos > HEADERS_MAX) return null
    const headers = partHeaders(buf.toString('utf8', pos, end))
    if (!headers) return null
    const start = end + 4
    const next = buf.indexOf(between, start)
    if (next < 0) return null
    parts.push({ ...headers, body: input.subarray(start, next) })
    pos = next + 2
  }
}

const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true })

/** Read a form's submission (see the header). `files`: the form has a files field. */
export async function readFormSubmission(request: Request, opts: { files: boolean }): Promise<FormBody> {
  const contentType = request.headers.get('content-type') ?? ''
  const type = contentType.toLowerCase()
  const tooLarge = (withFiles: boolean): FormBody => ({ ok: false, status: 413, error: withFiles ? BODY_TOO_LARGE_FILES : BODY_TOO_LARGE_TEXT })
  const unreadable: FormBody = { ok: false, status: 400, error: BODY_UNREADABLE }
  try {
    if (type.includes('application/json') || type.includes('application/x-www-form-urlencoded')) {
      const bytes = await readCapped(request, FORM_TEXT_BODY_MAX)
      if (bytes === 'too_large') return tooLarge(false)
      const text = new TextDecoder().decode(bytes)
      if (type.includes('application/json')) {
        const json = JSON.parse(text) as unknown
        if (!json || typeof json !== 'object' || Array.isArray(json)) return unreadable
        return { ok: true, fields: json as Record<string, unknown>, files: [], fileBytes: 0 }
      }
      const fields: Record<string, unknown> = {}
      for (const [name, value] of new URLSearchParams(text)) put(fields, name, value)
      return { ok: true, fields, files: [], fileBytes: 0 }
    }
    if (type.includes('multipart/form-data')) {
      const boundary = boundaryOf(contentType)
      if (!boundary) return unreadable
      const bytes = await readCapped(request, opts.files ? FORM_UPLOAD_BODY_MAX : FORM_TEXT_BODY_MAX)
      if (bytes === 'too_large') return tooLarge(opts.files)
      const parts = parseMultipart(bytes, boundary)
      if (!parts) return unreadable
      const fields: Record<string, unknown> = {}
      const files: UploadedPart[] = []
      let textBytes = 0
      let fileBytes = 0
      for (const part of parts) {
        if (part.filename === null) {
          const value = textDecoder.decode(part.body)
          textBytes += part.name.length + value.length
          if (textBytes > FORM_TEXT_BODY_MAX) return tooLarge(false)
          put(fields, part.name, value)
          continue
        }
        // A file input left empty still sends a part: no name, no bytes.
        if (!opts.files || (!part.filename && part.body.byteLength === 0)) continue
        const size = part.body.byteLength
        fileBytes += size
        files.push({ name: part.filename, type: part.type, size, bytes: size <= FORM_FILE_LIMITS.maxBytes ? part.body : null })
      }
      return { ok: true, fields, files, fileBytes }
    }
  } catch {
    return unreadable
  }
  return unreadable
}
