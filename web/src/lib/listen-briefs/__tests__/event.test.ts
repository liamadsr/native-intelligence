import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { gatherPersonContext, type PersonContext } from '@/lib/crm/person-context'
import { captureSpeech } from '../builders/capture'
import {
  MAX_GUESTS,
  agendaOf,
  eventSpeech,
  eventWords,
  inviteSays,
  parseEventInput,
  pickPrevious,
  recordsThisMeeting,
  resolveAttendees,
  seriesKeys,
  type ContactMatch,
  type EventInput,
  type FollowUpRow,
  type PreviousMeeting,
  type PriorCapture,
} from '../builders/event'
import type { BriefContext } from '../context'
import { Speech } from '../speech'
import type { Clock } from '../when'

vi.mock('@/lib/crm/person-context', () => ({ gatherPersonContext: vi.fn() }))
vi.mock('../builders/capture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../builders/capture')>()),
  captureSpeech: vi.fn(),
}))

// Sunday Sep 27 2026, 3 PM in Los Angeles.
const clock: Clock = { now: new Date('2026-09-27T22:00:00Z'), timeZone: 'America/Los_Angeles' }
const who = { memberId: 'member-me', clock }
const LINKED = '3f1c2a9e-1b2c-4d3e-8f90-123456789abc'

function parsed(input: unknown): EventInput {
  const event = parseEventInput(input)
  if (!event) throw new Error('expected an event')
  return event
}

/** What the brief says about an invite, with what the workspace found. */
function wordsFor(
  input: unknown,
  found: { contacts?: ContactMatch[]; ownEmails?: string[]; previous?: PreviousMeeting | null; people?: PersonContext[] } = {},
): string[] {
  const event = parsed(input)
  const attendees = resolveAttendees(event, {
    contacts: found.contacts ?? [],
    ownEmails: found.ownEmails ?? ['liam@dial8.ai'],
    memberId: 'member-me',
  })
  return eventWords({ event, attendees, previous: found.previous ?? null, people: found.people ?? [] }, who).toArray()
}

const pricingSync = {
  title: 'Pricing sync',
  start: '2026-09-27T22:25:00.000Z', // 3:25 PM PDT
  end: '2026-09-27T22:55:00.000Z',
  isAllDay: false,
  location: 'https://acme.zoom.us/j/8123456789',
  hasVideoCall: true,
  description:
    '<p>Agenda: the new tiers &amp; the launch date</p><br>Join Zoom Meeting<br><a href="https://acme.zoom.us/j/8123456789">https://acme.zoom.us/j/8123456789</a><br>Meeting ID: 812 345 6789',
  attendees: [
    { email: 'Liam@Dial8.ai', name: 'Liam', responseStatus: 'accepted' },
    { email: 'jessa@acme.com', name: 'Jessa', responseStatus: 'accepted' },
    { email: 'jordan.lee@acme.com', responseStatus: 'declined' },
    { email: 'sam@dial8.ai', responseStatus: 'tentative' },
    { email: 'c_1888@resource.calendar.google.com', name: 'Room 4B' },
  ],
  organizer: 'jessa@acme.com',
  icalUid: 'abc123@google.com',
  seriesMasterId: 'abc123',
}

const contacts: ContactMatch[] = [
  {
    id: 'contact-jessa',
    full_name: 'Jessa Lin',
    email: 'jessa@acme.com',
    secondary_emails: null,
    job_title: 'Head of Ops',
    member_id: null,
    company: { name: 'Acme' },
  },
  // A teammate's own contact, reached by their other address.
  {
    id: 'contact-sam',
    full_name: 'Sam Park',
    email: 'sam.park@dial8.ai',
    secondary_emails: ['sam@dial8.ai'],
    job_title: null,
    member_id: 'member-sam',
    company: [{ name: 'Dial8' }],
  },
]

