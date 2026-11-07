import { describe, it, expect } from 'vitest'
import type { PersonContext } from '@/lib/crm/person-context'
import { contactWords } from '../builders/contact'
import type { Clock } from '../when'

// Sunday Sep 27 2026, 3 PM in Los Angeles.
const clock: Clock = { now: new Date('2026-09-27T22:00:00Z'), timeZone: 'America/Los_Angeles' }

const person: PersonContext = {
  contact: {
    id: 'c-1',
    workspace_id: 'ws-1',
    full_name: 'Jessa Lin',
    email: 'jessa@acme.com',
    secondary_emails: null,
    job_title: 'Head of Ops',
    member_id: null,
    visibility: 'workspace',
    relationship_type: 'customer',
    relationship_strength: 'strong',
    last_interaction_at: '2026-09-26T16:00:00Z', // yesterday 9 AM, after the meeting
    interaction_count: 14,
    enrichment_status: null,
    company: { id: 'co-1', name: 'Acme', domain: 'acme.com' },
  },
  is_teammate: false,
  open_actions: [
    {
      id: 'a1',
      identifier: 'OPS-3',
      title: 'Send the signed order form.',
      status: 'Todo',
      status_category: 'unstarted',
      due_at: '2026-10-02',
      priority: null,
      confirmation: 'confirmed',
      assigned_via: 'contact',
    },
  ],
  pending_commitments: [],
  recent_captures: [
    { id: 'cap-1', title: 'Pricing sync', started_at: '2026-09-22T21:00:00Z', ai_summary: 'Agreed to hold the price.' },
  ],
  my_open_actions_from_their_meetings: [
    { id: 'a2', identifier: 'ENG-9', title: 'Share the security questionnaire', status: 'Todo', due_at: '2026-09-28', source_capture_title: 'Pricing sync' },
    { id: 'a3', identifier: 'ENG-10', title: 'Book the follow-up', status: 'Todo', due_at: null, source_capture_title: 'Pricing sync' },
  ],
  recent_email_threads: [
    { id: 't1', subject: 'Security review', last_message_at: '2026-09-26T16:00:00Z', needs_reply: true, from_email: 'jessa@acme.com', message_count: 3 },
    { id: 't2', subject: 'Invoice', last_message_at: '2026-09-20T16:00:00Z', needs_reply: false, from_email: 'me@x.com', message_count: 2 },
  ],
  decisions: [],
}

describe('contactWords', () => {
  it('who they are, when you last met and were in touch, what is open between you, and mail waiting', () => {
    expect(contactWords(person, '2026-09-29T16:00:00Z', clock).toArray()).toEqual([
      'Jessa Lin, Head of Ops at Acme.',
      'You were last in touch yesterday at 9 AM, and last met on Tuesday, in Pricing sync.',
      'Jessa has one open action: Send the signed order form, due on Friday.',
      'You have two actions open from your meetings with Jessa.',
      'Share the security questionnaire, due tomorrow.',
      'Book the follow-up.',
      "Jessa's email about Security review is waiting on your reply.",
      'You planned to follow up with Jessa on Tuesday at 9 AM.',
    ])
  })

  it('a meeting that was the last touch is said once; several emails are counted; a missed follow-up', () => {
    const words = contactWords(
      {
        ...person,
        contact: { ...person.contact, last_interaction_at: '2026-09-22T21:30:00Z' },
        open_actions: [],
        my_open_actions_from_their_meetings: [],
        recent_email_threads: person.recent_email_threads?.map((t) => ({ ...t, needs_reply: true })),
      },
      '2026-09-26T16:00:00Z',
      clock,
    ).toArray()
    expect(words).toEqual([
      'Jessa Lin, Head of Ops at Acme.',
      'You last met on Tuesday, in Pricing sync.',
      'Two emails from Jessa are waiting on your reply.',
      'You meant to follow up with Jessa yesterday at 9 AM.',
    ])
  })

  it('their open actions one by one, the most pressing first; "at least" at the most the gatherer reads', () => {
    const theirs = (titles: Array<[string, string | null]>) =>
      titles.map(([title, due_at], i) => ({ ...person.open_actions[0], id: `a${i}`, title, due_at }))
    const words = contactWords(
      {
        ...person,
        open_actions: theirs([
          ['Book the onsite', null],
          ['Sign the MSA', '2026-09-24'],
          ['Send the order form', '2026-10-02'],
        ]),
        my_open_actions_from_their_meetings: [],
        recent_email_threads: [],
      },
      null,
      clock,
    ).toArray()
    expect(words.slice(2)).toEqual([
      'Jessa has three open actions.',
      'Sign the MSA, overdue since Thursday.',
      'Send the order form, due on Friday.',
      'Book the onsite.',
    ])

    const eight = contactWords(
      {
        ...person,
        open_actions: theirs(Array.from({ length: 8 }, (_, i): [string, null] => [`Task ${i + 1}`, null])),
        my_open_actions_from_their_meetings: [],
        recent_email_threads: [],
      },
      null,
      clock,
    ).toArray()
    expect(eight.slice(2)).toEqual([
      'Jessa has at least eight open actions.',
      'Task 1.',
      'Task 2.',
      'Task 3.',
      'Task 4.',
      'Task 5.',
      'And at least three more.',
    ])
  })

  it('a teammate with nothing on record', () => {
    const words = contactWords(
      {
        ...person,
        contact: { ...person.contact, job_title: null, company: null, last_interaction_at: null, interaction_count: 0 },
        is_teammate: true,
        open_actions: [],
        recent_captures: [],
        my_open_actions_from_their_meetings: [],
        recent_email_threads: undefined,
      },
      null,
      clock,
    ).toArray()
    expect(words).toEqual(['Jessa Lin, your teammate.', "There's no history with Jessa yet."])
  })
})
