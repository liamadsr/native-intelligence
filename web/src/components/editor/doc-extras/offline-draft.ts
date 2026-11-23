/**
 * Offline editing (docs/plans/doc-editor-extras.md, phase 5): the text a
 * document's save couldn't deliver (no connection, or the request failed
 * without an answer), kept on this device with the revision and text it was
 * based on, until a save of it lands.
 *
 * Nothing here merges: the kept text is saved through the panel's own save,
 * with its ORIGINAL base revision, so the compare-and-swap (migration 364)
 * decides. Nobody changed the document: it saves. Somebody did: the save
 * loses the swap and the panel's three-way merge combines both or asks, as
 * for any other conflict. Nobody's work is overwritten either way.
 *
 * `localStorage`, one entry per document; every call is safe where storage
 * is missing or full (it then keeps nothing, and the error line shows as
 * before).
 */

export interface OfflineDraft {
  /** The person's text that didn't reach the server. */
  content: string
  /** The revision, and its text, the person was editing on. */
  baseRevision: number
  baseContent: string
  /** When it was kept (ms). */
  savedAt: number
}

export const OFFLINE_DRAFT_PREFIX = 'ni:doc-offline:'

/** A kept copy this old is dropped unread (the document has long moved on, or is gone). */
export const OFFLINE_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readOfflineDraft(documentId: string, now = Date.now()): OfflineDraft | null {
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(OFFLINE_DRAFT_PREFIX + documentId)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<OfflineDraft>
    if (typeof d.content !== 'string' || typeof d.baseRevision !== 'number' || typeof d.baseContent !== 'string' || typeof d.savedAt !== 'number') {
      s.removeItem(OFFLINE_DRAFT_PREFIX + documentId)
      return null
    }
    if (now - d.savedAt > OFFLINE_DRAFT_MAX_AGE_MS) {
      s.removeItem(OFFLINE_DRAFT_PREFIX + documentId)
      return null
    }
    return d as OfflineDraft
  } catch {
    return null
  }
}

/** Keep the text; true when it was kept. */
export function writeOfflineDraft(documentId: string, draft: Omit<OfflineDraft, 'savedAt'>, now = Date.now()): boolean {
  const s = storage()
  if (!s) return false
  try {
    s.setItem(OFFLINE_DRAFT_PREFIX + documentId, JSON.stringify({ ...draft, savedAt: now } satisfies OfflineDraft))
    return true
  } catch {
    return false
  }
}

export function clearOfflineDraft(documentId: string) {
  try {
    storage()?.removeItem(OFFLINE_DRAFT_PREFIX + documentId)
  } catch {
    // Nothing to clear.
  }
}

/** Is the browser offline right now? (False when it can't say.) */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/** A save result that never reached the server (no answer at all). */
export function isUndelivered(result: { ok: boolean; status?: number }): boolean {
  return !result.ok && result.status === 0
}

/**
 * What to do with a kept copy when the document loads: nothing kept, or it is
 * exactly what the server has now (`drop` it), or it holds text the server
 * doesn't (`restore` it into the editor and save it on its own base). Pure.
 */
export function offlineDraftOnLoad(draft: OfflineDraft | null, server: { content: string | null; revision: number | null }): 'none' | 'drop' | 'restore' {
  if (!draft) return 'none'
  if ((server.content ?? '') === draft.content) return 'drop'
  return 'restore'
}
