import type { SkillEvalCase } from '../types'

/**
 * The Marketing core (385, marketing M0): the product doc is the brand
 * context, graded by evidence from customer calls. It is read by key, edited
 * a section at a time, and only an admin's edits apply at once. Loops are
 * built only when asked.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'how do we usually answer the pricing objection?',
    loads: ['marketing-playbook'],
    tools: ['read_canon'],
    params: { read_canon: { key: 'product' } },
    avoid: ['propose_section_edit'],
    why: 'The answer lives in the product doc: read it, cite its grade, and say what is only an assumption.',
  },
  {
    request: 'what are customers saying about Gong on our calls?',
    loads: ['marketing-playbook'],
    tools: ['find'],
    avoid: ['propose_section_edit', 'create_document'],
    why: 'Internal reading of the calls; nothing written until they ask.',
  },
  {
    request: 'keep our product doc current from customer calls',
    loads: ['marketing-playbook'],
    tools: ['search_tools', 'create_flow'],
    params: { create_flow: { trigger: { type: 'capture_processed' }, actions: [{ type: 'run_skill', skill: 'marketing-lens' }], enabled: true } },
    why: 'A lens on the one read of each call; they asked, so it is on.',
  },
  {
    request: 'send a newsletter to all our customers about the launch',
    loads: ['marketing-playbook'],
    tools: [],
    avoid: ['enroll_contacts_in_sequence', 'create_email_draft', 'run_browser_task'],
    why: 'Native Intelligence sends no broadcasts: offer the newsletter as a document they copy into their own tool.',
  },
  {
    request: 'add to the product doc that we are the only tool that files actions during the call',
    loads: ['marketing-playbook'],
    tools: ['read_canon', 'propose_section_edit'],
    params: { read_canon: { key: 'product' }, propose_section_edit: { key: 'product' } },
    why: '"The only" needs proof: grade it from its evidence (an assumption without two companies or a published document).',
  },
]
