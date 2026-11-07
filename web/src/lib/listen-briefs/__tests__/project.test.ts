import { describe, it, expect } from 'vitest'
import { projectWords, type OpenActionRow, type ProjectRow } from '../builders/project'
import type { Clock } from '../when'

// Sunday Sep 27 2026, 3 PM in Los Angeles.
const clock: Clock = { now: new Date('2026-09-27T22:00:00Z'), timeZone: 'America/Los_Angeles' }
const who = { memberId: 'member-me', clock }

const project: ProjectRow = {
  id: 'proj-1',
  name: 'Q4 Launch',
  status: 'active',
  target_date: '2026-10-16',
  is_archived: false,
  lead_id: 'member-me',
  lead: { display_name: 'Liam' },
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

const me = { id: 'member-me', display_name: 'Liam' }

type Data = Parameters<typeof projectWords>[0]
const nothing: Omit<Data, 'project'> = { milestones: [], openActions: [], counts: null, meetings: [] }
const words = (data: Data) => projectWords(data, who).toArray()

describe('projectWords', () => {
  it('says where it stands, how far along it is, its open action items (most pressing first), what comes next and its latest meeting', () => {
    expect(
      words({
        project,
        milestones: [
          { name: 'Pricing page', status: 'completed', target_date: '2026-09-18' },
          { name: 'Beta', status: 'in_progress', target_date: '2026-10-02' },
          { name: 'GA', status: 'pending', target_date: '2026-10-16' },
        ],
        // Not in the query's order: the most pressing is ranked here.
        openActions: [
          action('Write the launch email', {
            due_at: '2026-10-01T00:00:00+00:00', // all-day, Thursday
            priority: 'medium',
            assignee: { id: 'member-jordan', display_name: 'Jordan Lee' },
          }),
          action('Update the docs', { priority: 'none', assignee: [{ id: 'member-sam', display_name: 'Sam Park' }] }),
          action('Fix the checkout bug', {
            due_at: '2026-09-24',
            priority: 'urgent',
            assignee: me,
            workflow_state: [{ category: 'started' }],
          }),
          action('Book the launch venue', { priority: 'high', context_data: { original_owner: 'Priya' } }),
          action('Record the demo video', { due_at: '2026-09-27', priority: 'low', assignee: me }),
          action('Security review sign-off', {
            due_at: '2026-09-26T17:00:00+00:00', // Saturday 10 AM PDT
            assignee_contact: { full_name: 'Jessa Lin' },
          }),
        ],
        counts: { open: 6, done: 9 },
        meetings: [{ title: 'Launch standup', started_at: '2026-09-25T16:30:00Z' }], // Fri 9:30 AM PDT
      }),
    ).toEqual([
      'Q4 Launch is active, led by you, due on October 16.',
      'Six actions are open, two of them overdue, and nine are done.',
      'Fix the checkout bug, assigned to you, overdue since Thursday.',
      'Security review sign-off, assigned to Jessa Lin, overdue since yesterday at 10 AM.',
      'Record the demo video, assigned to you, due today.',
      'Write the launch email, assigned to Jordan Lee, due on Thursday.',
      'Book the launch venue, assigned to Priya.',
      'And one more.',
      'The next milestone is Beta, due on Friday.',
      'The latest meeting in it was Launch standup, on Friday.',
    ])
  })

  it('says only what a new project has, and nothing about counts it could not read', () => {
    const bare: ProjectRow = {
      id: 'proj-2',
      name: 'Website refresh',
      status: 'planned',
      target_date: null,
      is_archived: false,
      lead_id: null,
      lead: null,
    }
    expect(words({ ...nothing, project: bare, counts: { open: 0, done: 0 } })).toEqual([
      'Website refresh is planned.',
      'It has no actions yet.',
    ])
    expect(words({ ...nothing, project: bare })).toEqual(['Website refresh is planned.'])
  })

  it('says a target date and a milestone that slipped, "at least" when not every overdue action was read, and how many more there are', () => {
    const slipped: ProjectRow = {
      ...project,
      target_date: '2026-09-25',
      is_archived: true,
      lead_id: 'member-jessa',
      lead: { display_name: 'Jessa Lin' },
    }
    const data: Data = {
      project: slipped,
      milestones: [
        { name: 'Alpha', status: 'in_progress', target_date: null },
        { name: 'Beta', status: 'pending', target_date: '2026-09-21' },
      ],
      openActions: [
        action('Sign the contract', { due_at: '2026-09-20', assignee_contact: { full_name: 'Jessa Lin' } }),
        action('Send the invoice', { due_at: '2026-09-22' }),
      ],
      counts: { open: 150, done: 0 },
      meetings: [],
    }

    expect(words(data)).toEqual([
      'Q4 Launch is active, led by Jessa Lin, and its target date, Friday, has passed.',
      "It's archived.",
      '150 actions are open, at least two of them overdue, and none are done yet.',
      'Sign the contract, assigned to Jessa Lin, overdue since September 20.',
      'Send the invoice, overdue since Tuesday.',
      'And 148 more.',
      'The next milestone is Beta, which was due on Monday.',
    ])
    // Finished: a passed target date is history, not a slip.
    expect(words({ ...data, project: { ...slipped, status: 'completed' } })[0]).toBe('Q4 Launch is completed, led by Jessa Lin.')
    // No dated milestone ahead: the next one in the project's order.
    expect(words({ ...data, milestones: [data.milestones[0]] })).toContain('The next milestone is Alpha.')
  })

  it('says how far along it is in plain words', () => {
    const progress = (counts: { open: number; done: number }, openActions: OpenActionRow[] = []) =>
      words({ ...nothing, project, counts, openActions })[1]
    expect(progress({ open: 0, done: 9 })).toBe('All nine of its actions are done.')
    expect(progress({ open: 0, done: 1 })).toBe('Its only action is done.')
    expect(progress({ open: 1, done: 1 }, [action('Sign it', { due_at: '2026-09-25' })])).toBe(
      'One action is open and overdue, and one is done.',
    )
    const late = ['2026-09-20', '2026-09-21', '2026-09-22'].map((due) => action('Late', { due_at: due }))
    expect(progress({ open: 3, done: 0 }, late)).toBe('Three actions are open, all of them overdue, and none are done yet.')
  })

  it('says when each open action item is due, and whose it is', () => {
    const item = (a: OpenActionRow) => words({ ...nothing, project, openActions: [a] }).at(-1)
    expect(
      item(action('Write the launch email', { due_at: '2026-10-01T00:00:00+00:00', assignee: { id: 'member-jordan', display_name: 'Jordan Lee' } })),
    ).toBe('Write the launch email, assigned to Jordan Lee, due on Thursday.')
    expect(item(action('Renew the domain', { due_at: '2026-09-17T17:00:00Z' }))).toBe('Renew the domain, due 10 days ago.')
    expect(item(action('Book the venue', { context_data: { original_owner: 'Priya' } }))).toBe('Book the venue, assigned to Priya.')
    expect(item(action('Draft the brief', { assignee_ai_member: { name: 'Nova' } }))).toBe('Draft the brief, assigned to Nova, an AI teammate.')
  })
})
