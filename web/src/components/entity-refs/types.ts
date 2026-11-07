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
