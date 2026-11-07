/**
 * The Activity copy and ordering, shared by the dialog and the detail panel.
 */
import { describe, it, expect } from 'vitest'
import type { WorkItem } from '../types'
import {
  deliverableVerb,
  durationText,
  isPausedFailure,
  itemLine,
  kindLabel,
  kindLine,
  laterSettled,
  partitionWork,
  primaryDeliverable,
  relativeTime,
  reviewLine,
  sectionOf,
} from '../presentation'

function item(over: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    workspace_id: 'w',
    member_id: 'm',
    kind: 'flow_run',
    title: 't',
    status: 'done',
    actor: 'loop',
    current_step: null,
    progress: {},
    result_summary: null,
    error_message: null,
    skip_reason: null,
    deliverables: [],
    needs: null,
    source: {},
    run_key: null,
    agent_run_id: null,
    flow_run_id: null,
    created_at: '2026-09-17T10:00:00.000Z',
    started_at: null,
    finished_at: null,
    reviewed_at: null,
    last_beat_at: '2026-09-17T10:00:00.000Z',
    deadline_at: null,
    ...over,
  }
}

describe('partitionWork', () => {
  it('splits into Needs you (oldest first), Running now and Recent (newest first)', () => {
    const items = [
      item({ id: 'done-old', status: 'done', finished_at: '2026-09-17T09:00:00.000Z' }),
      item({ id: 'done-new', status: 'done', finished_at: '2026-09-17T11:00:00.000Z' }),
      item({ id: 'review-new', status: 'needs_review', finished_at: '2026-09-17T12:00:00.000Z' }),
      item({ id: 'input-old', status: 'needs_input', last_beat_at: '2026-09-17T08:00:00.000Z' }),
      item({ id: 'run-a', status: 'running', started_at: '2026-09-17T10:30:00.000Z' }),
      item({ id: 'run-b', status: 'queued', created_at: '2026-09-17T10:45:00.000Z' }),
      item({ id: 'failed', status: 'failed', finished_at: '2026-09-17T10:15:00.000Z' }),
    ]
    const p = partitionWork(items)
    expect(p.needsYou.map((i) => i.id)).toEqual(['input-old', 'review-new'])
    expect(p.running.map((i) => i.id)).toEqual(['run-b', 'run-a'])
    expect(p.recent.map((i) => i.id)).toEqual(['done-new', 'failed', 'done-old'])
    expect(sectionOf({ status: 'canceled' })).toBe('recent')
  })
})

