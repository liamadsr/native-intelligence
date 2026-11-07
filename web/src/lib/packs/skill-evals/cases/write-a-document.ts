import type { SkillEvalCase } from '../types'

/**
 * `write-a-document` (documents, pack-only): listed in the Documents pack,
 * which a documents tool's first call (or the core's load) brings in. Every
 * case reaches the pack before the load. Since 370: `find` searches documents
 * in full (no `all_time`), and your own wording on an existing page is a draft
 * (`propose_document_edit`), never a live part edit.
 */
export const cases: SkillEvalCase[] = [
  {
    request: "write up yesterday's pricing call as a doc on the Atlas project",
    loads: ['documents-playbook', 'write-a-document'],
    tools: ['search_tools', 'list_captures', 'get_capture_content', 'create_document'],
    params: { list_captures: { since: 'yesterday' } },
    avoid: ['update_document', 'run_browser_task'],
  },
  {
    request: 'draft a one-pager on the Website Relaunch project for the leadership sync',
    loads: ['documents-playbook', 'write-a-document'],
    tools: ['search_tools', 'list_projects', 'get_project_context', 'create_document'],
    params: { list_projects: { search: 'Website Relaunch' } },
    avoid: ['update_document'],
  },
  {
    request: 'write a spec for the CSV export feature and link it to ENG-118',
    loads: ['documents-playbook', 'write-a-document'],
    tools: ['search_tools', 'find', 'create_document', 'get_action', 'link_document_to_action'],
    params: { get_action: { identifier: 'ENG-118' } },
    avoid: ['update_document'],
    why: 'find first for an existing spec, then create it, look up ENG-118 for its id and link it.',
  },
  {
    request: 'add a section on refunds to our Pricing FAQ',
    loads: ['documents-playbook', 'write-a-document'],
    tools: ['search_tools', 'find', 'get_document', 'propose_document_edit'],
    avoid: ['create_document', 'update_document', 'publish_draft', 'insert_section_after', 'append_to_section'],
    why: "An existing page and a section you write: propose the full new body as a draft, don't make a second page, overwrite it or add it live.",
  },
  {
    request: 'turn this morning’s standup into meeting notes in the docs',
    loads: ['documents-playbook', 'write-a-document'],
    tools: ['search_tools', 'list_captures', 'get_capture_content', 'create_document'],
    params: { list_captures: { since: 'today' } },
  },
  {
    request: 'write a doc on everything we know about our SOC 2 status',
    loads: ['documents-playbook', 'write-a-document'],
    tools: ['search_tools', 'find', 'create_document'],
    avoid: ['run_browser_task'],
  },
]
