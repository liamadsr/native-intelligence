import type { SkillEvalCase } from '../types'

/**
 * `launch-a-sequence` (sequences, pack-only, 326): listed in the Sequences
 * pack, which rides the search for the sequences tools, so the cases load the
 * pack first. The launch is the person's yes (461): the recipe stages,
 * reviews, then `launch_sequence` puts up the card with every email and
 * recipient, and the agent says what will send and that it waits for them.
 * Resuming a paused one sends real mail, so `forbidParams` holds every turn
 * without the person's yes to never pass `status` resume.
 */
const NO_RESUME = { update_sequence: { status: 'resume' } }

export const cases: SkillEvalCase[] = [
  {
    request: 'put the fintech CFOs in my CRM into the Q4 outbound sequence and launch it',
    loads: ['sequences-playbook', 'launch-a-sequence'],
    tools: ['search_tools', 'list_sequences', 'list_contacts'],
    avoid: ['enroll_contacts_in_sequence'],
    forbidParams: NO_RESUME,
    why: 'A segment they described, not named: read back who goes in and wait for the yes (enrollment is sticky); the launch card comes after.',
  },
  {
    request: 'enroll all our leads at Globex in the Globex outreach sequence and get it going',
    loads: ['sequences-playbook', 'launch-a-sequence'],
    tools: ['search_tools', 'list_sequences', 'list_companies', 'list_contacts', 'enroll_contacts_in_sequence'],
    params: { list_contacts: { relationship_type: 'lead' } },
    forbidParams: NO_RESUME,
  },
  {
    request: 'set up a 4-step sequence for design partners and launch it to my partner contacts',
    loads: ['sequences-playbook', 'launch-a-sequence'],
    tools: ['search_tools', 'list_sequences'],
    avoid: ['enroll_contacts_in_sequence'],
    forbidParams: NO_RESUME,
    why: 'Nothing fits: save the steps as a draft (it never sends), show them and offer changes; enroll and hand over once they are happy.',
  },
  {
    request: 'launch the Q4 outbound sequence to the 30 people I enrolled yesterday',
    loads: ['sequences-playbook', 'launch-a-sequence'],
    tools: ['search_tools', 'list_sequences', 'get_sequence', 'launch_sequence'],
    avoid: ['enroll_contacts_in_sequence'],
    forbidParams: NO_RESUME,
    why: 'Already staged: review the steps against them, then launch_sequence puts up the card; say what step 1 sends and when, and that it waits for their yes.',
  },
  {
    request: 'turn the paused investor sequence back on',
    loads: ['sequences-playbook', 'launch-a-sequence'],
    tools: ['search_tools', 'list_sequences', 'get_sequence'],
    forbidParams: NO_RESUME,
    why: 'Resuming sends real mail: say how many active contacts it reaches and when, then wait for the yes.',
  },
  {
    request: 'yes, go ahead and resume the investor sequence',
    loads: ['sequences-playbook'],
    tools: ['search_tools', 'list_sequences', 'get_sequence', 'update_sequence'],
    params: { update_sequence: { status: 'resume' } },
    avoid: ['enroll_contacts_in_sequence'],
    why: 'This is the yes, to that resume.',
  },
]
