import type { SkillEvalCase } from '../types'

/**
 * `meeting-recap` (captures, pack-only, 325): listed in the Captures pack,
 * which `list_captures` (core) loads, so the cases find the meeting first.
 * Summary and extractions before any transcript page; nothing is accepted.
 */
const READ_ONLY = ['accept_proposal', 'dismiss_proposal', 'run_browser_task']
export const cases: SkillEvalCase[] = [
  {
    request: "recap yesterday's Atlas sync",
    loads: ['meeting-recap'],
    tools: ['list_captures', 'load_skill', 'search_tools', 'get_capture_content', 'get_capture_extractions'],
    params: { list_captures: { since: 'yesterday' } },
    avoid: [...READ_ONLY, 'get_capture_transcript'],
  },
  {
    request: 'give me a recap of the Acme call: decisions, action items and open questions',
    loads: ['meeting-recap'],
    tools: ['list_captures', 'load_skill', 'search_tools', 'get_capture_content', 'get_capture_extractions'],
    avoid: READ_ONLY,
  },
  {
    request: 'recap the Globex call and quote exactly what they said about budget',
    loads: ['meeting-recap'],
    tools: ['list_captures', 'load_skill', 'search_tools', 'get_capture_content', 'get_capture_transcript'],
    avoid: READ_ONLY,
    why: 'An exact quote is when the transcript earns its pages.',
  },
  {
    request: "recap this week's standups in one summary",
    loads: ['meeting-recap'],
    tools: ['list_captures', 'load_skill', 'search_tools', 'get_capture_content'],
    params: { list_captures: { since: 'this_week' } },
    avoid: READ_ONLY,
  },
  {
    request: "what were the action items from this morning's design review, and which ones are actually on the board?",
    loads: ['meeting-recap'],
    tools: ['list_captures', 'load_skill', 'search_tools', 'get_capture_extractions'],
    avoid: READ_ONLY,
    why: 'Accepted vs proposed comes from the extractions: proposals are marked proposed.',
  },
  {
    request: 'recap my last meeting with Maria Chen',
    loads: ['meeting-recap'],
    tools: ['search_tools', 'list_contact_captures', 'load_skill', 'get_capture_content'],
    avoid: READ_ONLY,
  },
]
