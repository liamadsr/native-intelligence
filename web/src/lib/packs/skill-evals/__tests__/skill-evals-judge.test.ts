/**
 * The live runner's verdict (judgeSkillEvalRun) is pure, so it's pinned here,
 * in the normal suite: the live evals themselves never run in CI.
 */
import { describe, it, expect } from 'vitest'
import {
  INSTRUCTIONS_CORE_CASES_PER_SKILL,
  INSTRUCTIONS_SUITE,
  SKILL_EVAL_CASES,
  caseShapeErrors,
  deepPartialMatch,
  isOrderedSubsequence,
  judgeSkillEvalRun,
  selectSkillEvalSuites,
  skillEvalSuites,
  unknownSkillEvalSlugs,
  type ObservedRun,
  type SkillEvalCase,
} from '../index'

const todo: SkillEvalCase = {
  request: "what's on my plate today?",
  loads: ['my-todo-list'],
  tools: ['list_actions'],
  params: { list_actions: { assignee: 'me', filter: 'today' } },
  avoid: ['create_action'],
}

function run(toolCalls: ObservedRun['toolCalls'], extra: Partial<ObservedRun> = {}): ObservedRun {
  return { toolCalls, finished: true, error: null, ...extra }
}

describe('judgeSkillEvalRun', () => {
  it('passes the expected load, sequence and params, extra calls allowed', () => {
    const v = judgeSkillEvalRun(
      todo,
      run([
        { name: 'load_skill', input: { skill: 'my-todo-list' }, skill: 'my-todo-list' },
        { name: 'get_dashboard_summary', input: {}, packs: ['actions'] },
        { name: 'list_actions', input: { assignee: 'me', filter: 'today', limit: 50 } },
      ]),
    )
    expect(v.failures).toEqual([])
    expect(v.pass).toBe(true)
    expect(v.loadsSeen).toEqual(['my-todo-list', 'actions-playbook'])
  })

  it('counts a pack riding a result as its playbook loading (a core loads without load_skill)', () => {
    const core: SkillEvalCase = { request: 'my overdue work', loads: ['actions-playbook'], tools: ['list_actions'] }
    expect(judgeSkillEvalRun(core, run([{ name: 'list_actions', input: {}, packs: ['actions'] }])).pass).toBe(true)
    expect(judgeSkillEvalRun(core, run([{ name: 'list_actions', input: {} }])).failures).toEqual([
      expect.stringContaining('loads [actions-playbook] not in order'),
    ])
  })

  it('uses the skill load_skill resolved to, else the name it was called with', () => {
    const core: SkillEvalCase = { request: 'x', loads: ['actions-playbook'], tools: [] }
    expect(judgeSkillEvalRun(core, run([{ name: 'load_skill', input: { skill: 'actions' }, skill: 'actions-playbook' }])).pass).toBe(true)
    expect(judgeSkillEvalRun(core, run([{ name: 'load_skill', input: { skill: 'Actions-Playbook' } }])).pass).toBe(true)
  })

  it('fails on a missing load, a wrong order, unmatched params, an avoided tool and an unfinished turn', () => {
    const v = judgeSkillEvalRun(
      { ...todo, tools: ['list_actions', 'show'] },
      run(
        [
          { name: 'show', input: {} },
          { name: 'list_actions', input: { assignee: 'me', filter: 'overdue' } },
          { name: 'create_action', input: { title: 'x' } },
        ],
        { finished: false, error: 'TURN TIMEOUT (180s)' },
      ),
    )
    expect(v.pass).toBe(false)
    expect(v.failures).toEqual([
      'run error: TURN TIMEOUT (180s)',
      'turn did not finish',
      expect.stringContaining('loads [my-todo-list] not in order'),
      expect.stringContaining('tools [list_actions, show] not an ordered subsequence'),
      expect.stringContaining('params for list_actions: no call matched'),
      'called create_action, which it should avoid',
    ])
  })

  it('loads: [] means no load_skill call, while a pack riding a result is fine', () => {
    const none: SkillEvalCase = { request: 'add a to-do', loads: [], tools: ['create_action'] }
    expect(judgeSkillEvalRun(none, run([{ name: 'create_action', input: {}, packs: ['actions'] }])).pass).toBe(true)
    expect(judgeSkillEvalRun(none, run([{ name: 'load_skill', input: { skill: 'my-todo-list' } }, { name: 'create_action', input: {} }])).failures).toEqual([
      expect.stringContaining('expected no load_skill'),
    ])
  })

  it('a params tool that was never called fails', () => {
    expect(judgeSkillEvalRun({ ...todo, tools: [] }, run([{ name: 'load_skill', input: { skill: 'my-todo-list' } }])).failures).toEqual([
      'params for list_actions: never called',
    ])
  })
})

