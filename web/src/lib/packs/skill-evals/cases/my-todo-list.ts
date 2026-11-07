import type { SkillEvalCase } from '../types'

/**
 * `my-todo-list` (actions, global): open actions assigned to the person, read
 * in ONE call (urgent first) and split by hand into overdue, due this week and
 * the rest. A `filter` only when the person asks for one slice.
 */
const MY_LIST = { assignee: 'me', confirmation: 'confirmed', limit: 200 }

export const cases: SkillEvalCase[] = [
  {
    request: "what's on my plate?",
    loads: ['my-todo-list'],
    tools: ['list_actions'],
    params: { list_actions: MY_LIST },
    avoid: ['run_browser_task'],
    why: 'The to-do list is confirmed actions assigned to me, read once and split client-side.',
  },
  {
    request: 'show me my to-dos',
    loads: ['my-todo-list'],
    tools: ['list_actions', 'show'],
    params: {
      list_actions: MY_LIST,
      show: {
        kind: 'list',
        entity_type: 'action',
        filters: [
          { field: 'assignee_id', operator: 'is', value: '@me' },
          { field: 'confirmation', operator: 'is', value: 'confirmed' },
          { field: 'status_type', operator: 'is_none_of', value: ['completed', 'canceled'] },
        ],
      },
    },
    why: 'Attended: the list also goes up as a card; the answer comes from the list_actions rows.',
  },
  {
    request: 'what should I work on today?',
    loads: ['my-todo-list'],
    tools: ['list_actions'],
    params: { list_actions: MY_LIST },
    avoid: ['get_dashboard_summary'],
    why: 'The dashboard is counts and the first 10: the recommendation needs the list itself.',
  },
  {
    request: "what's due for me this week?",
    loads: ['my-todo-list'],
    tools: ['list_actions'],
    params: { list_actions: { assignee: 'me', confirmation: 'confirmed', filter: 'this_week' } },
    why: 'One slice asked for: the filter, not the whole list.',
  },
  {
    request: 'what are my tasks',
    loads: ['my-todo-list'],
    tools: ['list_actions'],
    params: { list_actions: MY_LIST },
    avoid: ['find', 'run_browser_task'],
    why: '`find` does not search actions.',
  },
  {
    request: "what's on Sam's plate?",
    loads: ['my-todo-list'],
    tools: ['search_tools', 'list_workspace_members', 'list_actions'],
    params: { list_actions: { confirmation: 'confirmed', limit: 200 } },
    avoid: ['run_browser_task'],
    why: "A teammate's list: the same call with their member id as `assignee`.",
  },
  {
    request: "I'm swamped this week. What can slip?",
    loads: ['my-todo-list'],
    tools: ['list_actions', 'suggest_changes'],
    params: { list_actions: MY_LIST },
    why: 'Overloaded: new dates are staged as suggestions, never moved silently.',
  },
  {
    request: 'pull up my to-do list',
    loads: ['my-todo-list'],
    tools: ['list_actions'],
    params: { list_actions: MY_LIST },
    avoid: ['get_calendar_events'],
  },
  {
    request: 'anything overdue on my list?',
    loads: ['my-todo-list'],
    tools: ['list_actions'],
    params: { list_actions: { assignee: 'me', confirmation: 'confirmed', filter: 'overdue' } },
    why: 'One slice asked for: filter overdue.',
  },
]
