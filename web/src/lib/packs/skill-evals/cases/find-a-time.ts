import type { SkillEvalCase } from '../types'

/**
 * `find-a-time` (calendar, pack-only, 325; on find_times since 551): listed in
 * the Calendar pack, which `get_calendar_events` (core) or a `search_tools`
 * that reveals a calendar tool loads. `find_times` finds the free time, never
 * a hand count over the events; two or three slots, then the invite only
 * after the yes: `forbidParams`/`avoid` hold the first turn to reading.
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
]
