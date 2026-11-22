/**
 * What the composer holds when it closes without sending (Esc, Close): kept
 * for this person in this browser, so opening the composer again on the same
 * thread (or New email) picks up where they left off. A convenience only, as
 * the browser keeps it: Save draft is what puts a draft in the mailbox.
 *
 * In memory first (the tab's session), then localStorage (a reload), each
 * read and write guarded: storage can be missing, full or refused.
 */
import type { ComposeMode } from './compose'
import type { ComposeAttachmentWire } from './compose-attachments'

export interface LocalComposeDraft {
  mode: ComposeMode
  /** The message replied to or forwarded (null: a new email). */
  sourceId: string | null
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  html: string
  savedAt: number
  /** The thread's AI draft it was filled from (replaced when it is sent). */
  replacesDraftId?: string | null
  /** Attached files: kept in memory only (too big for storage). */
  files?: ComposeAttachmentWire[]
}

const PREFIX = 'ni:mail-compose:'
/** A week: an older one is a stale thought, not a draft. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const memory = new Map<string, LocalComposeDraft>()

/** The key for a thread's composer, or New email's. */
export function composeDraftKey(threadId: string | null | undefined): string {
  return threadId ? `thread:${threadId}` : 'new'
}

function isDraft(value: unknown): value is LocalComposeDraft {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const list = (x: unknown) => Array.isArray(x) && x.every((a) => typeof a === 'string')
  return (
    typeof v.mode === 'string' &&
    ['reply', 'replyAll', 'forward', 'new'].includes(v.mode) &&
    (v.sourceId === null || typeof v.sourceId === 'string') &&
    list(v.to) &&
    list(v.cc) &&
    list(v.bcc) &&
    typeof v.subject === 'string' &&
    typeof v.html === 'string' &&
    typeof v.savedAt === 'number'
  )
}

export function readComposeDraft(key: string, now = Date.now()): LocalComposeDraft | null {
  let draft = memory.get(key) ?? null
  if (!draft) {
    try {
      const raw = window.localStorage.getItem(PREFIX + key)
      const parsed = raw ? (JSON.parse(raw) as unknown) : null
      draft = isDraft(parsed) ? parsed : null
    } catch {
      draft = null
    }
  }
  if (draft && now - draft.savedAt > MAX_AGE_MS) {
    clearComposeDraft(key)
    return null
  }
  return draft
}

export function writeComposeDraft(key: string, draft: LocalComposeDraft): void {
  memory.set(key, draft)
  try {
    const { files: _files, ...stored } = draft
    void _files
    window.localStorage.setItem(PREFIX + key, JSON.stringify(stored))
  } catch {
    // Kept in memory only.
  }
}

export function clearComposeDraft(key: string): void {
  memory.delete(key)
  try {
    window.localStorage.removeItem(PREFIX + key)
  } catch {
    // Nothing to clear.
  }
}
