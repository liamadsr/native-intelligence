/**
 * The note a run chat's message carries for each file attached to it (bots v4,
 * the full composer). Pure (no runtime imports): the turn builder writes it
 * (run-chat-turn.ts) and the replay reads it back (run-chat-events.ts).
 *
 * A run chat never hands its agent a file part: eve stages every file part of
 * a user message into the session's sandbox (provisioning one: a Vercel
 * Sandbox microVM in production) and keeps a reference to it in the history.
 * So the files ride the turn as text instead: their content as one-turn
 * context, and, in the message itself, one text part per file naming it,
 * which the session keeps. That note is what a later turn knows the file by
 * (its storage path, for read_chat_file), and what a reload shows as a chip.
 */

/** How every note starts. */
export const ATTACHED_FILE_NOTE_PREFIX = '[attached file] '

/** The media type a reload shows for a file, from its extension (never the client's word for it). */
export function attachedFileMediaType(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'md':
      return 'text/markdown'
    case 'csv':
      return 'text/csv'
    case 'json':
      return 'application/json'
    case 'html':
      return 'text/html'
    case 'xml':
      return 'application/xml'
    case 'yaml':
    case 'yml':
      return 'application/yaml'
    default:
      return 'text/plain'
  }
}

/** A name for one line of the note: no line breaks, no quotes or angle brackets, bounded. */
function noteName(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim().replace(/["“”]/g, '’').replace(/</g, '‹').replace(/>/g, '›')
  const bounded = flat.length <= 120 ? flat : `${flat.slice(0, 119).trimEnd()}…`
  return bounded || 'file'
}

/** The note for one attached file: `[attached file] "<name>" (<type>) storage_path: <path>`. */
export function attachedFileNote(file: { fileName: string; mediaType: string; storagePath: string }): string {
  return `${ATTACHED_FILE_NOTE_PREFIX}"${noteName(file.fileName)}" (${file.mediaType}) storage_path: ${file.storagePath}`
}

const NOTE = /^\[attached file\] "([^"\n]*)" \(([\w.+-]+\/[\w.+-]+)\)(?: storage_path: \S+)?$/

/** A note's file (its name and type), or null when the text isn't one. */
export function parseAttachedFileNote(text: string): { filename: string; mediaType: string } | null {
  const m = NOTE.exec(text.trim())
  if (!m) return null
  return { filename: m[1], mediaType: m[2] }
}
