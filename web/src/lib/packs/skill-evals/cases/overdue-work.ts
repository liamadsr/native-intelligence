import type { SkillEvalCase } from '../types'

/**
 * `overdue-work` (actions, pack-only): listed in the Actions pack, which rides
 * the first `list_actions` call, so the cases load the pack first. The scope
 * (person, project, team) is a `list_actions` filter, in the database.
 */
export const cases: SkillEvalCase[] = [
  {
    request: "what's overdue on Atlas?",
    loads: ['actions-playbook', 'overdue-work'],
    tools: ['search_tools', 'list_projects', 'list_actions'],
    params: { list_projects: { search: 'Atlas' }, list_actions: { filter: 'overdue', confirmation: 'confirmed' } },
    avoid: ['run_browser_task'],
    why: "The project's id from list_projects, then list_actions with that project_id.",
  },
  {
    request: "what's Sam behind on?",
    loads: ['actions-playbook', 'overdue-work'],
    tools: ['search_tools', 'list_workspace_members', 'list_actions'],
    params: { list_actions: { filter: 'overdue', confirmation: 'confirmed' } },
  },
  {
    request: 'which overdue items does the Design team have?',
    loads: ['actions-playbook', 'overdue-work'],
    tools: ['search_tools', 'list_workflow_states', 'list_actions', 'show'],
    params: {
      list_actions: { filter: 'overdue', confirmation: 'confirmed' },
      show: {
        kind: 'list',
        entity_type: 'action',
        filters: [
          { field: 'team_id', operator: 'is', value: 'Design' },
          { field: 'due_at', operator: 'lt' },
          { field: 'status_type', operator: 'is_none_of', value: ['completed', 'canceled'] },
        ],
      },
    },
    why: "The team's id from list_workflow_states for list_actions; the card filters due_at lt today's ISO date.",
  },
  {
    request: 'clean up the overdue stuff on Website Relaunch and propose new dates',
    loads: ['actions-playbook', 'overdue-work'],
    tools: ['search_tools', 'list_projects', 'list_actions', 'suggest_changes'],
    params: { list_actions: { filter: 'overdue', confirmation: 'confirmed' } },
    avoid: ['delete_action'],
    why: 'Fixes are staged with suggest_changes, one batch.',
  },
  {
    request: 'how much overdue work is there across the whole workspace?',
    loads: ['actions-playbook', 'overdue-work'],
    tools: ['list_actions'],
    params: { list_actions: { filter: 'overdue', confirmation: 'confirmed', limit: 200 } },
  },
  {
    request: 'who on the team is sitting on the most late tasks?',
    loads: ['actions-playbook', 'overdue-work'],
    tools: ['list_actions', 'search_tools', 'list_workspace_members'],
    params: { list_actions: { filter: 'overdue', confirmation: 'confirmed' } },
    why: 'Owners: assignee ids mapped to names.',
  },
]
