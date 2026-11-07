import { describe, it, expect } from 'vitest'
import {
  deriveButtonLabel,
  deriveEntityChips,
  derivePendingReason,
  isTargetlessUpdate,
  isUnsupportedChange,
} from '../derive-ui'
import type { ProposedChange } from '../types'
import type { TrustPolicy } from '../trust-policy'

// A full trust policy (One Accept Authority). Decisions/milestones require_explicit
// by default (D2) — the copy honors it. Actions carry explicitness through the
// ownership path, so require_explicit stays false for them.
const POLICY: TrustPolicy = {
  enabled: true,
  actions: { enabled: true, min_confidence: 0.8, require_explicit: false },
  decisions: { enabled: true, min_confidence: 0.85, require_explicit: true },
  milestones: { enabled: true, min_confidence: 0.85, require_explicit: true },
  claims: { enabled: true, min_confidence: 0.85, require_explicit: false },
  allow_external: false,
}
const ME = 'member-me'

function makeChange(overrides: Partial<ProposedChange>): ProposedChange {
  return {
    id: 'test-id',
    workspace_id: 'ws-1',
    capture_id: 'cap-1',
    change_type: 'create',
    entity_type: 'action',
    entity_id: null,
    display_text: 'Test change',
    title: null,
    description: null,
    priority: null,
    due_date: null,
    status_from: null,
    status_to: null,
    assignee_name: null,
    assignee_member_id: null,
    assignee_contact_id: null,
    team_id: null,
    project_id: null,
    labels: null,
    email_to_name: null,
    email_to_address: null,
    email_subject: null,
    email_context: null,
    extra: null,
    anchor_text: null,
    sort_order: 0,
    confidence: 0.9,
    trigger_quote: null,
    reasoning: null,
    stakes: null,
    open_questions: null,
    status: 'pending',
    applied_at: null,
    applied_by: null,
    result_entity_id: null,
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('deriveButtonLabel', () => {
  describe('create:action', () => {
    it('returns "Create task" when no assignee is present', () => {
      const change = makeChange({ change_type: 'create', entity_type: 'action' })
      expect(deriveButtonLabel(change)).toBe('Create task')
    })

    it('returns "Assign to [first name]" when assignee is set', () => {
      const change = makeChange({
        change_type: 'create',
        entity_type: 'action',
        assignee_name: 'Jane Doe',
      })
      expect(deriveButtonLabel(change)).toBe('Assign to Jane')
    })

    it('returns "Assign to [first name]" with single-word assignee name', () => {
      const change = makeChange({
        change_type: 'create',
        entity_type: 'action',
        assignee_name: 'Alice',
      })
      expect(deriveButtonLabel(change)).toBe('Assign to Alice')
    })
  })

  describe('assign:action', () => {
    it('returns "Reassign to [first name]" when assignee is set', () => {
      const change = makeChange({
        change_type: 'assign',
        entity_type: 'action',
        entity_id: 'action-uuid',
        assignee_name: 'Bob Smith',
      })
      expect(deriveButtonLabel(change)).toBe('Reassign to Bob')
    })

    it('returns "Reassign" when no assignee name is present', () => {
      const change = makeChange({
        change_type: 'assign',
        entity_type: 'action',
        entity_id: 'action-uuid',
      })
      expect(deriveButtonLabel(change)).toBe('Reassign')
    })

    it('labels a TARGET-LESS assign as the create it will apply as', () => {
      // No entity_id → the engine creates the action; say so rather than
      // promising a "Reassign" of a row that does not exist.
      expect(
        deriveButtonLabel(
          makeChange({ change_type: 'assign', entity_type: 'action', entity_id: null, assignee_name: 'Bob Smith' }),
        ),
      ).toBe('Assign to Bob')
      // The prod card: assign:contact with no target → create:action.
      expect(
        deriveButtonLabel(
          makeChange({ change_type: 'assign', entity_type: 'contact', entity_id: null, assignee_name: 'Liam Alizadeh' }),
        ),
      ).toBe('Assign to Liam')
      expect(
        deriveButtonLabel(makeChange({ change_type: 'assign', entity_type: 'contact', entity_id: null })),
      ).toBe('Create task')
    })
  })

  describe('update:action', () => {
    // These exercise status-derived labels for a TARGETED update (entity_id set);
    // a target-less update takes the "Choose target" path (W-4b, covered below).
    it('returns "Mark done" when status_to is "completed"', () => {
      const change = makeChange({ change_type: 'update', entity_type: 'action', entity_id: 'act-1', status_to: 'completed' })
      expect(deriveButtonLabel(change)).toBe('Mark done')
    })

    it('returns "Mark done" when status_to is "done"', () => {
      const change = makeChange({ change_type: 'update', entity_type: 'action', entity_id: 'act-1', status_to: 'done' })
      expect(deriveButtonLabel(change)).toBe('Mark done')
    })

    it('returns "Mark [status]" for other statuses', () => {
      const change = makeChange({ change_type: 'update', entity_type: 'action', entity_id: 'act-1', status_to: 'in_progress' })
      expect(deriveButtonLabel(change)).toBe('Mark in_progress')
    })

    it('returns "Update" when no status_to', () => {
      const change = makeChange({ change_type: 'update', entity_type: 'action', entity_id: 'act-1' })
      expect(deriveButtonLabel(change)).toBe('Update')
    })
  })

  describe('create:decision', () => {
    it('returns "Record decision"', () => {
      const change = makeChange({ change_type: 'create', entity_type: 'decision' })
      expect(deriveButtonLabel(change)).toBe('Record decision')
    })
  })

  describe('delete:action', () => {
    it('returns "Remove"', () => {
      const change = makeChange({ change_type: 'delete', entity_type: 'action' })
      expect(deriveButtonLabel(change)).toBe('Remove')
    })
  })
})

describe('deriveEntityChips', () => {
  it('returns empty array when no chips are present', () => {
    const change = makeChange({})
    expect(deriveEntityChips(change)).toEqual([])
  })

  it('returns a member chip when assignee_member_id and assignee_name are set', () => {
    const change = makeChange({
      assignee_member_id: 'member-1',
      assignee_name: 'Alice Johnson',
    })
    const chips = deriveEntityChips(change)
    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({ type: 'member', label: 'Alice Johnson', id: 'member-1' })
  })

  it('returns a contact chip when assignee_contact_id is set', () => {
    const change = makeChange({
      assignee_contact_id: 'contact-1',
      assignee_name: 'Bob External',
    })
    const chips = deriveEntityChips(change)
    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({ type: 'contact', label: 'Bob External', id: 'contact-1' })
  })

  it('returns a person_text chip when only assignee_name is set', () => {
    const change = makeChange({ assignee_name: 'Charlie Unknown' })
    const chips = deriveEntityChips(change)
    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({ type: 'person_text', label: 'Charlie Unknown' })
  })

  it('returns a date chip when due_date is set', () => {
    const change = makeChange({ due_date: '2026-06-01' })
    const chips = deriveEntityChips(change)
    const dateChip = chips.find((c) => c.type === 'date')
    expect(dateChip).toBeDefined()
    expect(dateChip?.value).toBe('2026-06-01')
  })
})

describe('derivePendingReason', () => {
  it('returns null for a non-pending change', () => {
    const change = makeChange({ status: 'applied', confidence: 0.95 })
    expect(derivePendingReason(change, POLICY, ME)).toBeNull()
  })

  it('returns null when policy is not loaded', () => {
    const change = makeChange({ status: 'pending' })
    expect(derivePendingReason(change, null, ME)).toBeNull()
  })

  it('flags auto_accept_off when the master switch is off (before any other gate)', () => {
    const change = makeChange({ confidence: 0.99, assignee_member_id: ME })
    const r = derivePendingReason(change, { ...POLICY, enabled: false }, ME)
    expect(r?.code).toBe('auto_accept_off')
  })

  it('flags external for a send_email proposal when allow_external is off', () => {
    const change = makeChange({ change_type: 'send_email', confidence: 0.99 })
    expect(derivePendingReason(change, POLICY, ME)?.code).toBe('external')
  })

  it('does NOT flag external for send_email when allow_external is on (falls through to other gates)', () => {
    const change = makeChange({ change_type: 'send_email', entity_type: 'action', confidence: 0.99, assignee_member_id: ME })
    const r = derivePendingReason(change, { ...POLICY, allow_external: true }, ME)
    expect(r?.code).not.toBe('external')
  })

  it('flags below_threshold when confidence is under the per-kind bar', () => {
    const change = makeChange({ confidence: 0.5, assignee_member_id: ME })
    const r = derivePendingReason(change, POLICY, ME)
    expect(r?.code).toBe('below_threshold')
    expect(r?.detail).toContain('50%')
    expect(r?.detail).toContain('80%')
  })

  it('uses the decisions threshold for a decision', () => {
    const change = makeChange({ entity_type: 'decision', confidence: 0.82 })
    // 0.82 < 0.85 decisions threshold → below; (decisions are not assignable, so
    // if it cleared the bar it would auto-accept)
    expect(derivePendingReason(change, POLICY, ME)?.code).toBe('below_threshold')
  })

  it('flags inferred for a high-confidence decision the model did NOT mark explicitly stated (D2)', () => {
    // Clears 0.85 but require_explicit is on and the item wasn't explicitly stated.
    const change = makeChange({ entity_type: 'decision', confidence: 0.9, extra: null })
    expect(derivePendingReason(change, POLICY, ME)?.code).toBe('inferred')
  })

  it('returns null for an EXPLICITLY-STATED decision that clears its threshold (would auto-accept)', () => {
    const change = makeChange({
      entity_type: 'decision',
      confidence: 0.9,
      extra: { is_explicitly_stated: true },
    })
    expect(derivePendingReason(change, POLICY, ME)).toBeNull()
  })

  it('uses the MILESTONES class rule (its own threshold + explicitness), not the actions bucket', () => {
    // A milestone at 0.82 is below the 0.85 milestones threshold — previously
    // milestones were collapsed into the 0.8 actions bar and this would have
    // passed. Full trust semantics gives milestones their own rule.
    const change = makeChange({ entity_type: 'milestone', confidence: 0.82 })
    expect(derivePendingReason(change, POLICY, ME)?.code).toBe('below_threshold')
  })

  it('flags inferred for a high-confidence milestone not explicitly stated (D2)', () => {
    const change = makeChange({ entity_type: 'milestone', confidence: 0.95, extra: null })
    expect(derivePendingReason(change, POLICY, ME)?.code).toBe('inferred')
  })

  it('flags class_disabled when the entity class auto-apply is turned off', () => {
    const change = makeChange({ entity_type: 'decision', confidence: 0.99, extra: { is_explicitly_stated: true } })
    const policy: TrustPolicy = {
      ...POLICY,
      decisions: { ...POLICY.decisions, enabled: false },
    }
    expect(derivePendingReason(change, policy, ME)?.code).toBe('class_disabled')
  })

  it('returns null for an unmapped entity class the gate does not judge (project)', () => {
    // A project create is not gate-judged, so there is nothing to explain.
    const change = makeChange({ entity_type: 'project', confidence: 0.99 })
    expect(derivePendingReason(change, POLICY, ME)).toBeNull()
  })

  it('flags not_mine for an action assigned to a non-member (assignee_member_id null)', () => {
    const change = makeChange({ confidence: 0.95, assignee_name: 'Aman', assignee_member_id: null })
    const r = derivePendingReason(change, POLICY, ME)
    expect(r?.code).toBe('not_mine')
    expect(r?.detail).toContain('Aman')
    expect(r?.detail).toContain("isn't in your workspace")
  })

  it('flags not_mine for an action assigned to another member', () => {
    const change = makeChange({ confidence: 0.95, assignee_name: 'Priya', assignee_member_id: 'member-priya' })
    const r = derivePendingReason(change, POLICY, ME)
    expect(r?.code).toBe('not_mine')
    expect(r?.detail).toContain('Priya')
  })

  it('returns null for MY own high-confidence action (it would auto-accept)', () => {
    const change = makeChange({ confidence: 0.95, assignee_name: 'Me', assignee_member_id: ME })
    expect(derivePendingReason(change, POLICY, ME)).toBeNull()
  })

  it('flags no_confidence when the model did not score the item', () => {
    const change = makeChange({ confidence: null as unknown as number, assignee_member_id: ME })
    expect(derivePendingReason(change, POLICY, ME)?.code).toBe('no_confidence')
  })
})

describe('isTargetlessUpdate (W-4b)', () => {
  it('is true for an action update with no entity_id', () => {
    expect(
      isTargetlessUpdate({ change_type: 'update', entity_type: 'action', entity_id: null }),
    ).toBe(true)
  })

  it('is false for an action update WITH a resolved entity_id', () => {
    expect(
      isTargetlessUpdate({ change_type: 'update', entity_type: 'action', entity_id: 'act-1' }),
    ).toBe(false)
  })

  it('is false for a create (never targets an existing entity)', () => {
    expect(
      isTargetlessUpdate({ change_type: 'create', entity_type: 'action', entity_id: null }),
    ).toBe(false)
  })

  it('is false for a non-action update (project/milestone carry their own id path)', () => {
    expect(
      isTargetlessUpdate({ change_type: 'update', entity_type: 'project', entity_id: null }),
    ).toBe(false)
  })

  it('classifies a real ProposedChange row', () => {
    const targetless = makeChange({ change_type: 'update', entity_type: 'action', entity_id: null })
    const targeted = makeChange({ change_type: 'update', entity_type: 'action', entity_id: 'act-9' })
    expect(isTargetlessUpdate(targetless)).toBe(true)
    expect(isTargetlessUpdate(targeted)).toBe(false)
  })
})

describe('deriveButtonLabel — target-less update (W-4b)', () => {
  it('labels a target-less action update "Choose target" instead of "Update"', () => {
    const change = makeChange({ change_type: 'update', entity_type: 'action', entity_id: null })
    expect(deriveButtonLabel(change)).toBe('Choose target')
  })

  it('labels a targeted action update "Update"', () => {
    const change = makeChange({ change_type: 'update', entity_type: 'action', entity_id: 'act-1' })
    expect(deriveButtonLabel(change)).toBe('Update')
  })
})

describe('isUnsupportedChange (drift guard)', () => {
  it('is false for every combo the apply engine handles', () => {
    // The four formerly-dead combos are now appliable — none must read unsupported.
    expect(isUnsupportedChange({ change_type: 'update', entity_type: 'decision' })).toBe(false)
    expect(isUnsupportedChange({ change_type: 'create', entity_type: 'contact' })).toBe(false)
    expect(isUnsupportedChange({ change_type: 'update', entity_type: 'contact' })).toBe(false)
    expect(isUnsupportedChange({ change_type: 'delete', entity_type: 'milestone' })).toBe(false)
    // A representative already-supported combo, for good measure.
    expect(isUnsupportedChange({ change_type: 'create', entity_type: 'action' })).toBe(false)
  })

  it('is false for a target-less assign of any entity (normalizes to create:action)', () => {
    // The prod card: "Connect with Nikhil's son" staged as assign:contact with no
    // entity_id. It is a task; the engine applies it as create:action.
    expect(isUnsupportedChange({ change_type: 'assign', entity_type: 'contact', entity_id: null })).toBe(false)
    expect(isUnsupportedChange({ change_type: 'assign', entity_type: 'project' })).toBe(false)
  })

  it('is true for a TARGETED assign of a non-action entity (no handler to re-point it)', () => {
    expect(isUnsupportedChange({ change_type: 'assign', entity_type: 'contact', entity_id: 'c-1' })).toBe(true)
  })

  it('is true for a proposable-but-unhandled combo (future drift)', () => {
    // No handler for create:initiative yet — the card must render disabled.
    expect(isUnsupportedChange({ change_type: 'create', entity_type: 'initiative' })).toBe(true)
  })

  it('deriveButtonLabel names the unsupported type on a disabled card', () => {
    const change = makeChange({ change_type: 'create', entity_type: 'initiative' })
    expect(deriveButtonLabel(change)).toBe('Unsupported: create initiative')
  })
})

describe('deriveEntityChips due date', () => {
  it('shows a date-only due date on its own day west of UTC', () => {
    const prevTz = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const chips = deriveEntityChips(makeChange({ due_date: '2026-03-05' }))
      expect(chips.find((c) => c.type === 'date')?.label).toBe('Mar 5')
    } finally {
      // Assigning undefined would set the string "undefined".
      if (prevTz === undefined) delete process.env.TZ
      else process.env.TZ = prevTz
    }
  })
})
