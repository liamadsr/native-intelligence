import type { SkillEvalCase } from '../types'

/**
 * The Campaigns core (326): it rides `search_tools` revealing the campaigns
 * tools, or the campaigns page card. The tools list, create and edit fields,
 * and launch a campaign that sends on the person's card (461): no delete
 * (archive), no metrics beyond a sending campaign's counts.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'what campaigns are we running right now?',
    loads: ['campaigns-playbook'],
    tools: ['search_tools', 'list_campaigns'],
    params: { list_campaigns: { status: 'active' } },
  },
  {
    request: 'set up a campaign for the spring launch: email and linkedin, Sam owns it',
    loads: ['campaigns-playbook'],
    tools: ['search_tools', 'list_campaigns', 'list_workspace_members', 'create_campaign'],
    params: { create_campaign: { channels: ['email', 'linkedin'] } },
    why: 'Check for a duplicate first; the owner is a member id from list_workspace_members.',
  },
  {
    request: 'mark the Q3 webinar series as completed',
    loads: ['campaigns-playbook'],
    tools: ['search_tools', 'list_campaigns', 'update_campaign'],
    params: { update_campaign: { status: 'completed' } },
  },
  {
    request: 'delete the old holiday promo campaign',
    loads: ['campaigns-playbook'],
    tools: ['search_tools', 'list_campaigns', 'update_campaign'],
    params: { update_campaign: { status: 'archived' } },
    why: 'There is no delete: archive it.',
  },
  {
    request: "send a win-back to customers we haven't seen in 6 months",
    loads: ['campaigns-playbook'],
    tools: ['search_tools', 'list_campaigns', 'create_campaign'],
    params: { create_campaign: { recipe: 'win_back' } },
    why: 'The win_back recipe makes the campaign and its draft emails; tailor them, then launch_campaign puts up the card.',
  },
  {
    request: 'how is the win-back doing?',
    loads: ['campaigns-playbook'],
    tools: ['search_tools', 'list_campaigns'],
    why: 'Its counts (sent, replied, opted out) come back on list_campaigns.',
  },
  {
    request: 'show me our campaigns',
    loads: ['campaigns-playbook'],
    tools: ['show'],
    params: { show: { kind: 'campaigns' } },
  },
  {
    request: 'how many signups did the spring launch campaign drive?',
    loads: ['campaigns-playbook'],
    tools: ['search_tools', 'list_campaigns'],
    avoid: ['run_browser_task'],
    why: 'Native Intelligence holds no campaign metrics: say so, and offer what the team has said about it.',
  },
  {
    request: 'tie the webinar recap doc to the Q3 webinar campaign',
    loads: ['campaigns-playbook'],
    tools: ['search_tools', 'list_campaigns', 'link_entities'],
    params: { link_entities: { target_type: 'campaign' } },
  },
]