/** An action from a meeting: open, not assigned, unless told otherwise. */
function followUp(fields: Partial<FollowUpRow> & { id: string; title: string }): FollowUpRow {
  return {
    due_at: null,
    priority: null,
    assignee_id: null,
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

const lastTime: PreviousMeeting = {
  via: 'series',
  capture: {
    id: 'cap-prev',
    title: 'Pricing sync',
    ai_summary: 'We agreed to hold the price at $99.\n\nLaunch moves to November.\n\nJessa owns the deck.',
    summary: null,
    started_at: '2026-09-22T21:00:00Z', // Tue 2 PM PDT
    occurrence_start: '2026-09-22T21:00:00Z',
  },
  followUps: [
    followUp({ id: 'act-deck', title: 'Send the revised deck', assignee_contact: { full_name: 'Jessa Lin' }, workflow_state: { category: 'started' } }),
    followUp({ id: 'act-questionnaire', title: 'Share the security questionnaire', assignee_id: 'member-me', assignee: me, workflow_state: [{ category: 'unstarted' }] }),
    followUp({ id: 'act-booked', title: 'Book the room', assignee_id: 'member-me', assignee: me, workflow_state: { category: 'completed' } }),
  ],
}

const jessa: PersonContext = {
  contact: {
    id: 'contact-jessa',
    workspace_id: 'ws-1',
    full_name: 'Jessa Lin',
    email: 'jessa@acme.com',
    secondary_emails: null,
    job_title: 'Head of Ops',
    member_id: null,
    visibility: 'workspace',
    relationship_type: 'customer',
    relationship_strength: 'strong',
    last_interaction_at: '2026-09-22T21:00:00Z',
    interaction_count: 6,
    enrichment_status: null,
    company: { id: 'co-1', name: 'Acme', domain: 'acme.com' },
  },
  is_teammate: false,
  // Hers are left out of the brief: only what waits on the user is said.
  open_actions: [
    {
      id: 'act-order',
      identifier: 'GEN-2',
      title: 'Sign the order form',
      status: 'Todo',
      status_category: 'unstarted',
      due_at: '2026-10-02',
      priority: null,
      confirmation: 'confirmed',
      assigned_via: 'contact',
    },
  ],
  pending_commitments: [],
  recent_captures: [],
  my_open_actions_from_their_meetings: [
    // Already counted as still open from last time.
    {
      id: 'act-questionnaire',
      identifier: 'GEN-3',
      title: 'Share the security questionnaire',
      status: 'Todo',
      due_at: null,
      source_capture_title: 'Pricing sync',
    },
    {
      id: 'act-tiers',
      identifier: 'GEN-4',
      title: 'Send Jessa the pricing tiers',
      status: 'Todo',
      due_at: '2026-09-27',
      source_capture_title: 'Kickoff',
    },
  ],
  recent_email_threads: [
    {
      id: 'thread-security',
      subject: 'Security review',
      last_message_at: '2026-09-26T16:00:00Z', // Sat 9 AM PDT
      needs_reply: true,
      from_email: 'jessa@acme.com',
      message_count: 3,
    },
    {
      id: 'thread-invoice',
      subject: 'Invoice',
      last_message_at: '2026-09-25T16:00:00Z',
      needs_reply: false,
      from_email: 'jessa@acme.com',
      message_count: 1,
    },
  ],
  decisions: [],
}

describe('eventWords', () => {
  it('preps a meeting: when and where, who, the invite, last time, and what waits on the user', () => {
    expect(wordsFor(pricingSync, { contacts, previous: lastTime, people: [jessa] })).toEqual([
      'Pricing sync, in about 25 minutes, on a video call.',
      'With Jessa Lin from Acme and Sam Park.',
      'Jessa organized it.',
      'Jordan declined.',
      'The invite says: Agenda: the new tiers & the launch date.',
      'You last met on Tuesday.',
      'We agreed to hold the price at $99.',
      'Launch moves to November.',
      'Two action items from that meeting are still open, one of them yours.',
      'Send the revised deck, assigned to Jessa Lin.',
      'Share the security questionnaire, assigned to you.',
      "Jessa's email about Security review is waiting on your reply.",
      'You have one action open from your meetings with Jessa: Send Jessa the pricing tiers, due today.',
    ])
  })

  it('reads the open items most pressing first, and "at least" at the most the gatherer reads', () => {
    const late = followUp({ id: 'act-late', title: 'Sign the order form', due_at: '2026-09-24', assignee_contact: { full_name: 'Jessa Lin' } })
    const mine = Array.from({ length: 5 }, (_, i) => ({ ...jessa.my_open_actions_from_their_meetings[1], id: `act-${i}`, title: `Task ${i + 1}`, due_at: null }))
    const words = wordsFor(pricingSync, {
      contacts,
      previous: { ...lastTime, followUps: [...lastTime.followUps, late] },
      people: [{ ...jessa, recent_email_threads: [], my_open_actions_from_their_meetings: mine }],
    })
    expect(words.slice(words.indexOf('Three action items from that meeting are still open, one of them yours.'))).toEqual([
      'Three action items from that meeting are still open, one of them yours.',
      'Sign the order form, assigned to Jessa Lin, overdue since Thursday.',
      'Send the revised deck, assigned to Jessa Lin.',
      'Share the security questionnaire, assigned to you.',
      'You have at least five actions open from your meetings with Jessa.',
      'Task 1.',
      'Task 2.',
      'Task 3.',
      'Task 4.',
      'Task 5.',
    ])
  })

  it('says little about an event with nothing but a time, and never its title twice', () => {
    expect(wordsFor({ title: 'Focus time', start: '2026-09-28T17:00:00Z', end: '2026-09-28T18:00:00Z' })).toEqual([
      'Focus time, tomorrow at 10 AM.',
    ])
    expect(wordsFor({ title: 'Focus time', start: '2026-09-28T17:00:00Z', description: 'Focus time.\nNo meetings, please.' })).toEqual([
      'Focus time, tomorrow at 10 AM.',
      'The invite says: No meetings, please.',
    ])
    // No title of its own.
    expect(wordsFor({ start: '2026-09-28T17:00:00Z', attendees: [{ email: 'bo@beta.io' }] })).toEqual([
      'Untitled event, tomorrow at 10 AM.',
      'With Bo.',
    ])
  })

  it('knows the user by their own member contact, and says when they said no', () => {
    const self: ContactMatch = {
      id: 'contact-me',
      full_name: 'Liam Alizadeh',
      email: 'me.personal@gmail.com',
      secondary_emails: null,
      job_title: null,
      member_id: 'member-me',
      company: null,
    }
    // Microsoft leaves the organizer off the attendee list; the user set it up.
    const organized = wordsFor(
      {
        title: 'Intro call',
        start: '2026-09-28T17:00:00Z',
        location: 'Blue Bottle, Hayes Valley',
        attendees: [{ email: 'bo@beta.io', name: 'Bo Chen' }],
        organizer: 'me.personal@gmail.com',
      },
      { contacts: [self], ownEmails: [] },
    )
    expect(organized).toEqual(['Intro call, tomorrow at 10 AM, at Blue Bottle, Hayes Valley.', 'With Bo Chen.'])

    const declined = wordsFor({
      title: 'All hands',
      start: '2026-09-28T17:00:00Z',
      attendees: [{ email: 'liam@dial8.ai', responseStatus: 'declined' }, { email: 'bo@beta.io' }],
    })
    expect(declined).toEqual(['All hands, tomorrow at 10 AM.', 'With Bo.', 'You declined it.'])
  })

  it('says a room with a call, and a Teams "location", as where it is', () => {
    const at = (location: string, hasVideoCall: boolean) =>
      wordsFor({ title: 'Review', start: '2026-09-28T17:00:00Z', location, hasVideoCall })[0]
    expect(at('Room 4B', true)).toBe('Review, tomorrow at 10 AM, at Room 4B or on a video call.')
    expect(at('Microsoft Teams Meeting', true)).toBe('Review, tomorrow at 10 AM, on a video call.')
    expect(at('Zoom: https://zoom.us/j/1', false)).toBe('Review, tomorrow at 10 AM, on a video call.')
  })

  it('names a few people and counts the rest, the ones the client did not send too', () => {
    // An audience: who of them declined goes unsaid.
    const guests = Array.from({ length: 12 }, (_, i) => ({ email: `guest${i}@beta.io`, responseStatus: i === 5 ? 'declined' : undefined }))
    expect(wordsFor({ title: 'Webinar', start: '2026-09-28T17:00:00Z', attendees: guests })).toEqual([
      'Webinar, tomorrow at 10 AM.',
      'With Guest0, Guest1 and nine others.',
    ])

    // The client sends MAX_GUESTS of them, and how many there are in all.
    const many = Array.from({ length: 40 }, (_, i) => ({ email: `guest${i}@beta.io` }))
    expect(wordsFor({ title: 'Webinar', start: '2026-09-28T17:00:00Z', attendees: many, attendeeCount: 120 })[1]).toBe(
      'With Guest0, Guest1 and 118 others.',
    )

    // A few from one company: the company said once.
    const acme = [{ email: 'jessa@acme.com' }, { email: 'jordan.lee@acme.com' }]
    const both: ContactMatch[] = [contacts[0], { ...contacts[0], id: 'contact-jordan', full_name: 'Jordan Lee', email: 'jordan.lee@acme.com' }]
    expect(wordsFor({ title: 'QBR', start: '2026-09-28T17:00:00Z', attendees: acme }, { contacts: both })[1]).toBe(
      'With Jessa Lin and Jordan Lee from Acme.',
    )
  })

  it('says a meeting is happening now, with when it started and ends', () => {
    expect(
      wordsFor({
        title: 'Standup',
        start: '2026-09-27T21:50:00Z',
        end: '2026-09-27T22:20:00Z',
        hasVideoCall: true,
        attendees: [{ email: 'sam@dial8.ai' }],
      }),
    ).toEqual(['Standup is happening now.', 'It started about 10 minutes ago and ends in about 20 minutes.', 'With Sam.'])
  })

  it('says all-day events by the day, however the provider wrote the date', () => {
    const allDay = (title: string, start: string, end: string) => wordsFor({ title, start, end, isAllDay: true })
    expect(allDay('Offsite', '2026-09-28T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).toEqual([
      'Offsite, from tomorrow through Wednesday.',
    ])
    // 3 PM in LA is already tomorrow in UTC: still today.
    expect(allDay('OOO', '2026-09-27', '2026-09-28')).toEqual(['OOO, today, all day.'])
    expect(allDay('Conference', '2026-09-25', '2026-09-29')).toEqual(['Conference, from Friday through tomorrow.'])
    expect(allDay('Retreat', '2026-09-21', '2026-09-22')).toEqual(['Retreat was on Monday.'])
  })

  it('falls back to the last meeting with the guests, before one that is over, and skips notes still streaming', () => {
    const words = wordsFor(
      { title: 'Intro call', start: '2026-09-26T17:00:00Z', attendees: [{ email: 'bo@beta.io', name: 'Bo Chen' }] },
      {
        previous: {
          via: 'guests',
          capture: {
            id: 'cap-kickoff',
            title: null,
            ai_summary: '{{streaming}}',
            summary: null,
            started_at: '2026-09-03T17:00:00Z',
            occurrence_start: null,
          },
          followUps: [followUp({ id: 'act-done', title: 'Send the notes', assignee_id: 'member-me', assignee: me, workflow_state: { category: 'canceled' } })],
        },
      },
    )
    expect(words).toEqual([
      'Intro call was yesterday at 10 AM.',
      'With Bo Chen.',
      'Before that, your last meeting with Bo was 3 weeks ago.',
    ])
  })

  it('names the series meeting when it went by another title, and counts several emails', () => {
    const renamed: PreviousMeeting = {
      ...lastTime,
      capture: { ...lastTime.capture, title: 'Pricing kickoff', ai_summary: null, summary: 'Scoped the tiers.' },
      followUps: [followUp({ id: 'act-mine', title: 'Book the pilot kickoff', assignee_id: 'member-me', assignee: me, workflow_state: { category: 'started' } })],
    }
    const busy: PersonContext = {
      ...jessa,
      my_open_actions_from_their_meetings: [],
      recent_email_threads: jessa.recent_email_threads?.map((t) => ({ ...t, needs_reply: true })),
    }
    expect(wordsFor({ title: 'Pricing sync', start: pricingSync.start }, { previous: renamed, people: [busy] })).toEqual([
      'Pricing sync, in about 25 minutes.',
      'You last met on Tuesday, in Pricing kickoff.',
      'Scoped the tiers.',
      'One action item from that meeting is still open: Book the pilot kickoff, assigned to you.',
      'Two emails from Jessa are waiting on your reply.',
    ])
  })
})

describe('inviteSays', () => {
  it('says a list as one sentence with the line that leads into it, and skips a greeting', () => {
    expect(
      inviteSays(
        'Hi all,<br><br>Agenda:<ul><li>The new tiers.</li><li>The launch date</li><li>Q&amp;A</li></ul>Join Zoom Meeting<br>https://zoom.us/j/1',
      ),
    ).toEqual(['Agenda: The new tiers, The launch date and Q&A'])
    // Plain lines under a label, then prose.
    expect(inviteSays('Agenda:\nPricing\nLaunch date\n\nPlease come prepared. Bring the deck.')).toEqual([
      'Agenda: Pricing and Launch date',
      'Please come prepared.',
    ])
    expect(inviteSays('- A\n- B\n- C\n- D\n- E')).toEqual(['A, B, C and two more'])
  })

  it('takes the first two sentences of prose, and nothing from an empty invite', () => {
    expect(inviteSays('Walk through the Q4 numbers. Then decide on pricing. Bring the deck.')).toEqual([
      'Walk through the Q4 numbers.',
      'Then decide on pricing.',
    ])
    expect(inviteSays('Join Zoom Meeting\nhttps://zoom.us/j/1')).toEqual([])
    expect(inviteSays(null)).toEqual([])
  })
})

describe('parseEventInput', () => {
  it('refuses what is not an event', () => {
    expect(parseEventInput(null)).toBeNull()
    expect(parseEventInput('Pricing sync')).toBeNull()
    expect(parseEventInput([pricingSync])).toBeNull()
    expect(parseEventInput({ title: 'No start' })).toBeNull()
    expect(parseEventInput({ title: 'Bad start', start: 'next tuesday-ish' })).toBeNull()
    expect(parseEventInput({ title: 'Huge start', start: '2026-09-28T17:00:00Z'.repeat(3) })).toBeNull()
    // Nothing to say beyond a time.
    expect(parseEventInput({ title: '(No title)', start: '2026-09-28T17:00:00Z' })).toBeNull()
  })

  it('drops junk fields and junk guests one by one, and cuts text to size', () => {
    const event = parsed({
      title: `  Pricing\n sync ${'x'.repeat(400)}`,
      start: '2026-09-28T17:00:00Z',
      end: 12,
      isAllDay: 'yes',
      location: { lat: 1 },
      hasVideoCall: true,
      description: 'd'.repeat(10000),
      attendees: [
        { email: ' Jessa@Acme.com ', name: 'Jessa   Lin', responseStatus: 'accepted' },
        { email: 'jessa@acme.com' },
        { email: 'not-an-email' },
        'junk',
        null,
        { email: 'c_1@resource.calendar.google.com' },
        { email: 'bo@beta.io', name: 7, responseStatus: {} },
      ],
      attendeeCount: -3,
      organizer: 'nobody',
      icalUid: '',
      seriesMasterId: 'm'.repeat(600),
      linkedCaptureId: '../../x',
      extra: 'ignored',
    })
    expect(event.title?.startsWith('Pricing sync xxx')).toBe(true)
    expect(event.title).toHaveLength(300)
    expect(event.description).toHaveLength(4000)
    expect(event.attendees).toEqual([
      { email: 'jessa@acme.com', name: 'Jessa Lin', responseStatus: 'accepted' },
      { email: 'bo@beta.io' },
    ])
    expect(event).toMatchObject({ start: '2026-09-28T17:00:00Z', hasVideoCall: true })
    for (const dropped of ['end', 'isAllDay', 'location', 'attendeeCount', 'organizer', 'icalUid', 'seriesMasterId', 'linkedCaptureId', 'extra']) {
      expect(event).not.toHaveProperty(dropped, expect.anything())
    }
  })

  it('keeps at most MAX_GUESTS guests, and a real linked capture id', () => {
    const event = parsed({
      start: '2026-09-28T17:00:00Z',
      attendees: Array.from({ length: 50 }, (_, i) => ({ email: `g${i}@beta.io` })),
      linkedCaptureId: LINKED,
    })
    expect(event.attendees).toHaveLength(MAX_GUESTS)
    expect(event.linkedCaptureId).toBe(LINKED)
  })
})

describe('meeting history', () => {
  const event = parsed({
    title: 'Pricing sync',
    start: '2026-09-29T21:00:00Z',
    end: '2026-09-29T21:30:00Z',
    linkedCaptureId: LINKED,
  })
  const capture = (id: string, started: string | null, occurrence: string | null): PriorCapture => ({
    id,
    title: id,
    ai_summary: null,
    summary: null,
    started_at: started,
    occurrence_start: occurrence,
  })

  it('picks the newest meeting from before this one, never this one', () => {
    const picked = pickPrevious(
      [
        capture(LINKED, '2026-09-22T21:00:00Z', null),
        capture('teammate-same-call', '2026-09-29T21:02:00Z', '2026-09-29T21:00:00Z'),
        capture('started-early', '2026-09-29T20:50:00Z', null),
        capture('two-weeks-ago', '2026-09-15T21:00:00Z', '2026-09-15T21:00:00Z'),
        capture('last-week', '2026-09-22T21:05:00Z', '2026-09-22T21:00:00Z'),
        capture('never-started', null, null),
      ],
      event,
    )
    expect(picked?.id).toBe('last-week')
    expect(pickPrevious([], event)).toBeNull()
  })

  it('takes a linked capture as the recording only once it started, and of this occurrence', () => {
    expect(recordsThisMeeting(null, event)).toBe(false)
    expect(recordsThisMeeting({ started_at: null, occurrence_start: '2026-09-29T21:00:00Z' }, event)).toBe(false)
    expect(recordsThisMeeting({ started_at: '2026-09-29T21:03:00Z', occurrence_start: '2026-09-29T21:00:00Z' }, event)).toBe(true)
    expect(recordsThisMeeting({ started_at: '2026-09-29T20:55:00Z', occurrence_start: null }, event)).toBe(true)
    // An EventKit series shares one event id: last week's recording isn't this one.
    expect(recordsThisMeeting({ started_at: '2026-09-22T21:00:00Z', occurrence_start: '2026-09-22T21:00:00Z' }, event)).toBe(false)
  })

  it('finds the series by its master id, the one a Google instance id carries, the iCal UID and the event id', () => {
    expect(seriesKeys('evt-1', { ...event, seriesMasterId: 'master', icalUid: 'uid@google.com' })).toEqual([
      { column: 'series_key', value: 'master' },
      { column: 'ical_uid', value: 'uid@google.com' },
      { column: 'calendar_event_id', value: 'evt-1' },
    ])
    expect(seriesKeys('abc123_20260929T210000Z', event)).toEqual([
      { column: 'series_key', value: 'abc123' },
      { column: 'calendar_event_id', value: 'abc123_20260929T210000Z' },
    ])
  })
})

describe('agendaOf', () => {
  it('cuts the conferencing text calendars append, and drops links', () => {
    expect(
      agendaOf(
        'Walk through Q4.\nDeck: https://docs.google.com/x\n\n-::~:~::~:~:~:~:~:~:~::~:~::-\nJoin with Google Meet: https://meet.google.com/abc-defg-hij\nPlease do not edit this section.',
      ),
    ).toBe('Walk through Q4.\nDeck:')
    expect(
      agendaOf('Quarterly review\n________________________________________________________________________________\nMicrosoft Teams meeting\nJoin on your computer'),
    ).toBe('Quarterly review')
    expect(agendaOf('Join Zoom Meeting\nhttps://zoom.us/j/1\nMeeting ID: 1')).toBeNull()
    expect(agendaOf('<ul><li>Pricing</li><li>Launch &lt;date&gt;</li></ul>')).toBe('- Pricing\n- Launch <date>')
    // A list starts on a line of its own.
    expect(agendaOf('Agenda:<ol><li>Pricing</li></ol>')).toBe('Agenda:\n- Pricing')
    expect(agendaOf('Is 3 < 5 and 7 > 2? Yes.')).toBe('Is 3 < 5 and 7 > 2? Yes.')
    expect(agendaOf(null)).toBeNull()
  })
})

// ── eventSpeech, on a stub client ────────────────────────────────────────────

type Call = [method: string, args: unknown[]]
type Answer = { data: unknown; error: { message: string } | null }
const ok = (data: unknown): Answer => ({ data, error: null })

/** Whether a read was built with `method(...args)` (args as a prefix). */
function has(calls: Call[], method: string, ...args: unknown[]): boolean {
  return calls.some(([m, a]) => m === method && args.every((arg, i) => a[i] === arg))
}

/** A client whose every read resolves to what `answer` says for its table and
 *  the filters it was built with; `reads` keeps them for asserting. */
function stubClient(answer: (table: string, calls: Call[]) => Answer) {
  const reads: Array<{ table: string; calls: Call[] }> = []
  const client = {
    from(table: string) {
      const read = { table, calls: [] as Call[] }
      reads.push(read)
      const chain: object = new Proxy(
        {},
        {
          get(_target, method: string) {
            if (method === 'then') {
              const result = Promise.resolve(answer(table, read.calls))
              return result.then.bind(result)
            }
            return (...args: unknown[]) => {
              read.calls.push([method, args])
              if (method !== 'maybeSingle') return chain
              const { data, error } = answer(table, read.calls)
              return Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error })
            }
          },
        },
      )
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, reads }
}

const service = { from: () => undefined } as unknown as SupabaseClient
const ctxWith = (supabase: SupabaseClient, userEmail: string | null = null): BriefContext => ({
  supabase,
  service,
  workspaceId: 'ws-1',
  userId: 'user-1',
  memberId: 'member-me',
  userEmail,
  clock,
})

// Earlier today, 1 PM PDT: over by the time it is opened.
const earlier = { ...pricingSync, start: '2026-09-27T20:00:00.000Z', end: '2026-09-27T20:30:00.000Z', linkedCaptureId: LINKED }

describe('eventSpeech', () => {
  beforeEach(() => {
    vi.mocked(captureSpeech).mockReset()
    vi.mocked(gatherPersonContext).mockReset()
  })

  it('says what came of a meeting that is over and was recorded', async () => {
    const { client } = stubClient((table, calls) =>
      table === 'captures' && has(calls, 'eq', 'id', LINKED)
        ? ok({ started_at: '2026-09-27T20:02:00Z', occurrence_start: '2026-09-27T20:00:00Z' })
        : ok([]),
    )
    const recording = new Speech().say('Pricing sync, today at 1 PM, with Jessa Lin from Acme')
    vi.mocked(captureSpeech).mockResolvedValueOnce(recording)

    expect(await eventSpeech(ctxWith(client), 'evt-1', earlier)).toBe(recording)
    expect(captureSpeech).toHaveBeenCalledWith(expect.anything(), LINKED)
  })

  it('preps from the calendar when the linked capture was never recorded, and a failing read only loses its part', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = stubClient((table, calls) => {
      if (table === 'captures' && has(calls, 'eq', 'id', LINKED)) return ok({ started_at: null, occurrence_start: null })
      if (table === 'contact') return { data: null, error: { message: 'boom' } }
      if (table === 'connected_account') return ok([{ account_email: 'Liam@Dial8.ai' }])
      if (table === 'captures' && has(calls, 'eq', 'series_key', 'abc123')) return ok([lastTime.capture])
      if (table === 'actions' && has(calls, 'eq', 'source_capture_id', 'cap-prev')) return ok(lastTime.followUps)
      return ok([])
    })

    const words = (await eventSpeech(ctxWith(client), 'evt-1', earlier))?.toArray()
    expect(captureSpeech).not.toHaveBeenCalled()
    // No CRM: the invite's own names, and the user known by a connected account.
    expect(words).toEqual([
      'Pricing sync was today at 1 PM.',
      'With Jessa and Sam.',
      'Jessa organized it.',
      'Jordan declined.',
      'The invite says: Agenda: the new tiers & the launch date.',
      'Before that, you met on Tuesday.',
      'We agreed to hold the price at $99.',
      'Launch moves to November.',
      'Two action items from that meeting are still open, one of them yours.',
      'Send the revised deck, assigned to Jessa Lin.',
      'Share the security questionnaire, assigned to you.',
    ])
    expect(warn).toHaveBeenCalledWith('[listen-brief] contacts failed:', 'boom')
    expect(gatherPersonContext).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("falls back to the last meeting with the guests, and gathers what's open with those in the CRM", async () => {
    vi.mocked(gatherPersonContext).mockResolvedValue(jessa)
    const { client, reads } = stubClient((table, calls) => {
      if (table === 'contact' && has(calls, 'in', 'email')) return ok([contacts[0]])
      if (table === 'captures' && has(calls, 'in', 'cp.external_email')) {
        return ok([{ id: 'cap-kickoff', title: 'Kickoff', ai_summary: 'Scoped the pilot.', summary: null, started_at: '2026-09-03T17:00:00Z', occurrence_start: null }])
      }
      return ok([])
    })
    const oneOff = {
      title: 'Pricing sync',
      start: pricingSync.start,
      end: pricingSync.end,
      attendees: [{ email: 'liam@dial8.ai' }, { email: 'jessa@acme.com' }, { email: 'jordan.lee@acme.com' }],
    }

    // No connected accounts: the user is known by their sign-in address.
    const words = (await eventSpeech(ctxWith(client, 'Liam@Dial8.ai'), 'evt-2', oneOff))?.toArray()
    expect(words).toEqual([
      'Pricing sync, in about 25 minutes.',
      'With Jessa Lin from Acme and Jordan Lee.',
      'Your last meeting with them was Kickoff, 3 weeks ago.',
      'Scoped the pilot.',
      "Jessa's email about Security review is waiting on your reply.",
      'You have two actions open from your meetings with Jessa.',
      'Send Jessa the pricing tiers, due today.',
      'Share the security questionnaire.',
    ])
    expect(gatherPersonContext).toHaveBeenCalledTimes(1)
    expect(gatherPersonContext).toHaveBeenCalledWith(service, {
      workspaceId: 'ws-1',
      userId: 'user-1',
      contactId: 'contact-jessa',
      requester: 'user-1',
    })
    // Guests' meetings by the addresses they joined with (never the user's),
    // fenced like any capture read.
    const withGuests = reads.find((r) => r.table === 'captures' && has(r.calls, 'in', 'cp.external_email'))
    expect(withGuests?.calls).toContainEqual(['in', ['cp.external_email', ['jessa@acme.com', 'jordan.lee@acme.com']]])
    expect(withGuests?.calls).toContainEqual(['or', ['visibility.eq.workspace,user_id.eq.user-1']])
    expect(withGuests?.calls).toContainEqual(['neq', ['is_eval', true]])
  })

  it('refuses junk input without reading anything', async () => {
    const { client, reads } = stubClient(() => ok([]))
    expect(await eventSpeech(ctxWith(client), 'evt-3', { title: 'No start' })).toBeNull()
    expect(reads).toHaveLength(0)
  })
})
