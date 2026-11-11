import type { SkillEvalCase } from '../types'

/**
 * `find-a-time` (calendar, pack-only, 325; on find_times since 551): listed in
 * the Calendar pack, which `get_calendar_events` (core) or a `search_tools`
 * that reveals a calendar tool loads. `find_times` finds the free time, never
 * a hand count over the events; two or three slots, then the invite only
 * after the yes: `forbidParams`/`avoid` hold the first turn to reading. An
 * outside guest is offered the slots with `offer_times` (555), a link by
 * default: the times are held and nothing is sent; several outside guests
 * at once are one poll, offer_times with `recipients` (584).
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'find a time next week for a 45 minute call with Dana and Lee',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['load_skill', 'find_times'],
    params: { find_times: { duration_minutes: 45 } },
    avoid: ['create_calendar_event', 'run_browser_task'],
    why: 'find_times over the whole window, offer two or three slots, end the turn.',
  },
  {
    request: 'when am I free for an hour this week?',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['load_skill', 'find_times'],
    params: { find_times: { duration_minutes: 60 } },
    avoid: ['create_calendar_event'],
  },
  {
    request: 'set up 30 minutes with sarah@acme.com before Friday and send the invite',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['load_skill', 'find_times'],
    avoid: ['create_calendar_event'],
    why: '"And send the invite" without a time is not the yes: propose slots first.',
  },
  {
    request: "find my first free hour tomorrow and put a 'Deep work' block there",
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['load_skill', 'find_times', 'create_calendar_event'],
    params: { find_times: { duration_minutes: 60 }, create_calendar_event: { title: 'Deep work' } },
    forbidParams: { create_calendar_event: { attendees: [] } },
    why: 'Their own calendar alone, asked outright: book it, with no guests.',
  },
  {
    request: 'find two slots for a working session with the design team in the next two weeks, mornings only',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['load_skill', 'find_times'],
    params: { find_times: { duration_minutes: 60 } },
    avoid: ['create_calendar_event', 'set_working_hours'],
    why: '"Mornings only" is a limit for this meeting: pick from `free`, never change their working hours.',
  },
  {
    request: 'can you find a time with the Initech folks and email them some options?',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['load_skill', 'find_times'],
    avoid: ['create_calendar_event'],
    why: 'The email of options is a draft the person sends, after they pick the slots.',
  },
  // 553: teammates go in `people`; an outside guest's calendar is never read.
  {
    request: 'find 30 minutes next week that works for me and Priya from my team',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['load_skill', 'find_times'],
    params: { find_times: { duration_minutes: 30, people: ['Priya'] } },
    avoid: ['create_calendar_event', 'get_calendar_events'],
    why: 'A teammate goes in `people`: find_times returns the times that work for both, never a read of anyone\'s events.',
  },
  {
    request: 'when are Sam Ortiz and Lee Okafor on my team both free for an hour with me this week?',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['load_skill', 'find_times'],
    params: { find_times: { duration_minutes: 60, people: ['Sam Ortiz', 'Lee Okafor'] } },
    avoid: ['create_calendar_event'],
  },
  {
    request: 'find a time for a 30 minute call with jordan@globex.example next week',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['load_skill', 'find_times'],
    forbidParams: { find_times: { people: ['jordan@globex.example'] } },
    avoid: ['create_calendar_event'],
    why: "An outside guest's calendar can't be read: find times on the person's own calendar and say so.",
  },
  // 555: an outside guest is offered the slots with offer_times (held; a link by default, nothing sent).
  {
    request: 'offer morgan@hooli.example three times for a 45 minute call this week and give me the link',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['load_skill', 'find_times', 'offer_times'],
    params: { find_times: { duration_minutes: 45 }, offer_times: { duration_minutes: 45 } },
    forbidParams: { offer_times: [{ send_by: 'email' }, { send_by: 'text' }] },
    avoid: ['create_calendar_event', 'create_email_draft'],
    why: 'offer_times by link holds the times and returns the link and the text to paste; nothing is sent.',
  },
  // 584: several outside guests at once are one poll (offer_times' recipients), never an offer each.
  {
    request: 'find three times next week for a 30 minute call with morgan@hooli.example and priya@initech.example, and give me their links',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['load_skill', 'find_times', 'offer_times'],
    params: { find_times: { duration_minutes: 30 }, offer_times: { duration_minutes: 30 } },
    forbidParams: { offer_times: [{ send_by: 'email' }, { send_by: 'text' }] },
    avoid: ['create_calendar_event', 'create_email_draft'],
    why: 'Two outside guests are one poll: offer_times with both in recipients, by link; each gets their own link and the last answer books.',
  },
]
