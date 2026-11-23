import { describe, expect, it } from 'vitest'
import { categoryForStatus, checkMapping, guessMapping, parseDueDate, parsePriority, splitLabels } from '../columns'
import { matchMember, matchState, planTaskImport, type MatchContext } from '../plan'
import type { ActionRecord } from '../../types'

const ctx: MatchContext = {
  teamId: 'team-1',
  states: [
    { id: 's-backlog', name: 'Backlog', category: 'backlog', sort_order: 0 },
    { id: 's-todo', name: 'Todo', category: 'unstarted', is_default: true, sort_order: 1 },
    { id: 's-doing', name: 'In Progress', category: 'started', sort_order: 2 },
    { id: 's-done', name: 'Done', category: 'completed', sort_order: 3 },
    { id: 's-cancel', name: 'Canceled', category: 'canceled', sort_order: 4 },
  ],
  members: [
    { id: 'm-ava', name: 'Ava Stone', email: 'ava@example.com' },
    { id: 'm-ben', name: 'Ben Ortiz', email: 'ben@example.com' },
    { id: 'm-ben2', name: 'Ben Park', email: 'benp@example.com' },
  ],
  labels: [{ id: 'l-bug', name: 'Bug' }],
  projects: [{ id: 'p-site', name: 'Website' }],
}

describe('task CSV columns', () => {
  it('guesses the mapping from headers, one column a field', () => {
    expect(guessMapping(['Task Name', 'Status', 'Assigned To', 'Due Date', 'Tags', 'Tags', 'Notes', 'Whatever'])).toEqual([
      'title', 'status', 'assignee', 'due_date', 'labels', 'skip', 'description', 'skip',
    ])
  })

  it('takes the first free column as the title when none is named', () => {
    expect(guessMapping(['Thing', 'Status'])).toEqual(['title', 'status'])
  })

  it('checks a mapping: a title, one of each field, labels may repeat', () => {
    expect(checkMapping(['title', 'labels', 'labels'], 3)).toEqual({ ok: true, mapping: ['title', 'labels', 'labels'] })
    expect(checkMapping(['status'], 1).ok).toBe(false)
    expect(checkMapping(['title', 'title'], 2).ok).toBe(false)
    expect(checkMapping(['title', 'nope'], 2).ok).toBe(false)
    expect(checkMapping(['title'], 2).ok).toBe(false)
  })

  it('reads status words as a kind of state', () => {
    expect(categoryForStatus('Done')).toBe('completed')
    expect(categoryForStatus('in_progress')).toBe('started')
    expect(categoryForStatus("Won't do")).toBe('canceled')
    expect(categoryForStatus('To Do')).toBe('unstarted')
    expect(categoryForStatus('Purple')).toBeNull()
  })

  it('reads priorities as words, Linear numbers and P-levels', () => {
    expect(parsePriority('High')).toBe('high')
    expect(parsePriority('1')).toBe('urgent')
    expect(parsePriority('0')).toBe('none')
    expect(parsePriority('P0')).toBe('urgent')
    expect(parsePriority('p3')).toBe('low')
    expect(parsePriority('critical')).toBe('urgent')
    expect(parsePriority('soon')).toBeNull()
  })

  it('reads dates in the usual export forms', () => {
    expect(parseDueDate('2026-11-23')).toBe('2026-11-23')
    expect(parseDueDate('2026-11-23T10:00:00Z')).toBe('2026-11-23')
    expect(parseDueDate('11/23/2026')).toBe('2026-11-23')
    expect(parseDueDate('23/11/2026')).toBe('2026-11-23')
    expect(parseDueDate('23.11.2026')).toBe('2026-11-23')
    expect(parseDueDate('Nov 23, 2026')).toBe('2026-11-23')
    expect(parseDueDate('23 November 2026')).toBe('2026-11-23')
    expect(parseDueDate('46349')).toBe('2026-11-23')
    expect(parseDueDate('2026-02-30')).toBeNull()
    expect(parseDueDate('next week')).toBeNull()
  })

  it('splits labels, dedupes case-blind, caps', () => {
    expect(splitLabels('Bug, bug; UI | Backend')).toEqual(['Bug', 'UI', 'Backend'])
    expect(splitLabels(Array.from({ length: 20 }, (_, i) => `l${i}`).join(','))).toHaveLength(10)
  })
})

