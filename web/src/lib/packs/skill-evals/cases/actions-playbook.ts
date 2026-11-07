import type { SkillEvalCase } from '../types'

/** The Actions core: it rides the first actions tool call. */
export const cases: SkillEvalCase[] = [
  {
    request: 'close ENG-42',
    loads: ['actions-playbook'],
    tools: ['complete_action'],
    params: { complete_action: { identifier: 'ENG-42' } },
    avoid: ['delete_action'],
  },
  {
    request: 'move GEN-12 to In Progress',
    loads: ['actions-playbook'],
    tools: ['update_action'],
    params: { update_action: { identifier: 'GEN-12', status_name: 'In Progress' } },
  },
  {
    request: "show me everything assigned to me that's still open, as a board",
    loads: ['actions-playbook'],
    tools: ['show'],
    params: {
      show: {
        kind: 'board',
        entity_type: 'action',
        filters: [
          { field: 'assignee_id', operator: 'is', value: '@me' },
          { field: 'status_type', operator: 'is_none_of', value: ['completed', 'canceled'] },
        ],
      },
    },
  },
  {
    request: 'add a task to send Acme the revised SOW by Friday',
    loads: ['actions-playbook'],
    tools: ['list_actions', 'create_action'],
    why: 'Look for a twin (list_actions search) before creating.',
  },
  {
    request: "the board's a mess. What should we clean up?",
    loads: ['actions-playbook'],
    tools: ['list_actions', 'suggest_changes'],
    avoid: ['delete_action'],
    why: 'Unasked changes are staged as suggestions, not made.',
  },
  {
    request: 'give ENG-7 to Sam',
    loads: ['actions-playbook'],
    tools: ['search_tools', 'list_workspace_members', 'update_action'],
    params: { update_action: { identifier: 'ENG-7' } },
    why: 'update_action takes assignee_id, so Sam is looked up first.',
  },
  {
    request: "what's everyone working on right now?",
    loads: ['actions-playbook'],
    tools: ['list_actions'],
    params: { list_actions: { status: 'active' } },
    avoid: ['run_browser_task'],
  },
]
