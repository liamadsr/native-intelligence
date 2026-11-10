import { describe, it, expect } from 'vitest'
import type {
  CompanyContext,
  CompanyContextCompany,
  CompanyEmailThread,
  CompanyOpenAction,
  CompanyPerson,
} from '@/lib/crm/company-context'
import { companyWords, type CompanyExtra } from '../builders/company'
import type { Clock } from '../when'

// Sunday Sep 27 2026, 3 PM in Los Angeles.
const clock: Clock = { now: new Date('2026-09-27T22:00:00Z'), timeZone: 'America/Los_Angeles' }
const who = { memberId: 'member-me', clock }
const NONE: ReadonlySet<string> = new Set()

const person = (over: Partial<CompanyPerson>): CompanyPerson => ({
  id: 'c-x',
  full_name: null,
  email: null,
  job_title: null,
  relationship_strength: null,
  interaction_count: null,
  last_interaction_at: null,
  member_id: null,
  is_teammate: false,
  ...over,
})

const action = (over: Partial<CompanyOpenAction>): CompanyOpenAction => ({
  id: 'act-x',
  identifier: null,
  title: 'Untitled',
  status: 'Todo',
  status_category: 'unstarted',
  due_at: null,
  priority: null,
  confirmation: 'confirmed',
  assigned_via: 'contact',
  assignee_contact_id: null,
  assignee_name: null,
  ...over,
})

const thread = (over: Partial<CompanyEmailThread>): CompanyEmailThread => ({
  id: 't-x',
  subject: null,
  last_message_at: '2026-09-26T16:00:00Z',
  needs_reply: true,
  from_email: null,
  message_count: 1,
  ...over,
})

const account = (over: Partial<CompanyContext> = {}, company: Partial<CompanyContextCompany> = {}): CompanyContext => ({
  company: {
    id: 'co-1',
    workspace_id: 'ws-1',
    name: 'Acme',
    domain: 'acme.com',
    website: null,
    industry: null,
    description: null,
    employee_count_range: null,
    annual_revenue_range: null,
    city: null,
    state: null,
    country: null,
    tags: null,
    created_at: null,
    updated_at: null,
    ...company,
  },
  people: [],
  people_on_record: 0,
  people_visible: 0,
  last_interaction_at: null,
  open_actions: [],
  pending_commitments: [],
  recent_captures: [],
  decisions: [],
  ...over,
})

const words = (of: CompanyContext, extra: CompanyExtra | null = null, mine: ReadonlySet<string> = NONE) =>
  companyWords({ account: of, extra, mine }, who).toArray()