describe('itemLine / reviewLine', () => {
  it('reads the one thing to know per status', () => {
    expect(itemLine(item({ id: 'a', status: 'running', current_step: 'Reading the thread' }))).toBe('Reading the thread')
    expect(itemLine(item({ id: 'a', status: 'running' }))).toBe('Starting')
    expect(itemLine(item({ id: 'a', status: 'queued', current_step: 'Waiting for your device' }))).toBe('Waiting for your device')
    expect(itemLine(item({ id: 'a', status: 'needs_input' }))).toBe('Waiting on your answer')
    expect(itemLine(item({ id: 'a', status: 'done', result_summary: 'filed 2 · 1 for you' }))).toBe('filed 2 · 1 for you')
    expect(itemLine(item({ id: 'a', status: 'failed', error_message: 'Model timed out' }))).toBe('Model timed out')
    expect(itemLine(item({ id: 'a', status: 'skipped', skip_reason: 'Workspace dormant' }))).toBe('Workspace dormant')
    expect(itemLine(item({ id: 'a', status: 'canceled' }))).toBe('Canceled')
  })

  it('a run waiting on the teammate it handed work to names the role, or the count (row 13)', () => {
    expect(itemLine(item({ id: 'a', status: 'waiting_on_child', needs: { kind: 'child', work_item_id: 'c', role: 'researcher' } }))).toBe('Waiting on Researcher')
    expect(itemLine(item({ id: 'a', status: 'waiting_on_child', needs: { kind: 'child', work_item_id: 'c', role: 'researcher', count: 3 } }))).toBe('Waiting on 3 teammates')
    expect(itemLine(item({ id: 'a', status: 'waiting_on_child', needs: null }))).toBe('Waiting on a teammate')
  })

  it('counts the unresolved deliverables behind the review verb', () => {
    const review = item({
      id: 'r',
      status: 'needs_review',
      needs: { kind: 'review', verb: 'review' },
      deliverables: [
        { type: 'email_draft', id: 'd1', label: 'Re: A' },
        { type: 'email_draft', id: 'd2', label: 'Re: B', resolved_at: '2026-09-17T12:00:00.000Z' },
        { type: 'document', id: 'doc', label: 'Recap' },
      ],
    })
    expect(reviewLine(review)).toBe('Review 1 draft, 1 document')
    expect(itemLine(review)).toBe('Review 1 draft, 1 document')
    expect(
      reviewLine(item({ id: 'c', needs: { kind: 'review', verb: 'check' }, deliverables: [{ type: 'document', id: 'x', label: 'Doc' }] })),
    ).toBe('Check 1 document')
    expect(
      reviewLine(item({ id: 'k', needs: { kind: 'review', verb: 'review' }, deliverables: [{ type: 'attention_cards', id: 'fr', label: '3 cards', count: 3 }] })),
    ).toBe('Review 3 cards')
    expect(reviewLine(item({ id: 'e', needs: { kind: 'review', verb: 'approve' } }))).toBe('Approve the result')
  })
})

describe('labels and verbs', () => {
  it('names kinds and deliverable verbs', () => {
    expect(kindLabel('email_drafts')).toBe('Email assistant')
    expect(kindLabel('some_new_kind')).toBe('Some new kind')
    expect(deliverableVerb({ type: 'email_draft', id: 'd', label: 'x' })).toBe('Review draft')
    expect(deliverableVerb({ type: 'email_draft', id: 'd', label: 'x', resolved_at: 't' })).toBe('Open draft')
    expect(deliverableVerb({ type: 'attention_cards', id: 'fr', label: 'x', count: 2 })).toBe('See 2 cards')
    expect(deliverableVerb({ type: 'pr', id: 'https://x', label: 'PR' })).toBe('Open pull request')
  })

  it('says who ran it before the kind, once (row 4)', () => {
    const mate = (name: string) => ({ id: 'tm', name, is_system: true, system_key: null })
    expect(kindLine({ kind: 'flow_run', teammate: mate('Triage') })).toBe('Triage · Loop')
    expect(kindLine({ kind: 'email_drafts', teammate: mate('Email drafts') })).toBe('Email drafts · Email assistant')
    // A name that already says the kind is not repeated.
    expect(kindLine({ kind: 'extraction', teammate: mate('Extraction') })).toBe('Extraction')
    // No teammate (a person's own run, a user-built loop, a private team's): the kind alone.
    expect(kindLine({ kind: 'work_run', teammate: null })).toBe('Work run')
    expect(kindLine({ kind: 'work_run' })).toBe('Work run')
  })

  it('reads a usage-limit failure as paused', () => {
    expect(isPausedFailure(item({ id: 'p', status: 'failed', error_message: 'AI usage limit reached' }))).toBe(true)
    expect(isPausedFailure(item({ id: 'p', status: 'failed', error_message: 'boom' }))).toBe(false)
    expect(isPausedFailure(item({ id: 'p', status: 'done', error_message: 'usage limit' }))).toBe(false)
  })
})

