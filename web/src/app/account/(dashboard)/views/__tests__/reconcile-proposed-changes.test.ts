// @vitest-environment jsdom
/**
 * Identity-preserving reconcile for the capture panel's proposed-changes
 * refetches.
 *
 * Every proposed_change realtime event triggers a full-list refetch, and the
 * response used to wholesale-replace state — new object identity for every
 * row, so every (memoized) ProposalCard re-rendered even when nothing about it
 * changed. reconcileProposedChanges is the contract that makes React.memo
 * effective: unchanged rows keep their PREVIOUS object identity, and a fetch
 * that changed nothing keeps the previous ARRAY identity (which in turn keeps
 * proposalNodeCtx stable).
 *
 * The unchanged test is updated_at alone: the table's update trigger (mig 071)
 * bumps it on every server-side mutation, so a same-updated_at row is
 * byte-identical on the server — and a LOCAL copy that differs anyway holds an
 * optimistic flip (accept/dismiss ahead of the echo) that a stale response
 * must not revert.
 */
import { describe, it, expect, vi } from 'vitest'

// The panel's editor stack reaches react-tweet, which ships raw CSS modules
// node can't load — stub the editor at its module boundary. This test only
// exercises the pure reconcile helper the panel exports.
vi.mock('@/app/account/(dashboard)/views/note-editor', () => ({ NoteEditor: () => null }))

import { reconcileProposedChanges } from '../capture-detail-panel'
import type { ProposedChange } from '@/lib/proposed-changes/types'

function makeChange(id: string, overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    id,
    workspace_id: 'ws-1',
    capture_id: 'cap-1',
    change_type: 'create',
    entity_type: 'action',
    entity_id: null,
    display_text: `Change ${id}`,
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
    created_at: '2026-08-04T00:00:00Z',
    updated_at: '2026-08-04T00:00:00Z',
    ...overrides,
  }
}

describe('reconcileProposedChanges', () => {
  it('returns the fetched list untouched when there is no previous state', () => {
    const fetched = [makeChange('a'), makeChange('b')]
    expect(reconcileProposedChanges([], fetched)).toBe(fetched)
  })

  it('keeps the previous ARRAY identity when nothing changed', () => {
    const prev = [makeChange('a'), makeChange('b')]
    // Fresh clones, as a refetch produces — same ids, same updated_at.
    const fetched = [makeChange('a'), makeChange('b')]
    expect(reconcileProposedChanges(prev, fetched)).toBe(prev)
  })

  it('keeps previous OBJECT identity for unchanged rows while taking changed ones', () => {
    const prev = [makeChange('a'), makeChange('b')]
    const changedB = makeChange('b', { updated_at: '2026-08-04T00:00:05Z', status: 'applied' })
    const fetched = [makeChange('a'), changedB]
    const next = reconcileProposedChanges(prev, fetched)
    expect(next).not.toBe(prev)
    expect(next[0]).toBe(prev[0])
    expect(next[1]).toBe(changedB)
  })

  it('adopts new rows and drops deleted ones', () => {
    const prev = [makeChange('a'), makeChange('b')]
    const added = makeChange('c')
    const fetched = [makeChange('a'), added]
    const next = reconcileProposedChanges(prev, fetched)
    expect(next.map((c) => c.id)).toEqual(['a', 'c'])
    expect(next[0]).toBe(prev[0])
    expect(next[1]).toBe(added)
  })

  it('preserves an optimistic local flip against a stale same-updated_at response', () => {
    // Accept flipped this row optimistically — status changed locally, but
    // updated_at still holds the pre-apply value until the server echo lands.
    const optimistic = makeChange('a', { status: 'applied', result_entity_id: 'act-1' })
    const prev = [optimistic]
    // A refetch dispatched before the apply committed resolves late, carrying
    // the pre-apply row (same updated_at, status still pending).
    const stale = [makeChange('a', { status: 'pending' })]
    const next = reconcileProposedChanges(prev, stale)
    expect(next).toBe(prev)
    expect(next[0].status).toBe('applied')
  })

  it('converges to the server row once the echo bumps updated_at', () => {
    const optimistic = makeChange('a', { status: 'applied', result_entity_id: 'act-1' })
    const echoed = makeChange('a', {
      status: 'applied',
      result_entity_id: 'act-1',
      updated_at: '2026-08-04T00:00:10Z',
    })
    const next = reconcileProposedChanges([optimistic], [echoed])
    expect(next[0]).toBe(echoed)
  })

  it('reorders without losing row identity', () => {
    const prev = [makeChange('a'), makeChange('b')]
    const fetched = [makeChange('b'), makeChange('a')]
    const next = reconcileProposedChanges(prev, fetched)
    expect(next.map((c) => c.id)).toEqual(['b', 'a'])
    expect(next[0]).toBe(prev[1])
    expect(next[1]).toBe(prev[0])
  })
})
