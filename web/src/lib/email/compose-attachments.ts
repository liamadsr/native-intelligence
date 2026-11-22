/**
 * Files the person attaches in Mail's composer, on their way to the mailbox:
 * POST /api/account/email/send and save-draft take them as base64, and
 * sendEmail / saveDraftToProvider put them in the message (Gmail: a
 * multipart/mixed MIME part each; Outlook: a fileAttachment each, before the
 * send). Pure and shared, so the composer refuses what the route would.
 *
 * Limits: Outlook takes a file of up to 3 MB in one request (bigger needs an
 * upload session), so 3 MB a file; 10 files and 6 MB in all, because the
 * request passes the app's proxy (src/proxy.ts covers /api/account), which
 * reads at most 10 MB of a body, and base64 grows the files by a third.
 */

export const MAX_COMPOSE_FILES = 10
export const MAX_COMPOSE_FILE_BYTES = 3 * 1024 * 1024
export const MAX_COMPOSE_TOTAL_BYTES = 6 * 1024 * 1024

export interface ComposeAttachment {
  name: string
  mimeType: string
  /** The file's bytes, base64 (standard alphabet, padded). */
  contentBase64: string
}

/** What the routes take: snake_case, as the rest of the body. */
export interface ComposeAttachmentWire {
  name: string
  mime_type: string
  content_base64: string
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** The decoded size of a base64 string. */
export function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

/**
 * A file name safe to put in a MIME header and in Graph's JSON: one line, no
 * quotes, backslashes or path, at most 200 characters (the extension kept).
 */
export function safeAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  let name = base.replace(/[\x00-\x1f\x7f"\\]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name || name === '.' || name === '..') name = 'attachment'
  if (name.length > 200) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : ''
    name = name.slice(0, 200 - ext.length) + ext
  }
  return name
}

/** Why these files can't go (as the composer says it); null: they can. */
export function attachmentsProblem(files: ReadonlyArray<{ name: string; size: number }>): string | null {
  if (files.length > MAX_COMPOSE_FILES) return `Attach ${MAX_COMPOSE_FILES} files at most`
  const big = files.find((f) => f.size > MAX_COMPOSE_FILE_BYTES)
  if (big) return `“${big.name}” is over 3 MB`
  const total = files.reduce((n, f) => n + f.size, 0)
  if (total > MAX_COMPOSE_TOTAL_BYTES) return 'Attachments are over 6 MB in all'
  return null
}

/**
 * The attachments in a request body, checked: [] when there are none,
 * 'invalid' when any is malformed or the set is over the limits.
 */
export function parseComposeAttachments(value: unknown): ComposeAttachment[] | 'invalid' {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_COMPOSE_FILES) return 'invalid'
  const out: ComposeAttachment[] = []
  let total = 0
  for (const item of value) {
    if (!item || typeof item !== 'object') return 'invalid'
    const { name, mime_type: mimeType, content_base64: content } = item as Record<string, unknown>
    if (typeof name !== 'string' || typeof mimeType !== 'string' || typeof content !== 'string') return 'invalid'
    if (!name.trim() || !MIME.test(mimeType)) return 'invalid'
    const b64 = content.replace(/\s+/g, '')
    if (!b64 || b64.length % 4 !== 0 || !BASE64.test(b64)) return 'invalid'
    const bytes = base64Bytes(b64)
    if (bytes > MAX_COMPOSE_FILE_BYTES) return 'invalid'
    total += bytes
    if (total > MAX_COMPOSE_TOTAL_BYTES) return 'invalid'
    out.push({ name: safeAttachmentName(name), mimeType: mimeType.toLowerCase(), contentBase64: b64 })
  }
  return out
}

export function toWire(files: readonly ComposeAttachment[]): ComposeAttachmentWire[] {
  return files.map((f) => ({ name: f.name, mime_type: f.mimeType, content_base64: f.contentBase64 }))
}

/** RFC 2231 filename*: the name as UTF-8, percent-encoded (any client reads it). */
function encodedFilename(name: string): string {
  return `UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

/** One attachment's MIME part: base64 in 76-character lines. */
export function attachmentMimePart(boundary: string, file: ComposeAttachment): string {
  const ascii = /^[\x20-\x7e]+$/.test(file.name)
  const disposition = ascii
    ? `attachment; filename="${file.name}"`
    : `attachment; filename*=${encodedFilename(file.name)}`
  const type = ascii ? `${file.mimeType}; name="${file.name}"` : file.mimeType
  const lines = file.contentBase64.match(/.{1,76}/g) ?? []
  return (
    `--${boundary}\r\n` +
    `Content-Type: ${type}\r\n` +
    `Content-Disposition: ${disposition}\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${lines.join('\r\n')}\r\n`
  )
}

/** Graph's fileAttachment for one file. */
export function graphFileAttachment(file: ComposeAttachment): Record<string, string> {
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: file.name,
    contentType: file.mimeType,
    contentBytes: file.contentBase64,
  }
}
