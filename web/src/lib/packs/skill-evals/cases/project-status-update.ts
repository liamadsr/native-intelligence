import type { SkillEvalCase } from '../types'

/**
 * `project-status-update` (projects, pack-only): listed in the Projects pack,
 * which rides `search_tools` revealing the projects tools.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'write a status update for Atlas',
    loads: ['projects-playbook', 'project-status-update'],
    tools: ['search_tools', 'list_projects', 'get_project_context', 'list_actions'],
    params: { list_projects: { search: 'Atlas' } },
    avoid: ['run_browser_task'],
  },
  {
    request: "how's the Website Relaunch project going?",
    loads: ['projects-playbook', 'project-status-update'],
    tools: ['search_tools', 'list_projects', 'get_project_context', 'list_actions'],
    params: { list_projects: { search: 'Website Relaunch' } },
  },
  {
    request: 'give me a PM-style update on Onboarding v2 for the Friday sync',
    loads: ['projects-playbook', 'project-status-update'],
    tools: ['search_tools', 'list_projects', 'get_project_context', 'list_actions'],
    params: { list_projects: { search: 'Onboarding v2' } },
  },
  {
    request: 'is the Mobile App project on track?',
    loads: ['projects-playbook', 'project-status-update'],
    tools: ['search_tools', 'list_projects', 'get_project_context', 'list_actions'],
    params: { list_actions: { filter: 'completed', time_field: 'updated_at' } },
    why: 'get_project_context has the open work (the 20 most urgent and open_actions_total); list_actions adds what finished lately.',
  },
  {
    request: 'draft a status update for Atlas and save it as a doc on the project',
    loads: ['projects-playbook', 'project-status-update'],
    tools: ['search_tools', 'list_projects', 'get_project_context', 'list_actions', 'create_document'],
    why: 'Saved as a document only because they asked.',
  },
  {
    request: "what's at risk on the Q4 Launch project?",
    loads: ['projects-playbook', 'project-status-update'],
    tools: ['search_tools', 'list_projects', 'get_project_context', 'list_actions'],
    params: { list_projects: { search: 'Q4 Launch' } },
  },
]
