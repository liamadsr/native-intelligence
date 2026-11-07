import { parseISO } from 'date-fns'
import type { ProposedChange } from './types'
import type { TrustPolicy, TrustEntity } from './trust-policy'
import { canApplyChange, normalizeProposedChange } from './appliable-combos'

// ─── Pending-reason derivation ───────────────────────────────
//
// A high-confidence proposal can sit "pending" for several non-obvious reasons,
// and the UI otherwise gives no hint why it wasn't auto-accepted. This mirrors
// the EXACT skip logic in the live-agent auto-apply loop
// (src/app/api/ai/live-agent/route.ts ~496-512) so the explanation we show is
// guaranteed to match why the item really stayed pending.

export type PendingReasonCode =
  | 'auto_accept_off'   // the workspace master toggle is off
  | 'class_disabled'    // this entity class's auto-apply is turned off
  | 'not_mine'          // an action assigned to someone who isn't you (or unresolved)
  | 'below_threshold'   // confidence didn't clear the per-kind threshold
  | 'inferred'          // a decision/milestone the model inferred (not explicitly stated)
  | 'external'          // an external side-effect that always waits for a click
  | 'no_confidence'     // the model didn't score it, so it can't auto-accept

export interface PendingReason {
  code: PendingReasonCode
  /** Short label for a chip/badge, e.g. "Not yours". */
  label: string
  /** Full sentence for a tooltip. */
  detail: string
}

/** The human name of an entity class for the pending-reason copy. */
function bucketNoun(bucket: TrustEntity): string {
  if (bucket === 'decisions') return 'decisions'
  if (bucket === 'milestones') return 'milestones'
  return 'action items'
}

/**
 * Map an entity_type to its trust-policy rule bucket, or null if the gate does
 * not judge it (everything unmapped stays pending with no "why" to surface —
 * projects, initiatives, contacts). Mirrors the gate's entityBucket so the copy
 * matches which class rule actually applied.
 */
function pendingBucket(entityType: string): TrustEntity | null {
  if (entityType === 'action') return 'actions'
  if (entityType === 'decision') return 'decisions'
  if (entityType === 'milestone') return 'milestones'
  return null
}

/**
 * Explain why a PENDING proposal was not auto-accepted, given the workspace TRUST
 * policy (One Accept Authority — the ONE source) and the current user. Returns
 * null when there is nothing to explain — the item isn't pending, it's an entity
 * class the gate doesn't judge, or it WOULD have auto-accepted and is only pending
 * for a reason we don't surface. The checks run in the same order as the shared
 * gate (auto-apply-gate.ts) so the first failing gate is the one reported — now
 * with FULL trust-policy semantics: per-class enable flags, the milestones class
 * (previously collapsed into actions), and the D2 require_explicit rule for
 * decisions/milestones.
 *
 * `currentMemberId` is the viewer's member id (to evaluate the mine-only rule).
 */
