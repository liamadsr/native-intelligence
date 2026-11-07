// ─── Appliable-combo registry (client-safe) ─────────────────────────────────
//
// The single source of truth for "can the apply engine execute this
// change_type:entity_type combo". It lives in its own module — with ZERO server
// imports — so both sides can use it without dragging server-only code across the
// boundary:
//
//   • apply-engine.ts (server) dispatches on these exact keys and re-exports
//     canApplyChange, so the runtime dispatch and this list can never disagree.
//   • derive-ui.ts (imported by 'use client' cards) calls canApplyChange to hide
//     the one-click Accept for an unhandled combo. Routing that through
//     apply-engine would pull the MCP SDK + crypto into the client bundle; a
//     plain data module keeps the card layer clean.
//   • live-agent/tools.ts (propose_change) calls normalizeProposedChange at
//     STAGING time so a row is written in its appliable form, and rejects a combo
//     that still has no handler so the model re-proposes instead of staging a
//     card that can only be dismissed.
//
// When you add a handler in apply-engine.ts, add its key here (a test asserts the
// runtime handler map and this set stay in lockstep).

/**
 * Combos the apply engine has a direct handler for. Mirrors the `handlers` map
 * keys in apply-engine.ts — kept in sync by apply-engine's own module (it asserts
 * against this set at load-adjacent test time) so this is the one list to edit.
 */
export const HANDLED_COMBOS: ReadonlySet<string> = new Set([
  'create:action',
  'create:decision',
  'create:contact',
  'create:milestone',
  'update:project',
  'update:action',
  'update:decision',
  'update:contact',
  'update:milestone',
  'assign:action',
  'delete:action',
  'delete:milestone',
  'send_email:action',
  'send_email:contact',
  'send_email:external',
  'mcp_call:external',
])

/** The minimal shape every normalization/appliability check reads. */
export interface ComboFacts {
  change_type?: string | null
  entity_type?: string | null
  /** Omit or null when the proposal names no existing entity. */
  entity_id?: string | null
}

export interface NormalizedCombo {
  change_type: string
  entity_type: string
  /** True when the combo was rewritten; callers persist the new pair. */
  changed: boolean
}

/**
 * Rewrites a structurally-impossible proposal into the combo that satisfies the
 * same intent. Pure and client-safe; the ONE place the rules live, used by the
 * apply engine (dispatch), propose_change (staging), and the card layer
 * (appliability).
 *
 *   • Target-less `assign` (any entity_type) → `create:action`. The extractor
 *     reaches for "assign" whenever a person is involved — "assign this to X",
 *     or a follow-up ABOUT a contact ("connect with Nikhil's son"), which it has
 *     labelled assign:contact in prod. With no entity_id there is nothing to
 *     re-point; the proposal already carries title/assignee/priority — a task —
 *     so creating the action assigned to that person satisfies the intent.
 *   • Target-less `update:decision` → `create:decision`. A confirmed/refined
 *     decision with no decision UUID is a decision worth recording.
 *
 * A proposal WITH an entity_id is left alone: it names a real row, so the
 * handler for its own combo (or the lack of one) is the truth.
 */
export function normalizeProposedChange(facts: ComboFacts): NormalizedCombo {
  const changeType = facts.change_type ?? ''
  const entityType = facts.entity_type ?? ''
  const targetless = !facts.entity_id

  if (changeType === 'assign' && targetless) {
    return { change_type: 'create', entity_type: 'action', changed: true }
  }
  if (changeType === 'update' && entityType === 'decision' && targetless) {
    return { change_type: 'create', entity_type: 'decision', changed: true }
  }
  return { change_type: changeType, entity_type: entityType, changed: false }
}

/**
 * True when applyChange() can execute this proposal — its combo has a handler
 * directly, or normalizeProposedChange rewrites it into one — rather than
 * dead-ending on "Unsupported change". The card-rendering layer uses this to
 * avoid offering a one-click Accept that could only fail; the drift test uses it
 * to assert every combo the extractor can propose is covered.
 *
 * Structural (reads change_type/entity_type/entity_id) so it works on a
 * ProposedChange row, an attention-card payload, or a synthesized candidate.
 * Pass entity_id when you have it: a TARGETED assign:contact (names a real
 * contact row) has no handler and stays unsupported, while the target-less form
 * normalizes to create:action and is appliable.
 */
export function canApplyChange(change: ComboFacts): boolean {
  if (HANDLED_COMBOS.has(`${change.change_type}:${change.entity_type}`)) return true
  const normalized = normalizeProposedChange(change)
  return normalized.changed && HANDLED_COMBOS.has(`${normalized.change_type}:${normalized.entity_type}`)
}
