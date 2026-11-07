import { describe, expect, it } from 'vitest'
import { normalizeShowInput, parseRelativeDate } from '../validate'

describe('normalizeShowInput', () => {
  it('refuses a field the entity does not have, naming the valid ones', () => {
    const r = normalizeShowInput({ kind: 'list', title: 'Due', entity_type: 'action', filters: [{ field: 'due_date', operator: 'is', value: '2026-10-08' }] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("filters[0]: 'due_date' is not a field of action")
    expect(r.error).toContain('due_at')
    expect(r.error).toContain('assignee_id')
  })

  it('refuses an operator the field type does not take, listing the ones it does', () => {
    const r = normalizeShowInput({ kind: 'list', title: 'x', entity_type: 'action', filters: [{ field: 'priority', operator: 'contains', value: 'high' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Use one of: is, is_not, is_any_of, is_none_of/)
  })

  it('refuses an option value, listing the options', () => {
    const r = normalizeShowInput({ kind: 'list', title: 'x', entity_type: 'action', filters: [{ field: 'priority', operator: 'is', value: 'p1' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('urgent, high, medium, low, none')
  })

  it('fixes the obvious slips: me, a single value for a list, an option in the wrong case, board as a kind', () => {
    const r = normalizeShowInput({
      kind: 'board',
      title: '  Mine   this week ',
      entity_type: 'action',
      filters: [
        { field: 'assignee_id', operator: 'is', value: 'me' },
        { field: 'priority', operator: 'is_any_of', value: 'HIGH' },
        { field: 'due_at', operator: 'is_relative', value: 'this week' },
      ],
    })
    expect(r).toEqual({
      ok: true,
      value: {
        kind: 'list',
        title: 'Mine this week',
        entity_type: 'action',
        layout: 'board',
        filters: [
          { field: 'assignee_id', operator: 'is', value: '@me' },
          { field: 'priority', operator: 'is_any_of', value: ['high'] },
          { field: 'due_at', operator: 'is_relative', value: { unit: 'week', direction: 'this' } },
        ],
      },
    })
  })

  it('checks sort, grouping and columns against what the page offers', () => {
    expect(normalizeShowInput({ kind: 'list', title: 'x', entity_type: 'action', ordering: [{ field: 'labels' }] }).ok).toBe(false)
    expect(normalizeShowInput({ kind: 'list', title: 'x', entity_type: 'action', grouping: { field: 'title' } }).ok).toBe(false)
    const bad = normalizeShowInput({ kind: 'list', title: 'x', entity_type: 'action', columns: ['nope'] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('priority')
    const good = normalizeShowInput({
      kind: 'list',
      title: 'x',
      entity_type: 'action',
      ordering: [{ field: 'due_at', direction: 'asc' }],
      grouping: { field: 'project_id' },
      columns: ['identifier', 'status'],
    })
    expect(good.ok && good.value).toMatchObject({ ordering: [{ field: 'due_at', direction: 'asc' }], grouping: { field: 'project_id', direction: 'asc' }, columns: ['identifier', 'status'] })
  })

  it('takes a record by type and id, and refuses a missing title or an unknown kind', () => {
    expect(normalizeShowInput({ kind: 'record', title: 'GEN-42', record: { type: 'action', id: 'GEN-42' } })).toEqual({
      ok: true,
      value: { kind: 'record', title: 'GEN-42', record: { type: 'action', id: 'GEN-42' } },
    })
    expect(normalizeShowInput({ kind: 'record', title: '', record: { type: 'action', id: 'x' } }).ok).toBe(false)
    expect(normalizeShowInput({ kind: 'calendar', title: 'x' }).ok).toBe(false)
    expect(normalizeShowInput({ kind: 'list', title: 'x', entity_type: 'email_thread' }).ok).toBe(false)
  })

  it('asks for ISO dates on a date field, pointing at is_relative', () => {
    const r = normalizeShowInput({ kind: 'list', title: 'x', entity_type: 'action', filters: [{ field: 'due_at', operator: 'lt', value: 'tomorrow' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('is_relative')
  })
})

describe('value caps', () => {
  it('refuses more than 50 values in one list filter, naming the fix', () => {
    const r = normalizeShowInput({ kind: 'list', title: 'x', entity_type: 'action', filters: [{ field: 'priority', operator: 'is_any_of', value: Array(51).fill('high') }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('at most 50 values')
  })
})

describe('parseRelativeDate', () => {
  it('reads the spellings a model uses', () => {
    expect(parseRelativeDate('next 7 days')).toEqual({ unit: 'day', direction: 'future', count: 7 })
    expect(parseRelativeDate('last_month')).toEqual({ unit: 'month', direction: 'past' })
    expect(parseRelativeDate('today')).toEqual({ unit: 'day', direction: 'this' })
    expect(parseRelativeDate({ unit: 'week', direction: 'past', count: 2 })).toEqual({ unit: 'week', direction: 'past', count: 2 })
    expect(parseRelativeDate('soonish')).toBeNull()
  })
})