export function derivePendingReason(
  change: ProposedChange,
  policy: TrustPolicy | null | undefined,
  currentMemberId: string | null | undefined,
): PendingReason | null {
  // Only pending items have a "why didn't this auto-accept" story.
  if (change.status !== 'pending') return null
  // No policy known (not loaded yet) — say nothing rather than guess.
  if (!policy) return null

  const key = `${change.change_type}:${change.entity_type}`

  // 1) Master kill-switch off → everything waits for review.
  if (!policy.enabled) {
    return {
      code: 'auto_accept_off',
      label: 'Review',
      detail: 'Auto-accept is off, so every suggestion waits for your review.',
    }
  }

  // 2) External side effects never auto-fire unless explicitly allowed.
  const isExternal =
    change.change_type === 'send_email' ||
    change.change_type === 'mcp_call' ||
    change.entity_type === 'external'
  if (isExternal && !policy.allow_external) {
    return {
      code: 'external',
      label: 'Needs a click',
      detail: 'This acts outside Dial8 (sends an email or hits an external tool), so it always waits for an explicit click — even at high confidence.',
    }
  }

  // The entity class this proposal falls under (actions / decisions / milestones).
  // An unmapped class (project / initiative / contact) is not gate-judged, so
  // there's nothing to explain — leave it silent.
  const bucket = pendingBucket(change.entity_type)
  if (!bucket) return null
  const rule = policy[bucket]

  // 3) Per-class enable flag off → this class waits regardless of threshold.
  if (!rule.enabled) {
    return {
      code: 'class_disabled',
      label: 'Review',
      detail: `Auto-accept for ${bucketNoun(bucket)} is turned off, so this waits for your review.`,
    }
  }

  // 4) Confidence gate — per the CLASS's own threshold (actions/decisions/
  // milestones each have their own now, not a decisions-vs-everything-else split).
  const conf = typeof change.confidence === 'number' && !Number.isNaN(change.confidence)
    ? change.confidence
    : null
  if (conf === null) {
    return {
      code: 'no_confidence',
      label: 'Review',
      detail: "The AI didn't put a confidence score on this, so it can't auto-accept — it's here for you to confirm.",
    }
  }
  if (conf < rule.min_confidence) {
    const pct = Math.round(conf * 100)
    const need = Math.round(rule.min_confidence * 100)
    return {
      code: 'below_threshold',
      label: 'Below threshold',
      detail: `Confidence ${pct}% is below the ${need}% auto-accept threshold for ${bucketNoun(bucket)}, so it waits for review.`,
    }
  }

  // 5) D2 explicitness rule (decisions/milestones): a class that requires the
  // item be explicitly stated won't auto-apply an INFERRED one. Actions carry
  // their explicitness through the ownership path (below), not this flag, so
  // require_explicit is false for them and this branch never fires.
  if (rule.require_explicit && (bucket === 'decisions' || bucket === 'milestones')) {
    const explicitlyStated =
      (change.extra as Record<string, unknown> | null)?.is_explicitly_stated === true
    if (!explicitlyStated) {
      return {
        code: 'inferred',
        label: 'Inferred',
        detail: `This ${bucket === 'decisions' ? 'decision' : 'milestone'} was inferred from context rather than explicitly stated, so it waits for you to confirm.`,
      }
    }
  }

  // 6) Mine-only rule: assignable items auto-apply only when assigned to ME.
  // Exception: an item assigned to an AGENT isn't "someone else's" — it's work
  // you're delegating to a bot, so the not-yours rule doesn't apply.
  const assignedToAgent = !!(change.extra?.assignee_ai_member_id)
  const isAssignable = key === 'create:action' || key === 'assign:action'
  if (isAssignable && !assignedToAgent && change.assignee_member_id !== currentMemberId) {
    if (!change.assignee_member_id) {
      // The named assignee didn't resolve to a workspace member (e.g. "Aman").
      const who = change.assignee_name ? ` (${change.assignee_name})` : ''
      return {
        code: 'not_mine',
        label: 'Not yours',
        detail: `This is for someone${who} who isn't in your workspace, so it won't auto-add to your board. Review it, reassign it to yourself, or leave it as a tracked suggestion.`,
      }
    }
    return {
      code: 'not_mine',
      label: 'Not yours',
      detail: `Auto-accept only adds YOUR own action items to your board. This one is assigned to ${change.assignee_name || 'someone else'}, so it waits for review.`,
    }
  }

  // Cleared every gate it should have → nothing to explain (it either was
  // auto-accepted, or is a kind we don't auto-apply but also don't flag).
  return null
}

// ─── Target-less update classification (One Accept Authority, W-4b) ──────────
//
// An extraction `update:action` proposal is almost always staged with
// entity_id=null (the model hears the task, never its UUID). propose_change
// resolves most targets at staging time (resolve-action-target.ts), but when the
// fuzzy match is ambiguous or empty the proposal stays TARGET-LESS. Such a
// proposal cannot be applied with one click — its accept dead-ends on
// UPDATE_TARGET_UNRESOLVED (the canonical dud dd1dc8c8). It must NOT render as a
// one-click "Apply update"; it renders as a NEEDS-TARGET variant whose primary
// action opens an action picker (W-4c) before the update can apply.
//
// Structural, not table-shaped: takes the minimal fields so it works on a
// ProposedChange row, an attention-card payload, or a synthesized candidate.

export interface UpdateTargetFacts {
  change_type?: string | null
  entity_type?: string | null
  entity_id?: string | null
}

/**
 * True iff this is an action UPDATE with no resolved target — a card that cannot
 * apply in one click and needs a target chosen first. An update to a NON-action
 * entity (project/milestone) carries its own entity_id path and is out of scope;
 * a create never targets an existing entity.
 */
export function isTargetlessUpdate(facts: UpdateTargetFacts): boolean {
  return (
    facts.change_type === 'update' &&
    facts.entity_type === 'action' &&
    !facts.entity_id
  )
}

