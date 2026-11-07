import type { SkillEvalCase } from '../types'

/**
 * The Sequences core (326): it rides `search_tools` revealing the sequences
 * tools. A launch is the person's yes: launch_sequence puts up the card (461).
 * Resuming sends real mail, so `forbidParams` holds a bare "resume X" to state
 * what will send first, and a "launch" request to never reach for resume.
 */
const NO_RESUME = { update_sequence: { status: 'resume' } }

export const cases: SkillEvalCase[] = [
  {
    request: "how's my investor outreach going?",
    loads: ['sequences-playbook'],
    tools: ['search_tools', 'list_sequences', 'get_sequence'],
    avoid: ['update_sequence'],
    why: 'Lead with replies, then what is active and when the next sends go.',
  },
  {
    request: 'who replied to the Q4 outbound sequence?',
    loads: ['sequences-playbook'],
    tools: ['search_tools', 'list_sequences', 'get_sequence'],
    avoid: ['update_sequence', 'run_browser_task'],
  },
  {
    request: 'write me a 3-step sequence for seed investors, a follow-up every 3 days',
    loads: ['sequences-playbook'],
    tools: ['search_tools', 'create_sequence'],
    params: {
      create_sequence: {
        steps: [
          { step_order: 1, delay_days: 0 },
          { step_order: 2, delay_days: 3 },
          { step_order: 3, delay_days: 3 },
        ],
      },
    },
    avoid: ['enroll_contacts_in_sequence'],
    why: 'A draft never sends; later steps leave the subject off so they thread.',
  },
  {
    request: 'pause the Q4 outbound sequence',
    loads: ['sequences-playbook'],
    tools: ['search_tools', 'list_sequences', 'update_sequence'],
    params: { update_sequence: { status: 'pause' } },
    forbidParams: NO_RESUME,
  },
  {
    request: 'resume the investor sequence',
    loads: ['sequences-playbook'],
    tools: ['search_tools', 'list_sequences', 'get_sequence'],
    forbidParams: NO_RESUME,
    why: 'Resuming sends real mail: say how many are active and when the next sends go, and resume on the yes.',
  },
  {
    request: 'launch the investor sequence',
    loads: ['sequences-playbook'],
    tools: ['search_tools', 'list_sequences', 'launch_sequence'],
    forbidParams: NO_RESUME,
    why: 'launch_sequence puts up the card with every email and recipient; it launches only on their yes.',
  },
  {
    request: 'take Mark Lee out of the Q4 sequence, he asked us to stop',
    loads: ['sequences-playbook'],
    tools: ['search_tools', 'list_sequences', 'get_sequence', 'remove_from_sequence'],
    avoid: ['update_sequence'],
  },
  {
    request: "change step 2 of the investor sequence to mention we just closed our Series A",
    loads: ['sequences-playbook'],
    tools: ['search_tools', 'list_sequences', 'get_sequence', 'update_sequence'],
    params: { update_sequence: { steps: [{ step_order: 2 }] } },
    avoid: ['create_sequence'],
    forbidParams: NO_RESUME,
    why: 'Pass every step with its id; a step left out is deleted.',
  },
]
