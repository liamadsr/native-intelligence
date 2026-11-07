import { describe, it, expect } from 'vitest'
import { actionWords, type ActionRow, type ParentRow, type SourceCaptureRow, type SubTaskRow } from '../builders/action'
import type { Clock } from '../when'

// Sunday Sep 27 2026, 3 PM in Los Angeles.
const clock: Clock = { now: new Date('2026-09-27T22:00:00Z'), timeZone: 'America/Los_Angeles' }
const who = { userId: 'user-1', memberId: 'member-me', clock }

const meeting: SourceCaptureRow = {
  title: 'Pricing sync',
  started_at: '2026-09-22T21:00:00Z', // Tue 2 PM PDT
  recorded_at: null,
  created_at: '2026-09-22T21:00:00Z',
  visibility: 'workspace',
  user_id: 'user-2',
  is_eval: false,
}

const action: ActionRow = {
  title: 'Send Jessa the revised deck with the new tiers.',
  description: 'Jessa wants it before the board meeting.<!-- ai:owner -->\n\n\n\n- Starter: $19\n- Team: **$99**',
  priority: 'urgent',
  due_at: '2026-09-25T00:00:00+00:00', // midnight UTC: an all-day date, Fri Sep 25
  confirmation: 'confirmed',
  user_id: 'user-2',
  parent_id: 'act-0',
  created_at: '2026-09-22T21:40:00Z',
  agent_run_status: 'idle',
  context_data: null,
  workflow_state: { name: 'In Review', category: 'started' },
  assignee: { id: 'member-jordan', display_name: 'Jordan Lee' },
  assignees: [
    { member: { id: 'member-jordan', display_name: 'Jordan Lee' } },
    { member: [{ id: 'member-me', display_name: 'Liam' }] },
  ],
  assignee_ai_member: null,
  assignee_contact: null,
  project: { name: 'Q4 Launch' },
  milestone: [{ name: 'Pricing page live' }],
  source_capture: meeting,
}

const bare: ActionRow = {
  ...action,
  title: 'Book the offsite',
  description: null,
  priority: 'none',
  due_at: null,
  parent_id: null,
  created_at: '2026-09-03T16:00:00Z', // Thu Sep 3, 9 AM PDT
  workflow_state: { name: 'Todo', category: 'unstarted' },
  assignee: null,
  assignees: [],
  project: null,
  milestone: null,
  // Someone else's private meeting: never named.
  source_capture: { ...meeting, title: 'Private 1:1', visibility: 'private' },
}

type Found = { creator: string | null; parent: ParentRow | null; subTasks: SubTaskRow[] }
const none: Found = { creator: null, parent: null, subTasks: [] }
/** A sub-task in this state: untitled, unassigned and undated unless told otherwise. */
const sub = (category: string, fields: Partial<SubTaskRow> = {}): SubTaskRow => ({
  title: null,
  due_at: null,
  priority: null,
  context_data: null,
  assignee: null,
  assignees: null,
  assignee_ai_member: null,
  assignee_contact: null,
  workflow_state: { category },
  ...fields,
})
const words = (a: ActionRow, found: Partial<Found> = {}) => actionWords({ action: a, ...none, ...found }, who).toArray()

