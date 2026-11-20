/**
 * What the contact demo's requests are answered with (lib/demo/demo-fetch.ts).
 * FICTIONAL: a made-up person at a made-up company, the same story the rest
 * of the landing page tells.
 */
import type { DemoSnapshot } from '../demo-fetch'

export const DEMO_CONTACT_ID = 'demo-contact-lena'

/**
 * Times are counted back from `now`, so the record always reads as this
 * week's ("2h ago", "Yesterday"), whenever the page is opened.
 */
export function contactSnapshot(now: Date = new Date()): DemoSnapshot {
  const HOUR = 3_600_000
  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR).toISOString()
  const ahead = (days: number) => new Date(now.getTime() + days * 24 * HOUR).toISOString()
  return {
  [`/api/account/contacts/${DEMO_CONTACT_ID}`]: {
    contact: {
      id: DEMO_CONTACT_ID,
      full_name: 'Lena Park',
      first_name: 'Lena',
      last_name: 'Park',
      email: 'lena.park@northwind.example',
      secondary_emails: [],
      phone: '+1 555-0142',
      job_title: 'Head of Operations',
      department: 'Operations',
      linkedin_url: null,
      avatar_url: null,
      relationship_type: 'customer',
      relationship_strength: 'strong',
      last_interaction_at: ago(2),
      interaction_count: 14,
      next_followup_at: ahead(3),
      visibility: 'workspace',
      member_id: null,
      created_by_member_id: null,
      notes:
        'Runs the March delivery on Northwind’s side.\n\n- Delivery moved to March 18, with 200 units early on March 4.\n- Wants a revised invoice before Friday.\n- Prefers a short email over a call for routine changes.',
      tags: ['Spring launch'],
      metadata: null,
      company: { id: 'demo-company-northwind', name: 'Northwind', domain: 'northwind.example', industry: 'Logistics' },
      interactions: [
        { id: 'i1', interaction_type: 'capture', title: 'Northwind call', occurred_at: ago(3), reference_type: 'capture', reference_id: 'demo-capture-1' },
        { id: 'i2', interaction_type: 'email_received', title: 'Re: March delivery', occurred_at: ago(8), reference_type: null, reference_id: null },
        { id: 'i3', interaction_type: 'action_assigned', title: 'Send Northwind the revised invoice', occurred_at: ago(8), reference_type: null, reference_id: null },
        { id: 'i4', interaction_type: 'email_sent', title: 'Delivery dates for March', occurred_at: ago(5 * 24), reference_type: null, reference_id: null },
        { id: 'i5', interaction_type: 'capture', title: 'Northwind check-in', occurred_at: ago(12 * 24), reference_type: 'capture', reference_id: 'demo-capture-2' },
      ],
      captures: [
        { id: 'demo-capture-1', title: 'Northwind call', ai_summary: 'Delivery moves to March 18. 200 units ship early on March 4. Lena is waiting on the revised invoice.', started_at: ago(3), ended_at: ago(2), status: 'completed' },
        { id: 'demo-capture-2', title: 'Northwind check-in', ai_summary: 'Lena reported an export timeout. Marcus took the fix.', started_at: ago(12 * 24), ended_at: ago(12 * 24 - 0.5), status: 'completed' },
      ],
      email_threads: [
        { id: 't1', provider_thread_id: 'demo-thread-1', subject: 'Re: March delivery', snippet: 'Could we move the delivery to the 18th? We can take 200 units early.', last_message_at: ago(8), needs_reply: false },
      ],
      open_actions: [
        { id: 'a1', title: 'Send Northwind the revised invoice', identifier: 'OPS-31', priority: 'high', due_at: ahead(2) },
        { id: 'a2', title: 'Confirm the March 4 shipment', identifier: 'OPS-32', priority: 'medium', due_at: ahead(1) },
      ],
      actions: [
        { id: 'a1', title: 'Send Northwind the revised invoice', identifier: 'OPS-31', priority: 'high', due_at: ahead(2), status_name: 'In Progress', status_category: 'started', status_color: '#f59e0b' },
        { id: 'a2', title: 'Confirm the March 4 shipment', identifier: 'OPS-32', priority: 'medium', due_at: ahead(1), status_name: 'Todo', status_category: 'unstarted', status_color: '#94a3b8' },
      ],
    },
  },
  '/api/account/knowledge/entity-context': {
    claims: [
      { id: 'c1', text: 'Northwind’s delivery moved to March 18.', type: 'fact', confirmation: 'confirmed', status: 'active', event_at: null, created_at: ago(2), excerpt: { excerpt: 'Let’s say the 18th, and we can take two hundred units on the 4th.', source_type: 'capture' } },
      { id: 'c2', text: 'Lena needs a revised invoice before Friday.', type: 'fact', confirmation: 'confirmed', status: 'active', event_at: null, created_at: ago(8), excerpt: { excerpt: 'Please send a revised invoice before Friday.', source_type: 'email' } },
      { id: 'c3', text: 'Will Northwind take the remaining units in one shipment?', type: 'open_question', confirmation: 'suggested', status: 'active', event_at: null, created_at: ago(2), excerpt: null },
    ],
  },
  '/api/account/companies': { companies: [{ id: 'demo-company-northwind', name: 'Northwind' }] },
}
}