describe('companyWords', () => {
  it('says what they are and do, who you know there, when you last met, what is open and what waits on your reply', () => {
    expect(
      words(
        account(
          {
            people: [
              person({ id: 'c-jessa', full_name: 'Jessa Lin', email: 'jessa@acme.com', job_title: 'Head of Ops', interaction_count: 14 }),
              person({ id: 'c-jordan', full_name: 'Jordan Lee', email: 'jordan@acme.com', job_title: 'VP Sales', interaction_count: 6 }),
              person({ id: 'c-sam', full_name: 'Sam Park', email: 'sam@acme.com' }),
              person({ id: 'c-priya', full_name: 'Priya Nair', email: 'priya@acme.com', job_title: 'CFO' }),
            ],
            people_on_record: 5,
            people_visible: 4,
            last_interaction_at: '2026-09-26T22:30:00Z',
            recent_captures: [
              { id: 'cap-1', title: 'Pricing sync', started_at: '2026-09-22T21:00:00Z', ai_summary: '## Summary\nWe held the price.' },
              { id: 'cap-2', title: 'Security review kickoff', started_at: '2026-09-15T16:00:00Z', ai_summary: null },
            ],
            open_actions: [
              action({ id: 'act-1', title: 'Send the revised deck', assignee_contact_id: 'c-jordan', assignee_name: 'Jordan Lee' }),
              action({
                id: 'act-2',
                title: 'Share the SOC 2 report',
                confirmation: 'suggested',
                assignee_contact_id: 'c-jessa',
                assignee_name: 'Jessa Lin',
              }),
            ],
            recent_email_threads: [
              thread({ id: 't-1', subject: 'Security questionnaire', from_email: 'Jessa@Acme.com' }),
              thread({ id: 't-2', subject: 'Re: pricing', needs_reply: false, from_email: 'jordan@acme.com' }),
            ],
            decisions: [{ id: 'd-1', content: 'Hold the price at $99', capture_title: 'Pricing sync', created_at: null }],
          },
          {
            industry: 'Logistics software',
            description: 'Acme builds autonomous forklifts for mid-size warehouses. It was founded in 2019 in Austin.',
            employee_count_range: '51-200',
            city: 'Austin',
          },
        ),
        { is_workspace_company: false, metadata: { enrichment: { summary: 'Acme is a Series B robotics company.' } } },
      ),
    ).toEqual([
      'Acme, Logistics software, 51 to 200 people.',
      'Acme builds autonomous forklifts for mid-size warehouses.',
      'You know four people there, including Jessa Lin and Jordan Lee.',
      'Your latest meeting with them was Pricing sync, on Tuesday.',
      'Two actions are open with people there.',
      'Send the revised deck, assigned to Jordan Lee.',
      'Share the SOC 2 report, assigned to Jessa Lin.',
      "Jessa's email about Security questionnaire is waiting on your reply.",
    ])
  })

  it('a company with no one in your CRM is two short sentences', () => {
    // Two on record, neither visible to the user: never hinted at.
    expect(words(account({ people_on_record: 2 }))).toEqual(['Acme.', 'No one from Acme is in your CRM yet.'])
  })

  it('one person there, the last touch without a meeting, the research when the description runs long, mail from someone unknown', () => {
    const long = `Globex ${'designs, builds and sells industrial robots, '.repeat(5)}and much more.`
    expect(
      words(
        account(
          {
            people: [person({ id: 'c-priya', full_name: 'Priya Nair', email: 'priya@globex.com', job_title: 'CFO' })],
            people_on_record: 1,
            people_visible: 1,
            last_interaction_at: '2026-09-26T22:30:00Z',
            open_actions: [action({ id: 'act-1', title: 'Send the MSA', assignee_contact_id: 'c-priya', assignee_name: 'Priya Nair' })],
            recent_email_threads: [thread({ subject: 'Invoice 1042', from_email: 'ap@globex.com' })],
          },
          { name: 'Globex', description: long, employee_count_range: '1000+' },
        ),
        { is_workspace_company: false, metadata: { enrichment: { summary: 'Globex makes industrial robots. About 4,000 people work there.' } } },
      ),
    ).toEqual([
      'Globex, over 1,000 people.',
      'Globex makes industrial robots.',
      'You know one person there: Priya Nair, CFO.',
      'You were last in touch yesterday at 3:30 PM.',
      'One action is open with people there: Send the MSA, assigned to Priya Nair.',
      'An email from Globex about Invoice 1042 is waiting on your reply.',
    ])
  })

  it('says a size range the way people say it', () => {
    const size = (range: string) => words(account({}, { employee_count_range: range }))[0]
    expect(size('1-10')).toBe('Acme, one to ten people.')
    expect(size('501-1000')).toBe('Acme, 501 to 1,000 people.')
    expect(size('1000+')).toBe('Acme, over 1,000 people.')
    expect(size('about 40')).toBe('Acme, about 40 people.')
  })

  it("the user's own company: says so, leaves out who you know and when you met, and counts only a teammate's mail", () => {
    const ownCompany = (threads: CompanyEmailThread[]) =>
      words(
        account(
          {
            people: [
              person({ id: 'c-me', full_name: 'Liam Alizadeh', email: 'liam@dial8.ai', member_id: 'member-me', is_teammate: true, interaction_count: 40 }),
              person({ id: 'c-sam', full_name: 'Sam Lee', email: 'sam@dial8.ai', job_title: 'CTO', member_id: 'member-sam', is_teammate: true }),
              person({ id: 'c-ana', full_name: 'Ana Ruiz', email: 'ana@dial8.ai', member_id: 'member-ana', is_teammate: true }),
            ],
            people_on_record: 3,
            people_visible: 3,
            last_interaction_at: '2026-09-27T21:00:00Z',
            recent_captures: [{ id: 'cap-9', title: 'Standup', started_at: '2026-09-27T16:00:00Z', ai_summary: null }],
            open_actions: [
              action({ id: 'act-mine', title: 'Ship the listen briefs', assigned_via: 'member', assignee_name: 'Liam Alizadeh' }),
              action({ id: 'act-sam', title: 'Review the PR', assigned_via: 'member', assignee_name: 'Sam Lee' }),
            ],
            // The user's own address is one of the company's, so every thread of theirs matches.
            recent_email_threads: threads,
          },
          { name: 'Native Intelligence', industry: 'Software', description: 'Meetings, projects and CRM in one workspace.' },
        ),
        { is_workspace_company: true, metadata: null },
        new Set(['act-mine']),
      )

    const quote = thread({ id: 't-out', subject: 'Quote for 40 seats', from_email: 'buyer@bigco.com' })
    expect(ownCompany([thread({ id: 't-sam', subject: 'Launch plan', from_email: 'sam@dial8.ai' }), quote])).toEqual([
      'Native Intelligence, your own company.',
      'Meetings, projects and CRM in one workspace.',
      'Two actions are open with people there, one of them yours.',
      'Ship the listen briefs, assigned to you.',
      'Review the PR, assigned to Sam Lee.',
      "Sam Lee's email about Launch plan is waiting on your reply.",
    ])
    expect(ownCompany([thread({ from_email: 'sam@dial8.ai' }), quote, thread({ from_email: 'ana@dial8.ai' })]).at(-1)).toBe(
      'Two emails from your teammates are waiting on your reply.',
    )
    expect(ownCompany([quote]).at(-1)).toBe('Review the PR, assigned to Sam Lee.')
  })

  it('says how much of what is open is yours, and "at least" at the most the gatherer reads', () => {
    const open = (n: number, mine: string[]) =>
      words(
        account({ open_actions: Array.from({ length: n }, (_, i) => action({ id: `a${i}`, title: `Task ${i + 1}` })) }),
        null,
        new Set(mine),
      ).filter((line) => /open with people there|^Task|^And/.test(line))
    expect(open(1, ['a0'])).toEqual(['One action is open with people there: Task 1, assigned to you.'])
    expect(open(3, ['a1'])).toEqual([
      'Three actions are open with people there, one of them yours.',
      'Task 1.',
      'Task 2, assigned to you.',
      'Task 3.',
    ])
    expect(open(3, ['a0', 'a1', 'a2'])[0]).toBe('Three actions are open with people there, all of them yours.')
    expect(open(8, [])).toEqual([
      'At least eight actions are open with people there.',
      'Task 1.',
      'Task 2.',
      'Task 3.',
      'Task 4.',
      'Task 5.',
      'And at least three more.',
    ])
    expect(open(8, ['a0', 'a5'])[0]).toBe('At least eight actions are open with people there, at least two of them yours.')
  })

  it('reads the most pressing first: overdue, then soonest due, then the undated', () => {
    const lines = words(
      account({
        open_actions: [
          action({ id: 'a1', title: 'Undated' }),
          action({ id: 'a2', title: 'Next week', due_at: '2026-10-02' }),
          action({ id: 'a3', title: 'Late', due_at: '2026-09-24', assignee_name: 'Jessa Lin' }),
        ],
      }),
    )
    expect(lines.slice(-3)).toEqual(['Late, assigned to Jessa Lin, overdue since Thursday.', 'Next week, due on Friday.', 'Undated.'])
  })

  it('several emails waiting, from anyone there', () => {
    const said = words(
      account({
        people: [person({ id: 'c-jessa', full_name: 'Jessa Lin', email: 'jessa@acme.com' })],
        people_on_record: 1,
        people_visible: 1,
        recent_email_threads: [thread({ from_email: 'jessa@acme.com' }), thread({ from_email: 'ap@acme.com' })],
      }),
    )
    expect(said.at(-1)).toBe('Two emails from people there are waiting on your reply.')
  })
})
