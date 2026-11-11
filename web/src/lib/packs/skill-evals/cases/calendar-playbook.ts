import type { SkillEvalCase } from '../types'

/**
 * The Calendar core (325): it rides `get_calendar_events`, a core tool, or a
 * `search_tools` reveal of a calendar tool. Invites to other people ask
 * first; Native Intelligence's own calendar never needs the browser. Free
 * time comes from `find_times` (551), never a hand count over the events;
 * with teammates, from its `people` (553). An outside guest is offered the
 * slots with `offer_times` (555): held, picked on a link or by replying.
 */
export const cases: SkillEvalCase[] = [
  {
    request: "what's my day look like tomorrow?",
    loads: ['calendar-playbook'],
    tools: ['get_calendar_events'],
    avoid: ['run_browser_task', 'create_calendar_event'],
    why: 'One read of the whole day; lead with what matters, never a printout.',
  },
  {
    request: 'show me my week',
    loads: ['calendar-playbook'],
    tools: ['show'],
    params: { show: { kind: 'calendar', calendar: { view: 'week' } } },
    avoid: ['run_browser_task'],
  },
  {
    request: 'prep me for my 2pm with Acme',
    loads: ['calendar-playbook'],
    tools: ['get_calendar_events', 'search_tools', 'get_meeting_prep'],
    why: 'event_id finds only an event with a capture: pass participant_email (the Acme attendee) with it.',
  },
  {
    request: 'send Sam and Priya an invite for a 30 minute sync on Thursday',
    loads: ['calendar-playbook'],
    tools: ['find_times'],
    params: { find_times: { duration_minutes: 30 } },
    avoid: ['create_calendar_event'],
    why: 'No time given: find_times for Thursday and propose slots; an invite to others waits for the yes.',
  },
  {
    request: 'block 2 to 4 tomorrow afternoon for focus time',
    loads: ['calendar-playbook'],
    tools: ['get_calendar_events', 'search_tools', 'create_calendar_event'],
    forbidParams: { create_calendar_event: { attendees: [] } },
    why: 'An event on their own calendar alone, asked for outright, needs no extra check (and no guests).',
  },
  {
    request: 'send sarah@acme.com an invite called Acme sync for next Tuesday at 2pm, 30 minutes',
    loads: ['calendar-playbook'],
    tools: ['search_tools', 'create_calendar_event'],
    params: { create_calendar_event: { title: 'Acme sync', attendees: ['sarah@acme.com'] } },
    why: 'A request naming the exact time, length and guests and saying to send it is the yes.',
  },
  {
    request: 'which of my meetings today are being recorded?',
    loads: ['calendar-playbook'],
    tools: ['search_tools', 'get_upcoming_meetings'],
    avoid: ['run_browser_task'],
  },
  {
    request: 'move my 1:1 with Jordan on Friday to 3pm',
    loads: ['calendar-playbook'],
    tools: ['get_calendar_events', 'search_tools'],
    avoid: ['update_calendar_event', 'delete_calendar_event'],
    why: 'Moving a meeting others are in reaches them: confirm the new time first.',
  },
  {
    request: 'send Sarah from Acme an invite Tue 2pm, 30 min',
    loads: ['calendar-playbook'],
    tools: ['search_tools', 'list_contacts'],
    avoid: ['create_calendar_event'],
    why: "An address you looked up yourself isn't the yes: confirm Sarah's address with the person before sending.",
  },
  {
    request: 'is there a 30 minute slot on Thursday that works for me and Dana Whitfield on my team?',
    loads: ['calendar-playbook'],
    tools: ['find_times'],
    params: { find_times: { duration_minutes: 30, people: ['Dana Whitfield'] } },
    avoid: ['create_calendar_event'],
    why: "A teammate goes in find_times' `people` (553): the common times, never a read of her events.",
  },
  // 555: an outside guest is offered the slots with offer_times; by email it is the person's card.
  {
    request: 'email lee@umbrella.example a few times next week for a 30 minute intro call',
    loads: ['calendar-playbook'],
    tools: ['find_times', 'offer_times'],
    params: { find_times: { duration_minutes: 30 }, offer_times: { send_by: 'email', duration_minutes: 30 } },
    avoid: ['create_calendar_event', 'create_email_draft'],
    why: "offer_times holds the times and, by email, becomes the person's card with the exact words (555): never a hand-written draft or an invite.",
  },
  {
    request: 'Dana Reyes replied to my offer that Tuesday at 10 works for the intro call. Book it.',
    loads: ['calendar-playbook'],
    tools: ['list_time_offers', 'accept_time_offer'],
    avoid: ['create_calendar_event', 'offer_times'],
    why: "Her answer in words books that offer's own time (accept_time_offer), for her: never a new invite.",
  },
]
