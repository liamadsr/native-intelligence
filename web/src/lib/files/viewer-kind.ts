/**
 * Which in-app viewer a file opens in (docs/plans/drive-files.md, phase 1).
 *
 * Decided from the file's name and its MIME type alone, so every place that
 * opens a file (Drive, a mail attachment chip, a team chat attachment, a
 * search result) picks the same viewer. Nothing here fetches the file and
 * nothing here sends a file anywhere: every viewer renders in the browser
 * from the file's own bytes. The one exception is a Figma link, which is not
 * a file: it is shown in Figma's own embed, the way the link's owner shares it.
 */

export type ViewerKind =
  | 'pdf'
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'docx'
  | 'sheet'
  | 'pptx'
  | 'figma'
  | 'none'

/** A file's lowercased extension, without the dot, or ''. */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const idx = base.lastIndexOf('.')
  if (idx <= 0 || idx === base.length - 1) return ''
  return base.slice(idx + 1).toLowerCase()
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus'])
const SHEET_EXTENSIONS = new Set(['xlsx', 'csv', 'tsv'])

/**
 * Plain text and source code, shown as text. SVG is here, not with the images:
 * an SVG can carry script, and as text it can never run.
 */
export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'yaml', 'yml', 'toml', 'xml', 'svg', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp',
  'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'r', 'lua', 'pl', 'ini', 'cfg', 'conf', 'env', 'gitignore', 'dockerfile',
  'graphql', 'proto', 'vue', 'svelte', 'ics', 'vcf', 'srt', 'vtt', 'diff', 'patch',
])

/** A link to a Figma file, prototype, board or slides that Figma's embed shows. */
export function isFigmaUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host !== 'figma.com' && host !== 'www.figma.com') return false
  return /^\/(file|design|proto|board|slides|deck)\/[A-Za-z0-9]+/.test(url.pathname)
}

/**
 * Figma's own embed for a Figma link (https://embed.figma.com), or null when
 * `value` is not one. The link is passed as Figma documents it; nothing of
 * ours goes with it.
 */
export function figmaEmbedUrl(value: string): string | null {
  if (!isFigmaUrl(value)) return null
  const url = new URL(value)
  const embed = new URL(`https://embed.figma.com${url.pathname}`)
  url.searchParams.forEach((v, k) => embed.searchParams.set(k, v))
  embed.searchParams.set('embed-host', 'native-intelligence')
  return embed.toString()
}

/** The viewer for a file named `name` with MIME type `mimeType`. */
export function viewerKindOf(file: { name: string; mimeType?: string | null; url?: string | null }): ViewerKind {
  if (file.url && isFigmaUrl(file.url)) return 'figma'
  const ext = extensionOf(file.name)
  const mime = (file.mimeType ?? '').toLowerCase().split(';')[0].trim()
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf'
  if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (ext === 'pptx' || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx'
  if (SHEET_EXTENSIONS.has(ext) || mime === 'text/csv' || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'sheet'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext) || (mime.startsWith('image/') && mime !== 'image/svg+xml')) return 'image'
  if (VIDEO_EXTENSIONS.has(ext) || mime.startsWith('video/')) return 'video'
  if (AUDIO_EXTENSIONS.has(ext) || mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text'
  return 'none'
}

/** The largest file a viewer reads into the page; past it the file is offered as a download. */
export const VIEWER_MAX_BYTES: Record<Exclude<ViewerKind, 'figma' | 'none'>, number> = {
  pdf: 60 * 1024 * 1024,
  image: 40 * 1024 * 1024,
  video: 500 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  text: 2 * 1024 * 1024,
  docx: 25 * 1024 * 1024,
  sheet: 20 * 1024 * 1024,
  pptx: 60 * 1024 * 1024,
}

/** Whether a file of `size` bytes opens in its viewer (an unknown size does). */
export function fitsViewer(kind: ViewerKind, size: number | null | undefined): boolean {
  if (kind === 'none') return false
  if (kind === 'figma') return true
  if (typeof size !== 'number' || !Number.isFinite(size)) return true
  return size <= VIEWER_MAX_BYTES[kind]
}