describe('matching', () => {
  it('matches a member by email, name, then a unique first name', () => {
    expect(matchMember(ctx.members, 'Ava Stone <ava@example.com>')?.id).toBe('m-ava')
    expect(matchMember(ctx.members, 'ben ortiz')?.id).toBe('m-ben')
    expect(matchMember(ctx.members, 'Ava')?.id).toBe('m-ava')
    expect(matchMember(ctx.members, 'Ben')).toBeNull()
    expect(matchMember(ctx.members, 'Zed')).toBeNull()
  })

  it('matches a state by name, then kind, else the default', () => {
    expect(matchState(ctx.states, 'in progress')).toEqual({ state: ctx.states[2], matched: true })
    expect(matchState(ctx.states, 'Closed')?.state.id).toBe('s-done')
    expect(matchState(ctx.states, '')?.state.id).toBe('s-todo')
    expect(matchState(ctx.states, 'Purple')).toEqual({ state: ctx.states[1], matched: false })
  })
})

describe('planTaskImport', () => {
  const headers = ['Title', 'Status', 'Priority', 'Assignee', 'Due', 'Project', 'Labels', 'Notes']
  const rows = [
    ['Fix login', 'Done', 'High', 'ava@example.com', '2026-12-01', 'Website', 'Bug, Auth', 'Details here'],
    ['Write docs', 'Purple', '', 'Zed', 'someday', 'Docs', 'auth', ''],
    ['', 'Todo', '', '', '', '', '', ''],
    ['Ship it', '', 'meh', 'Ben Ortiz', '', '', '', ''],
  ]
  const plan = planTaskImport({ headers, rows, mapping: guessMapping(headers), context: ctx, projectId: 'p-site' })
  const actions = plan.items.filter((i) => i.record.kind === 'action').map((i) => i.record as ActionRecord)

  it('makes one action a titled row, skipping the untitled', () => {
    expect(actions.map((a) => a.title)).toEqual(['Fix login', 'Write docs', 'Ship it'])
    expect(plan.counts).toMatchObject({ action: 3, skipped: 1 })
  })

  it('matches and makes labels and projects once each, before the tasks that use them', () => {
    const kinds = plan.items.map((i) => `${i.record.kind}:${i.ref}`)
    expect(kinds.indexOf('label:label:0')).toBeLessThan(kinds.indexOf('action:row:2'))
    expect(plan.items.filter((i) => i.record.kind === 'label').map((i) => (i.record as { name: string }).name)).toEqual(['Auth'])
    expect(plan.items.filter((i) => i.record.kind === 'project').map((i) => (i.record as { name: string }).name)).toEqual(['Docs'])
    expect(actions[0].labels).toEqual([{ id: 'l-bug' }, { ref: 'label:0' }])
    expect(actions[1].labels).toEqual([{ ref: 'label:0' }])
    expect(actions[0].project).toEqual({ id: 'p-site' })
    expect(actions[1].project).toEqual({ ref: 'project:0' })
    // No project cell: the one chosen for every row.
    expect(actions[2].project).toEqual({ id: 'p-site' })
  })

  it('resolves statuses, people, priorities and dates, and says what it could not', () => {
    expect(actions[0]).toMatchObject({ status: { id: 's-done' }, priority: 'high', assignee_member_id: 'm-ava', due_date: '2026-12-01', description: 'Details here', source_label: 'Row 2' })
    expect(actions[1]).toMatchObject({ status: { id: 's-todo' }, assignee_member_id: null, due_date: null })
    expect(actions[2]).toMatchObject({ priority: 'none', assignee_member_id: 'm-ben' })
    const text = plan.notes.map((n) => n.text).join('\n')
    expect(text).toMatch(/no title/)
    expect(text).toMatch(/“Purple”.*go to Todo/)
    expect(text).toMatch(/“Zed”/)
    expect(text).toMatch(/1 due date couldn’t be read/)
    expect(text).toMatch(/1 priority couldn’t be read/)
  })
})
