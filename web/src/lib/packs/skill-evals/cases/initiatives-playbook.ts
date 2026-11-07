import type { SkillEvalCase } from '../types'

/**
 * The Initiatives core (rewritten in 327): computed health, the project
 * rollup, list_initiatives defaulting to active. Every initiatives and
 * projects tool sits behind search_tools.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'which of our initiatives are at risk?',
    loads: ['initiatives-playbook'],
    tools: ['search_tools', 'list_initiatives'],
    params: { list_initiatives: { health: 'at_risk' } },
    avoid: ['run_browser_task', 'update_initiative'],
  },
  {
    request: 'show me the initiatives I own',
    loads: ['initiatives-playbook'],
    tools: ['show'],
    params: {
      show: { kind: 'list', entity_type: 'initiative', filters: [{ field: 'owner_id', operator: 'is', value: '@me' }] },
    },
  },
  {
    request: 'list every initiative, planned and completed ones too',
    loads: ['initiatives-playbook'],
    tools: ['search_tools', 'list_initiatives'],
    params: { list_initiatives: { filter: 'all' } },
    why: 'list_initiatives shows only active ones by default.',
  },
  {
    request: 'what projects sit under the Enterprise Expansion initiative?',
    loads: ['initiatives-playbook'],
    tools: ['search_tools', 'get_initiative'],
    params: { get_initiative: { name: 'Enterprise Expansion' } },
  },
  {
    request: "create an initiative 'Win 20 mid-market logos by Q2', owned by Sarah, target June 30",
    loads: ['initiatives-playbook'],
    tools: ['search_tools', 'list_workspace_members', 'create_initiative'],
    params: { create_initiative: { name: 'Win 20 mid-market logos by Q2' } },
  },
  {
    request: 'put the Billing v2 project under the Monetization initiative',
    loads: ['initiatives-playbook'],
    tools: ['search_tools', 'list_initiatives', 'update_project'],
    avoid: ['update_initiative', 'create_project'],
    why: 'Projects join an initiative through update_project with initiative_id.',
  },
  {
    request: "we dropped the Partnerships initiative, archive it",
    loads: ['initiatives-playbook'],
    tools: ['search_tools', 'update_initiative'],
    params: { update_initiative: { status: 'archived' } },
  },
  {
    request: 'mark the Q3 Launch initiative as at risk',
    loads: ['initiatives-playbook'],
    tools: ['search_tools', 'get_initiative'],
    avoid: ['update_initiative'],
    why: "Health is computed, never set: explain what drives it instead of writing a status.",
  },
]
