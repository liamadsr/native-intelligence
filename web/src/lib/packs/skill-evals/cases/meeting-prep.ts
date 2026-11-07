import type { SkillEvalCase } from '../types'

/**
 * `meeting-prep` (calendar, pack-only, 325; the 159 row): listed in the
 * Calendar pack, which `get_calendar_events` (core) loads, so the cases read
 * the calendar before the load. get_meeting_prep takes the event and the main
 * external attendee's address; then the gaps, cheapest first. Read only.
 */
const READ_ONLY = ['create_email_draft', 'create_calendar_event', 'update_calendar_event', 'run_browser_task']
export const cases: SkillEvalCase[] = [
  {
    request: 'prep me for my next meeting',
    loads: ['calendar-playbook', 'meeting-prep'],
    tools: ['get_calendar_events', 'load_skill', 'search_tools', 'get_meeting_prep'],
    params: { get_calendar_events: { max_results: 20 } },
    avoid: READ_ONLY,
    why: 'No meeting named: read from now with max_results 20 and pick the next substantive one.',
  },
  {
    request: 'give me a full brief for the Acme renewal call tomorrow',
    loads: ['calendar-playbook', 'meeting-prep'],
    tools: ['get_calendar_events', 'load_skill', 'search_tools', 'get_meeting_prep', 'find'],
    avoid: READ_ONLY,
    why: 'Thin prep is normal: find fills the last-time gap.',
  },
  {
    request: 'what do I owe Globex before our 3pm?',
    loads: ['calendar-playbook', 'meeting-prep'],
    tools: ['get_calendar_events', 'load_skill', 'search_tools', 'get_meeting_prep', 'list_actions'],
    params: { list_actions: { search: 'Globex' } },
    avoid: READ_ONLY,
  },
  {
    request: "who's in my 10am with Initech and how do I know them?",
    loads: ['calendar-playbook', 'meeting-prep'],
    tools: ['get_calendar_events', 'load_skill', 'search_tools', 'get_meeting_prep', 'get_contact_details'],
    avoid: READ_ONLY,
  },
  {
    request: 'prep me for Thursday\'s board meeting, what should I raise?',
    loads: ['calendar-playbook', 'meeting-prep'],
    tools: ['get_calendar_events', 'load_skill', 'get_meeting_prep'],
    avoid: READ_ONLY,
  },
  {
    request: 'brief me on the intro call with Hooli, it is our first meeting',
    loads: ['calendar-playbook', 'meeting-prep'],
    tools: ['get_calendar_events', 'load_skill', 'search_tools', 'get_meeting_prep'],
    avoid: READ_ONLY,
    why: 'A first meeting gets the attendee read and "no prior context", never an invented backstory.',
  },
]
