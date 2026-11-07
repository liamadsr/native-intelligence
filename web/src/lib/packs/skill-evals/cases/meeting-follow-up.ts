import type { SkillEvalCase } from '../types'

/**
 * `meeting-follow-up` (captures, pack-only, 325): listed in the Captures
 * pack, which `list_captures` (core) loads. The email is a draft the person
 * sends (no send tool exists; the browser is never the way round), and
 * proposals are accepted only on the person's yes.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'draft the follow-up email for the Acme call',
    loads: ['meeting-follow-up'],
    tools: ['list_captures', 'load_skill', 'search_tools', 'get_capture_extractions', 'draft_followup_email'],
    avoid: ['accept_proposal', 'run_browser_task'],
    why: 'Draft now; accepting the pending proposals waits for the yes.',
  },
  {
    request: "send a follow-up to everyone from today's Globex meeting",
    loads: ['meeting-follow-up'],
    tools: ['list_captures', 'load_skill', 'search_tools', 'draft_followup_email'],
    params: { list_captures: { since: 'today' } },
    avoid: ['run_browser_task', 'accept_proposal'],
    why: '"Send" still means a draft the person sends.',
  },
  {
    request: "follow up with just the Initech people from yesterday's call, keep it casual",
    loads: ['meeting-follow-up'],
    tools: ['list_captures', 'load_skill', 'search_tools', 'get_capture_content', 'draft_followup_email'],
    params: { draft_followup_email: { tone: 'casual' } },
    avoid: ['run_browser_task'],
  },
  {
    request: 'yes, accept the proposed actions from the Acme call and then draft the follow-up',
    loads: ['meeting-follow-up'],
    tools: ['list_captures', 'load_skill', 'search_tools', 'get_capture_extractions', 'accept_proposal', 'draft_followup_email'],
    why: 'The yes came first: accept, then draft (the draft carries accepted actions only).',
  },
  {
    request: 'after the Hooli call, stage the follow-up actions for me to approve',
    loads: ['meeting-follow-up'],
    tools: ['list_captures', 'load_skill', 'search_tools', 'get_capture_extractions', 'suggest_changes'],
    avoid: ['accept_proposal'],
  },
  {
    request: "reply in the existing Acme email thread with a recap of today's call",
    loads: ['meeting-follow-up'],
    tools: ['list_captures', 'load_skill', 'search_tools', 'get_capture_content', 'read_email', 'create_email_draft'],
    avoid: ['draft_followup_email', 'run_browser_task'],
    why: 'A reply in a thread is create_email_draft with thread_id and in_reply_to.',
  },
]
