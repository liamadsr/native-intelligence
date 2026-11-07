import type { SkillEvalCase } from '../types'

/**
 * `build-a-workflow` (flows, pack-only, 324; its asking rule in 400): listed in
 * the Flows pack, which rides the search for the flows tools, so the cases
 * load the pack first. A loop the person asks for is created on (`enabled`
 * true) and said in one line, with no second ask; a webhook loop is the one
 * exception, saved off by the server behind the person's card. update_flow
 * never follows in the same turn.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'every weekday at 9 send me a standup brief',
    loads: ['flows-playbook', 'build-a-workflow'],
    tools: ['search_tools', 'list_flows', 'list_skills', 'create_flow'],
    params: {
      create_flow: {
        trigger: { type: 'schedule', cadence: 'weekdays', time: '09:00' },
        actions: [{ type: 'run_skill' }],
        enabled: true,
      },
    },
    avoid: ['update_flow'],
    why: 'They asked for it: created on, then a one-line summary.',
  },
  {
    request: 'set up a daily 8am digest of my overdue actions and turn it on',
    loads: ['flows-playbook', 'build-a-workflow'],
    tools: ['search_tools', 'list_flows', 'create_flow'],
    params: { create_flow: { trigger: { type: 'schedule', cadence: 'daily', time: '08:00' }, enabled: true } },
    avoid: ['update_flow'],
    why: 'Asked for and told to turn it on: created on in one call, no second ask.',
  },
  {
    request: "when a meeting is captured, archive it if it's shorter than two minutes",
    loads: ['flows-playbook', 'build-a-workflow'],
    tools: ['search_tools', 'list_flows'],
    avoid: ['create_flow'],
    why: 'A condition cannot look at a capture: archive_capture would archive every capture. Say so instead of building it.',
  },
  {
    request: 'remind me 15 minutes before calendar events titled "Pipeline review" with a prep brief',
    loads: ['flows-playbook', 'build-a-workflow'],
    tools: ['search_tools', 'list_flows', 'list_skills', 'create_flow'],
    params: {
      create_flow: {
        trigger: { type: 'calendar_event', event_title: 'Pipeline review', offset_minutes: -15 },
        actions: [{ type: 'run_skill' }],
      },
    },
    avoid: ['update_flow'],
  },
  {
    request: 'yes, turn on the Morning brief loop',
    loads: ['flows-playbook'],
    tools: ['search_tools', 'list_flows', 'update_flow'],
    params: { update_flow: { enabled: true, confirmed_with_user: true } },
    avoid: ['create_flow'],
    why: 'Asking outright to switch on a named loop is the yes.',
  },
  {
    request: 'make the Monday report run in act mode',
    loads: ['flows-playbook', 'build-a-workflow'],
    tools: ['search_tools', 'list_flows', 'update_flow'],
    params: { update_flow: { actions: [{ type: 'run_skill', mode: 'act' }] } },
    avoid: ['create_flow', 'delete_flow'],
    why: 'actions replaces the whole list: re-send every action with its id, changing only the mode.',
  },
  {
    request: 'every hour, post our open urgent actions to https://hooks.example.com/dial8',
    loads: ['flows-playbook', 'build-a-workflow'],
    tools: ['search_tools', 'list_flows', 'create_flow'],
    params: {
      create_flow: {
        trigger: { type: 'schedule', cadence: 'hourly' },
        actions: [{ type: 'http_post', url: 'https://hooks.example.com/dial8' }],
        enabled: true,
      },
    },
    avoid: ['update_flow'],
    why: 'Asked for, so enabled: true; a webhook is the one exception: the server saves it off behind the person\'s approval card, and the agent says it is just below in the chat.',
  },
  {
    request: 'move the Morning brief to 7:30',
    loads: ['flows-playbook'],
    tools: ['search_tools', 'list_flows', 'update_flow'],
    params: { update_flow: { trigger: { type: 'schedule', time: '07:30' } } },
    avoid: ['create_flow'],
    why: 'Same trigger type: only time changes, the rest is kept.',
  },
  {
    request: 'every Friday at 4pm, run the weekly report skill and have it close out the finished tasks',
    loads: ['flows-playbook', 'build-a-workflow'],
    tools: ['search_tools', 'list_flows', 'list_skills', 'create_flow'],
    params: {
      create_flow: {
        trigger: { type: 'schedule', cadence: 'weekly', weekday: 5, time: '16:00' },
        actions: [{ type: 'run_skill', mode: 'act' }],
      },
    },
    avoid: ['update_flow'],
    why: 'The person asked it to change things, so act mode; still created off until they say yes.',
  },
  {
    request: 'run the groom skill every other Tuesday',
    loads: ['flows-playbook', 'build-a-workflow'],
    tools: ['search_tools', 'list_flows'],
    avoid: ['update_flow'],
    why: 'No cron or fortnightly cadence: offer weekly on Tuesday and ask.',
  },
]
