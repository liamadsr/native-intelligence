import type { SkillEvalCase } from '../types'

/**
 * The CRM core (326): it rides `search_tools` revealing the CRM tools, or a
 * contact card. Cheapest first: find the contact or company, then the brief
 * or the overview. Native Intelligence's own records never need the browser, and a check-in
 * is a draft, never a send.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'brief me on Sarah Chen before my 2pm',
    loads: ['crm-playbook'],
    tools: ['search_tools', 'list_contacts', 'get_contact_details'],
    params: { list_contacts: { search: 'Sarah Chen' } },
    avoid: ['run_browser_task'],
    why: 'Resolve the contact, then the brief: relationship, last meetings, what each side owes.',
  },
  {
    request: "what's going on with the Acme account?",
    loads: ['crm-playbook'],
    tools: ['search_tools', 'list_companies', 'get_company_overview'],
    params: { list_companies: { search: 'Acme' } },
    avoid: ['run_browser_task'],
    why: 'get_company_overview takes a company_id or domain, never a name: find the company first.',
  },
  {
    request: 'mark Dave at Globex as a customer and remind me to follow up with him in March',
    loads: ['crm-playbook'],
    tools: ['search_tools', 'list_contacts', 'update_crm_contact'],
    params: { update_crm_contact: { relationship_type: 'customer' } },
    avoid: ['update_contact', 'create_contact'],
    why: 'Type and follow-up date are relationship fields: update_crm_contact, with next_followup_at.',
  },
  {
    request: 'add jane@initech.com as a lead, she runs RevOps there',
    loads: ['crm-playbook'],
    tools: ['search_tools', 'list_contacts', 'create_contact'],
    params: { create_contact: { email: 'jane@initech.com', relationship_type: 'lead' } },
    why: 'Search before creating: create_contact does not dedupe.',
  },
  {
    request: 'show me my customers that have gone cold',
    loads: ['crm-playbook'],
    tools: ['show'],
    params: {
      show: {
        kind: 'list',
        entity_type: 'contact',
        filters: [
          { field: 'relationship_type', operator: 'is', value: 'customer' },
          { field: 'relationship_strength', operator: 'is', value: 'cold' },
        ],
      },
    },
  },
  {
    request: 'whose follow-ups am I late on?',
    loads: ['crm-playbook'],
    tools: ['show'],
    params: { show: { kind: 'list', entity_type: 'contact', filters: [{ field: 'next_followup_at', operator: 'lt' }] } },
    why: 'Overdue follow-ups: next_followup_at before today, on the contact card.',
  },
  {
    request: 'which meetings has Priya from Vanta been in?',
    loads: ['crm-playbook'],
    tools: ['search_tools', 'list_contacts', 'list_contact_captures'],
    avoid: ['run_browser_task'],
    why: 'list_contact_captures covers meetings they spoke in, were identified in by voice, or were linked to.',
  },
  {
    request: 'anyone at Northwind I should check in with? we have not talked in ages',
    loads: ['crm-playbook'],
    tools: ['search_tools', 'list_companies', 'get_company_overview', 'suggest_changes'],
    params: { suggest_changes: { changes: [{ change: 'send_email', entity: 'contact' }] } },
    avoid: ['run_browser_task'],
    why: 'A recommended check-in is a draft card (send_email change), never a send from the chat.',
  },
]
