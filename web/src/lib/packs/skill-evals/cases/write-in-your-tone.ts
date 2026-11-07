import type { SkillEvalCase } from '../types'

/**
 * `write-in-your-tone` (mail, pack-only since 325): listed in the Mail pack,
 * which a mail tool's call loads, so the cases touch mail before the load.
 */
export const cases: SkillEvalCase[] = [
  {
    request: "draft a reply to Tom's email in my voice",
    loads: ['write-in-your-tone'],
    tools: ['search_tools', 'list_emails', 'load_skill', 'read_email', 'create_email_draft'],
    avoid: ['run_browser_task'],
  },
  {
    request: 'write a short casual reply to Priya saying yes to lunch on Friday, the way I write',
    loads: ['write-in-your-tone'],
    tools: ['search_tools', 'list_emails', 'load_skill', 'create_email_draft'],
  },
  {
    request: "rewrite my draft to Acme so it sounds like me, and remember I sign off with 'Cheers, Liam'",
    loads: ['write-in-your-tone'],
    tools: ['search_tools', 'get_email_drafts', 'load_skill', 'revise_email_draft', 'remember'],
    params: { remember: { area: 'mail' } },
  },
  {
    request: 'the drafts Dial8 wrote for me sound robotic, make them sound like me',
    loads: ['write-in-your-tone'],
    tools: ['search_tools', 'get_email_drafts', 'load_skill', 'revise_email_draft'],
    avoid: ['generate_email_drafts'],
  },
  {
    request: 'reply to the Globex email in my usual tone, I never use exclamation marks',
    loads: ['write-in-your-tone'],
    tools: ['search_tools', 'list_emails', 'load_skill', 'read_email', 'create_email_draft'],
  },
]
