import type { SkillEvalCase } from '../types'

/**
 * `clear-inbox` (mail, pack-only since 325): listed in the Mail pack, which
 * `get_email_summary` (after `search_tools`) loads. Read, sort and draft,
 * and tidy in the main chat (442: update_email_thread); never send or
 * delete, and never by the browser.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'clear my inbox',
    loads: ['clear-inbox'],
    tools: ['search_tools', 'get_email_summary', 'load_skill', 'list_emails'],
    avoid: ['run_browser_task'],
  },
  {
    request: 'handle my email for me',
    loads: ['clear-inbox'],
    tools: ['search_tools', 'get_email_summary', 'load_skill', 'list_emails'],
    params: { list_emails: { max_results: 25 } },
    avoid: ['run_browser_task'],
  },
  {
    request: "draft replies to everything that needs me, there's a lot",
    loads: ['clear-inbox'],
    tools: ['search_tools', 'get_email_summary', 'load_skill', 'list_emails', 'generate_email_drafts'],
    avoid: ['run_browser_task'],
  },
  {
    request: "triage my inbox but don't draft anything yet",
    loads: ['clear-inbox'],
    tools: ['search_tools', 'get_email_summary', 'load_skill', 'list_emails'],
    avoid: ['create_email_draft', 'generate_email_drafts'],
  },
  {
    request: 'go through my inbox and archive all the newsletters',
    loads: ['clear-inbox'],
    tools: ['search_tools', 'get_email_summary', 'load_skill', 'list_emails'],
    avoid: ['run_browser_task'],
    why: 'Archive the newsletters with update_email_thread (442); over ten threads, the count first and the person\'s yes before confirmed_with_user.',
  },
  {
    request: "I've got a pile of drafts waiting, help me get through them",
    loads: ['clear-inbox'],
    tools: ['search_tools', 'get_email_summary', 'load_skill', 'get_email_drafts'],
    avoid: ['run_browser_task'],
  },
]
