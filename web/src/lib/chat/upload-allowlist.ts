/**
 * Single source of truth for which file types may be uploaded in AI chat.
 *
 * Chat uploads are TEXT-ONLY by design: the agent reads the file's text (via
 * the read_chat_file tool) and the Knowledge Weaver skill turns it into claims.
 * Binary office formats (doc/docx/xls/xlsx/ppt/pptx) and PDFs are deliberately
 * EXCLUDED — there is no text-extraction path for them, so the agent would only
 * see a filename. Images are handled separately (passed inline to the model as
 * vision parts), so they are NOT in this set — this list is for text files that
 * read_chat_file can decode.
 *
 * Keep every chat-upload gate importing from here so the frontend accept filter,
 * the client-side guard, and the two server routes can never drift apart.
 *
 * This module must stay dependency-free (no server-only imports) so client
 * components can import it.
 */

/** Text/code extensions the agent can read as plain text. */
const TEXT_UPLOAD_EXTENSIONS = [
  'txt', 'md', 'csv', 'tsv', 'vcf', 'json',
  'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cpp', 'h', 'hpp', 'css', 'scss', 'html', 'xml', 'yaml', 'yml', 'toml',
  'sh', 'sql', 'r', 'lua', 'php', 'env', 'log', 'conf', 'cfg', 'ini',
] as const

/** Image extensions handled via the model's vision input (not read as text). */
const IMAGE_UPLOAD_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
] as const

/**
 * Binary spreadsheets the agent can't read as text but imports into the CRM
 * (read_contact_file / import_contact_file, roadmap track G1). Only .xlsx: the
 * old binary .xls is still refused.
 */
const SPREADSHEET_UPLOAD_EXTENSIONS = ['xlsx'] as const

/**
 * Everything the chat upload endpoint accepts: text files (read by the agent),
 * images (seen by the model directly) and .xlsx spreadsheets (imported as
 * contacts). PDFs and other office docs are NOT here.
 */
const ALLOWED_UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  ...TEXT_UPLOAD_EXTENSIONS,
  ...IMAGE_UPLOAD_EXTENSIONS,
  ...SPREADSHEET_UPLOAD_EXTENSIONS,
])

/** `accept` attribute value for a chat file <input>. */
export const UPLOAD_ACCEPT_ATTR = [
  'image/*',
  ...TEXT_UPLOAD_EXTENSIONS.map((ext) => `.${ext}`),
  ...SPREADSHEET_UPLOAD_EXTENSIONS.map((ext) => `.${ext}`),
].join(',')

/** `accept` for a chat that can't take photos (a run's chat, a teammate's thread): text files only. */
export const UPLOAD_TEXT_ACCEPT_ATTR = TEXT_UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(',')

/** True if a bare extension (no dot) is an allowed chat upload type. */
export function isAllowedUploadExtension(ext: string): boolean {
  return ALLOWED_UPLOAD_EXTENSIONS.has(ext.toLowerCase())
}

const TEXT_UPLOAD_EXTENSION_SET: ReadonlySet<string> = new Set(TEXT_UPLOAD_EXTENSIONS)
const IMAGE_UPLOAD_EXTENSION_SET: ReadonlySet<string> = new Set(IMAGE_UPLOAD_EXTENSIONS)

/** True if a bare extension is a chat upload the agent reads as text. */
export function isTextUploadExtension(ext: string): boolean {
  return TEXT_UPLOAD_EXTENSION_SET.has(ext.toLowerCase())
}

/** True if a bare extension is a chat upload the model sees as an image. */
export function isImageUploadExtension(ext: string): boolean {
  return IMAGE_UPLOAD_EXTENSION_SET.has(ext.toLowerCase())
}

/**
 * True if a candidate upload is a photo or other image, by its name's
 * extension or its declared type. The chats that can't take photos yet (a
 * run's chat, a teammate's thread: bots v4) refuse these in the composer; the
 * run-chat routes refuse them again by extension, and never trust the name for
 * what they inline (run-chat-turn.ts reads the bytes).
 */
export function isChatImageUpload(file: { name: string; type?: string }): boolean {
  const ext = getChatUploadExtension(file.name)
  if (ext && IMAGE_UPLOAD_EXTENSION_SET.has(ext)) return true
  return typeof file.type === 'string' && file.type.toLowerCase().startsWith('image/')
}

/**
 * Max size for a chat upload. Lower than the general attachment ceiling because
 * the agent has to read the whole file into its context — kept in sync with the
 * server route that verifies object metadata after a direct-to-storage upload.
 */
export const MAX_CHAT_UPLOAD_BYTES = 10 * 1024 * 1024

/** Lowercased extension (no dot); `''` when the name has no usable extension. */
export function getChatUploadExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx <= 0 || idx === name.length - 1) return ''
  return name.slice(idx + 1).toLowerCase()
}

/**
 * Validate a candidate chat upload against the extension allowlist and size cap.
 * Reasons are user-readable so every surface can show them verbatim.
 */
export function validateChatUpload(
  file: { name: string; size: number },
): { ok: true } | { ok: false; reason: string } {
  const ext = getChatUploadExtension(file.name)
  if (!ext || !ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    return { ok: false, reason: 'File type not supported in chat' }
  }
  if (file.size > MAX_CHAT_UPLOAD_BYTES) {
    return { ok: false, reason: 'File exceeds the 10MB chat limit' }
  }
  return { ok: true }
}

/** One path segment of a chat upload object name: `<uuid>.<ext>`. */
const CHAT_UPLOAD_OBJECT_NAME = /^[A-Za-z0-9._-]+$/

/**
 * True only when `storagePath` is a single object directly inside the
 * caller's own `<userId>/chat-uploads/` folder.
 *
 * A prefix check alone is not enough: storage-js joins the path into the
 * object URL without encoding it, so `<uid>/chat-uploads/../../<victim>/...`
 * (or its `%2e%2e` spelling) resolves to another user's object once the URL
 * is normalized. Every gate that hands a chat-upload path to service-role
 * storage (read_chat_file, attach_chat_file, /api/ai/chat/upload) uses this.
 */
export function isOwnChatUploadPath(userId: string, storagePath: string): boolean {
  if (!userId || typeof storagePath !== 'string') return false
  if (storagePath.includes('..') || storagePath.includes('%') || storagePath.includes('\\')) {
    return false
  }
  const prefix = `${userId}/chat-uploads/`
  if (!storagePath.startsWith(prefix)) return false
  const objectName = storagePath.slice(prefix.length)
  return CHAT_UPLOAD_OBJECT_NAME.test(objectName)
}
