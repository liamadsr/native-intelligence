import { describe, it, expect } from 'vitest'
import { captureWords, type ActionRow, type CaptureRow, type ParticipantRow } from '../builders/capture'
import type { Clock } from '../when'

// Sunday Sep 27 2026, 3 PM in Los Angeles.
const clock: Clock = { now: new Date('2026-09-27T22:00:00Z'), timeZone: 'America/Los_Angeles' }
const who = { memberId: 'member-me', clock }
const ownEmails = ['liam@dial8.ai', 'liam@work.com']

const NOTES = [
  '## Summary',
  'We agreed to hold the price at $99.<!-- proposal:abc --> Launch moves to **November**.',
  '',
  '## Key points',
  '- Security review is the blocker.',
  '',
  '## Action items',
  '- [ ] Send the revised deck',
].join('\n')

const capture: CaptureRow = {
  id: 'cap-1',
  title: 'Pricing sync',
  summary: null,
  ai_summary: NOTES,
  ai_processed: true,
  started_at: '2026-09-22T21:00:00Z', // Tue 2 PM PDT, this week
  recorded_at: null,
  created_at: '2026-09-22T21:00:00Z',
  participants: [{ name: 'Liam', email: 'liam@dial8.ai' }, { name: 'Invited Only', email: 'inv@x.com', company: 'Initech' }],
  is_eval: false,
}

const me: ParticipantRow = { member_id: 'member-me', external_name: null, external_email: null, company: null, member: { display_name: 'Liam' }, contact: null }
const jessa: ParticipantRow = {
  member_id: null,
  external_name: 'jessa',
  external_email: 'jessa@acme.com',
  company: null,
  member: null,
  contact: { full_name: 'Jessa Lin', company: [{ name: 'Acme' }] },
}
const jordan: ParticipantRow = { member_id: null, external_name: 'Jordan Lee', external_email: 'jordan@acme.com', company: 'Acme', member: null, contact: null }

/** An accepted, open, unassigned action item unless told otherwise. */
const action = (fields: Partial<ActionRow> & { title: string }): ActionRow => ({
  due_at: null,
  confirmation: 'confirmed',
  context_data: null,
  workflow_state: { category: 'unstarted' },
  assignee: null,
  assignees: null,
  assignee_ai_member: null,
  assignee_contact: null,
  ...fields,
})

const deck = action({ title: 'Send the revised deck', assignee: { id: 'member-me', display_name: 'Liam' }, due_at: '2026-10-02' })
const review = action({ title: 'Book the security review', assignee_contact: { full_name: 'Jessa Lin' }, due_at: '2026-09-26' })
const sheet = action({ title: 'Share the pricing sheet', assignee: { id: 'member-jordan', display_name: 'Jordan Lee' }, workflow_state: { category: 'completed' } })

describe('captureWords', () => {
  it('what it was and who was in it, its own summary, then the action items accepted from it', () => {
    const words = captureWords(
      {
        capture,
        participants: [me, jessa, jordan],
        actions: [
          deck,
          review,
          sheet,
          action({ title: 'Book a venue', workflow_state: { category: 'canceled' } }),
          action({ title: 'Maybe a webinar', confirmation: 'suggested' }),
        ],
        suggested: 1,
        ownEmails,
      },
      who,
    ).toArray()
    expect(words).toEqual([
      'Pricing sync, on Tuesday, with Jessa Lin and Jordan Lee from Acme.',
      'We agreed to hold the price at $99.',
      'Launch moves to November.',
      'Three action items were accepted from it.',
      'Send the revised deck, assigned to you, due on Friday.',
      'Book the security review, assigned to Jessa Lin, overdue since yesterday.',
      'Share the pricing sheet, done.',
      'Two more suggested action items are waiting for your review.',
    ])
  })

  it('one accepted action item in a sentence; past five, "and N more"', () => {
    const one = captureWords({ capture, participants: [me, jessa], actions: [deck], suggested: 0, ownEmails }, who).toArray()
    expect(one.slice(3)).toEqual(['One action item was accepted from it: Send the revised deck, assigned to you, due on Friday.'])

    const many = captureWords(
      {
        capture,
        participants: [me, jessa],
        actions: Array.from({ length: 7 }, (_, i) => action({ title: `Task ${i + 1}` })),
        suggested: 0,
        ownEmails,
      },
      who,
    ).toArray()
    expect(many.slice(3)).toEqual([
      'Seven action items were accepted from it.',
      'Task 1.',
      'Task 2.',
      'Task 3.',
      'Task 4.',
      'Task 5.',
      'And two more.',
    ])
  })

  it('suggestions alone: waiting for review', () => {
    const words = captureWords({ capture, participants: [me, jessa], actions: [], suggested: 2, ownEmails }, who).toArray()
    expect(words.slice(3)).toEqual(['Two suggested action items are waiting for your review.'])
  })

  it('never reads an email address, and never names the user under one of their own', () => {
    const byAddress: ParticipantRow = { member_id: null, external_name: 'jessa.lin@gmail.com', external_email: 'jessa.lin@gmail.com', company: null, member: null, contact: null }
    const myOtherAddress: ParticipantRow = { member_id: null, external_name: 'liam@work.com', external_email: 'LIAM@work.com', company: null, member: null, contact: null }
    const words = captureWords(
      { capture: { ...capture, ai_summary: '## Summary\nWe sent sam.o@gmail.com the deck.' }, participants: [me, myOtherAddress, byAddress], actions: [], suggested: 0, ownEmails },
      who,
    ).toArray()
    expect(words).toEqual(['Pricing sync, on Tuesday, with Jessa Lin.', 'We sent Sam O the deck.'])

    const invited = captureWords(
      {
        capture: { ...capture, participants: [{ name: 'liam@work.com', email: 'liam@work.com' }, { name: 'jordan.lee@gmail.com', email: 'jordan.lee@gmail.com' }] },
        participants: [],
        actions: [],
        suggested: 0,
        ownEmails,
      },
      who,
    ).toArray()
    expect(invited[0]).toBe('Pricing sync, on Tuesday, with Jordan Lee.')
  })

  it('people from several companies are just named; the invite stands in without participants, the user left out', () => {
    const mixed = captureWords(
      { capture, participants: [jessa, { ...jordan, company: 'Initech' }], actions: [], suggested: 0, ownEmails },
      who,
    ).toArray()
    expect(mixed[0]).toBe('Pricing sync, on Tuesday, with Jessa Lin and Jordan Lee.')

    const invited = captureWords({ capture, participants: [], actions: [], suggested: 0, ownEmails }, who).toArray()
    expect(invited[0]).toBe('Pricing sync, on Tuesday, with Invited Only from Initech.')
  })

  it('a voice note, and notes not ready or still being written', () => {
    const note = { ...capture, title: null, participants: null, ai_summary: null, ai_processed: false }
    expect(captureWords({ capture: note, participants: [me], actions: [], suggested: 0, ownEmails }, who).toArray()).toEqual([
      'Untitled capture, recorded on Tuesday.',
      "Its notes aren't ready yet.",
    ])

    const streaming = { ...capture, ai_summary: '{{streaming}}' }
    expect(captureWords({ capture: streaming, participants: [me, jessa], actions: [], suggested: 0, ownEmails }, who).toArray()).toEqual([
      'Pricing sync, on Tuesday, with Jessa Lin from Acme.',
      'Its notes are still being written.',
    ])
  })
})
