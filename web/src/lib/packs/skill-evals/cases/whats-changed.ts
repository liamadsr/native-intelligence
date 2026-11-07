import type { SkillEvalCase } from '../types'

/**
 * `whats-changed` (knowledge, pack-only): listed in the Knowledge pack, which
 * rides `search_tools` revealing the claims tools.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'what changed this week?',
    loads: ['knowledge-playbook', 'whats-changed'],
    tools: ['search_tools', 'list_claims'],
    params: { list_claims: { group_by_change: true, since: 'this_week' } },
  },
  {
    request: "what's new with Acme since last week?",
    loads: ['knowledge-playbook', 'whats-changed'],
    tools: ['search_tools', 'list_companies', 'list_claims'],
    params: { list_claims: { group_by_change: true, entity_type: 'company', since: 'last_week' } },
  },
  {
    request: 'what changed on Atlas in the past month?',
    loads: ['knowledge-playbook', 'whats-changed'],
    tools: ['search_tools', 'list_projects', 'list_claims', 'list_captures'],
    params: { list_claims: { group_by_change: true, entity_type: 'project', since: 'past_30_days' } },
  },
  {
    request: 'anything superseded or newly confirmed in the last 7 days?',
    loads: ['knowledge-playbook', 'whats-changed'],
    tools: ['search_tools', 'list_claims'],
    params: { list_claims: { group_by_change: true, since: 'past_7_days' } },
  },
  {
    request: 'catch me up on what changed since Monday',
    loads: ['knowledge-playbook', 'whats-changed'],
    tools: ['search_tools', 'list_claims', 'list_captures'],
    params: { list_claims: { group_by_change: true } },
    why: 'group_by_change needs a since: an ISO date for Monday.',
  },
  {
    request: 'what changed with Sarah Chen recently?',
    loads: ['knowledge-playbook', 'whats-changed'],
    tools: ['search_tools', 'list_contacts', 'list_claims', 'list_contact_captures'],
    params: { list_claims: { group_by_change: true, entity_type: 'contact' } },
  },
]
