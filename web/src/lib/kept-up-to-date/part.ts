/**
 * A record kept up to date, in the home thread (migration 539,
 * ./engine.ts): one data part, written by the server, that the chat draws as
 * a chip ("Updated from your mail · Acme renewal · Stage: Proposal → Won ·
 * “We signed this morning.” · Undo"). Undo goes through
 * /api/account/kept-up-to-date/[id]/undo, which rewrites the part with
 * `undone`, so a reload says so.
 *
 * The part is data the person's own client could write, so it only names the
 * row: Undo reads what to put back from kept_change, never from here.
 *
 * Client-safe and pure: a part is data, so every field is checked.
 */

/** The part's type. */
export const KEPT_PART_TYPE = 'data-kept-up-to-date' as const

/** `ui_message.metadata.kind` of the message. */
export const KEPT_MESSAGE_KIND = 'kept_up_to_date' as const

export const KEPT_TITLE_MAX = 200
export const KEPT_VALUE_MAX = 120
export const KEPT_EVIDENCE_MAX = 300

export type KeptSourceKind = 'email' | 'capture' | 'sms'
export const KEPT_SOURCES: readonly KeptSourceKind[] = ['email', 'capture', 'sms']

export interface KeptPartData {
  /** kept_change.id */
  record_id: string
  record_type: 'action' | 'data_row'
  /** The to-do's or the row's id. */
  target_id: string
  /** A row's table. */
  table_id: string | null
  title: string
  /** A to-do's GEN-42. */
  identifier: string | null
  /** A row's table name. */
  table: string | null
  /** The column changed ("Stage"); null for a to-do. */
  field: string | null
  /** The value before and after, as words ("Proposal", "Won"; a to-do: "Done"). */
  from: string | null
  to: string
  /** The sentence that said it. */
  evidence: string | null
  source: KeptSourceKind
  /** A sender's domain, when there is one. */
  source_label: string | null
  /** The person took it back with Undo. */
  undone?: boolean
  /** Undo found it changed since, and left it where it is. */
  changed?: boolean
}

/** The message id of a change's message: one per change, rewritten in place on Undo. */
export function keptMessageId(recordId: string): string {
  return `kept-up-to-date:${recordId}`
}

/** "your mail", "a meeting", "a text": where a change came from, in the chip's words. */
export function keptSourceWords(source: KeptSourceKind): string {
  return source === 'email' ? 'your mail' : source === 'capture' ? 'a meeting' : 'a text'
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** The part's data, or null when it is not one (a part is data). Pure. */
export function keptPartData(value: unknown): KeptPartData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.record_id !== 'string' || !v.record_id) return null
  if (v.record_type !== 'action' && v.record_type !== 'data_row') return null
  if (typeof v.target_id !== 'string' || !v.target_id) return null
  const title = str(v.title, KEPT_TITLE_MAX)
  const to = str(v.to, KEPT_VALUE_MAX)
  if (!title || !to) return null
  if (!(KEPT_SOURCES as readonly unknown[]).includes(v.source)) return null
  return {
    record_id: v.record_id,
    record_type: v.record_type,
    target_id: v.target_id,
    table_id: typeof v.table_id === 'string' && v.table_id ? v.table_id : null,
    title,
    identifier: typeof v.identifier === 'string' && v.identifier.trim() && v.identifier.length <= 64 ? v.identifier.trim() : null,
    table: str(v.table, KEPT_TITLE_MAX),
    field: str(v.field, 60),
    from: str(v.from, KEPT_VALUE_MAX),
    to,
    evidence: str(v.evidence, KEPT_EVIDENCE_MAX),
    source: v.source as KeptSourceKind,
    source_label: typeof v.source_label === 'string' && DOMAIN_RE.test(v.source_label) ? v.source_label : null,
    ...(v.undone === true ? { undone: true } : {}),
    ...(v.changed === true ? { changed: true } : {}),
  }
}
