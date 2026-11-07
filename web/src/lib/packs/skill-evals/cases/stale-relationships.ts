import type { SkillEvalCase } from '../types'

/**
 * `stale-relationships` (crm, pack-only, 326): listed in the CRM pack, which
 * rides the search for the CRM tools, so the cases load the pack first.
 * Candidates from the CRM rows, the stakes for the top few, a next step each;
 * check-ins are offered as draft cards and nothing is sent or drafted in the
 * mailbox unasked.
 */
export const cases: SkillEvalCase[] = [
  {
    request: "who haven't I talked to in a while?",
    loads: ['crm-playbook', 'stale-relationships'],
    tools: ['search_tools', 'list_contacts'],
    params: { list_contacts: [{ relationship_type: 'customer' }] },
    avoid: ['run_browser_task', 'create_email_draft'],
    why: 'No window given: 30 days, said out loud.',
  },
  {
    request: 'which customers have gone quiet for 60 days or more?',
    loads: ['crm-playbook', 'stale-relationships'],
    tools: ['search_tools', 'list_contacts', 'show'],
    params: {
      list_contacts: { relationship_type: 'customer' },
      show: { kind: 'list', entity_type: 'contact', filters: [{ field: 'last_interaction_at', operator: 'lt' }] },
    },
    avoid: ['create_email_draft'],
  },
  {
    request: 'which accounts have we gone dark on since the summer?',
    loads: ['crm-playbook', 'stale-relationships'],
    tools: ['search_tools', 'list_companies', 'get_company_overview'],
    avoid: ['run_browser_task'],
    why: "A company's last_interaction_at is the latest touch with anyone there; the overview gives the stakes.",
  },
  {
    request: 'find my neglected relationships and draft check-ins for the most important ones',
    loads: ['crm-playbook', 'stale-relationships'],
    tools: ['search_tools', 'list_contacts', 'get_contact_details', 'suggest_changes'],
    params: { suggest_changes: { changes: [{ change: 'send_email', entity: 'contact' }] } },
    avoid: ['run_browser_task'],
    why: 'Check-ins are draft cards: Accept writes a draft for review, and nothing sends.',
  },
  {
    request: 'any important relationships I am letting slip? leads count too',
    loads: ['crm-playbook', 'stale-relationships'],
    tools: ['search_tools', 'list_contacts', 'get_contact_details'],
    params: { list_contacts: [{ relationship_type: 'customer' }, { relationship_type: 'lead' }] },
    avoid: ['create_email_draft'],
    why: 'Rank from the rows, then the stakes (open actions, pending commitments) for the top few only.',
  },
  {
    request: "who on my partner list haven't I spoken to in a month? just tell me, don't change anything",
    loads: ['crm-playbook', 'stale-relationships'],
    tools: ['search_tools', 'list_contacts'],
    params: { list_contacts: { relationship_type: 'partner' } },
    avoid: ['update_crm_contact', 'create_email_draft'],
  },
]