describe('actionWords', () => {
  it('where it stands, where it came from and belongs, what is left, then its description in full', () => {
    expect(
      actionWords(
        {
          action,
          creator: 'Jordan Lee',
          parent: { title: 'Launch the new pricing' },
          subTasks: [
            sub('completed', { title: 'Draft the tiers' }),
            sub('canceled', { workflow_state: [{ category: 'canceled' }] }),
            sub('started', { title: 'Update the tier table', assignee: { id: 'member-jordan', display_name: 'Jordan Lee' } }),
          ],
        },
        who,
      ).toArray(),
    ).toEqual([
      'Send Jessa the revised deck with the new tiers.',
      "It's in review, assigned to you and Jordan Lee, and was due on Friday.",
      "It's urgent.",
      'It came from Pricing sync, on Tuesday.',
      "It's part of Q4 Launch and the Pricing page live milestone.",
      "It's a sub-task of Launch the new pricing.",
      'One of its three sub-tasks is still open: Update the tier table, assigned to Jordan Lee.',
      'Jessa wants it before the board meeting.',
      'Starter: $19.',
      'Team: $99.',
    ])
  })

  it('says little about a bare one, and never names a meeting the user cannot see', () => {
    expect(words(bare)).toEqual(['Book the offsite.', "It's not started, not assigned to anyone yet.", 'It was created 3 weeks ago.'])

    // Nor an evaluation capture: who created it is said instead.
    const fromEval = words({ ...bare, source_capture: { ...meeting, is_eval: true } }, { creator: 'Jordan Lee' })
    expect(fromEval).toContain('Jordan Lee created it 3 weeks ago.')
    expect(fromEval.join(' ')).not.toContain('Pricing sync')

    expect(words({ ...bare, user_id: 'user-1', source_capture: null })).toContain('You created it 3 weeks ago.')
    expect(words({ ...bare, title: '  ', source_capture: { ...meeting, title: null } })).toEqual([
      'Untitled action.',
      "It's not started, not assigned to anyone yet.",
      'It came from a meeting on Tuesday.',
    ])
  })

  it('names an AI teammate and what its agent is doing, a suggestion no one confirmed, and no lateness once done', () => {
    const nova: ActionRow = {
      ...bare,
      assignee_ai_member: { name: 'Nova' },
      agent_run_status: 'needs_input',
      confirmation: 'suggested',
      priority: 'high',
      due_at: '2026-09-25',
      workflow_state: { name: 'Done', category: 'completed' },
    }
    expect(words(nova)).toEqual([
      'Book the offsite.',
      "It's done, assigned to Nova, an AI teammate.",
      'Nova is waiting on your answer.',
      "It's a suggestion no one has confirmed yet.",
      'It was created 3 weeks ago.',
    ])

    const running = { ...bare, agent_run_status: 'working', priority: 'high', confirmation: 'dismissed' }
    expect(words(running).slice(1, 5)).toEqual([
      "It's not started, not assigned to anyone yet.",
      "It's high priority.",
      'An agent is working on it right now.',
      'It was dismissed.',
    ])
    expect(words({ ...bare, agent_run_status: 'pr_open' })).toContain('Its agent opened a pull request.')
    expect(words({ ...nova, agent_run_status: 'failed' })).toContain("Nova's last run failed.")
  })

  it('says whom it was given to outside the team, and the state by the team’s own name when that reads', () => {
    expect(words({ ...bare, assignee_contact: { full_name: 'Jessa Lin' } })[1]).toBe("It's not started, assigned to Jessa Lin.")
    expect(words({ ...bare, context_data: { original_owner: 'Jordan' } })[1]).toBe("It's not started, assigned to Jordan.")

    const state = (name: string | null, category = 'started') => words({ ...bare, workflow_state: { name, category } })[1]
    expect(state('Code Review')).toBe("It's in code review, not assigned to anyone yet.")
    expect(state('Ready for QA')).toBe("It's ready for QA, not assigned to anyone yet.")
    expect(state('Needs Review')).toBe("It's waiting on review, not assigned to anyone yet.")
    expect(state('Doing')).toBe("It's in progress, not assigned to anyone yet.")
    expect(state(null)).toBe("It's in progress, not assigned to anyone yet.")
    expect(state('Icebox', 'backlog')).toBe("It's in the backlog, not assigned to anyone yet.")
    expect(state('Won’t do', 'canceled')).toBe("It's canceled.")
  })

  it('counts its sub-tasks the way people say them, then reads the open ones', () => {
    // The bare action has no description: its sub-tasks are said last.
    const said = (...categories: string[]) => {
      const all = words(bare, { subTasks: categories.map((c, i) => sub(c, { title: `Step ${i + 1}` })) })
      return all.slice(all.findIndex((line) => line.includes('sub-task')))
    }
    expect(said('completed', 'canceled')).toEqual(['All its sub-tasks are done.'])
    expect(said('started', 'unstarted')).toEqual(['Both its sub-tasks are still open.', 'Step 1.', 'Step 2.'])
    expect(said('started', 'unstarted', 'backlog')).toEqual(['All three of its sub-tasks are still open.', 'Step 1.', 'Step 2.', 'Step 3.'])
    expect(said('started', 'unstarted', 'completed')).toEqual(['Two of its three sub-tasks are still open.', 'Step 1.', 'Step 2.'])
    expect(said('unstarted')).toEqual(['Its one sub-task is still open: Step 1.'])
  })

  it('reads its open sub-tasks the most pressing first, with whose each is and when it is due, five at most', () => {
    const lines = words(bare, {
      subTasks: [
        sub('unstarted', { title: 'Book the venue' }),
        sub('unstarted', { title: 'Send the invites', due_at: '2026-10-02', assignee: { id: 'member-me', display_name: 'Liam' } }),
        sub('started', { title: 'Confirm the budget', due_at: '2026-09-24', assignee_contact: { full_name: 'Jessa Lin' } }),
        sub('completed', { title: 'Pick the dates' }),
        sub('unstarted', { title: 'Plan the agenda', priority: 'high' }),
        sub('unstarted', { title: 'Order the food' }),
        sub('unstarted', { title: 'Arrange the travel' }),
        sub('unstarted', { title: 'Print the badges' }),
      ],
    })
    expect(lines.slice(lines.findIndex((line) => line.includes('sub-task')))).toEqual([
      'Seven of its eight sub-tasks are still open.',
      'Confirm the budget, assigned to Jessa Lin, overdue since Thursday.',
      'Send the invites, assigned to you, due on Friday.',
      'Plan the agenda.',
      'Book the venue.',
      'Order the food.',
      'And two more.',
    ])
  })
})
