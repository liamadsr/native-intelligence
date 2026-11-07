import type { SkillEvalCase } from '../types'

/**
 * The Library core (rewritten in 327): skills and agents, who can see them
 * (personal, workspace, public for owners and admins), create after showing
 * the draft, update only what changes. Every library tool sits behind
 * search_tools.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'what skills do I have?',
    loads: ['library-playbook'],
    tools: ['search_tools', 'list_skills'],
    avoid: ['create_skill'],
  },
  {
    request: 'save what we just did as a skill',
    loads: ['library-playbook'],
    tools: ['search_tools', 'list_skills'],
    avoid: ['create_skill'],
    why: 'Check for a near-duplicate and show the name, description and prompt before saving.',
  },
  {
    request: "looks good, save it as the 'Weekly client recap' skill",
    loads: ['library-playbook'],
    tools: ['search_tools', 'create_skill'],
    params: { create_skill: { name: 'Weekly client recap' } },
    forbidParams: { create_skill: [{ visibility: 'workspace' }, { visibility: 'public' }] },
    why: 'Personal unless they ask to share it.',
  },
  {
    request: 'share my standup-notes skill with the whole team',
    loads: ['library-playbook'],
    tools: ['search_tools', 'list_skills', 'update_skill'],
    params: { update_skill: { visibility: 'workspace' } },
    forbidParams: { update_skill: { visibility: 'public' } },
  },
  {
    request: "what instructions does the Sales Coach agent follow?",
    loads: ['library-playbook'],
    tools: ['search_tools', 'get_agent'],
    params: { get_agent: { name: 'Sales Coach' } },
  },
  {
    request: 'change the triage skill so it never assigns work to me',
    loads: ['library-playbook'],
    tools: ['search_tools', 'list_skills', 'get_skill'],
    avoid: ['create_skill'],
    why: 'Read it first; a system skill refuses edits, so suggest forking it.',
  },
  {
    request: 'update the prompt of my deal-recap skill to also list next steps',
    loads: ['library-playbook'],
    tools: ['search_tools', 'list_skills', 'get_skill', 'update_skill'],
    avoid: ['create_skill'],
  },
  {
    request: 'make my deal-recap skill public for everyone',
    loads: ['library-playbook'],
    tools: [],
    avoid: ['update_skill'],
    why: 'Public publishes to Discover for every Dial8 user, owners and admins only: confirm that exact skill first, offer workspace otherwise.',
  },
]
