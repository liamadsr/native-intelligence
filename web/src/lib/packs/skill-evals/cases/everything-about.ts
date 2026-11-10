import type { SkillEvalCase } from '../types'

/** `everything-about` (knowledge, global): one entity walked across Native Intelligence, cheapest first. */
export const cases: SkillEvalCase[] = [
  {
    request: 'tell me everything about Acme',
    loads: ['everything-about'],
    tools: ['search_tools', 'list_companies', 'get_company_overview', 'list_claims'],
    params: { list_companies: { search: 'Acme' }, list_claims: { entity_type: 'company' } },
    avoid: ['run_browser_task'],
  },
  {
    request: 'everything we have on Sarah Chen',
    loads: ['everything-about'],
    tools: ['search_tools', 'list_contacts', 'get_contact_details'],
    params: { list_contacts: { search: 'Sarah Chen' } },
    avoid: ['run_browser_task'],
  },
  {
    request: 'give me the full picture on the Atlas project',
    loads: ['everything-about'],
    tools: ['search_tools', 'list_projects', 'get_project_context', 'list_documents'],
    params: { list_projects: { search: 'Atlas' } },
    why: 'get_project_context brings the open work with its total; list_actions only when there is more.',
  },
  {
    request: 'brief me on Globex before my call, everything we know',
    loads: ['everything-about'],
    tools: ['search_tools', 'list_companies', 'get_company_overview'],
    params: { list_companies: { search: 'Globex' } },
    avoid: ['run_browser_task'],
    why: 'The overview already has open actions and meetings: no separate calls for those.',
  },
  {
    request: "everything about Sam's work right now",
    loads: ['everything-about'],
    tools: ['search_tools', 'list_workspace_members', 'list_actions'],
    why: 'A teammate: their member id as assignee, then their commitments.',
  },
  {
    request: "what's the whole story with acme.com?",
    loads: ['everything-about'],
    tools: ['search_tools', 'list_companies', 'get_company_overview'],
    params: { list_companies: { search: 'acme.com' } },
  },
]
