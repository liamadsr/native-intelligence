import type { SkillEvalCase } from '../types'

/**
 * The Prospecting core (326): it rides `search_tools` revealing the
 * prospecting tools. The rules it keeps from 322: every search, publish and
 * dismiss waits for a yes to that call (`forbidParams` holds a first turn to
 * never pass `confirmed_with_user` true), and the list is not the CRM.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'how did the Series A fintech list do?',
    loads: ['prospecting-playbook'],
    tools: ['search_tools', 'list_prospect_lists', 'list_prospect_entries'],
    avoid: ['run_prospect_discovery', 'find_prospect_people'],
    why: 'Reading a list runs nothing: the front door, then its entries best match first.',
  },
  {
    request: 'just the strong matches on my investors list please',
    loads: ['prospecting-playbook'],
    tools: ['search_tools', 'list_prospect_lists', 'list_prospect_entries'],
    params: { list_prospect_entries: { min_fit_score: 80 } },
    avoid: ['run_prospect_discovery'],
  },
  {
    request: 'find more companies for the RevOps list',
    loads: ['prospecting-playbook'],
    tools: ['search_tools', 'list_prospect_lists'],
    forbidParams: { run_prospect_discovery: { confirmed_with_user: true } },
    why: 'A search waits for a yes to that run: say what it does and about how long (four to eight minutes), then ask.',
  },
  {
    request: 'dismiss Ramp from the fintech list, they are a competitor',
    loads: ['prospecting-playbook'],
    tools: ['search_tools', 'list_prospect_lists', 'list_prospect_entries'],
    forbidParams: { dismiss_prospect_entries: { confirmed_with_user: true } },
    why: 'competitor suppresses Ramp in every list in the workspace: say so and confirm the batch first.',
  },
  {
    request: 'push the saved ones on the fintech list into the CRM',
    loads: ['prospecting-playbook'],
    tools: ['search_tools', 'list_prospect_lists', 'list_prospect_entries'],
    forbidParams: { publish_prospect_list: { confirmed_with_user: true } },
    why: 'Publish writes real CRM rows: say how many go in under the list name, then wait for the yes.',
  },
  {
    request: 'save Vanta and Drata on the compliance list',
    loads: ['prospecting-playbook'],
    tools: ['search_tools', 'list_prospect_lists', 'list_prospect_entries', 'save_prospect_entries'],
    avoid: ['publish_prospect_list'],
    why: 'Saving keeps them on the list and writes nothing to the CRM: no go-ahead needed, and no publish.',
  },
  {
    request: 'what did my company research say we sell?',
    loads: ['prospecting-playbook'],
    tools: ['search_tools', 'research_my_company'],
    forbidParams: { research_my_company: { confirmed_with_user: true } },
    why: 'With no arguments it runs nothing when the company is already profiled.',
  },
]
