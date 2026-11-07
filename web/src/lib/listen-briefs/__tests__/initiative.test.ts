import { describe, it, expect } from 'vitest'
import { initiativeWords, type InitiativeRow } from '../builders/initiative'
import type { OpenActionRow } from '../builders/action-items'
import type { Clock } from '../when'

// Sunday Sep 27 2026, 3 PM in Los Angeles.
const clock: Clock = { now: new Date('2026-09-27T22:00:00Z'), timeZone: 'America/Los_Angeles' }
const who = { memberId: 'member-me', clock }

const initiative: InitiativeRow = {
  id: 'init-1',
  name: 'Growth 2026',
  status: 'active',
  target_date: '2026-12-31',
  owner_id: 'member-me',
  owner: { display_name: 'Liam' },
}

function action(title: string, fields: Partial<OpenActionRow> = {}): OpenActionRow {
  return {
    title,
    due_at: null,
    priority: null,
    context_data: null,
    assignee: null,
    assignees: null,
    assignee_ai_member: null,
    assignee_contact: null,
    workflow_state: { category: 'unstarted' },
    ...fields,
  }
}

const projects = (...names: string[]) => names.map((name) => ({ name }))
type Data = Parameters<typeof initiativeWords>[0]
const words = (data: Data) => initiativeWords(data, who).toArray()

describe('initiativeWords', () => {
  it('says where it stands, its projects, how far along their actions are and the open ones, most pressing first', () => {
    expect(
      words({
        initiative,
        projects: projects('Q4 Launch', 'Pricing revamp', 'Beta program'),
        openActions: [
          action('Book the venue'),
          action('Write the launch email', {
            due_at: '2026-10-01T00:00:00+00:00', // all-day, Thursday
            assignee: { id: 'member-jordan', display_name: 'Jordan Lee' },
          }),
          action('Fix the checkout bug', { due_at: '2026-09-24', priority: 'urgent', assignee: { id: 'member-me', display_name: 'Liam' } }),
        ],
        counts: { open: 3, done: 4 },
      }),
    ).toEqual([
      'Growth 2026 is active, owned by you, due on December 31.',
      'It has three projects: Q4 Launch, Pricing revamp and Beta program.',
      'Three actions are open, one of them overdue, and four are done.',
      'Fix the checkout bug, assigned to you, overdue since Thursday.',
      'Write the launch email, assigned to Jordan Lee, due on Thursday.',
      'Book the venue.',
    ])
  })

  it('one project by name; many as a few and "others"; none, and then nothing about actions', () => {
    const one = words({ initiative, projects: projects('Q4 Launch'), openActions: [], counts: { open: 0, done: 2 } })
    expect(one.slice(1)).toEqual(['It has one project, Q4 Launch.', 'All two of its actions are done.'])

    const many = words({ initiative, projects: projects('A', 'B', 'C', 'D', 'E'), openActions: [], counts: null })
    expect(many[1]).toBe('It has five projects: A, B and three others.')

    const none = words({
      initiative: { ...initiative, status: 'planned', owner_id: 'member-jessa', owner: { display_name: 'Jessa Lin' }, target_date: null },
      projects: [],
      openActions: [],
      counts: { open: 0, done: 0 },
    })
    expect(none).toEqual(['Growth 2026 is planned, owned by Jessa Lin.', 'It has no projects yet.'])
  })

  it('a target date that passed; none said once it is finished', () => {
    const slipped = { ...initiative, target_date: '2026-09-25' }
    expect(words({ initiative: slipped, projects: [], openActions: [], counts: null })[0]).toBe(
      'Growth 2026 is active, owned by you, and its target date, Friday, has passed.',
    )
    expect(words({ initiative: { ...slipped, status: 'completed' }, projects: [], openActions: [], counts: null })[0]).toBe(
      'Growth 2026 is completed, owned by you.',
    )
  })

  it('past five open items, how many more', () => {
    const openActions = Array.from({ length: 8 }, (_, i) => action(`Task ${i + 1}`))
    expect(words({ initiative, projects: projects('Q4 Launch', 'Beta program'), openActions, counts: { open: 12, done: 0 } }).slice(2)).toEqual([
      '12 actions are open, and none are done yet.',
      'Task 1.',
      'Task 2.',
      'Task 3.',
      'Task 4.',
      'Task 5.',
      'And seven more.',
    ])
  })
})
