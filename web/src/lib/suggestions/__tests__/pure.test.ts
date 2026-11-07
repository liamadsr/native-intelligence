import { describe, it, expect } from 'vitest'
import { compareActionDrift, isDriftCheckable, type DriftRow } from '../drift'
import { suggestionFingerprint } from '../fingerprint'
import { DEFAULT_TTL_DAYS, MAX_TTL_DAYS, expiresAtFor } from '../lifecycle'
import { isAlreadyTrue } from '../stage'
import { SUGGESTION_MARKER_RE, suggestionMarker } from '../types'
import type { ActionBase } from '../target'

const BASE: ActionBase = {
  status_id: 's-backlog',
  status: 'Backlog',
  status_category: 'backlog',
  assignee_id: null,
  assignee_contact_id: null,
  due_date: '2026-10-05',
  priority: 'medium',
  project_id: 'p-1',
}

function row(over: Partial<DriftRow> = {}): DriftRow {
  return {
    id: 'pc-1',
    workspace_id: 'ws-1',
    status: 'pending',
    change_type: 'update',
    entity_type: 'action',
    entity_id: 'act-1',
    status_to: 'Todo',
    due_date: '2026-10-09',
    base: BASE as unknown as Record<string, unknown>,
    ...over,
  }
}

describe('compareActionDrift', () => {
  it('nothing moved → none', () => {
    expect(compareActionDrift(row(), BASE)).toEqual({ kind: 'none' })
  })

  it('every proposed value already holds → already_true', () => {
    expect(compareActionDrift(row(), { ...BASE, status: 'todo', due_date: '2026-10-09' })).toEqual({ kind: 'already_true' })
  })

  it('someone else moved a field the suggestion changes → changed, with was/now', () => {
    const d = compareActionDrift(row(), { ...BASE, status: 'In Progress' })
    expect(d).toEqual({ kind: 'changed', fields: [{ field: 'status', was: 'Backlog', now: 'In Progress' }] })
  })

  it('a field the suggestion does not touch moving is not drift', () => {
    expect(compareActionDrift(row(), { ...BASE, priority: 'urgent' })).toEqual({ kind: 'none' })
  })

  it('the action is gone → target_deleted', () => {
    expect(compareActionDrift(row(), null)).toEqual({ kind: 'target_deleted' })
  })

  it('a project move reads extra.move_to_project_id', () => {
    const r = row({ status_to: null, due_date: null, extra: { move_to_project_id: 'p-2' } })
    expect(compareActionDrift(r, { ...BASE, project_id: 'p-2' })).toEqual({ kind: 'already_true' })
  })

  it('only pending action updates/assigns/deletes with a base are checked', () => {
    expect(isDriftCheckable(row())).toBe(true)
    expect(isDriftCheckable(row({ status: 'applied' }))).toBe(false)
    expect(isDriftCheckable(row({ change_type: 'create', entity_id: null }))).toBe(false)
    expect(isDriftCheckable(row({ base: null }))).toBe(false)
    expect(isDriftCheckable(row({ entity_type: 'project' }))).toBe(false)
  })
})

describe('isAlreadyTrue (staging)', () => {
  const base = BASE as unknown as Record<string, unknown>
  it('true when every proposed value matches', () => {
    expect(isAlreadyTrue({ status_to: 'backlog', priority: 'medium' }, base, {})).toBe(true)
  })
  it('false when one differs', () => {
    expect(isAlreadyTrue({ status_to: 'Done', priority: 'medium' }, base, {})).toBe(false)
  })
  it('a title rewrite is never already true', () => {
    expect(isAlreadyTrue({ status_to: 'Backlog', title: 'New name' }, base, {})).toBe(false)
  })
  it('nothing proposed is not "already true"', () => {
    expect(isAlreadyTrue({}, base, {})).toBe(false)
  })
})

describe('suggestionFingerprint', () => {
  const facts = {
    workspaceId: 'ws-1',
    changeType: 'update',
    entityType: 'action',
    entityId: 'act-1',
    values: { status: 'Done', due_date: '2026-10-09' },
  }
  it('is stable and ignores case, spacing and key order', () => {
    const a = suggestionFingerprint(facts)
    const b = suggestionFingerprint({ ...facts, values: { due_date: '2026-10-09', status: '  done ' } })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })
  it('a different proposed value is a different suggestion', () => {
    expect(suggestionFingerprint(facts)).not.toBe(
      suggestionFingerprint({ ...facts, values: { status: 'Done', due_date: '2026-10-10' } }),
    )
  })
  it('creates are keyed by title', () => {
    const create = { workspaceId: 'ws-1', changeType: 'create', entityType: 'action', values: {} }
    expect(suggestionFingerprint({ ...create, title: 'Call Kenan' })).toBe(suggestionFingerprint({ ...create, title: 'call  kenan' }))
    expect(suggestionFingerprint({ ...create, title: 'Call Kenan' })).not.toBe(suggestionFingerprint({ ...create, title: 'Email Kenan' }))
  })
})

describe('lifecycle', () => {
  const now = new Date('2026-10-08T12:00:00Z')
  it('defaults to DEFAULT_TTL_DAYS', () => {
    expect(expiresAtFor(now)).toBe(new Date(now.getTime() + DEFAULT_TTL_DAYS * 86_400_000).toISOString())
  })
  it('clamps an asked-for TTL', () => {
    expect(expiresAtFor(now, 7)).toBe('2026-10-15T12:00:00.000Z')
    expect(expiresAtFor(now, 9999)).toBe(new Date(now.getTime() + MAX_TTL_DAYS * 86_400_000).toISOString())
    expect(expiresAtFor(now, 0)).toBe(expiresAtFor(now))
  })
})

describe('markers', () => {
  it('round-trips through the marker regex', () => {
    const id = '3f9a12c4-0000-4000-8000-000000000001'
    const text = `GEN-297 is overdue.\n${suggestionMarker(id)}\nMore text <!--proposal:ab12cd34-->`
    const ids = [...text.matchAll(SUGGESTION_MARKER_RE)].map((m) => m[1])
    expect(ids).toEqual([id, 'ab12cd34'])
  })
})