describe('judgeSkillEvalRun — a list of params per tool', () => {
  const twoCalls: SkillEvalCase = {
    request: 'status update for Atlas',
    loads: [],
    tools: ['list_actions'],
    params: { list_actions: [{ project_id: 'p-1' }, { project_id: 'p-1', filter: 'completed' }] },
  }

  it('passes when each entry matches some call', () => {
    const v = judgeSkillEvalRun(
      twoCalls,
      run([
        { name: 'list_actions', input: { project_id: 'p-1', limit: 200 } },
        { name: 'list_actions', input: { project_id: 'p-1', filter: 'completed', since: 'past_7_days' } },
      ]),
    )
    expect(v.failures).toEqual([])
  })

  it('fails for each entry no call matched', () => {
    const v = judgeSkillEvalRun(twoCalls, run([{ name: 'list_actions', input: { project_id: 'p-1' } }]))
    expect(v.failures).toEqual([expect.stringContaining('params for list_actions: no call matched {"project_id":"p-1","filter":"completed"}')])
  })
})

describe('deepPartialMatch', () => {
  it('matches nested objects partially, arrays order-free, strings ignoring case', () => {
    const actual = { kind: 'list', entity_type: 'action', filters: [{ field: 'status_type', operator: 'is_none_of', value: ['completed', 'canceled'] }, { field: 'assignee_id', operator: 'is', value: '@me' }] }
    expect(deepPartialMatch({ filters: [{ field: 'assignee_id' }] }, actual)).toBe(true)
    expect(deepPartialMatch({ entity_type: 'Action ' }, actual)).toBe(true)
    expect(deepPartialMatch({ filters: [{ field: 'due_at' }] }, actual)).toBe(false)
    expect(deepPartialMatch({ limit: 50 }, { limit: '50' })).toBe(false)
    expect(deepPartialMatch({ a: 1 }, undefined)).toBe(false)
  })
})

describe('isOrderedSubsequence', () => {
  it('allows gaps, not reordering', () => {
    expect(isOrderedSubsequence(['a', 'c'], ['a', 'b', 'c'])).toBe(true)
    expect(isOrderedSubsequence(['c', 'a'], ['a', 'b', 'c'])).toBe(false)
    expect(isOrderedSubsequence([], ['a'])).toBe(true)
    expect(isOrderedSubsequence(['a', 'a'], ['a'])).toBe(false)
  })
})

describe('caseShapeErrors', () => {
  it('takes params per tool as one object or a non-empty list of objects', () => {
    const base = { request: 'x', loads: [], tools: ['list_actions'] }
    expect(caseShapeErrors({ ...base, params: { list_actions: { a: 1 } } })).toEqual([])
    expect(caseShapeErrors({ ...base, params: { list_actions: [{ a: 1 }, { b: 2 }] } })).toEqual([])
    expect(caseShapeErrors({ ...base, params: { list_actions: [] } })).toEqual([expect.stringContaining('params:')])
    expect(caseShapeErrors({ ...base, params: { list_actions: [{ a: 1 }, 'b'] } })).toEqual([expect.stringContaining('params:')])
  })

  it('flags a malformed case', () => {
    expect(caseShapeErrors({ request: '', loads: 'x', tools: ['a'], avoid: ['a'], extra: 1 })).toEqual([
      'request: a non-empty string',
      'loads: an array of skill slugs',
      'unknown field: extra',
      'a is in both tools and avoid',
    ])
  })
})

