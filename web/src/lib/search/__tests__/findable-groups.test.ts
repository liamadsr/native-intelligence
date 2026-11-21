/**
 * The grouped tabs (docs/plans/mentions-everywhere.md, 3.2): every findable
 * kind names a group, every group is a known one, and the section→group
 * derivation agrees with each kind's own group. A separate file from
 * findable-registry.test.ts so the two can grow without stepping on each other.
 */
import { describe, expect, it } from 'vitest'
import {
  FINDABLE,
  FINDABLE_GROUP,
  FINDABLE_GROUPS,
  FINDABLE_KINDS,
  SECTION_GROUP,
} from '../findable-registry'

describe('findable groups', () => {
  it('gives every kind a group that is one of the known groups', () => {
    for (const kind of FINDABLE_KINDS) {
      expect(FINDABLE_GROUPS, kind).toContain(FINDABLE[kind].group)
      expect(FINDABLE_GROUP[kind], kind).toBe(FINDABLE[kind].group)
    }
  })

  it('maps a section to the same group as its kind', () => {
    for (const kind of FINDABLE_KINDS) {
      expect(SECTION_GROUP[FINDABLE[kind].section], kind).toBe(FINDABLE[kind].group)
    }
  })

  it('places the kinds its plan names together', () => {
    // Work holds the task-shaped kinds; CRM the sales-shaped; Meetings the
    // meeting-shaped. (A deal is a pipeline's row, so it is CRM.)
    expect(FINDABLE.action.group).toBe('work')
    expect(FINDABLE.project.group).toBe('work')
    expect(FINDABLE.initiative.group).toBe('work')
    expect(FINDABLE.company.group).toBe('crm')
    expect(FINDABLE.deal.group).toBe('crm')
    expect(FINDABLE.data_table.group).toBe('crm')
    expect(FINDABLE.data_row.group).toBe('crm')
    expect(FINDABLE.capture.group).toBe('meetings')
    expect(FINDABLE.calendar_event.group).toBe('meetings')
    expect(FINDABLE.decision.group).toBe('meetings')
    expect(FINDABLE.campaign.group).toBe('outreach')
    expect(FINDABLE.contact.group).toBe('people')
    expect(FINDABLE.document.group).toBe('docs')
    expect(FINDABLE.attachment.group).toBe('files')
  })
})
