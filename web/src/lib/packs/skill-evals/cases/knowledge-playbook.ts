import type { SkillEvalCase } from '../types'

/** The Knowledge core: it rides `search_tools` revealing the knowledge tools. */
export const cases: SkillEvalCase[] = [
  {
    request: 'what are the open questions about Acme?',
    loads: ['knowledge-playbook'],
    tools: ['search_tools', 'list_companies', 'list_claims'],
    params: { list_claims: { entity_type: 'company', type: 'open_question' } },
  },
  {
    request: "where did we get the claim that Acme's budget is $200k?",
    loads: ['knowledge-playbook'],
    tools: ['find', 'search_tools', 'get_claim'],
    why: 'A claim is answered with its sources.',
  },
  {
    request: "note that Globex renewed for two years, per today's call",
    loads: ['knowledge-playbook'],
    tools: ['search_tools', 'create_claim'],
    avoid: ['supersede_claim'],
    why: 'A new fact gets its source; nothing is replaced.',
  },
  {
    request: "what's linked to the Atlas project in the graph?",
    loads: ['knowledge-playbook'],
    tools: ['search_tools', 'list_projects', 'get_context_bundle'],
    params: { get_context_bundle: { entity_type: 'project' } },
  },
  {
    request: 'did we ever discuss SSO with Initech? look back as far as you can',
    loads: ['knowledge-playbook'],
    tools: ['find'],
    params: { find: { all_time: true } },
    avoid: ['run_browser_task'],
  },
  {
    request: 'which claims came in this week that nobody has confirmed yet?',
    loads: ['knowledge-playbook'],
    tools: ['search_tools', 'list_claims'],
    params: { list_claims: { confirmation: 'suggested', since: 'this_week' } },
  },
]
