// The media types the Studio stores and serves inline. Stored files are served from the app's own origin
// (files.ts), so a type a browser would run as a page (HTML, SVG, XML, script) must never come back inline: only the
// media the editor plays, shows or loads as a font does. Anything else is stored and served as opaque bytes, to be
// saved, never opened. A browser upload's type is never taken from the browser: it comes from the file's name.

/** What the Studio stores and serves inline: video, audio, still images and fonts. Never SVG, HTML or script. */
export const INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska',
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/aac',
  'image/png', 'image/jpeg', 'image/webp',
  'font/woff2', 'font/woff', 'font/ttf', 'font/otf',
])

/** The type of opaque bytes: served as a download, never opened. */
export const OPAQUE = 'application/octet-stream'

/** A file extension's type, for the allowed types only. */
const BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
}

/** A stated type reduced to its essence (`Video/MP4; codecs=…` → `video/mp4`). */
const essence = (type: string) => type.split(';')[0]!.trim().toLowerCase()

/** The allowed type of a file name or key from its extension; anything else is opaque bytes. */
export function typeForName(name: string): string {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  return BY_EXTENSION[ext] ?? OPAQUE
}

/** A type someone states (the worker, a stored row), kept when it is an allowed one; anything else is opaque bytes. */
export function allowedType(stated: string | null | undefined): string {
  const type = essence(stated ?? '')
  return INLINE_MEDIA_TYPES.has(type) ? type : OPAQUE
}

/**
 * How a stored file is served: its allowed type inline, or null when it must be a download (a stored type outside
 * the list, whatever its key says). A file stored as opaque bytes takes its key's extension, when that is allowed.
 */
export function inlineTypeOf(key: string, stored: string | null | undefined): string | null {
  const type = essence(stored ?? '')
  if (INLINE_MEDIA_TYPES.has(type)) return type
  if (!type || type === OPAQUE) {
    const byKey = typeForName(key)
    return byKey === OPAQUE ? null : byKey
  }
  return null
}