describe('time text', () => {
  it('formats durations and relative times', () => {
    expect(durationText('2026-09-17T10:00:00.000Z', '2026-09-17T10:00:12.000Z')).toBe('12s')
    expect(durationText('2026-09-17T10:00:00.000Z', '2026-09-17T10:03:20.000Z')).toBe('3m 20s')
    expect(durationText('2026-09-17T10:00:00.000Z', '2026-09-17T11:04:00.000Z')).toBe('1h 04m')
    expect(durationText(null)).toBe('')
    const now = Date.parse('2026-09-17T12:00:00.000Z')
    expect(relativeTime('2026-09-17T11:59:50.000Z', now)).toBe('now')
    expect(relativeTime('2026-09-17T11:56:00.000Z', now)).toBe('4m')
    expect(relativeTime('2026-09-17T09:00:00.000Z', now)).toBe('3h')
    expect(relativeTime('2026-09-15T12:00:00.000Z', now)).toBe('2d')
    expect(relativeTime(null, now)).toBe('')
  })
})

describe('laterSettled (a teammate’s last finished row)', () => {
  const at = (h: number) => `2026-10-01T${String(h).padStart(2, '0')}:00:00.000Z`

  it('takes a row that settled later, and keeps what it has on a tie or an earlier one', () => {
    const current = item({ id: 'a', status: 'done', finished_at: at(10) })
    const later = item({ id: 'b', status: 'failed', finished_at: at(11) })
    const tie = item({ id: 'c', status: 'done', finished_at: at(10) })
    const earlier = item({ id: 'd', status: 'canceled', finished_at: at(9) })
    expect(laterSettled(current, later)).toBe(later)
    expect(laterSettled(current, tie)).toBe(current)
    expect(laterSettled(current, earlier)).toBe(current)
    expect(laterSettled(null, earlier)).toBe(earlier)
  })

  it('never takes a row that has not settled', () => {
    const current = item({ id: 'a', status: 'done', finished_at: at(10) })
    for (const status of ['queued', 'running', 'needs_input', 'needs_review', 'waiting_on_child'] as const) {
      expect(laterSettled(current, item({ id: 'b', status, finished_at: at(12) }))).toBe(current)
      expect(laterSettled(null, item({ id: 'b', status }))).toBeNull()
    }
  })

  it('takes a newer copy of the row it has, and reads when it started for one with no finish time', () => {
    const current = item({ id: 'a', status: 'done', finished_at: at(10) })
    const copy = item({ id: 'a', status: 'done', finished_at: at(10), result_summary: 'Filed 3 actions' })
    expect(laterSettled(current, copy)).toBe(copy)
    const unstamped = item({ id: 'b', status: 'skipped', finished_at: null, created_at: at(11) })
    expect(laterSettled(current, unstamped)).toBe(unstamped)
  })
})

describe('primaryDeliverable: what a delivered item opens to', () => {
  const a = { type: 'document' as const, id: 'a', label: 'A' }
  const b = { type: 'document' as const, id: 'b', label: 'B' }
  it('the first that still waits', () => {
    expect(primaryDeliverable({ deliverables: [a, b], needs: null })).toBe(a)
    expect(primaryDeliverable({ deliverables: [{ ...a, resolved_at: '2026-10-15T00:00:00Z' }, b], needs: null })).toBe(b)
  })
  it('the one the review names, while it still waits', () => {
    expect(primaryDeliverable({ deliverables: [a, b], needs: { kind: 'review', verb: 'check', deliverable: 1 } })).toBe(b)
    const resolved = { ...b, resolved_at: '2026-10-15T00:00:00Z' }
    expect(primaryDeliverable({ deliverables: [a, resolved], needs: { kind: 'review', verb: 'check', deliverable: 1 } })).toBe(a)
    expect(primaryDeliverable({ deliverables: [a], needs: { kind: 'review', verb: 'check', deliverable: 7 } })).toBe(a)
  })
  it('null with nothing left to open', () => {
    expect(primaryDeliverable({ deliverables: [], needs: null })).toBeNull()
    expect(primaryDeliverable({ deliverables: [{ ...a, resolved_at: '2026-10-15T00:00:00Z' }], needs: null })).toBeNull()
  })
})
