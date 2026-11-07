/**
 * Suggestions: a staged change to workspace data that a person accepts,
 * dismisses or modifies. Stored as proposed_change rows (the capture page's
 * proposals are the same thing); see docs/plans/suggestions-everywhere.md.
 *
 * Client-safe: no server imports.
 */

/** Where a suggestion is shown. At most one per row (migration 312). */
export type SuggestionHome =
  | { kind: 'capture'; id: string }
  | { kind: 'document'; id: string }
  | { kind: 'conversation'; id: string }

/** Who staged it (proposed_change.origin). */
export type SuggestionOrigin = 'live_agent' | 'triage' | 'chat' | 'skill_run' | 'work_run' | 'mcp'

export type SuggestionStatus = 'pending' | 'applied' | 'dismissed' | 'expired'

/** Why a pending suggestion expired (extra.expire_reason). */
export type ExpireReason = 'ttl' | 'already_true' | 'target_deleted' | 'applied_elsewhere' | 'run_undelivered'

/** The changes an agent can stage with suggest_changes. */
export const SUGGEST_CHANGE_TYPES = ['create', 'update', 'assign', 'delete', 'send_email'] as const
// Decisions are left out: they belong to a capture, and the capture page stages them.
export const SUGGEST_ENTITY_TYPES = ['action', 'project', 'milestone', 'contact'] as const
export type SuggestChangeType = (typeof SUGGEST_CHANGE_TYPES)[number]
export type SuggestEntityType = (typeof SUGGEST_ENTITY_TYPES)[number]

export const SUGGEST_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const

/** One change as an agent stages it. */
export interface SuggestionInput {
  change: SuggestChangeType
  entity: SuggestEntityType
  /** 'GEN-297', a uuid, or a title. Required unless creating. */
  target?: string | null
  /** The card's one-liner. */
  summary: string
  /** The delta. */
  set?: {
    status?: string | null
    assignee?: string | null
    due_date?: string | null
    priority?: string | null
    project?: string | null
    title?: string | null
    description?: string | null
    email_to?: string | null
    email_subject?: string | null
  } | null
  /** Shown in the card's context popover. */
  why: string
  confidence?: number | null
  expires_in_days?: number | null
}

export type StageRefusal =
  | 'unsupported'
  | 'target_not_found'
  | 'target_ambiguous'
  | 'recently_dismissed'
  | 'already_true'
  | 'invalid'

export interface StagedSuggestion {
  /** Set unless refused. */
  id?: string
  /** '<!-- proposal:<id> -->': put it on its own line after the text it belongs to. */
  marker?: string
  summary: string
  result: 'staged' | 'existing' | 'refused'
  refusal?: StageRefusal
  /** Why it was refused, or what was resolved ("GEN-297 'Follow up with Kenan'"). */
  note?: string
}

/** The marker a document or a chat answer carries for a suggestion. */
export function suggestionMarker(id: string): string {
  return `<!-- proposal:${id} -->`
}

/** Matches a marker; group 1 is the id (a uuid, an 8-char short id, or a sort index). */
export const SUGGESTION_MARKER_RE = /<!--\s*proposal:([a-zA-Z0-9-]+)\s*-->/g
