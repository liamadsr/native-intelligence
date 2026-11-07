import type { SkillEvalCase } from '../types'

/**
 * `find-a-time` (calendar, pack-only, 325): listed in the Calendar pack,
 * which `get_calendar_events` (core) loads. Two or three slots, then the
 * invite only after the yes: `forbidParams`/`avoid` hold the first turn to
 * reading.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'find a time next week for a 45 minute call with Dana and Lee',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['get_calendar_events', 'load_skill'],
    avoid: ['create_calendar_event', 'run_browser_task'],
    why: 'Read the whole window, offer two or three slots, end the turn.',
  },
  {
    request: 'when am I free for an hour this week?',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['get_calendar_events', 'load_skill'],
    avoid: ['create_calendar_event'],
  },
  {
    request: 'set up 30 minutes with sarah@acme.com before Friday and send the invite',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['get_calendar_events', 'load_skill'],
    avoid: ['create_calendar_event'],
    why: '"And send the invite" without a time is not the yes: propose slots first.',
  },
  {
    request: "find my first free hour tomorrow and put a 'Deep work' block there",
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['get_calendar_events', 'load_skill', 'search_tools', 'create_calendar_event'],
    params: { create_calendar_event: { title: 'Deep work' } },
    forbidParams: { create_calendar_event: { attendees: [] } },
    why: 'Their own calendar alone, asked outright: book it, with no guests.',
  },
  {
    request: 'find two slots for a working session with the design team in the next two weeks, mornings only',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['get_calendar_events', 'load_skill'],
    params: { get_calendar_events: [{ max_results: 100 }] },
    avoid: ['create_calendar_event'],
  },
  {
    request: 'can you find a time with the Initech folks and email them some options?',
    loads: ['calendar-playbook', 'find-a-time'],
    tools: ['get_calendar_events', 'load_skill', 'search_tools'],
    avoid: ['create_calendar_event'],
    why: 'The email of options is a draft the person sends, after they pick the slots.',
  },
]
