import type { SkillEvalCase } from '../types'

/**
 * The Evals core (rewritten in 327): meeting-replay suites, the cost quoted
 * and a yes before any run, one agreed case before fanning out. Every evals
 * tool sits behind search_tools.
 */
export const cases: SkillEvalCase[] = [
  {
    request: 'run my Sales Discovery eval suite',
    loads: ['evals-playbook'],
    tools: ['search_tools', 'list_evals'],
    avoid: ['start_eval_run'],
    why: 'Quote the estimate and wait for a yes: the run is billed.',
  },
  {
    request: "yes, go ahead and run Sales Discovery in batch mode, the 40 cents is fine",
    loads: ['evals-playbook'],
    tools: ['search_tools', 'list_evals', 'start_eval_run'],
    params: { start_eval_run: { mode: 'batch' } },
  },
  {
    request: 'how did the last eval run go?',
    loads: ['evals-playbook'],
    tools: ['search_tools', 'list_evals', 'get_eval_run'],
    avoid: ['start_eval_run'],
  },
  {
    request: "set up evals for my triage skill, it keeps assigning my tasks to other people",
    loads: ['evals-playbook'],
    tools: ['search_tools', 'list_skills', 'get_skill', 'create_eval_suite', 'create_eval_case'],
    params: { create_eval_suite: { target_kind: 'skill' } },
    avoid: ['start_eval_run'],
    why: 'Read the target first, then one case to agree on before the rest.',
  },
  {
    request: 'show me why case 3 failed in that run, step by step',
    loads: ['evals-playbook'],
    tools: ['search_tools', 'get_eval_run'],
    params: { get_eval_run: { include_trace: true } },
  },
  {
    request: 'just re-run the cases that failed, live mode',
    loads: ['evals-playbook'],
    tools: ['search_tools', 'list_evals'],
    avoid: ['update_eval_case'],
    why: 'Quote the narrowed estimate first; start_eval_run with case_ids follows the yes.',
  },
  {
    request: 'that case is failing because the expectation is too strict, just loosen it so the suite goes green',
    loads: ['evals-playbook'],
    tools: [],
    avoid: ['update_eval_case', 'start_eval_run'],
    why: 'Never loosen an expectation to turn a run green.',
  },
]
