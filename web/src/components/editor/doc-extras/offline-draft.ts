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
 * Private text on a possibly shared computer, so:
 *   - every entry is keyed by the signed-in person AND the workspace
 *     (`ni:doc-offline:<user>:<workspace>:<document>`): another person on the
 *     same browser reads none of it;
 *   - the sign-out wipe (main-chat/state-wipe.ts) removes every entry, and no
 *     entry is written once a wipe has started this page load;
 *   - an entry goes as soon as its text is saved, and one older than
 *     OFFLINE_DRAFT_MAX_AGE_MS is dropped unread (pruneOfflineDrafts sweeps
 *     everyone's, whenever a document opens).
 * It is NOT encrypted: until it syncs it sits in the browser's storage as text
 * (a decision for the owner, in the plan).
 *
 * `localStorage`; every call is safe where storage is missing or full (it then
 * keeps nothing, and the error line shows as before).
 */
import { isTabStateWipeActive } from '@/app/account/(dashboard)/main-chat/state-wipe'

export interface OfflineDraft {
  /** The person's text that didn't reach the server. */
  content: string
  /** The revision, and its text, the person was editing on. */
  baseRevision: number
  baseContent: string
  /** When it was kept (ms). */
  savedAt: number
}

/** Whose copy: the signed-in person, in a workspace. */
export interface OfflineScope {
  userId: string
  workspaceId: string
}

/** Every key starts with this (the sign-out wipe sweeps it). */
export const OFFLINE_DRAFT_PREFIX = 'ni:doc-offline:'

/** A kept copy this old is dropped unread. */
export const OFFLINE_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** The storage key of one person's copy of one document. Pure. */
export function offlineDraftKey(scope: OfflineScope, documentId: string): string {
  return `${OFFLINE_DRAFT_PREFIX}${scope.userId}:${scope.workspaceId}:${documentId}`
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function parse(raw: string | null): OfflineDraft | null {
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as Partial<OfflineDraft>
    if (typeof d.content !== 'string' || typeof d.baseRevision !== 'number' || typeof d.baseContent !== 'string' || typeof d.savedAt !== 'number') return null
    return d as OfflineDraft
  } catch {
    return null
  }
}

export function readOfflineDraft(scope: OfflineScope | null, documentId: string, now = Date.now()): OfflineDraft | null {
  const s = storage()
  if (!s || !scope) return null
  const key = offlineDraftKey(scope, documentId)
  try {
    const d = parse(s.getItem(key))
    if (!d || now - d.savedAt > OFFLINE_DRAFT_MAX_AGE_MS) {
      s.removeItem(key)
      return null
    }
    return d
  } catch {
    return null
  }
}

/** Keep the text; true when it was kept (never after sign-out has begun, never without a person). */
export function writeOfflineDraft(scope: OfflineScope | null, documentId: string, draft: Omit<OfflineDraft, 'savedAt'>, now = Date.now()): boolean {
  const s = storage()
  if (!s || !scope || isTabStateWipeActive()) return false
  try {
    s.setItem(offlineDraftKey(scope, documentId), JSON.stringify({ ...draft, savedAt: now } satisfies OfflineDraft))
    return true
  } catch {
    return false
  }
}

export function clearOfflineDraft(scope: OfflineScope | null, documentId: string) {
  if (!scope) return
  try {
    storage()?.removeItem(offlineDraftKey(scope, documentId))
  } catch {
    // Nothing to clear.
  }
}

/** Drop every copy on this device (anyone's) that is too old or unreadable. How many went. */
export function pruneOfflineDrafts(now = Date.now()): number {
  const s = storage()
  if (!s) return 0
  try {
    const doomed: string[] = []
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i)
      if (!key?.startsWith(OFFLINE_DRAFT_PREFIX)) continue
      const d = parse(s.getItem(key))
      if (!d || now - d.savedAt > OFFLINE_DRAFT_MAX_AGE_MS) doomed.push(key)
    }
    for (const key of doomed) s.removeItem(key)
    return doomed.length
  } catch {
    return 0
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
