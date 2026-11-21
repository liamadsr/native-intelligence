/**
 * Shared types for the live identifier-chip layer (plan: "live references").
 *
 * An EntityRefData is the resolved shape of one action identifier, as returned
 * by GET /api/account/entities/resolve. The chip, the batcher cache and the
 * TipTap decorations all speak this shape.
 */

export interface EntityRefStatus {
  id: string
  name: string
  category: string
  color: string | null
}

export interface EntityRefAssignee {
  id: string
  name: string
}

export interface EntityRefProject {
  id: string
  name: string
}

export interface EntityRefData {
  id: string
  workspace_id: string
  team_id: string | null
  identifier: string
  title: string
  status: EntityRefStatus | null
  assignee: EntityRefAssignee | null
  priority: string | null
  /** ISO timestamp (the action's due_at), or null. */
  due_date: string | null
  project: EntityRefProject | null
}

/** The resolution state of one identifier in the client cache. */
export type EntityRefState =
  | { status: 'loading' }
  | { status: 'found'; data: EntityRefData }
  | { status: 'missing' }

/** Shape of the resolve endpoint's response body. */
export interface ResolveResponse {
  refs: Record<string, EntityRefData>
}

/** The identifier-matching pattern, shared by the remark splitter, the TipTap
 *  decoration finder and the resolve route's validation. A prefix of 2–10
 *  uppercase alphanumerics (first a letter), a dash, then digits. */
export const ENTITY_REF_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g

/** Normalise an identifier to its canonical (uppercase) cache key. */
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toUpperCase()
}

// ── Live mention chips (every kind, not just action identifiers) ──────────────
//
// GET /api/account/entities/resolve?mentions=type:id,… answers only what the
// caller may read. A chip resolves one {type,id} through the mention batcher.

/** One resolved mention: its current label and, where cheap, a status word. */
export interface MentionResolved {
  type: string
  id: string
  label: string
  /** A workflow state's name, or a project/initiative/campaign status, or null. */
  status: string | null
}

/**
 * The resolution state of one mention in the client cache.
 *  - `loading`:  not answered yet — the chip shows its stored words.
 *  - `found`:    the reader may see it — the chip shows the current label and status.
 *  - `hidden`:   the answer came back without it — the reader may not see it (a locked chip).
 *  - `error`:    the lookup failed — the chip keeps its stored words rather than falsely locking.
 */
export type MentionState =
  | { status: 'loading' }
  | { status: 'found'; data: MentionResolved }
  | { status: 'hidden' }
  | { status: 'error' }

/** Shape of the resolve endpoint's mentions response. */
export interface MentionResolveResponse {
  mentions: Record<string, MentionResolved>
}

/** The cache key for one mention: `type:id`, the id lower-cased (as the route answers). */
export function mentionCacheKey(type: string, id: string): string {
  return `${type}:${id.trim().toLowerCase()}`
}
