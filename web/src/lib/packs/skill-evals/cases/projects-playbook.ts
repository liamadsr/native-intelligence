import type { SkillEvalCase } from '../types'

/** The Projects core: it rides `search_tools` revealing the projects tools. */
export const cases: SkillEvalCase[] = [
  {
    request: 'list our active projects',
    loads: ['projects-playbook'],
    tools: ['search_tools', 'list_projects'],
    params: { list_projects: { status: 'active' } },
  },
  {
    request: 'which projects are behind schedule?',
    loads: ['projects-playbook'],
    tools: ['search_tools', 'list_projects'],
  },
  {
    request: "what's left to do on Atlas?",
    loads: ['projects-playbook'],
    tools: ['search_tools', 'list_projects', 'list_actions'],
    params: { list_projects: { search: 'Atlas' } },
    why: "list_actions with the project's project_id: filtered in the database, not by hand.",
  },
  {
    request: "add a milestone 'Beta live' to Atlas for Nov 15",
    loads: ['projects-playbook'],
    tools: ['search_tools', 'create_milestone'],
    params: { create_milestone: { name: 'Beta live' } },
  },
  {
    request: 'which documents and meetings are filed to the Website Relaunch project?',
    loads: ['projects-playbook'],
    tools: ['search_tools', 'list_projects', 'list_documents', 'list_captures'],
  },
  {
    request: 'Atlas slipped, push its target date out two weeks',
    loads: ['projects-playbook'],
    tools: ['search_tools', 'list_projects', 'update_project'],
  },
  {
    request: 'close out the current sprint for Engineering',
    loads: ['projects-playbook'],
    tools: ['search_tools', 'list_cycles', 'complete_cycle'],
  },
]
