import type { SkillEvalCase } from '../types'

/**
 * `build-prospect-list` (prospecting, global; rewritten in 326): the
 * Prospecting page arms it by slug, and chat lists it in every edition with
 * Prospecting. Each search, the company research and the publish wait for a
 * yes to that call: `forbidParams` holds a first turn to never pass
 * `confirmed_with_user` true.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'Learn about my company. Domain: acme.io.',
    loads: ['build-prospect-list'],
    tools: ['research_my_company'],
    forbidParams: { research_my_company: { confirmed_with_user: true } },
    why: 'Call it with no arguments first; researching reads their site, so it waits for a yes.',
  },
  {
    request: 'build me a prospect list of Series A fintechs in the US',
    loads: ['build-prospect-list'],
    tools: ['search_tools', 'research_my_company', 'list_prospect_lists'],
    forbidParams: { run_prospect_discovery: { confirmed_with_user: true } },
    why: 'Their company first, then the list; discovery waits for its own yes.',
  },
  {
    request: 'Continue prospect list: 7d1e2c40-0000-4000-8000-000000000001.',
    loads: ['build-prospect-list'],
    tools: ['search_tools', 'list_prospect_entries'],
    params: { list_prospect_entries: { list_id: '7d1e2c40-0000-4000-8000-000000000001' } },
    forbidParams: { run_prospect_discovery: { confirmed_with_user: true } },
  },
  {
    request: 'find people at the strong matches on my RevOps list',
    loads: ['build-prospect-list'],
    tools: ['search_tools', 'list_prospect_lists', 'list_prospect_entries'],
    params: { list_prospect_entries: { min_fit_score: 80 } },
    forbidParams: { find_prospect_people: { confirmed_with_user: true } },
    why: 'One search per company: say how many and about how long, then wait for the yes.',
  },
  {
    request: 'the last round was too big, US companies under 200 people only',
    loads: ['build-prospect-list'],
    tools: ['search_tools', 'list_prospect_lists', 'update_prospect_list'],
    avoid: ['create_prospect_list'],
    forbidParams: { run_prospect_discovery: { confirmed_with_user: true } },
    why: 'A reaction to a round edits the list rather than making a second one.',
  },
  {
    request: 'publish the fintech list to the CRM and enroll everyone in Q4 Outbound',
    loads: ['build-prospect-list'],
    tools: ['search_tools', 'list_prospect_lists', 'list_prospect_entries'],
    forbidParams: { publish_prospect_list: { confirmed_with_user: true } },
    avoid: ['enroll_contacts_in_sequence'],
    why: 'Publish waits for a yes to "N go into the CRM"; enrolling needs the contact ids publish returns.',
  },
]
