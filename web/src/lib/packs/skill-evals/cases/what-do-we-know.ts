import type { SkillEvalCase } from '../types'

/** `what-do-we-know` (knowledge, global): entity first, then its claims with sources. */
export const cases: SkillEvalCase[] = [
  {
    request: 'what do we know about Acme?',
    loads: ['what-do-we-know'],
    tools: ['search_tools', 'list_companies', 'get_context_bundle'],
    params: { list_companies: { search: 'Acme' }, get_context_bundle: { entity_type: 'company' } },
    avoid: ['run_browser_task'],
    why: 'Internal data: never the browser.',
  },
  {
    request: 'what do we know about Sarah Chen?',
    loads: ['what-do-we-know'],
    tools: ['search_tools', 'list_contacts', 'list_claims'],
    params: { list_contacts: { search: 'Sarah Chen' }, list_claims: { entity_type: 'contact' } },
  },
  {
    request: 'what do we know about our pricing strategy?',
    loads: ['what-do-we-know'],
    tools: ['find'],
    avoid: ['run_browser_task'],
    why: 'A topic with no entity: find.',
  },
  {
    request: "what's still unknown about the Atlas project?",
    loads: ['what-do-we-know'],
    tools: ['search_tools', 'list_projects', 'list_claims'],
    params: { list_claims: { entity_type: 'project', type: 'open_question' } },
  },
  {
    request: "what's confirmed about Globex's buying process?",
    loads: ['what-do-we-know'],
    tools: ['search_tools', 'list_companies', 'list_claims'],
    params: { list_companies: { search: 'Globex' }, list_claims: { entity_type: 'company' } },
  },
  {
    request: 'what does the team know about the SOC 2 audit? check older meetings too',
    loads: ['what-do-we-know'],
    tools: ['find'],
    params: { find: { all_time: true } },
    why: 'find covers 4 weeks of captures by default.',
  },
]
