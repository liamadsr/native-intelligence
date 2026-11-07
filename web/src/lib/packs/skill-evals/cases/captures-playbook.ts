import type { SkillEvalCase } from '../types'

/**
 * The Captures core (325): it rides `list_captures` (core) or a
 * `search_tools` reveal of a captures tool. Summary before transcript;
 * proposals settled when asked, or after the person agrees.
 */
export const cases: SkillEvalCase[] = [
  {
    request: "what did we decide in yesterday's Atlas sync?",
    loads: ['captures-playbook'],
    tools: ['list_captures', 'search_tools', 'get_capture_content'],
    params: { list_captures: { since: 'yesterday' } },
    avoid: ['get_capture_transcript', 'run_browser_task'],
    why: 'The summary answers it: no transcript.',
  },
  {
    request: 'what exactly did Maria say about pricing on the Acme call? I need her words',
    loads: ['captures-playbook'],
    tools: ['search_tools', 'get_capture_transcript'],
    avoid: ['run_browser_task'],
    why: 'Exact words: page the transcript (about 20K tokens a page) and stop once the passage is found.',
  },
  {
    request: "show me this week's meetings",
    loads: ['captures-playbook'],
    tools: ['show'],
    params: {
      show: {
        kind: 'list',
        entity_type: 'capture',
        filters: [
          { field: 'started_at', operator: 'is_relative', value: 'this week' },
          { field: 'status', operator: 'is', value: 'active' },
        ],
      },
    },
  },
  {
    request: "what's waiting for review from my meetings?",
    loads: ['captures-playbook'],
    tools: ['search_tools', 'get_action_suggestions'],
    avoid: ['accept_proposal', 'dismiss_proposal'],
  },
  {
    request: 'accept all the action items from the Globex call',
    loads: ['captures-playbook'],
    tools: ['list_captures', 'search_tools', 'get_capture_extractions', 'accept_proposal'],
    why: 'Asked outright: accept the pending proposals (by proposal_ids) once read.',
  },
  {
    request: "log a decision on today's pricing call: we're going with annual billing only",
    loads: ['captures-playbook'],
    tools: ['list_captures', 'search_tools', 'create_decision'],
  },
  {
    request: 'did we ever talk about SOC 2 in a meeting? check all of them',
    loads: ['captures-playbook'],
    tools: ['find'],
    params: { find: { all_time: true } },
    avoid: ['run_browser_task'],
  },
]
