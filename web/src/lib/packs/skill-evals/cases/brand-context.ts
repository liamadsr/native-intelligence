import type { SkillEvalCase } from '../types'

/**
 * `brand-context` (marketing, pack-only, 385): drafts the product doc's six
 * sections by inference, grades every claim by evidence, keeps the open
 * questions. Listed in the Marketing pack, which its playbook's load brings
 * in. Every case reaches the pack first.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'set up our positioning',
    loads: ['marketing-playbook', 'brand-context'],
    tools: ['read_canon', 'research_my_company', 'find', 'propose_section_edit'],
    params: { read_canon: { key: 'product' }, propose_section_edit: { key: 'product' } },
    forbidParams: { research_my_company: { confirmed_with_user: true } },
    why: 'Infer, never interview: read what is there, check the own company without running research, then one edit per section.',
  },
  {
    request: 'we have no product doc yet, write one from what you know about us',
    loads: ['marketing-playbook', 'brand-context'],
    tools: ['read_canon', 'create_canon_document', 'propose_section_edit'],
    params: { create_canon_document: { key: 'product' } },
  },
  {
    request: 'refresh the product doc with what customers said this month',
    loads: ['marketing-playbook', 'brand-context'],
    tools: ['read_canon', 'find', 'propose_section_edit'],
    params: { read_canon: { key: 'product' } },
    why: 'Customers\' words stay on the calls: the doc gets our words, each line graded from its calls.',
  },
  {
    request: 'look at our competitors\' websites and update the Positioning in the product doc',
    loads: ['marketing-playbook', 'brand-context'],
    tools: ['read_canon', 'propose_section_edit'],
    params: { propose_section_edit: { key: 'product', section: 'Positioning' } },
    why: 'At most 8 pages; an edit resting on web pages applies, labelled so in the history: say which sections.',
  },
  {
    request: 'the pricing question in the product doc is settled, we went per-workspace. update it',
    loads: ['marketing-playbook', 'brand-context'],
    tools: ['read_canon', 'propose_section_edit'],
    params: { read_canon: { key: 'product' } },
    why: 'Resolve the open question by moving it: the answer lands in its section, then it leaves the list. Never just delete it.',
  },
]
