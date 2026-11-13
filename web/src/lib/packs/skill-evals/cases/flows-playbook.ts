import type { SkillEvalCase } from '../types'

/**
 * The Flows core (rewritten in 324, its asking rule in 400): chat builds every
 * trigger and action the editor wires; a loop the person asks for is created
 * with `enabled` true (on), a webhook loop then waits on the person's card;
 * it debugs with list_flow_runs. Every flows tool sits behind search_tools.
 * 641: loops also start on mail, team chat messages and new documents, and
 * schedules may be monthly, cron or once; cron can't say "the first Monday".
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'post to https://hooks.slack.com/services/T000/B000/XXXX whenever an action moves to Done',
    loads: ['flows-playbook'],
    tools: ['search_tools', 'list_flows', 'list_workflow_states', 'create_flow'],
    params: {
      create_flow: {
        trigger: { type: 'entity_status_change', entity_type: 'action' },
        actions: [{ type: 'http_post', url: 'https://hooks.slack.com/services/T000/B000/XXXX' }],
        enabled: true,
      },
    },
    avoid: ['run_browser_task', 'update_flow'],
    why: 'Check for a twin, find the Done state id, then build the status loop with enabled: true, because they asked. A webhook is the one exception: the server saves it off behind their approval card.',
  },
  {
    request: "why didn't my Done webhook fire yesterday?",
    loads: ['flows-playbook'],
    tools: ['search_tools', 'list_flows', 'list_flow_runs'],
    avoid: ['update_flow'],
  },
  {
    request: 'set up a flow that runs the groom skill every Monday at 9',
    loads: ['flows-playbook'],
    tools: ['search_tools', 'list_flows', 'create_flow'],
    params: {
      create_flow: {
        trigger: { type: 'schedule', cadence: 'weekly', weekday: 1, time: '09:00' },
        actions: [{ type: 'run_skill', skill: 'groom' }],
        enabled: true,
      },
    },
    avoid: ['update_flow'],
    why: 'They asked for the loop, so it is created on (enabled: true) and said in one line.',
  },
  {
    request: 'what automations do we have running?',
    loads: ['flows-playbook'],
    tools: ['search_tools', 'list_flows'],
    avoid: ['create_flow', 'update_flow'],
  },
  {
    request: 'delete the old Zapier flow',
    loads: ['flows-playbook'],
    tools: ['search_tools', 'list_flows'],
    avoid: ['delete_flow'],
    why: 'Deleting is permanent: confirm first.',
  },
  {
    request: 'turn off the Morning brief loop',
    loads: ['flows-playbook'],
    tools: ['search_tools', 'list_flows', 'update_flow'],
    params: { update_flow: { enabled: false } },
    avoid: ['delete_flow'],
    why: 'On or off is update_flow with enabled alone; actions stay out.',
  },
  {
    request: "the Triage loop didn't do anything after today's call, is it broken?",
    loads: ['flows-playbook'],
    tools: ['search_tools', 'list_flows', 'list_flow_runs'],
    avoid: ['update_flow', 'delete_flow'],
    why: 'Read the runs (action_results) before changing anything.',
  },
  {
    request: 'run the triage skill whenever someone @mentions me in team chat',
    loads: ['flows-playbook'],
    tools: ['search_tools', 'list_flows', 'create_flow'],
    params: {
      create_flow: {
        trigger: { type: 'chat_message', channel_id: null, mentions_only: true },
        actions: [{ type: 'run_skill' }],
        enabled: true,
      },
    },
    avoid: ['update_flow'],
    why: 'Any channel is allowed only with mentions_only; the step reads {{trigger.chat_message_id}} with read_team_chat_message.',
  },
  {
    request: 'run the groom skill on the first Monday of every month at 9',
    loads: ['flows-playbook'],
    tools: ['search_tools', 'list_flows'],
    forbidParams: { create_flow: { trigger: { cron: '0 9 1-7 * 1' } } },
    avoid: ['update_flow'],
    why: 'Cron runs a day matching either day field, so "1-7" with Monday is every Monday too: offer monthly on a date or weekly on Monday, and say so.',
  },
]
