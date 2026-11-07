import type { SkillEvalCase } from '../types'

/** `find-anything` (knowledge, global): which tool finds which kind of thing. */
export const cases: SkillEvalCase[] = [
  {
    request: "where's the doc with the Acme SOW?",
    loads: ['find-anything'],
    tools: ['find'],
    avoid: ['run_browser_task'],
  },
  {
    request: 'find the task about renewing the SSL cert',
    loads: ['find-anything'],
    tools: ['list_actions'],
    avoid: ['run_browser_task'],
    why: '`find` does not search actions: list_actions with search.',
  },
  {
    request: 'which meeting did we talk about API rate limits in? it was a couple of months ago',
    loads: ['find-anything'],
    tools: ['find'],
    params: { find: { all_time: true } },
    why: 'Older than 4 weeks: all_time.',
  },
  {
    request: "find Priya's email address",
    loads: ['find-anything'],
    tools: ['search_tools', 'list_contacts'],
    avoid: ['run_browser_task'],
  },
  {
    request: 'find the spreadsheet someone attached with the Q3 numbers',
    loads: ['find-anything'],
    tools: ['find'],
    params: { find: { types: ['attachment'] } },
  },
  {
    request: 'is there already a project for the website relaunch?',
    loads: ['find-anything'],
    tools: ['search_tools', 'list_projects'],
  },
  {
    request: 'find where we decided to drop the free tier',
    loads: ['find-anything'],
    tools: ['find'],
    avoid: ['run_browser_task'],
  },
]
