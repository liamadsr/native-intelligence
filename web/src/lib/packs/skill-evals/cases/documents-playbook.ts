import type { SkillEvalCase } from '../types'

/**
 * The Documents core (rewritten in 327, phase 1 tools in 368): `find` before
 * creating, read the part you need, change the part and not the page (live
 * for a change the person spelled out, a draft for your own wording),
 * history and restore when asked, linking to work. Every documents tool sits
 * behind search_tools.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'show me the docs I wrote',
    loads: ['documents-playbook'],
    tools: ['show'],
    params: {
      show: { kind: 'list', entity_type: 'document', filters: [{ field: 'created_by', operator: 'is', value: '@me' }] },
    },
    avoid: ['run_browser_task'],
  },
  {
    request: 'what documents are in the Atlas project?',
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_projects', 'list_documents'],
    params: { list_projects: { search: 'Atlas' } },
    avoid: ['run_browser_task', 'create_document'],
  },
  {
    request: 'which docs were edited in the past week?',
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_documents'],
    params: { list_documents: { since: 'past_7_days', time_field: 'updated_at' } },
  },
  {
    request: "fix the typo in the onboarding guide: 'recieve' should be 'receive'",
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_documents', 'get_document', 'edit_document_content'],
    avoid: ['update_document', 'publish_draft'],
    why: 'A small fix asked for outright: one exact passage, live.',
  },
  {
    request: 'tighten up the intro of the Pricing FAQ, it rambles',
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_documents', 'get_document', 'propose_document_edit'],
    avoid: ['update_document', 'publish_draft'],
    why: "A rewrite of someone's page goes in as a draft the person publishes.",
  },
  {
    request: 'publish my draft of the security policy',
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_documents', 'publish_draft'],
    params: { list_documents: { search: 'security policy' } },
    avoid: ['propose_document_edit', 'update_document'],
  },
  {
    request: 'attach the API spec doc to ENG-42',
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_documents', 'get_action', 'link_document_to_action'],
    params: { get_action: { identifier: 'ENG-42' } },
    avoid: ['create_document', 'update_document'],
    why: 'link_document_to_action takes the action UUID: look ENG-42 up with get_action first.',
  },
  {
    request: 'move the Q3 planning doc into the Atlas project',
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_documents', 'list_projects', 'update_document'],
    avoid: ['create_document', 'propose_document_edit'],
    why: 'A page joins a project through update_document with project_id.',
  },
  {
    request: 'what does the Atlas spec say about rate limits?',
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_documents', 'get_document'],
    forbidParams: { get_document: { full: true } },
    avoid: ['update_document', 'propose_document_edit'],
    why: 'Read the part you need (section or match), not the whole body of a long page.',
  },
  {
    request: 'add a Risks section after Goals in the Atlas spec with two bullets: vendor lock-in, and the hiring freeze',
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_documents', 'get_document', 'insert_section_after'],
    params: { insert_section_after: { after: 'Goals', heading: 'Risks' } },
    avoid: ['update_document', 'propose_document_edit'],
    why: 'A change the person spelled out goes live as a part edit, not a whole-body rewrite.',
  },
  {
    request: 'drop the Open questions section from the launch plan',
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_documents', 'get_document', 'remove_section'],
    avoid: ['update_document', 'propose_document_edit'],
  },
  {
    request: 'what changed in the pricing FAQ this week?',
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_documents', 'list_document_revisions'],
    avoid: ['restore_document_revision', 'update_document'],
    why: 'The history answers it; looking is not undoing.',
  },
  {
    request: 'undo the last change Dial8 made to the onboarding guide',
    loads: ['documents-playbook'],
    tools: ['search_tools', 'list_documents', 'list_document_revisions', 'restore_document_revision'],
    avoid: ['update_document', 'propose_document_edit', 'edit_document_content'],
    why: 'The person asked: restore the version before it, as a new revision.',
  },
]
