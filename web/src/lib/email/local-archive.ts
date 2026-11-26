import { isMissingColumnError } from '@/lib/mcp-client/public-row'

/**
 * The person's archive here wins over the mailbox's older word (migration
 * 722; Liam, 11-26: "I dismissed all the notifications and they went through
 * and Google updated, but then they all came back again").
 *
 * An archive made in Native Intelligence (Incoming's Done, Mail's E, the
 * agent's triage, a muted thread's re-archive) stamps the thread's index rows
 * with when it happened (`local_archived_at`) and, for Gmail, the thread's
 * historyId just after it (`local_archived_history_id`). Moving it back here
 * (Undo) clears both.
 *
 * A mailbox sync that reads the thread as in the inbox may put it back only
 * with evidence the thread came back after the archive (reenteredInbox):
 *   - Gmail's historyId for the thread is newer than the archive's: something
 *     changed it since (a new message, or the person moving it back in Gmail);
 *     an answer at or below it predates the archive, however late it lands;
 *   - with no historyId on either side, a message newer than the archive.
 * The `synced_at` fence (email-sync.ts writeFenced) only stops a read that
 * STARTED before the archive's stamp; this stops any read whose answer
 * predates it. Taking a thread OUT of the inbox is never held back.
 *
 * Before 722 the columns don't exist: every write here drops them and goes on
 * as before (isPre722Error), and reads skip the check.
 */

export const LOCAL_ARCHIVE_COLUMNS = ['local_archived_at', 'local_archived_history_id'] as const

export interface LocalArchiveMark {
  local_archived_at?: string | null
  local_archived_history_id?: string | null
}

/** What a mailbox read says about the thread, to weigh against the mark. */
export interface MailboxReadEvidence {
  /** Gmail's thread historyId in the answer (null when it gave none). */
  historyId: string | null
  /** The newest message's time in the answer (ISO), drafts left out. */
  newestMessageAt: string | null
}

export function isPre722Error(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return LOCAL_ARCHIVE_COLUMNS.some((c) => isMissingColumnError(error, c))
}

/** The patch that records (archive true) or clears (false) the person's archive here. */
export function localArchivePatch(archive: boolean, historyId: string | null = null, now: Date = new Date()): Record<string, string | null> {
  return archive ? { local_archived_at: now.toISOString(), local_archived_history_id: historyId } : { local_archived_at: null, local_archived_history_id: null }
}

/** `patch` without the 722 columns (a database before the migration). */
export function withoutLocalArchive<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => !(LOCAL_ARCHIVE_COLUMNS as readonly string[]).includes(key))) as Partial<T>
}

function historyNumber(id: string | null | undefined): bigint | null {
  if (typeof id !== 'string' || !/^\d+$/.test(id)) return null
  try {
    return BigInt(id)
  } catch {
    return null
  }
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? NaN : t
}

/**
 * Whether a read that says "inbox" may put an archived-here thread back: no
 * mark (never archived here, or put back since) always may. Pure.
 */
export function reenteredInbox(mark: LocalArchiveMark | null | undefined, read: MailboxReadEvidence): boolean {
  const archivedAt = ms(mark?.local_archived_at)
  if (!mark || Number.isNaN(archivedAt)) return true
  const markHistory = historyNumber(mark.local_archived_history_id)
  const readHistory = historyNumber(read.historyId)
  if (markHistory !== null && readHistory !== null) return readHistory > markHistory
  const newest = ms(read.newestMessageAt)
  return !Number.isNaN(newest) && newest > archivedAt
}

/**
 * Whether a listed row is one the person archived here with nothing newer in
 * it since (its newest message no later than the archive): Incoming leaves
 * it out whatever its folder says. A row without the mark is listed. Pure.
 */
export function archivedHereSinceNewest(row: { last_message_at?: string | null } & LocalArchiveMark): boolean {
  const archivedAt = ms(row.local_archived_at)
  if (Number.isNaN(archivedAt)) return false
  const newest = ms(row.last_message_at)
  return Number.isNaN(newest) || newest <= archivedAt
}