// ─── Unsupported-combo detection (systemic drift guard) ──────────────────────
//
// A proposal whose change_type:entity_type combo has no apply-engine handler (and
// no normalization) can only ever dead-end on "Unsupported change: …" at accept
// time — the exact prod outage this file's sibling apply-engine change fixes. Such
// a card must NOT render a one-click Accept; the card layer renders it in the same
// disabled/needs-attention style the needs-target variant uses. With the handlers
// added in apply-engine.ts every combo currently in prod is appliable — this guard
// is for FUTURE drift (someone adds a proposable combo without a handler).
//
// Delegates to canApplyChange (the ONE source of truth in apply-engine.ts) so the
// card layer and the drift test can never disagree about what's appliable.

/** True iff this combo has no handler/normalization — the card can't apply it. */
export function isUnsupportedChange(facts: UpdateTargetFacts): boolean {
  return !canApplyChange(facts)
}

// ─── Button label derivation ─────────────────────────────────

/** Derives the primary action button label from the change data */
export function deriveButtonLabel(change: ProposedChange): string {
  // An unsupported combo has no handler — it can only dead-end on accept. Name
  // the type so the disabled card explains itself instead of promising an action
  // that would fail.
  if (isUnsupportedChange(change)) return `Unsupported: ${change.change_type} ${change.entity_type}`
  // A target-less action update can't apply in one click — the label names the
  // missing step (W-4b) rather than promising an "Update" that would dead-end.
  if (isTargetlessUpdate(change)) return 'Choose target'

  const name = change.assignee_name?.split(' ')[0] // First name for brevity

  // Label what accepting will ACTUALLY do. The apply engine rewrites a
  // target-less assign (any entity) into create:action and a target-less
  // decision update into create:decision — so the button must not promise a
  // "Reassign"/"Update" of a row that does not exist.
  const eff = normalizeProposedChange(change)

  switch (eff.change_type) {
    case 'create':
      switch (eff.entity_type) {
        case 'action':
          return name ? `Assign to ${name}` : 'Create task'
        case 'decision':
          return 'Record decision'
        case 'milestone':
          return 'Create milestone'
        case 'project':
          return 'Create project'
        case 'initiative':
          return 'Create initiative'
        default:
          return 'Create'
      }

    case 'update':
      if (change.status_to === 'completed' || change.status_to === 'done') {
        return 'Mark done'
      }
      if (change.status_to) {
        return `Mark ${change.status_to}`
      }
      return 'Update'

    case 'assign':
      return name ? `Reassign to ${name}` : 'Reassign'

    case 'delete':
      return 'Remove'

    case 'send_email': {
      const emailName = change.email_to_name?.split(' ')[0]
      return emailName ? `Draft email to ${emailName}` : 'Draft email'
    }

    case 'mcp_call': {
      const serverName = (change.extra as { server_name?: string } | null)?.server_name
      return serverName ? `Run in ${serverName}` : 'Run external'
    }

    default:
      return 'Apply'
  }
}

// ─── Entity chips detection ──────────────────────────────────

export interface EntityChip {
  type: 'member' | 'contact' | 'date' | 'project' | 'team' | 'person_text'
  label: string
  id?: string // member_id, contact_id, project_id, etc.
  value?: string // ISO date for date chips
}

/** Derives entity chips that should be highlighted in the display text */
export function deriveEntityChips(change: ProposedChange): EntityChip[] {
  const chips: EntityChip[] = []

  // Assignee
  if (change.assignee_member_id && change.assignee_name) {
    chips.push({
      type: 'member',
      label: change.assignee_name,
      id: change.assignee_member_id,
    })
  } else if (change.assignee_contact_id && change.assignee_name) {
    chips.push({
      type: 'contact',
      label: change.assignee_name,
      id: change.assignee_contact_id,
    })
  } else if (change.assignee_name) {
    chips.push({
      type: 'person_text',
      label: change.assignee_name,
    })
  }

  // Email recipient (if different from assignee)
  if (change.email_to_name && change.email_to_name !== change.assignee_name) {
    chips.push({
      type: 'person_text',
      label: change.email_to_name,
    })
  }

  // Due date
  if (change.due_date) {
    chips.push({
      type: 'date',
      label: formatDate(change.due_date),
      value: change.due_date,
    })
  }

  return chips
}

// ─── Helpers ─────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    // parseISO reads a date-only `YYYY-MM-DD` as local midnight; `new Date`
    // reads it as UTC midnight, which west of UTC shows the day before.
    const date = parseISO(iso)
    if (Number.isNaN(date.getTime())) return iso
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}