describe('judgeSkillEvalRun — forbidParams (no call may match)', () => {
  const build: SkillEvalCase = {
    request: 'set up a daily brief and turn it on',
    loads: [],
    tools: ['create_flow'],
    forbidParams: { create_flow: [{ enabled: true }, { confirmed_with_user: true }] },
    avoid: ['update_flow'],
  }

  it('passes when the tool is called, but never with a forbidden param', () => {
    const v = judgeSkillEvalRun(build, run([{ name: 'create_flow', input: { name: 'Brief', trigger: { type: 'schedule' }, enabled: false } }]))
    expect(v.failures).toEqual([])
  })

  it('fails a one-shot enable: any call that deep-matches any entry', () => {
    const v = judgeSkillEvalRun(
      build,
      run([
        { name: 'create_flow', input: { name: 'Brief' } },
        { name: 'create_flow', input: { name: 'Brief', enabled: true, confirmed_with_user: true } },
      ]),
    )
    expect(v.pass).toBe(false)
    expect(v.failures).toEqual([
      expect.stringContaining('forbidParams for create_flow: a call matched {"enabled":true}'),
      expect.stringContaining('forbidParams for create_flow: a call matched {"confirmed_with_user":true}'),
    ])
  })

  it('a forbidden param on ANOTHER tool does not count', () => {
    const v = judgeSkillEvalRun(build, run([{ name: 'create_flow', input: {} }, { name: 'list_flows', input: { enabled: true } }]))
    expect(v.failures).toEqual([])
  })

  it('caseShapeErrors takes forbidParams like params, and refuses it on an avoided tool', () => {
    const base = { request: 'x', loads: [], tools: ['create_flow'] }
    expect(caseShapeErrors({ ...base, forbidParams: { create_flow: { enabled: true } } })).toEqual([])
    expect(caseShapeErrors({ ...base, forbidParams: { create_flow: [] } })).toEqual([expect.stringContaining('forbidParams:')])
    expect(caseShapeErrors({ ...base, avoid: ['update_flow'], forbidParams: { update_flow: { enabled: true } } })).toEqual([
      expect.stringContaining('forbidParams for update_flow, which is in avoid'),
    ])
  })
})

describe('judgeSkillEvalRun — noToolErrors (the flywheel\'s failed-turn cases)', () => {
  const fixed: SkillEvalCase = { request: "what's on my plate today?", loads: [], tools: ['list_actions'], noToolErrors: true }

  it('fails when any call errored, naming its code and error', () => {
    const v = judgeSkillEvalRun(
      fixed,
      run([
        { name: 'list_actions', input: { filter: 'nope' }, ok: false, code: 'INPUT_INVALID', error: 'list_actions: bad filter [INPUT_INVALID]' },
        { name: 'list_actions', input: { filter: 'today' }, ok: true },
        { name: 'show', input: {}, ok: false },
      ]),
    )
    expect(v.failures).toEqual(['tool error: list_actions [INPUT_INVALID] list_actions: bad filter [INPUT_INVALID]', 'tool error: show'])
  })

  it('passes when every call succeeded, or the driver gave no verdict for a call', () => {
    expect(judgeSkillEvalRun(fixed, run([{ name: 'list_actions', input: {}, ok: true }, { name: 'show', input: {} }])).failures).toEqual([])
  })

  it('ignores errors without the flag (the hand-written cases tolerate a retry)', () => {
    const { noToolErrors: _drop, ...lenient } = fixed
    expect(judgeSkillEvalRun(lenient, run([{ name: 'list_actions', input: {}, ok: false, code: 'NOT_FOUND' }, { name: 'list_actions', input: {}, ok: true }])).pass).toBe(true)
  })

  it('caseShapeErrors takes noToolErrors as a boolean only', () => {
    expect(caseShapeErrors(fixed)).toEqual([])
    expect(caseShapeErrors({ ...fixed, noToolErrors: 'yes' })).toEqual(['noToolErrors: a boolean'])
  })
})

describe('selectSkillEvalSuites (CHAT_SKILL_EVAL_ONLY)', () => {
  const fileSlugs = Object.keys(SKILL_EVAL_CASES).sort()

  it('runs every suite when nothing is named, and one whole suite by slug', () => {
    expect(selectSkillEvalSuites([]).map((s) => s.slug)).toEqual(skillEvalSuites().map((s) => s.slug))
    const [todo] = selectSkillEvalSuites(['my-todo-list'])
    expect(todo.slug).toBe('my-todo-list')
    expect(todo.cases.length).toBeGreaterThanOrEqual(SKILL_EVAL_CASES['my-todo-list'].length)
    expect(todo.core).toBeUndefined()
  })

  it('instructions: the first cases of every skill, and a named skill in full', () => {
    const suites = selectSkillEvalSuites([INSTRUCTIONS_SUITE, 'my-todo-list'])
    for (const slug of fileSlugs) {
      const suite = suites.find((s) => s.slug === slug && s.slug !== INSTRUCTIONS_SUITE)
      expect(suite, slug).toBeDefined()
      if (slug === 'my-todo-list') expect(suite!.core).toBeUndefined()
      else {
        expect(suite!.core).toBe(true)
        expect(suite!.cases).toEqual(SKILL_EVAL_CASES[slug].slice(0, INSTRUCTIONS_CORE_CASES_PER_SKILL))
      }
    }
  })

  it('knows instructions and the suites, nothing else', () => {
    expect(unknownSkillEvalSlugs([INSTRUCTIONS_SUITE, 'my-todo-list', 'no-such-skill'])).toEqual(['no-such-skill'])
  })
})
