/**
 * Registration invariants for the 'sequence' views entity.
 *
 * The exhaustive Record<ViewEntityType, …> maps already force compile-time
 * coverage; these tests pin the CONTENT that the compiler can't check —
 * status options in lockstep with migration 227's CHECK constraint, board
 * grouping wired to a filterable field, defaults referencing real display
 * properties, the read-only contract (no inline pickers on sequence rows),
 * and search hitting `name` like the other name-titled entities.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_BOARD_GROUP_BY,
  DEFAULT_DISPLAY_PROPERTIES,
  defaultDisplayProperties,
  DISPLAY_PROPERTIES,
  FIELD_CATEGORIES,
  FILTERABLE_FIELDS,
} from '@/lib/views/types'
import {
  applySearch,
  SEQUENCE_ALLOWED_TRANSITIONS,
  SEQUENCE_STATUS_LABELS,
  SEQUENCE_STATUS_ORDER,
} from '@/lib/views/query-engine'
import { ENTITY_ENDPOINTS } from '@/lib/views/entity-endpoints'
import type { SequenceStatus } from '@/lib/sequences/types'

// The canonical lifecycle, in board-column order. Typed against the engine's
// SequenceStatus union so a drifted enum fails to compile here.
const STATUSES: SequenceStatus[] = ['draft', 'active', 'paused', 'archived']

describe('sequence views registration', () => {
  it('status filter options match the sequence status enum (migration 227)', () => {
    const statusField = FILTERABLE_FIELDS.sequence.find((f) => f.field === 'status')
    expect(statusField?.type).toBe('enum')
    expect(statusField?.options).toEqual(STATUSES)
  })

  it('board group-by is the status field, and it is filterable', () => {
    expect(DEFAULT_BOARD_GROUP_BY.sequence).toBe('status')
    expect(FILTERABLE_FIELDS.sequence.some((f) => f.field === 'status')).toBe(true)
  })

  it('board column injection covers every status, in lifecycle order', () => {
    expect(Object.keys(SEQUENCE_STATUS_ORDER)).toEqual(STATUSES)
    const sorted = [...STATUSES].sort(
      (a, b) => SEQUENCE_STATUS_ORDER[a] - SEQUENCE_STATUS_ORDER[b],
    )
    expect(sorted).toEqual(STATUSES)
    for (const status of STATUSES) {
      expect(SEQUENCE_STATUS_LABELS[status]).toBeTruthy()
    }
  })

  it('default display properties all exist in DISPLAY_PROPERTIES', () => {
    const declared = new Set(DISPLAY_PROPERTIES.sequence.map((d) => d.field))
    for (const field of DEFAULT_DISPLAY_PROPERTIES.sequence) {
      expect(declared.has(field)).toBe(true)
    }
  })

  it('no sequence display property is inline-editable (lifecycle + derived counts)', () => {
    // Status transitions carry semantics (resume recomputes schedules, archive
    // exits enrollments) and the count cells are derived — a generic picker
    // must never appear on a sequence row.
    for (const d of DISPLAY_PROPERTIES.sequence) {
      expect(d.editable).toBeUndefined()
    }
  })

  it('declares no Creator filter — created_by is auth.users-backed, the member picker is not', () => {
    // sequence.created_by (migration 227) references auth.users(id), while the
    // shared 'member'-typed filter picker emits member.id — a disjoint UUID
    // space — so a Creator filter would silently match zero rows for every
    // possible selection. Same deliberate omission as the flow entity. If this
    // fails, someone re-added the filter: it needs member→user_id translation
    // in the query route before it can work.
    expect(FILTERABLE_FIELDS.sequence.some((f) => f.field === 'created_by')).toBe(false)
    for (const category of FIELD_CATEGORIES.sequence) {
      expect(category.fields).not.toContain('created_by')
    }
  })

  it('board drag transitions mirror the PATCH route lifecycle rules', () => {
    // Keys cover the whole lifecycle — a new status must declare its moves.
    expect(Object.keys(SEQUENCE_ALLOWED_TRANSITIONS).sort()).toEqual([...STATUSES].sort())
    // draft→active is rejected: arming happens via Review & Launch (/launch),
    // never via a bare status PATCH — dragging the card must not attempt it.
    expect(SEQUENCE_ALLOWED_TRANSITIONS.draft).not.toContain('active')
    expect(SEQUENCE_ALLOWED_TRANSITIONS.draft).toEqual(['archived'])
    // Only active can pause; only paused can resume; anything can archive.
    expect(SEQUENCE_ALLOWED_TRANSITIONS.active).toEqual(['paused', 'archived'])
    expect(SEQUENCE_ALLOWED_TRANSITIONS.paused).toEqual(['active', 'archived'])
    // Archived is terminal.
    expect(SEQUENCE_ALLOWED_TRANSITIONS.archived).toEqual([])
  })

  it('the contact scope field stays hidden from the filter picker', () => {
    // enrolled_contact_id is an internal scope the contact panel embed sends
    // as a fixed filter (query-engine resolves it via sequence_enrollment).
    // The sibling embeds' scoping fields (`id` on captures) are not offered in
    // the picker either — declaring it here would surface it to users.
    expect(FILTERABLE_FIELDS.sequence.some((f) => f.field === 'enrolled_contact_id')).toBe(false)
    for (const category of FIELD_CATEGORIES.sequence) {
      expect(category.fields).not.toContain('enrolled_contact_id')
    }
  })

  it('the enrollment display property is scope-only, read-only, and kept out of global defaults', () => {
    // Rendered from `contact_enrollment`, which the views/query route merges
    // ONLY when the enrolled_contact_id scope is active. On the global list
    // the key is absent and the cell can never render, so the property must
    // be neither default-on nor offered in the picker there — `scopeOnly`
    // gates both. The scoped contact-panel embed gets it prepended (leftmost)
    // via defaultDisplayProperties.
    const enrollment = DISPLAY_PROPERTIES.sequence.find((d) => d.field === 'enrollment')
    expect(enrollment).toBeDefined()
    expect(enrollment?.editable).toBeUndefined()
    expect(enrollment?.scopeOnly).toBe('enrolled_contact_id')
    expect(DEFAULT_DISPLAY_PROPERTIES.sequence).not.toContain('enrollment')
    // Unscoped instances (and instances scoped by some other field) stay clean.
    expect(defaultDisplayProperties('sequence')).toEqual(DEFAULT_DISPLAY_PROPERTIES.sequence)
    expect(defaultDisplayProperties('sequence', new Set(['project_id']))).toEqual(
      DEFAULT_DISPLAY_PROPERTIES.sequence,
    )
    // The contact-scoped embed opts in, leftmost (rarest → left).
    expect(defaultDisplayProperties('sequence', new Set(['enrolled_contact_id']))).toEqual([
      'enrollment',
      ...DEFAULT_DISPLAY_PROPERTIES.sequence,
    ])
  })

  it('every categorized filter field is a declared filterable field', () => {
    const filterable = new Set(FILTERABLE_FIELDS.sequence.map((f) => f.field))
    for (const category of FIELD_CATEGORIES.sequence) {
      for (const field of category.fields) {
        expect(filterable.has(field)).toBe(true)
      }
    }
  })

  it('single-record endpoint targets the sequences API', () => {
    expect(ENTITY_ENDPOINTS.sequence('abc')).toBe('/api/account/sequences/abc')
  })

  it('search applies ilike on name', () => {
    const q = { or: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis() }
    applySearch(q as never, 'sequence', 'outreach')
    expect(q.ilike).toHaveBeenCalledWith('name', '%outreach%')
    expect(q.or).not.toHaveBeenCalled()
  })
})
