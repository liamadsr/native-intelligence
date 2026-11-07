import type { SkillEvalCase } from '../types'

/**
 * `x-post` (content, pack-only, 384): listed in the Content pack, which its
 * playbook's load (or the post checks' search) brings in. Every case reaches
 * the pack first. The craft: hook, one idea, concrete, cited, linted on every
 * version and reviewed once; the link opens X and the person posts.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'write an X post about the CSV export we shipped',
    loads: ['content-playbook', 'x-post'],
    tools: ['search_tools', 'list_actions', 'lint_post', 'review_post'],
    params: { list_actions: { status: 'completed' }, lint_post: { surface: 'x' } },
    avoid: ['run_browser_task'],
  },
  {
    request: 'make a short X thread about how we rebuilt onboarding this month',
    loads: ['content-playbook', 'x-post'],
    tools: ['search_tools', 'lint_post'],
    params: { lint_post: { surface: 'x' } },
    why: 'A thread only when one post cannot hold it: pass the posts as parts; the link opens the first.',
  },
  {
    request: 'draft a Bluesky post about the new calendar view',
    loads: ['content-playbook', 'x-post'],
    tools: ['search_tools', 'lint_post'],
    params: { lint_post: { surface: 'bluesky' } },
    why: 'Bluesky follows the X craft with its own surface in the checks.',
  },
  {
    request: 'tweet about our product being the fastest meeting tool on the market',
    loads: ['content-playbook', 'x-post'],
    tools: ['search_tools', 'read_canon'],
    params: { read_canon: { key: 'product' } },
    why: 'A superlative needs proof: read the product doc first, and hedge or drop a claim that is not proven.',
  },
  {
    request: 'punchier please, and drop the number',
    loads: ['content-playbook', 'x-post'],
    tools: ['search_tools', 'lint_post'],
    params: { lint_post: { surface: 'x' } },
    why: 'Change only what they asked, then check again.',
  },
]
