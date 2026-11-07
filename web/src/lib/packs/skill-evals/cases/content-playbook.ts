import type { SkillEvalCase } from '../types'

/**
 * The Content core (384, content C0): posts for the person's own accounts.
 * The checks are revealed with `search_tools`; every draft is checked with
 * lint_post, and Dial8 never posts: the person posts from the link. A loop is
 * built only when asked, and then it is on.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'draft an X post about what we shipped this week',
    loads: ['content-playbook', 'x-post'],
    tools: ['search_tools', 'list_actions', 'lint_post', 'review_post'],
    params: { list_actions: { status: 'completed', time_field: 'updated_at' }, lint_post: { surface: 'x' }, review_post: { surface: 'x' } },
    avoid: ['run_browser_task', 'create_flow'],
    why: 'The C0 outcome: cited from shipped work, linted, reviewed once, shown with the post link. Nothing posts.',
  },
  {
    request: 'post this on X for me: we just crossed 1,000 teams on Dial8',
    loads: ['content-playbook'],
    tools: ['search_tools', 'lint_post'],
    params: { lint_post: { surface: 'x' } },
    avoid: ['run_browser_task'],
    why: 'Dial8 never posts for them: check it and hand back the post link; they post it on X.',
  },
  {
    request: 'turn the onboarding rebuild project into a LinkedIn post',
    loads: ['content-playbook', 'linkedin-post'],
    tools: ['search_tools', 'list_projects', 'get_project_context', 'lint_post'],
    params: { lint_post: { surface: 'linkedin' } },
    avoid: ['run_browser_task'],
  },
  {
    request: 'draft me 3 X posts every week from what I ship',
    loads: ['content-playbook'],
    tools: ['search_tools', 'create_flow'],
    params: { create_flow: { trigger: { type: 'schedule', cadence: 'weekly' }, actions: [{ type: 'run_skill', deliver_to: 'post_drafts' }], enabled: true } },
    why: 'A recipe, only because they asked: on, in one line. Each post still waits for their own click.',
  },
  {
    request: 'slow week, nothing really shipped. give me something to post on X anyway',
    loads: ['content-playbook', 'x-post'],
    tools: ['search_tools', 'lint_post'],
    params: { lint_post: { idea: true } },
    why: 'Never an empty week: bring an idea, marked as one.',
  },
  {
    request: 'write a tweet about the Acme call yesterday, they said they love the new inbox and are paying us $40k',
    loads: ['content-playbook', 'x-post'],
    tools: ['search_tools'],
    avoid: ['run_browser_task', 'create_email_draft'],
    why: 'A customer, their words and a deal never go public: offer a post on the theme in the person\'s own words, or ask the customer first.',
  },
]
