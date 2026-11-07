import type { SkillEvalCase } from '../types'

/**
 * `initiative-review` (initiatives, pack-only): listed in the Initiatives
 * pack, which an initiatives tool's first call (or the core's load) brings in.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'review the Enterprise Expansion initiative for me',
    loads: ['initiatives-playbook', 'initiative-review'],
    tools: ['search_tools', 'get_initiative', 'list_projects'],
    params: { get_initiative: { name: 'Enterprise Expansion' } },
    avoid: ['run_browser_task', 'update_initiative'],
  },
  {
    request: "how's the Monetization initiative tracking? what's off track?",
    loads: ['initiatives-playbook', 'initiative-review'],
    tools: ['search_tools', 'get_initiative', 'list_projects', 'list_actions'],
    params: { list_actions: { filter: 'overdue' } },
    avoid: ['update_initiative'],
  },
  {
    request: 'give me an initiative review of Win 20 mid-market logos for the board deck',
    loads: ['initiatives-playbook', 'initiative-review'],
    tools: ['search_tools', 'get_initiative', 'list_projects'],
    avoid: ['create_document'],
    why: 'Written in chat; saved as a document only when asked.',
  },
  {
    request: 'what decisions does the Platform Rewrite initiative need from me?',
    loads: ['initiatives-playbook', 'initiative-review'],
    tools: ['search_tools', 'get_initiative', 'list_projects'],
    avoid: ['update_initiative', 'update_project'],
  },
  {
    request: 'is the Q4 Growth initiative going to hit its date? suggest fixes if not',
    loads: ['initiatives-playbook', 'initiative-review'],
    tools: ['search_tools', 'get_initiative', 'list_projects', 'suggest_changes'],
    avoid: ['update_project', 'update_initiative'],
    why: 'Fixes are staged as suggestions, not applied.',
  },
  {
    request: 'roll up the projects under Customer Success 2.0 and tell me which are stalled',
    loads: ['initiatives-playbook', 'initiative-review'],
    tools: ['search_tools', 'get_initiative', 'list_projects', 'list_actions'],
    params: { list_actions: { filter: 'completed', since: 'past_30_days', time_field: 'updated_at' } },
  },
]
