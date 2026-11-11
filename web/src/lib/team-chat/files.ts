/**
 * Team chat's files (migrations 555 and 558), pure and client-safe: which
 * files a message may carry, where each one is stored, and the attachments a
 * client sent, tidied before the server checks them against storage.
 *
 * A file lives in the private `team-chat-files` bucket at
 * `<channel id>/<user id>/<uuid>.<ext>`: the channel's own folder (whoever may
 * read the channel may read it, 558's policy) and the uploader's sub-folder
 * (only they upload or delete there). The page uploads straight to storage
 * as the person, then sends the paths with the message; the message's insert
 * guard (555) refuses a path outside the channel's folder, the author's
 * sub-folder.
 *
 * The cap is the AI chat's (MAX_CHAT_UPLOAD_BYTES, 10 MB). The types are
 * wider than the AI chat's (which only takes what the agent can read): these
 * are for people, so PDFs and office files are in, and HTML and SVG (which a
 * browser runs when the link is opened) are out.
 */
import { MAX_CHAT_UPLOAD_BYTES, getChatUploadExtension } from '@/lib/chat/upload-allowlist'
import type { TeamChatAttachment } from './types'

export const TEAM_CHAT_FILES_BUCKET = 'team-chat-files'
/** The most bytes one file holds (the AI chat's cap, and 558's bucket limit). */
export const TEAM_CHAT_FILE_MAX_BYTES = MAX_CHAT_UPLOAD_BYTES
/** The most files one message carries (555's check). */
export const TEAM_CHAT_MAX_FILES = 10
/** How long a link to a file lives (it is signed again when it runs out). */
export const TEAM_CHAT_FILE_URL_TTL_SECONDS = 60 * 60

/** Each extension a message's file may have, and the media type storage keeps it under. */
const TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip',
}

/** The images drawn inline (the rest are a chip with their name and size). HEIC isn't: most browsers can't draw it. */
const INLINE_IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** `accept` for the composer's file picker. */
export const TEAM_CHAT_FILE_ACCEPT = Object.keys(TYPES)
  .map((ext) => `.${ext}`)
  .join(',')

/** The media type a file is stored as, by its extension; null when it isn't one a message may carry. */
export function teamChatFileType(name: string): string | null {
  return TYPES[getChatUploadExtension(name)] ?? null
}

/** Can this file go on a message? The reason is the person's to read. */
export function validateTeamChatFile(file: { name: string; size: number }): { ok: true } | { ok: false; reason: string } {
  if (!teamChatFileType(file.name)) return { ok: false, reason: 'That kind of file can’t be shared here' }
  if (file.size > TEAM_CHAT_FILE_MAX_BYTES) return { ok: false, reason: 'Files are 10 MB at most' }
  if (file.size <= 0) return { ok: false, reason: 'That file is empty' }
  return { ok: true }
}

/** Where a new upload goes: the channel's folder, the person's sub-folder, a fresh name. */
export function teamChatFilePath(channelId: string, userId: string, fileName: string, id: string = crypto.randomUUID()): string {
  return `${channelId}/${userId}/${id}.${getChatUploadExtension(fileName)}`
}

/** True when an attachment is an image drawn inline. */
export function isInlineImage(attachment: Pick<TeamChatAttachment, 'path'>): boolean {
  return INLINE_IMAGES.has(getChatUploadExtension(attachment.path))
}

/** A file's size as the chip shows it: "820 B", "14 KB", "3.2 MB". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** True when a path is one of this person's uploads in this channel's folder (as 555's insert guard has it). */
export function isOwnTeamChatFilePath(path: unknown, channelId: string, userId: string): path is string {
  if (typeof path !== 'string') return false
  const m = new RegExp(`^${channelId.toLowerCase()}/${userId.toLowerCase()}/${UUID}\\.([a-z0-9]{1,8})$`).exec(path)
  return !!m && !!TYPES[m[1]]
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 20_000 ? value : undefined
}

/**
 * A client's attachments, tidied: only the person's own uploads in this
 * channel's folder, distinct, at most TEAM_CHAT_MAX_FILES, each name cut to
 * 200 characters. Size and type are the client's word only until the route
 * reads them from storage (attachmentsFromStorage in ./store.ts).
 */
export function tidyAttachments(raw: unknown, scope: { channelId: string; userId: string }): TeamChatAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: TeamChatAttachment[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const a = item as Record<string, unknown>
    if (!isOwnTeamChatFilePath(a.path, scope.channelId, scope.userId) || seen.has(a.path)) continue
    seen.add(a.path)
    const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 200) : a.path.slice(a.path.lastIndexOf('/') + 1)
    const width = positiveInt(a.width)
    const height = positiveInt(a.height)
    out.push({
      path: a.path,
      name,
      size: typeof a.size === 'number' && a.size > 0 ? a.size : 0,
      type: teamChatFileType(a.path) ?? 'application/octet-stream',
      ...(width && height ? { width, height } : {}),
    })
    if (out.length >= TEAM_CHAT_MAX_FILES) break
  }
  return out
}
